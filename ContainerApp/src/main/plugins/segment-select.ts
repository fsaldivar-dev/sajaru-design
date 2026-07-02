import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { type IpcMain, type WebContents } from 'electron'
import type {
  SamBoxInput,
  SamDecodeResult,
  SamEncodeResult,
  SamEncoderModel,
  SamEverythingMask,
  SamEverythingResult,
  SamPointInput
} from '@shared/types'
import { runSidecar, tmpRoot } from './sidecar'

/**
 * Adapter del plugin "segment-select" (MobileSAM): spawnea los comandos
 * `sam-encode` / `sam-decode` del sidecar CLI (vía el helper compartido
 * `sidecar.ts`), parsea su NDJSON y reenvía el progreso al renderer. El main de
 * Electron nunca corre onnx: solo orquesta el proceso hijo y mueve archivos temp.
 *
 * Flujo desde la mini app:
 *  1. `sam:encode` (1 vez por imagen): bytes de la imagen FUENTE → temp PNG →
 *     `sam-encode` → embedding .bin (incluye origW/origH en su header) → devuelve
 *     { embeddingPath, origW, origH }. Caro: el renderer cachea esto por imagen.
 *  2. `sam:decode` (1 por click/box): { embeddingPath, points (px ORIGINALES), box }
 *     → `sam-decode` → mask.png (1 canal, tamaño ORIGINAL) → devuelve sus bytes.
 *
 * El contrato del sidecar NO se toca: este adapter solo traduce IPC ↔ CLI.
 */

const PROGRESS_CHANNEL = 'sam:progress'
// "Analizar todo" (sam-everything) tarda ~50s: progreso por un canal propio para no
// pisar el spinner del encode/decode interactivo.
const EVERYTHING_PROGRESS_CHANNEL = 'sam:everythingProgress'
const TMP = 'sajaru-sam'

/** Carpeta temp del plugin; embeddings por imagen + máscaras por click viven acá. */
function dir(): string {
  return tmpRoot(TMP)
}

/** Contador de máscaras: cada decode escribe a un PNG nuevo (no pisa al anterior). */
let maskCounter = 0

/** Modelo de encoder válido (default mobilesam). Evita inyectar flags arbitrarios. */
function normalizeModel(model?: string): SamEncoderModel {
  return model === 'sam-vitb' ? 'sam-vitb' : 'mobilesam'
}

/**
 * Encodea la imagen FUENTE con el encoder elegido (`mobilesam` rápido / `sam-vitb`
 * preciso). Hashea los bytes + el modelo para cachear el embedding por (imagen,modelo):
 * si ya se encodeó esa imagen con ese encoder, reusa el .bin (no re-corre el encoder,
 * que es caro), y cambiar de precisión y volver atrás vuelve a pegar en cache. El
 * sidecar escribe origW/origH en el header del embedding y los devuelve en el
 * `result`, así el renderer sabe el espacio de coords del prompt.
 */
async function encode(
  bytes: ArrayBuffer,
  name: string,
  sender: WebContents,
  model?: string
): Promise<SamEncodeResult> {
  await fs.mkdir(dir(), { recursive: true })
  const buf = Buffer.from(bytes)
  const enc = normalizeModel(model)
  const hash = createHash('sha1').update(buf).digest('hex').slice(0, 16)
  const ext = path.extname(name) || '.png'
  const imgPath = path.join(dir(), `src-${hash}${ext}`)
  // El .bin lleva el modelo en el nombre → embeddings de distintos encoders coexisten.
  const embPath = path.join(dir(), `emb-${hash}-${enc}.bin`)

  // Cache hit: el embedding de esta imagen+modelo ya existe → leé sus dims y reusalo.
  try {
    await fs.access(embPath)
    const meta = await readEmbeddingMeta(embPath)
    if (meta) {
      sender.send(PROGRESS_CHANNEL, { type: 'progress', stage: 'sam-encode', progress: 1, message: 'Selección IA lista' })
      return { ok: true, embeddingPath: embPath, origW: meta.origW, origH: meta.origH }
    }
  } catch {
    /* no cache: encode abajo */
  }

  await fs.writeFile(imgPath, buf)
  const r = await runSidecar(
    ['sam-encode', '--events', '-i', imgPath, '-o', embPath, '--model', enc],
    sender,
    PROGRESS_CHANNEL
  )
  if (!r.ok) return { ok: false, error: r.error }
  const origW = Number(r.data?.origW)
  const origH = Number(r.data?.origH)
  const outPath = typeof r.data?.outPath === 'string' ? r.data.outPath : embPath
  if (!origW || !origH) {
    return { ok: false, error: { code: 'E_ENCODE', message: 'El encoder no devolvió dimensiones' } }
  }
  return { ok: true, embeddingPath: outPath, origW, origH }
}

/** Lee origW/origH del header JSON del embedding (mismo formato que el sidecar). */
async function readEmbeddingMeta(p: string): Promise<{ origW: number; origH: number } | null> {
  try {
    // El header es: magic 'SAMEMB1\n' (8 bytes) + uint32 LE len + JSON. Leemos un
    // prefijo chico (suficiente para el header) sin cargar el embedding entero.
    const fh = await fs.open(p, 'r')
    try {
      const head = Buffer.alloc(1024)
      const { bytesRead } = await fh.read(head, 0, head.length, 0)
      const magicLen = 'SAMEMB1\n'.length
      if (bytesRead < magicLen + 4) return null
      if (head.subarray(0, magicLen).toString('utf8') !== 'SAMEMB1\n') return null
      const headerLen = head.readUInt32LE(magicLen)
      const jsonStart = magicLen + 4
      if (jsonStart + headerLen > bytesRead) return null
      const meta = JSON.parse(head.subarray(jsonStart, jsonStart + headerLen).toString('utf8'))
      const origW = Number(meta.origW)
      const origH = Number(meta.origH)
      if (!origW || !origH) return null
      return { origW, origH }
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

/** Serializa un punto a `x,y,label` (px ORIGINALES; label 1=fg, 0=bg). */
function pointArg(p: SamPointInput): string {
  const label = p.label === undefined ? 1 : p.label
  return `${Math.round(p.x)},${Math.round(p.y)},${label}`
}

/** Lee un PNG temp a ArrayBuffer y lo borra (best-effort). null si no se pudo leer. */
async function readPngBytes(p: string): Promise<ArrayBuffer | null> {
  try {
    const buf = await fs.readFile(p)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    void fs.unlink(p).catch(() => {})
    return ab
  } catch {
    return null
  }
}

/** Forma del `result` del sidecar `sam-decode` (espejo de SamCandidate/SamDecodeResult). */
interface DecodeData {
  outMaskPath?: string
  width?: number
  height?: number
  iou?: number
  coverage?: number
  chosen?: number
  lowResPath?: string
  candidates?: Array<{ maskPath?: string; iou?: number; coverage?: number }>
}

/**
 * Decodifica un prompt (puntos/box) contra un embedding cacheado → K PNGs de
 * máscara candidatos (tamaño ORIGINAL) + el low-res (256x256) de la elegida. Lee
 * las candidatas a bytes (y borra sus PNG temp) pero CONSERVA el low-res en disco:
 * devuelve su ruta para que el renderer la realimente (`maskInputPath`) en el
 * próximo decode (refinamiento iterativo). Las coords vienen en px ORIGINALES.
 */
async function decode(
  input: {
    embeddingPath: string
    points?: SamPointInput[]
    box?: SamBoxInput
    maskInputPath?: string
    hasMaskInput?: boolean
    maskIndex?: number
  },
  sender: WebContents
): Promise<SamDecodeResult> {
  if (!input.embeddingPath) {
    return { ok: false, error: { code: 'E_NO_EMBEDDING', message: 'Falta el embedding (encodeá primero)' } }
  }
  if ((!input.points || input.points.length === 0) && !input.box) {
    return { ok: false, error: { code: 'E_ARG', message: 'Falta el prompt: un punto o un box' } }
  }

  const maskPath = path.join(dir(), `mask-${++maskCounter}.png`)
  const args = ['sam-decode', '--events', '-e', input.embeddingPath, '-o', maskPath]
  for (const p of input.points ?? []) args.push('--point', pointArg(p))
  if (input.box) {
    const [x0, y0, x1, y1] = input.box
    args.push('--box', `${Math.round(x0)},${Math.round(y0)},${Math.round(x1)},${Math.round(y1)}`)
  }
  // Refinamiento iterativo: realimentar el low-res del decode previo + los puntos nuevos.
  if (input.hasMaskInput && input.maskInputPath) {
    args.push('--mask-input', input.maskInputPath, '--has-mask-input')
  }
  // Ciclar formas: forzar cuál de las K candidatas es la elegida.
  if (typeof input.maskIndex === 'number') args.push('--mask-index', String(input.maskIndex))

  const r = await runSidecar(args, sender, PROGRESS_CHANNEL)
  if (!r.ok) return { ok: false, error: r.error }
  try {
    const d = (r.data ?? {}) as DecodeData
    // Leé cada candidata a bytes (y borrá su PNG temp). Conservá el orden.
    const candidates: SamDecodeResult['candidates'] = []
    let chosenBytes: ArrayBuffer | undefined
    const chosenIdx = typeof d.chosen === 'number' ? d.chosen : 0
    const list = Array.isArray(d.candidates) ? d.candidates : []
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      if (!c.maskPath) continue
      const bytes = await readPngBytes(c.maskPath)
      if (!bytes) continue
      candidates.push({ bytes, iou: Number(c.iou) || 0, coverage: Number(c.coverage) || 0 })
      if (i === chosenIdx) chosenBytes = bytes
    }
    // Fallback (sidecar viejo / sin candidatas): leé el outMaskPath directo.
    if (!chosenBytes) {
      const outPath = typeof d.outMaskPath === 'string' ? d.outMaskPath : maskPath
      const bytes = await readPngBytes(outPath)
      if (!bytes) return { ok: false, error: { code: 'E_READ', message: 'No se pudo leer la máscara' } }
      chosenBytes = bytes
    }
    return {
      ok: true,
      bytes: chosenBytes,
      width: Number(d.width) || undefined,
      height: Number(d.height) || undefined,
      iou: typeof d.iou === 'number' ? d.iou : undefined,
      coverage: typeof d.coverage === 'number' ? d.coverage : undefined,
      chosen: chosenIdx,
      candidates: candidates.length > 0 ? candidates : undefined,
      // Low-res: NO se borra acá; el renderer lo reenvía como maskInputPath al refinar.
      lowResPath: typeof d.lowResPath === 'string' ? d.lowResPath : undefined
    }
  } catch (e) {
    return { ok: false, error: { code: 'E_READ', message: (e as Error).message } }
  }
}

/** Forma del `result` del sidecar `sam-everything` (lo que nos hace falta acá). */
interface EverythingData {
  outDir?: string
  imageWidth?: number
  imageHeight?: number
  labelMapPath?: string
  summaryPath?: string
  count?: number
  masks?: Array<{ index?: number; area?: number; bbox?: [number, number, number, number] }>
}

/** Modelo válido para "Analizar todo": default sam-vitb (config verificada que aísla finos). */
function normalizeEverythingModel(model?: string): SamEncoderModel {
  return model === 'mobilesam' ? 'mobilesam' : 'sam-vitb'
}

/**
 * "Analizar todo" (sam-everything): guarda la imagen FUENTE a un dir temp único,
 * spawnea `sam-everything` (default sam-vitb/40/crops0: verificado, ~50s, aísla el
 * locker fino), lee el `labelmap.png` (PNG 8-bit: pixel = índice 1-based de su región)
 * + `summary.json` (regiones: index/bbox/area) y los devuelve al renderer. El renderer
 * decodea el labelmap a un typed array para el hover-lookup O(1). Limpia el dir temp.
 *
 * El dir es POR CORRIDA (no cacheado por imagen): la operación es costosa pero puntual
 * y el renderer cachea el resultado en memoria por imagen, así que acá borramos el dir
 * al terminar para no acumular máscaras (puede haber cientos de PNGs por corrida).
 */
async function everything(
  bytes: ArrayBuffer,
  name: string,
  sender: WebContents,
  model?: string
): Promise<SamEverythingResult> {
  const enc = normalizeEverythingModel(model)
  const buf = Buffer.from(bytes)
  const hash = createHash('sha1').update(buf).digest('hex').slice(0, 16)
  const ext = path.extname(name) || '.png'
  // Dir único por corrida (hash + timestamp): el sidecar escribe acá mask-NNN.png,
  // labelmap.png/.json y summary.json. Se borra al terminar.
  const outDir = path.join(dir(), `everything-${hash}-${Date.now()}`)
  const imgPath = path.join(outDir, `src${ext}`)

  try {
    await fs.mkdir(outDir, { recursive: true })
    await fs.writeFile(imgPath, buf)

    // Config verificada: sam-vitb + grilla 40 + sin crops extra (~50s, aísla finos).
    const r = await runSidecar(
      ['sam-everything', '--events', '-i', imgPath, '-o', outDir, '--model', enc, '--points', '40', '--crops', '0'],
      sender,
      EVERYTHING_PROGRESS_CHANNEL
    )
    if (!r.ok) return { ok: false, error: r.error }

    const d = (r.data ?? {}) as EverythingData
    const labelMapPath = typeof d.labelMapPath === 'string' ? d.labelMapPath : path.join(outDir, 'labelmap.png')
    const width = Number(d.imageWidth) || 0
    const height = Number(d.imageHeight) || 0
    if (!width || !height) {
      return { ok: false, error: { code: 'E_EVERYTHING', message: 'sam-everything no devolvió dimensiones' } }
    }

    // Leé el PNG del labelmap a bytes (el renderer lo decodea a un índice por pixel).
    let labelMapBytes: ArrayBuffer
    try {
      const lb = await fs.readFile(labelMapPath)
      labelMapBytes = lb.buffer.slice(lb.byteOffset, lb.byteOffset + lb.byteLength)
    } catch {
      return { ok: false, error: { code: 'E_READ', message: 'No se pudo leer labelmap.png' } }
    }

    // Regiones: del `result` si vino, si no del summary.json (fuente de verdad del CLI).
    let masks: SamEverythingMask[] = []
    const fromResult = Array.isArray(d.masks) ? d.masks : null
    if (fromResult && fromResult.length > 0) {
      masks = fromResult.map((m, i) => ({
        index: Number(m.index ?? i),
        area: Number(m.area) || 0,
        bbox: (m.bbox ?? [0, 0, 0, 0]) as [number, number, number, number]
      }))
    } else {
      try {
        const summaryRaw = await fs.readFile(path.join(outDir, 'summary.json'), 'utf8')
        const summary = JSON.parse(summaryRaw) as {
          masks?: Array<{ index?: number; area?: number; bbox?: [number, number, number, number] }>
        }
        masks = (summary.masks ?? []).map((m, i) => ({
          index: Number(m.index ?? i),
          area: Number(m.area) || 0,
          bbox: (m.bbox ?? [0, 0, 0, 0]) as [number, number, number, number]
        }))
      } catch {
        masks = []
      }
    }

    return { ok: true, labelMapBytes, width, height, masks }
  } catch (e) {
    return { ok: false, error: { code: 'E_EVERYTHING', message: (e as Error).message } }
  } finally {
    // Limpiá el dir de la corrida (cientos de PNGs posibles); best-effort.
    void fs.rm(outDir, { recursive: true, force: true }).catch(() => {})
  }
}

export function registerSegmentSelectIpc(ipcMain: IpcMain): void {
  ipcMain.handle('sam:encode', (e, bytes: ArrayBuffer, name: string, model?: SamEncoderModel) =>
    encode(bytes, name, e.sender, model)
  )
  ipcMain.handle('sam:everything', (e, bytes: ArrayBuffer, name: string, model?: SamEncoderModel) =>
    everything(bytes, name, e.sender, model)
  )
  ipcMain.handle(
    'sam:decode',
    (
      e,
      input: {
        embeddingPath: string
        points?: SamPointInput[]
        box?: SamBoxInput
        maskInputPath?: string
        hasMaskInput?: boolean
        maskIndex?: number
      }
    ) => decode(input, e.sender)
  )
}
