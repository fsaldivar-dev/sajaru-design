import type * as Ort from 'onnxruntime-node'
import sharp from 'sharp'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Ctx } from './context'
import { SidecarError } from './errors'
import { fileExists, writeOutput } from './image'
import { getModel, isDownloaded, modelPath } from './models/manager'

/**
 * MobileSAM — segmentación promptable (click → objeto, estilo Affinity). Dos
 * ONNX (registrados en models/registry como `mobilesam-encoder` /
 * `mobilesam-decoder`):
 *
 *  1. ENCODER: imagen → `image_embeddings (1,256,64,64)`. Es caro (~la mayor
 *     parte del tiempo), así que se corre UNA vez por imagen (`sam-encode`) y el
 *     embedding se cachea en disco.
 *  2. DECODER: `embedding + prompt (puntos/box)` → K máscaras (logits ya al
 *     tamaño ORIGINAL) + IoU. Es barato → se corre por cada click (`sam-decode`).
 *
 * El encoder corre fuera de Electron (sidecar) como el resto del trabajo pesado.
 *
 * ── Firma REAL de los ONNX (verificada cargando las sesiones) ──
 *  encoder.inputNames  = ['input_image']            ⚠️ NO 'images'
 *  encoder  input shape = [image_height, image_width, 3]  ⚠️ HWC, SIN batch, dims dinámicas
 *  encoder.outputNames = ['image_embeddings']  → (1,256,64,64)
 *  decoder.inputNames  = ['image_embeddings','point_coords','point_labels',
 *                         'mask_input','has_mask_input','orig_im_size']
 *  decoder.outputNames = ['masks','iou_predictions','low_res_masks']
 *
 * El encoder hace el resize/pad internamente (acepta cualquier H×W y siempre
 * emite 64×64), pero NO normaliza: probado con (px-mean)/std vs crudo, el
 * embedding cambia y solo el normalizado registra la máscara sobre el objeto
 * clickeado. Así que normalizamos nosotros (mean/std en 0..255) y, por fidelidad
 * a la convención SAM, mandamos la imagen ya remuestreada a lado-largo 1024 y
 * padeada a 1024×1024 (el espacio en el que viven las coords del decoder).
 */

/** Encoder por defecto (modo "Rápido"). El "Preciso" usa 'sam-vitb-encoder'. */
const ENCODER_ID = 'mobilesam-encoder'
const DECODER_ID = 'mobilesam-decoder'

/** Modelos de encoder soportados por `sam-encode` (mismo embedding → mismo decoder). */
export type SamEncoderModel = 'mobilesam' | 'sam-vitb'

/** Mapea el alias de CLI/UI al id del registry del encoder correspondiente. */
function encoderIdFor(model: SamEncoderModel): string {
  return model === 'sam-vitb' ? 'sam-vitb-encoder' : ENCODER_ID
}

/** Lado al que SAM remuestrea el lado LARGO de la imagen (y lado del pad). */
const SAM_SIZE = 1024

/** Magic + versión del archivo de embedding (header JSON + Float32 crudo). */
const EMB_MAGIC = 'SAMEMB1\n'

/** onnxruntime-node es un addon nativo pesado: cargalo perezoso (como remove-bg). */
async function loadOrt(): Promise<typeof import('onnxruntime-node')> {
  try {
    return await import('onnxruntime-node')
  } catch (e) {
    throw new SidecarError(
      'E_ORT_MISSING',
      'onnxruntime-node no está disponible. Reinstalá las dependencias del sidecar.',
      String(e)
    )
  }
}

/**
 * Opciones de sesión: fp32 en CPU (NUNCA fp16, que en CPU es más lento/impreciso)
 * e `intra_op_num_threads` a los cores FÍSICOS para acelerar el encode (la GEMM
 * del ViT paraleliza bien hasta los cores físicos; pasarse no ayuda).
 */
function sessionOptions(ort: typeof import('onnxruntime-node')): Ort.InferenceSession.SessionOptions {
  const physical = Math.max(1, os.cpus().length)
  return {
    executionProviders: ['cpu'],
    intraOpNumThreads: physical,
    graphOptimizationLevel: 'all'
  } as Ort.InferenceSession.SessionOptions
}

/**
 * Cuántos threads intra-op usa CADA sesión de decode del AMG. El AMG corre N
 * decodes CONCURRENTES (un worker pool sobre la grilla); si cada `session.run`
 * usa todos los cores (intraOp alto) con N corriendo a la vez se sobre-suscribe la
 * CPU y la concurrencia no rinde. El óptimo medido es intraOp BAJO (1–2) por
 * sesión × concurrencia≈cores. Tuneable por env para iterar sin recompilar
 * (`SAJARU_AMG_DECODE_INTRAOP`). Default 1. NO afecta el modo prompt (sam-decode),
 * que sigue usando `sessionOptions` con intraOp = cores físicos.
 */
function amgDecodeIntraOp(): number {
  const raw = Number(process.env.SAJARU_AMG_DECODE_INTRAOP)
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw)
  return 1
}

/** SessionOptions DEDICADAS al decode del AMG: igual que el prompt pero intraOp bajo. */
function amgDecodeSessionOptions(): Ort.InferenceSession.SessionOptions {
  return {
    executionProviders: ['cpu'],
    intraOpNumThreads: amgDecodeIntraOp(),
    graphOptimizationLevel: 'all'
  } as Ort.InferenceSession.SessionOptions
}

const sessions = new Map<string, Ort.InferenceSession>()

async function getSession(
  id: string,
  ort: typeof import('onnxruntime-node')
): Promise<Ort.InferenceSession> {
  if (!isDownloaded(id)) {
    throw new SidecarError(
      'E_MODEL_MISSING',
      `Modelo "${id}" no descargado. Corré: bg-sidecar models download ${id}`
    )
  }
  const cached = sessions.get(id)
  if (cached) return cached
  const session = await ort.InferenceSession.create(modelPath(id), sessionOptions(ort))
  // Confirmá los nombres reales de inputs/outputs (la firma puede diferir del
  // export esperado). Va a stderr para no ensuciar el stream JSON de stdout.
  console.error(`[sam] ${id} inputs=${JSON.stringify(session.inputNames)} outputs=${JSON.stringify(session.outputNames)}`)
  sessions.set(id, session)
  return session
}

/**
 * Crea una InferenceSession NUEVA (no cacheada/compartida) del decoder `id` con las
 * opciones del AMG (intraOp bajo). El AMG le da a CADA worker su PROPIA sesión: aunque
 * las sesiones de onnxruntime son thread-safe para `Run`, instancias separadas evitan
 * cualquier contención interna de estado por-Run y dejan a cada decode su propio cupo
 * de threads. Mismo modelo en disco, instancias independientes.
 */
async function createAmgDecodeSession(
  id: string,
  ort: typeof import('onnxruntime-node')
): Promise<Ort.InferenceSession> {
  if (!isDownloaded(id)) {
    throw new SidecarError(
      'E_MODEL_MISSING',
      `Modelo "${id}" no descargado. Corré: bg-sidecar models download ${id}`
    )
  }
  return ort.InferenceSession.create(modelPath(id), amgDecodeSessionOptions())
}

// ── ENCODE ────────────────────────────────────────────────────────────────

/**
 * Familia de decoder que consume el embedding. La elige el encoder que lo generó:
 *  - 'mobilesam': decoder MobileSAM `sam_mask_decoder_multi` (masks ya a tamaño
 *    original vía orig_im_size; coords/labels float; padding [0,0] label -1).
 *  - 'sam-vitb': decoder SAM ViT-B (transformers): input_points/input_labels (int64),
 *    NECESITA image_positional_embeddings, devuelve pred_masks 256×256 (sin upscale
 *    interno) → se upscalean acá. ⚠️ El decoder MobileSAM NO decodifica bien un
 *    embedding ViT-B (sale fragmentado): cada encoder va con SU decoder.
 */
export type SamDecoderFamily = 'mobilesam' | 'sam-vitb'

/** Metadatos guardados junto al embedding (necesarios para escalar el prompt). */
export interface SamEmbeddingMeta {
  origW: number
  origH: number
  /** Lado de remuestreo de SAM (1024); fija la escala coord *= SAM_SIZE/max(W,H). */
  samSize: number
  /** Dims del tensor de embedding, p.ej. [1,256,64,64]. */
  dims: number[]
  /** Id del modelo de encoder que generó el .bin (registry id). */
  model: string
  /** Qué decoder consume este embedding (deriva de `model`). Default 'mobilesam'. */
  decoder?: SamDecoderFamily
  /** Lado largo remuestreado de la imagen (≤ samSize); el resto es pad. Mapea 256→orig. */
  newW?: number
  newH?: number
  /**
   * Dims del SEGUNDO tensor (image_positional_embeddings) si el decoder lo necesita
   * (SAM ViT-B). Se guarda inmediatamente DESPUÉS del primero en el body. Ausente
   * para MobileSAM (que no usa positional externo).
   */
  posDims?: number[]
}

/**
 * Preproceso del encoder SAM. Remuestrea el lado LARGO a 1024 (manteniendo
 * aspecto), padea abajo/derecha hasta 1024×1024, normaliza con mean/std en
 * escala 0..255 y devuelve un Float32Array en el LAYOUT que pide el ONNX:
 *  - 'hwc'  (MobileSAM): shape [1024,1024,3], intercalado RGB, SIN batch.
 *  - 'nchw' (SAM ViT-B): shape [1,3,1024,1024], canal-planar (plano R, plano G, plano B).
 *
 * La normalización es la misma en ambos: (px - mean)/std con px en 0..255 (mean/std
 * en 0..255), NO la 0..1 de ImageNet — para SAM ViT-B el preprocessor de HF declara
 * mean/std ImageNet en 0..1, pero ×255 da EXACTO estos números (equivalente).
 */
async function preprocessEncoder(
  buf: Buffer,
  mean: [number, number, number],
  std: [number, number, number],
  layout: 'hwc' | 'nchw'
): Promise<{ data: Float32Array; newW: number; newH: number }> {
  const meta = await sharp(buf).metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  if (!W || !H) throw new SidecarError('E_IMAGE', 'No se pudieron leer las dimensiones de la imagen')

  const scale = SAM_SIZE / Math.max(W, H)
  const newW = Math.round(W * scale)
  const newH = Math.round(H * scale)

  // Lado largo a 1024 (aspecto intacto), RGB crudo 0..255.
  const resized = await sharp(buf, { limitInputPixels: false })
    .removeAlpha()
    .resize(newW, newH, { fit: 'fill' })
    .raw()
    .toBuffer()

  // Pad abajo/derecha hasta 1024×1024 (el resto queda en 0 = contexto vacío).
  const data = new Float32Array(SAM_SIZE * SAM_SIZE * 3)
  if (layout === 'nchw') {
    // Canal-planar: data = [todo R | todo G | todo B], cada plano 1024×1024.
    const plane = SAM_SIZE * SAM_SIZE
    for (let y = 0; y < newH; y++) {
      const srow = y * newW * 3
      const drow = y * SAM_SIZE
      for (let x = 0; x < newW; x++) {
        const s = srow + x * 3
        const d = drow + x
        data[d] = (resized[s] - mean[0]) / std[0]
        data[plane + d] = (resized[s + 1] - mean[1]) / std[1]
        data[2 * plane + d] = (resized[s + 2] - mean[2]) / std[2]
      }
    }
  } else {
    // HWC intercalado: data = [R0,G0,B0, R1,G1,B1, ...].
    for (let y = 0; y < newH; y++) {
      const srow = y * newW * 3
      const drow = y * SAM_SIZE * 3
      for (let x = 0; x < newW; x++) {
        const s = srow + x * 3
        const d = drow + x * 3
        data[d] = (resized[s] - mean[0]) / std[0]
        data[d + 1] = (resized[s + 1] - mean[1]) / std[1]
        data[d + 2] = (resized[s + 2] - mean[2]) / std[2]
      }
    }
  }
  return { data, newW, newH }
}

/**
 * Serializa el embedding: magic + header JSON length-prefixed + Float32 crudo del
 * embedding y, opcionalmente, un SEGUNDO tensor (positional, para SAM ViT-B) pegado
 * a continuación. La longitud del primer tensor se deriva de `meta.dims`, así el
 * lector sabe dónde empieza el segundo (`meta.posDims`).
 */
function packEmbedding(meta: SamEmbeddingMeta, emb: Float32Array, pos?: Float32Array): Buffer {
  const header = Buffer.from(JSON.stringify(meta), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(header.length, 0)
  const parts = [
    Buffer.from(EMB_MAGIC, 'utf8'),
    len,
    header,
    Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength)
  ]
  if (pos) parts.push(Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength))
  return Buffer.concat(parts)
}

/** Lee de vuelta un embedding empacado por `packEmbedding` (con su tensor posicional si lo tiene). */
export async function loadEmbedding(
  p: string
): Promise<{ meta: SamEmbeddingMeta; data: Float32Array; pos?: Float32Array }> {
  if (!(await fileExists(p))) {
    throw new SidecarError('E_INPUT_NOT_FOUND', `No existe el embedding: ${p}`)
  }
  const buf = await fs.readFile(p)
  const magic = EMB_MAGIC
  if (buf.subarray(0, magic.length).toString('utf8') !== magic) {
    throw new SidecarError('E_EMBEDDING', `Archivo de embedding inválido (magic): ${p}`)
  }
  let off = magic.length
  const headerLen = buf.readUInt32LE(off)
  off += 4
  const meta = JSON.parse(buf.subarray(off, off + headerLen).toString('utf8')) as SamEmbeddingMeta
  off += headerLen
  // Copiá a un Float32Array alineado (el offset del body puede no ser múltiplo de 4).
  const aligned = Buffer.from(buf.subarray(off)) // copia → byteOffset 0, alineado
  const all = new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4)
  // Si hay posDims, el primer tensor ocupa prod(dims) floats y el segundo lo sigue.
  if (meta.posDims && meta.posDims.length) {
    const n1 = (meta.dims ?? []).reduce((a, b) => a * b, 1)
    const data = all.subarray(0, n1)
    const pos = all.subarray(n1)
    return { meta, data: new Float32Array(data), pos: new Float32Array(pos) }
  }
  return { meta, data: all }
}

export interface SamEncodeResult {
  outPath: string
  origW: number
  origH: number
  dims: number[]
  bytes: number
}

/**
 * Corre el encoder SAM elegido (`mobilesam` rápido / `sam-vitb` preciso) sobre una
 * imagen y guarda el embedding (+ meta) en `outPath`. Ambos producen un embedding
 * (1,256,64,64); el preproceso (nombre de input + layout HWC vs NCHW) y el decoder
 * compatible se leen del registry. SAM ViT-B además emite `image_positional_embeddings`,
 * que su decoder necesita: lo guardamos pegado al embedding. Pensado para correr UNA
 * vez por imagen; los clicks reusan el embedding.
 */
export async function samEncode(
  imagePath: string,
  outPath: string,
  ctx: Ctx,
  model: SamEncoderModel = 'mobilesam'
): Promise<SamEncodeResult> {
  if (!(await fileExists(imagePath))) {
    throw new SidecarError('E_INPUT_NOT_FOUND', `No existe la imagen: ${imagePath}`)
  }
  const encoderId = encoderIdFor(model)
  const def = getModel(encoderId)
  ctx.progress('sam-encode', 0.05, `Cargando encoder ${def.name}`)
  const ort = await loadOrt()
  const session = await getSession(encoderId, ort)

  const buf = await fs.readFile(imagePath)
  const meta = await sharp(buf).metadata()
  const origW = meta.width ?? 0
  const origH = meta.height ?? 0

  // Layout/nombres del registry (MobileSAM = HWC 'input_image'; SAM ViT-B = NCHW
  // 'pixel_values'). Fallback al primer input/output reales por si la firma cambia.
  const layout = def.encoderLayout ?? 'hwc'
  const inName = def.encoderInputName ?? session.inputNames[0]
  const outName =
    def.encoderOutputName && session.outputNames.includes(def.encoderOutputName)
      ? def.encoderOutputName
      : session.outputNames[0]

  ctx.progress('sam-encode', 0.2, 'Preprocesando (resize 1024 + pad + normalizar)')
  const { data, newW, newH } = await preprocessEncoder(buf, def.mean, def.std, layout)

  // Shape según el layout: NCHW [1,3,1024,1024] (SAM ViT-B) o HWC [1024,1024,3] (MobileSAM).
  const inputDims = layout === 'nchw' ? [1, 3, SAM_SIZE, SAM_SIZE] : [SAM_SIZE, SAM_SIZE, 3]
  const input = new ort.Tensor('float32', data, inputDims)

  ctx.progress('sam-encode', 0.4, `Codificando imagen (${def.name}, puede tardar)`)
  const outputs = await session.run({ [inName]: input })
  const emb = outputs[outName] as Ort.Tensor
  const dims = emb.dims as number[]
  const embData = emb.data as Float32Array

  // SAM ViT-B: su decoder (transformers) necesita el positional embedding que el
  // encoder emite como segundo output. Lo capturamos y lo guardamos pegado.
  const decoder: SamDecoderFamily = model === 'sam-vitb' ? 'sam-vitb' : 'mobilesam'
  let posData: Float32Array | undefined
  let posDims: number[] | undefined
  if (decoder === 'sam-vitb') {
    const posName = outputs['image_positional_embeddings']
      ? 'image_positional_embeddings'
      : session.outputNames.find((n) => n !== outName)
    if (posName && outputs[posName]) {
      const posT = outputs[posName] as Ort.Tensor
      posData = posT.data as Float32Array
      posDims = posT.dims as number[]
    } else {
      throw new SidecarError(
        'E_ENCODE',
        'El encoder SAM ViT-B no devolvió image_positional_embeddings (firma inesperada).'
      )
    }
  }

  ctx.progress('sam-encode', 0.9, 'Guardando embedding')
  // `model` registra qué encoder generó el .bin; `decoder`/newW/newH/posDims los usa sam-decode.
  const metaOut: SamEmbeddingMeta = {
    origW,
    origH,
    samSize: SAM_SIZE,
    dims,
    model: encoderId,
    decoder,
    newW,
    newH,
    posDims
  }
  const packed = packEmbedding(metaOut, embData, posData)
  await writeOutput(outPath, packed)

  ctx.progress('sam-encode', 1)
  return { outPath, origW, origH, dims, bytes: packed.length }
}

// ── DECODE ──────────────────────────────────────────────────────────────────

/** Punto de prompt en px de la imagen ORIGINAL. label: 1=fg, 0=bg, 2/3=esquinas box. */
export interface SamPoint {
  x: number
  y: number
  label: number
}

/** Box de prompt en px de la imagen ORIGINAL: [x0,y0,x1,y1]. */
export type SamBox = [number, number, number, number]

export interface SamDecodeParams {
  origW: number
  origH: number
  points?: SamPoint[]
  box?: SamBox
  /** Lado de remuestreo de SAM (de la meta del embedding). Default 1024. */
  samSize?: number
  /**
   * Máscara low-res (256x256, 1 canal, gris) del decode PREVIO, para refinamiento
   * iterativo: SAM la realimenta como `mask_input` y afina la forma con los puntos
   * nuevos. Ruta a un PNG; requiere `hasMaskInput=true`. Sin esto = primer decode.
   */
  maskInputPath?: string
  /** Si hay `maskInputPath` válido para realimentar (has_mask_input del decoder). */
  hasMaskInput?: boolean
}

/** Una de las K máscaras candidatas del multimask: su PNG (tamaño original) + IoU. */
export interface SamCandidate {
  /** PNG de máscara (gris: 255 = objeto, 0 = fuera), tamaño ORIGINAL. */
  maskPath: string
  /** IoU predicho por SAM para esta candidata. */
  iou: number
  /** Fracción de píxeles activos (0 = vacía). */
  coverage: number
}

export interface SamDecodeResult {
  /** Compat: PNG de la candidata elegida (= candidates[chosen].maskPath). */
  outMaskPath: string
  /** IoU de la candidata elegida. */
  iou: number
  /** Índice de la máscara elegida entre las K. */
  chosen: number
  /** IoU de todas las máscaras candidatas (para debug/UI). */
  ious: number[]
  /** Las K máscaras candidatas del multimask (cada una como PNG + IoU). */
  candidates: SamCandidate[]
  /**
   * PNG low-res (256x256, gris) de la candidata elegida, para realimentar como
   * `maskInputPath` en el próximo decode (refinamiento iterativo estilo Affinity).
   */
  lowResPath: string
  width: number
  height: number
  /** Fracción de píxeles dentro de la máscara binaria elegida (sanidad: 0 = vacía). */
  coverage: number
}

/**
 * Construye los tensores de prompt del decoder SAM a partir de puntos/box en px
 * ORIGINALES. Las coords se escalan al espacio 1024 (coord *= 1024/max(W,H)); el
 * punto de padding [0,0] (label -1) queda en 0 tras la escala.
 *
 * Reglas de labels: 1=foreground, 0=background, -1=padding, 2/3=esquinas de box.
 *  - Click(s) simple(s): puntos + un padding [0,0] con label -1.
 *  - Box: 2 puntos (esquinas) con labels 2 y 3, SIN padding.
 *  - Box + puntos: esquinas (2,3) seguidas de los puntos, SIN padding extra.
 */
function buildPrompt(
  params: SamDecodeParams
): { coords: Float32Array; labels: Float32Array; n: number } {
  const samSize = params.samSize ?? SAM_SIZE
  const scale = samSize / Math.max(params.origW, params.origH)
  const coords: number[] = []
  const labels: number[] = []

  if (params.box) {
    const [x0, y0, x1, y1] = params.box
    coords.push(x0 * scale, y0 * scale, x1 * scale, y1 * scale)
    labels.push(2, 3)
    // Puntos adicionales (refinamiento dentro del box), si los hay. SIN padding.
    for (const p of params.points ?? []) {
      coords.push(p.x * scale, p.y * scale)
      labels.push(p.label)
    }
  } else {
    const pts = params.points ?? []
    if (pts.length === 0) {
      throw new SidecarError('E_ARG', 'Falta el prompt: pasá al menos un punto o un box.')
    }
    for (const p of pts) {
      coords.push(p.x * scale, p.y * scale)
      labels.push(p.label)
    }
    // Punto de padding [0,0] con label -1 (requisito del decoder sin box).
    coords.push(0, 0)
    labels.push(-1)
  }

  return {
    coords: Float32Array.from(coords),
    labels: Float32Array.from(labels),
    n: labels.length
  }
}

/** Lado del mask_input low-res del decoder SAM (256x256, fijo por la firma del ONNX). */
const LOW_RES = 256

/**
 * Lee un PNG de máscara low-res (256x256, gris) a un Float32Array de LOGITS para
 * realimentar como `mask_input`. El decoder espera logits crudos en `mask_input`,
 * NO 0..255; como guardamos el low-res binarizado a 0/255 (PNG visible/debuggable),
 * lo de-cuantizamos a un logit aproximado: 255 → +`MASK_LOGIT`, 0 → −`MASK_LOGIT`.
 * Un valor moderado alcanza para sesgar la forma sin "congelarla" (el prompt manda).
 */
async function loadMaskInput(p: string): Promise<Float32Array | null> {
  try {
    if (!(await fileExists(p))) return null
    const { data, info } = await sharp(p)
      .removeAlpha()
      .resize(LOW_RES, LOW_RES, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const n = LOW_RES * LOW_RES
    const ch = info.channels || 1
    const out = new Float32Array(n)
    const MASK_LOGIT = 10
    for (let i = 0; i < n; i++) {
      out[i] = data[i * ch] >= 128 ? MASK_LOGIT : -MASK_LOGIT
    }
    return out
  } catch {
    return null
  }
}

/** Deriva la ruta de la candidata `k` desde la base `outMaskPath` (sufijo `.kN`). */
function candidatePath(base: string, k: number): string {
  const ext = path.extname(base)
  const stem = base.slice(0, base.length - ext.length)
  return `${stem}.k${k}${ext || '.png'}`
}

/** Deriva la ruta del low-res de la elegida desde la base (sufijo `.lowres`). */
function lowResPathFor(base: string): string {
  const ext = path.extname(base)
  const stem = base.slice(0, base.length - ext.length)
  return `${stem}.lowres${ext || '.png'}`
}

/** Id del decoder SAM ViT-B (transformers) en el registry; pareja del encoder ViT-B. */
const VITB_DECODER_ID = 'sam-vitb-decoder'

/**
 * Logits crudos por candidata + dims, normalizados para el escritor de PNGs común.
 * `masksLogits` son K máscaras seguidas (cada una W*H) ya al tamaño ORIGINAL.
 * `lowResLogits` (256×256 por candidata) son para el feedback de refinamiento.
 */
interface DecodeRaw {
  K: number
  W: number
  H: number
  masksLogits: Float32Array
  ious: Float32Array
  lrW: number
  lrH: number
  lowResLogits: Float32Array
}

/** Producto interno (×4 + crop válido + bilinear) que upscalea un mapa 256→original. */
function upscaleLogits(
  src: Float32Array,
  off: number,
  mw: number,
  mh: number,
  validW: number,
  validH: number,
  W: number,
  H: number
): Float32Array {
  const out = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    const gy = (y / H) * validH
    const y0 = Math.min(mh - 1, Math.floor(gy))
    const y1 = Math.min(mh - 1, y0 + 1)
    const fy = gy - y0
    for (let x = 0; x < W; x++) {
      const gx = (x / W) * validW
      const x0 = Math.min(mw - 1, Math.floor(gx))
      const x1 = Math.min(mw - 1, x0 + 1)
      const fx = gx - x0
      const v00 = src[off + y0 * mw + x0]
      const v01 = src[off + y0 * mw + x1]
      const v10 = src[off + y1 * mw + x0]
      const v11 = src[off + y1 * mw + x1]
      out[y * W + x] = v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy) + v10 * (1 - fx) * fy + v11 * fx * fy
    }
  }
  return out
}

/**
 * Decode con el decoder MobileSAM (`sam_mask_decoder_multi`). Las masks salen ya al
 * tamaño ORIGINAL (el decoder upscalea con orig_im_size) y el low-res (256) es el
 * mapa de refinamiento. Coords/labels float, padding [0,0] label -1 sin box.
 */
async function decodeMobileSam(
  ort: typeof import('onnxruntime-node'),
  meta: SamEmbeddingMeta,
  data: Float32Array,
  resolved: SamDecodeParams,
  ctx: Ctx
): Promise<DecodeRaw> {
  const session = await getSession(DECODER_ID, ort)
  const dims = meta.dims && meta.dims.length === 4 ? meta.dims : [1, 256, 64, 64]
  const { coords, labels, n } = buildPrompt(resolved)

  // mask_input: vacío salvo refinamiento (realimentar el low-res del decode previo).
  let maskInput: Float32Array = new Float32Array(LOW_RES * LOW_RES)
  let hasMask = 0
  if (resolved.hasMaskInput && resolved.maskInputPath) {
    const prev = await loadMaskInput(resolved.maskInputPath)
    if (prev) {
      maskInput = prev
      hasMask = 1
    }
  }

  const feeds: Record<string, Ort.Tensor> = {
    image_embeddings: new ort.Tensor('float32', data, dims),
    point_coords: new ort.Tensor('float32', coords, [1, n, 2]),
    point_labels: new ort.Tensor('float32', labels, [1, n]),
    mask_input: new ort.Tensor('float32', maskInput, [1, 1, LOW_RES, LOW_RES]),
    has_mask_input: new ort.Tensor('float32', Float32Array.from([hasMask]), [1]),
    orig_im_size: new ort.Tensor('float32', Float32Array.from([resolved.origH, resolved.origW]), [2])
  }

  ctx.progress('sam-decode', 0.6, 'Decodificando máscaras')
  const out = await session.run(feeds)
  const masks = out.masks as Ort.Tensor
  const iouT = out.iou_predictions as Ort.Tensor
  const lowResT = out.low_res_masks as Ort.Tensor
  return {
    K: masks.dims[1] as number,
    H: masks.dims[2] as number,
    W: masks.dims[3] as number,
    masksLogits: masks.data as Float32Array,
    ious: iouT.data as Float32Array,
    lrH: lowResT.dims[2] as number,
    lrW: lowResT.dims[3] as number,
    lowResLogits: lowResT.data as Float32Array
  }
}

/**
 * Decode con el decoder SAM ViT-B (transformers). Necesita el positional embedding
 * (segundo tensor del .bin), labels INT64 y devuelve `pred_masks` (1,1,3,256,256)
 * en LOGITS sin upscale interno → los upscaleamos al tamaño original mapeando el
 * cuadrante VÁLIDO del 256 (newW/1024, newH/1024) a W×H (bilinear). El refinamiento
 * iterativo del decoder MobileSAM (mask_input) no aplica acá: el preview ViT-B se
 * re-decodea desde los puntos acumulados (igual resultado en la práctica).
 */
async function decodeVitB(
  ort: typeof import('onnxruntime-node'),
  meta: SamEmbeddingMeta,
  data: Float32Array,
  pos: Float32Array | undefined,
  resolved: SamDecodeParams,
  ctx: Ctx
): Promise<DecodeRaw> {
  if (!pos || !meta.posDims) {
    throw new SidecarError(
      'E_EMBEDDING',
      'El embedding "preciso" no trae positional embedding (re-encodeá con --model sam-vitb).'
    )
  }
  const session = await getSession(VITB_DECODER_ID, ort)
  const dims = meta.dims && meta.dims.length === 4 ? meta.dims : [1, 256, 64, 64]

  // Prompt transformers: coords en espacio 1024 (igual que MobileSAM), labels INT64,
  // SIN punto de padding. box → esquinas 2,3. Reusamos buildPrompt y filtramos el pad.
  const built = buildPrompt(resolved)
  const coordsAll = Array.from(built.coords)
  const labelsAll = Array.from(built.labels)
  const pts: number[] = []
  const labs: bigint[] = []
  for (let i = 0; i < labelsAll.length; i++) {
    if (labelsAll[i] === -1) continue // descartá el punto de padding [0,0] de MobileSAM
    pts.push(coordsAll[i * 2], coordsAll[i * 2 + 1])
    labs.push(BigInt(labelsAll[i]))
  }
  const np = labs.length

  const feeds: Record<string, Ort.Tensor> = {
    input_points: new ort.Tensor('float32', Float32Array.from(pts), [1, 1, np, 2]),
    input_labels: new ort.Tensor('int64', BigInt64Array.from(labs), [1, 1, np]),
    image_embeddings: new ort.Tensor('float32', data, dims),
    image_positional_embeddings: new ort.Tensor('float32', pos, meta.posDims)
  }

  ctx.progress('sam-decode', 0.6, 'Decodificando máscaras (preciso)')
  const out = await session.run(feeds)
  const pred = out.pred_masks as Ort.Tensor
  const iouT = out.iou_scores as Ort.Tensor
  // pred_masks: [1,1,K,256,256]. K = penúltima dim; mh/mw las dos últimas.
  const pdims = pred.dims as number[]
  const mh = pdims[pdims.length - 2]
  const mw = pdims[pdims.length - 1]
  const K = pdims[pdims.length - 3]
  const predData = pred.data as Float32Array
  const W = resolved.origW
  const H = resolved.origH
  // Cuadrante válido del 256 (el resto es el pad de la imagen 1024). newW/newH del .bin.
  const newW = meta.newW ?? Math.round((W / Math.max(W, H)) * SAM_SIZE)
  const newH = meta.newH ?? Math.round((H / Math.max(W, H)) * SAM_SIZE)
  const validW = (newW / SAM_SIZE) * mw
  const validH = (newH / SAM_SIZE) * mh

  // Upscaleá cada candidata a tamaño original; el low-res es el 256 crudo (refinamiento).
  const masksLogits = new Float32Array(K * W * H)
  for (let k = 0; k < K; k++) {
    const up = upscaleLogits(predData, k * mh * mw, mw, mh, validW, validH, W, H)
    masksLogits.set(up, k * W * H)
  }
  return {
    K,
    W,
    H,
    masksLogits,
    ious: iouT.data as Float32Array,
    lrH: mh,
    lrW: mw,
    lowResLogits: predData
  }
}

/**
 * Decodifica un embedding cacheado + un prompt (puntos/box) a las K máscaras
 * candidatas (PNG, tamaño original) + el low-res (256) de la elegida para
 * refinamiento. El DECODER se elige según `meta.decoder` del embedding:
 *  - 'mobilesam' (rápido): decoder MobileSAM (masks ya a tamaño original).
 *  - 'sam-vitb'  (preciso): decoder SAM ViT-B (logits 256 → upscale acá).
 * Ambos caminos terminan en el MISMO formato de salida, así el plugin/renderer no
 * se enteran de cuál corrió.
 */
export async function samDecode(
  embeddingPath: string,
  params: SamDecodeParams,
  outMaskPath: string,
  ctx: Ctx,
  maskIndex?: number
): Promise<SamDecodeResult> {
  ctx.progress('sam-decode', 0.1, 'Cargando decoder')
  const ort = await loadOrt()

  ctx.progress('sam-decode', 0.3, 'Cargando embedding')
  const { meta, data, pos } = await loadEmbedding(embeddingPath)
  // Usá los origW/H/samSize del embedding (autoridad) si el caller no los pasa.
  const resolved: SamDecodeParams = {
    ...params,
    origW: params.origW || meta.origW,
    origH: params.origH || meta.origH,
    samSize: meta.samSize || SAM_SIZE
  }

  const family: SamDecoderFamily = meta.decoder ?? 'mobilesam'
  const raw =
    family === 'sam-vitb'
      ? await decodeVitB(ort, meta, data, pos, resolved, ctx)
      : await decodeMobileSam(ort, meta, data, resolved, ctx)

  const { K, W, H, masksLogits, ious: iouData, lrW, lrH, lowResLogits } = raw

  const ious = Array.from(iouData.subarray(0, K), (v) => +v.toFixed(4))
  // Elegida: el índice pedido (si es válido) o argmax(IoU) entre las K.
  let chosen = 0
  for (let k = 1; k < K; k++) if (iouData[k] > iouData[chosen]) chosen = k
  if (maskIndex !== undefined && maskIndex >= 0 && maskIndex < K) chosen = maskIndex

  // Threshold en logit > 0 → alfa binaria (255/0), tamaño original. Escribimos las
  // K candidatas (cada una a su PNG con sufijo .kN) para poder ciclar en la UI.
  ctx.progress('sam-decode', 0.85, 'Generando PNGs de máscara')
  const candidates: SamCandidate[] = []
  for (let k = 0; k < K; k++) {
    const off = k * H * W
    const alpha = Buffer.alloc(W * H)
    let positive = 0
    for (let i = 0; i < W * H; i++) {
      if (masksLogits[off + i] > 0) {
        alpha[i] = 255
        positive++
      }
    }
    const png = await sharp(alpha, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer()
    const maskPath = k === chosen ? outMaskPath : candidatePath(outMaskPath, k)
    await writeOutput(maskPath, png)
    candidates.push({
      maskPath,
      iou: +iouData[k].toFixed(4),
      coverage: +(positive / (W * H)).toFixed(4)
    })
  }

  // Low-res de la elegida (256x256, binarizado a 0/255) → realimentable como
  // mask_input en el próximo decode (solo lo usa el path MobileSAM; ViT-B re-decodea).
  const lrOff = chosen * lrH * lrW
  const lowAlpha = Buffer.alloc(lrW * lrH)
  for (let i = 0; i < lrW * lrH; i++) lowAlpha[i] = lowResLogits[lrOff + i] > 0 ? 255 : 0
  const lowPng = await sharp(lowAlpha, { raw: { width: lrW, height: lrH, channels: 1 } }).png().toBuffer()
  const lowResPath = lowResPathFor(outMaskPath)
  await writeOutput(lowResPath, lowPng)

  ctx.progress('sam-decode', 1)
  return {
    outMaskPath: candidates[chosen].maskPath,
    iou: candidates[chosen].iou,
    chosen,
    ious,
    candidates,
    lowResPath,
    width: W,
    height: H,
    coverage: candidates[chosen].coverage
  }
}

// ── PRIMITIVAS REUSABLES (para el "segmentar todo" / Automatic Mask Generator) ──
//
// El AMG (core/amg.ts) corre el DECODER miles de veces (una grilla de puntos), así
// que no puede pasar por `samDecode` (que escribe K PNGs por click). Estas
// primitivas exponen el motor de SAM ya construido y verificado acá, sin UI ni IO:
//  - encodear una imagen a embedding cacheado (reúsa `samEncode`).
//  - cargar ese embedding.
//  - correr UN punto por el decoder en modo LOW-RES (orig_im_size = 256) y devolver
//    los LOGITS crudos a 256×256 + los IoU, SIN upscale ni PNG. El AMG filtra,
//    deduplica (NMS) y SOLO al final upscalea las máscaras que sobreviven.
//
// Por qué low-res: el decoder MobileSAM upscalea `masks` a orig_im_size adentro del
// grafo; pedírselo a tamaño original (p.ej. 1520²) por cada uno de miles de puntos
// es inviable en CPU/RAM. Con orig_im_size = [256,256] `masks` vuelve a 256×256
// (≈21 ms/decode medido), idéntico criterio que el AMG oficial de Meta.

/** Lado de trabajo del AMG: el decoder devuelve `masks` a esta resolución. */
export const AMG_RES = LOW_RES

/** Carga (perezosa) el runtime ONNX; reúsa el loader cacheado del módulo. */
export function loadSamOrt(): Promise<typeof import('onnxruntime-node')> {
  return loadOrt()
}

/** Lee la meta del embedding (origW/H, decoder, dims) sin tocar el cuerpo de datos. */
export type { SamEmbeddingMeta as SamMeta }

/** Resultado crudo de un decode de un punto a 256×256 (sin upscale ni PNG). */
export interface SamPointMasks {
  /** K máscaras en LOGITS, contiguas (cada una AMG_RES×AMG_RES). */
  logits: Float32Array
  /** IoU predicho por SAM para cada una de las K. */
  ious: Float32Array
  /** Cantidad de máscaras (K = 4 en MobileSAM: 1 single + 3 multimask). */
  K: number
  /** Lado de las máscaras (= AMG_RES). */
  size: number
}

/**
 * Sesión + meta + datos de un embedding listos para decodear muchos puntos en
 * batch. La familia decide qué decoder corre. Construido una vez por (imagen|crop).
 */
export interface SamDecodeSession {
  ort: typeof import('onnxruntime-node')
  session: Ort.InferenceSession
  meta: SamEmbeddingMeta
  data: Float32Array
  pos?: Float32Array
  family: SamDecoderFamily
}

/**
 * Abre una sesión de decode sobre un embedding ya en disco. Carga el embedding,
 * resuelve la familia del decoder y crea (o reúsa) la sesión ONNX correspondiente.
 * Pensado para que el AMG decodee N puntos sin recargar nada por punto.
 */
export async function openDecodeSession(embeddingPath: string): Promise<SamDecodeSession> {
  const ort = await loadOrt()
  const { meta, data, pos } = await loadEmbedding(embeddingPath)
  const family: SamDecoderFamily = meta.decoder ?? 'mobilesam'
  const decoderId = family === 'sam-vitb' ? VITB_DECODER_ID : DECODER_ID
  const session = await getSession(decoderId, ort)
  return { ort, session, meta, data, pos, family }
}

/**
 * Carga el embedding del crop UNA vez (meta/data/pos read-only, se comparten entre
 * workers sin riesgo) y devuelve un "pool" de N SamDecodeSession para el AMG: cada
 * una con su PROPIA InferenceSession dedicada (intraOp bajo) pero apuntando al MISMO
 * embedding en memoria. El AMG asigna una sesión por worker y decodea la grilla en
 * paralelo. No toca la sesión compartida del modo prompt.
 *
 * `n` = concurrencia (cantidad de sesiones/workers). El embedding (≈8MB) NO se
 * duplica: las N sesiones referencian el mismo `data`/`pos`.
 */
export async function openDecodeSessionPool(
  embeddingPath: string,
  n: number
): Promise<SamDecodeSession[]> {
  const ort = await loadOrt()
  const { meta, data, pos } = await loadEmbedding(embeddingPath)
  const family: SamDecoderFamily = meta.decoder ?? 'mobilesam'
  const decoderId = family === 'sam-vitb' ? VITB_DECODER_ID : DECODER_ID
  const count = Math.max(1, Math.floor(n))
  // Creá las sesiones en paralelo (cada `create` es independiente).
  const built = await Promise.all(
    Array.from({ length: count }, () => createAmgDecodeSession(decoderId, ort))
  )
  console.error(
    `[amg] pool de decode: ${count} sesión(es) ${decoderId} · intraOp=${amgDecodeIntraOp()} · UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? '(default)'}`
  )
  return built.map((session) => ({ ort, session, meta, data, pos, family }))
}

/**
 * Decodea UN punto (label 1, foreground) en px de la imagen ORIGINAL del embedding
 * y devuelve las K máscaras en LOGITS a 256×256 + sus IoU. No escribe nada. Es el
 * ladrillo del AMG: se llama una vez por cada punto de la grilla.
 *
 * MobileSAM: pide `masks` a orig_im_size=[256,256] (vuelve a 256 directo).
 * SAM ViT-B: el decoder ya devuelve pred_masks 256×256 (se toman crudas).
 */
export async function decodePointLowRes(
  s: SamDecodeSession,
  x: number,
  y: number
): Promise<SamPointMasks> {
  const { ort, session, meta, data, pos, family } = s
  const samSize = meta.samSize || SAM_SIZE
  const scale = samSize / Math.max(meta.origW, meta.origH)
  const dims = meta.dims && meta.dims.length === 4 ? meta.dims : [1, 256, 64, 64]

  if (family === 'sam-vitb') {
    if (!pos || !meta.posDims) {
      throw new SidecarError('E_EMBEDDING', 'Embedding ViT-B sin positional (re-encodeá con --model sam-vitb).')
    }
    const feeds: Record<string, Ort.Tensor> = {
      input_points: new ort.Tensor('float32', Float32Array.from([x * scale, y * scale]), [1, 1, 1, 2]),
      input_labels: new ort.Tensor('int64', BigInt64Array.from([1n]), [1, 1, 1]),
      image_embeddings: new ort.Tensor('float32', data, dims),
      image_positional_embeddings: new ort.Tensor('float32', pos, meta.posDims)
    }
    const out = await session.run(feeds)
    const pred = out.pred_masks as Ort.Tensor
    const iouT = out.iou_scores as Ort.Tensor
    const pdims = pred.dims as number[]
    const K = pdims[pdims.length - 3]
    const mh = pdims[pdims.length - 2]
    const mw = pdims[pdims.length - 1]
    // pred_masks ya son 256×256 logits; si por export difiriera, AMG_RES manda.
    if (mh !== AMG_RES || mw !== AMG_RES) {
      throw new SidecarError('E_DECODE', `ViT-B pred_masks ${mw}x${mh} != ${AMG_RES} (firma inesperada).`)
    }
    return { logits: pred.data as Float32Array, ious: iouT.data as Float32Array, K, size: AMG_RES }
  }

  // MobileSAM: 1 punto + padding [0,0] label -1, masks pedidas a 256×256.
  const coords = Float32Array.from([x * scale, y * scale, 0, 0])
  const labels = Float32Array.from([1, -1])
  const feeds: Record<string, Ort.Tensor> = {
    image_embeddings: new ort.Tensor('float32', data, dims),
    point_coords: new ort.Tensor('float32', coords, [1, 2, 2]),
    point_labels: new ort.Tensor('float32', labels, [1, 2]),
    mask_input: new ort.Tensor('float32', new Float32Array(AMG_RES * AMG_RES), [1, 1, AMG_RES, AMG_RES]),
    has_mask_input: new ort.Tensor('float32', Float32Array.from([0]), [1]),
    orig_im_size: new ort.Tensor('float32', Float32Array.from([AMG_RES, AMG_RES]), [2])
  }
  const out = await session.run(feeds)
  const masks = out.masks as Ort.Tensor
  const iouT = out.iou_predictions as Ort.Tensor
  return {
    logits: masks.data as Float32Array,
    ious: iouT.data as Float32Array,
    K: masks.dims[1] as number,
    size: masks.dims[2] as number
  }
}
