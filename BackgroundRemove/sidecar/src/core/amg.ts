import sharp from 'sharp'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { Ctx } from './context'
import { SidecarError } from './errors'
import { fileExists, writeOutput } from './image'
import { samEncode, type SamEncoderModel } from './sam'
import { AMG_RES, type SamPointMasks } from './sam'

/**
 * "Segmentar todo" — Automatic Mask Generator (AMG) sobre SAM/MobileSAM.
 *
 * Replica la lógica de `SamAutomaticMaskGenerator` de Meta
 * (github.com/facebookresearch/segment-anything, Apache-2.0) en TypeScript, sin
 * portar pesos: reúsa el ENCODER y el DECODER ya verificados en core/sam.ts.
 *
 * Idea (la "Selección de objeto" de Affinity): en vez de un click que elige el
 * objeto DOMINANTE, se particiona TODA la imagen en sus regiones y el usuario
 * elige después. Para eso:
 *   1. Encodeá la imagen una vez (caro). [+ por cada crop si cropLayers≥1]
 *   2. Tirá una grilla regular de pointsPerSide² puntos sobre la imagen.
 *   3. Por cada punto, decodeá (point prompt, label 1) → K máscaras + IoU; calculá
 *      el stability_score (umbral del logit a ±delta y ratio de áreas).
 *   4. Filtrá por pred_iou_thresh y stability_score_thresh; descartá máscaras
 *      diminutas (min_mask_region_area) sin matar finos.
 *   5. NMS por IoU para deduplicar solapadas (quedate con la de mejor score),
 *      tuneado para PRESERVAR máscaras chicas/finas (no dejar que el cuerpo grande
 *      se trague la franja).
 *   6. Emitís cada máscara como PNG + un label map (índice de la máscara top por
 *      pixel) + un summary.json.
 *
 * TODO el grueso del trabajo (grilla, scoring, NMS) corre a AMG_RES (256×256) — el
 * decoder devuelve `masks` ya a esa resolución — y SOLO las máscaras que sobreviven
 * se upscalean al tamaño original. Es lo que hace viable miles de decodes en CPU.
 */

/** Parámetros del AMG. Defaults alineados con el generador oficial de Meta. */
export interface AmgParams {
  imagePath: string
  outDir: string
  /** Lado de la grilla de puntos (NxN). Más = más regiones, más lento. Default 48. */
  pointsPerSide: number
  /** Encoder/decoder: 'mobilesam' (rápido) | 'sam-vitb' (preciso). Default mobilesam. */
  model: SamEncoderModel
  /** Capas de crop extra (0 = solo imagen completa; 1 = + grilla sobre 2x2 crops). */
  cropLayers: number
  /** Umbral de IoU predicho por SAM para quedarse con una máscara. Default 0.86. */
  predIouThresh: number
  /** Umbral de stability_score. Default 0.92. */
  stabilityScoreThresh: number
  /** Delta (en logits) para el stability_score. Default 1.0. */
  stabilityScoreOffset: number
  /** IoU de NMS: dos máscaras con IoU mayor a esto se consideran duplicadas. Default 0.7. */
  boxNmsThresh: number
  /** Área mínima de máscara como FRACCIÓN del total (descarta diminutas). Default 0.0005. */
  minMaskRegionArea: number
  /** Tope de máscaras emitidas (las de mejor score). Default 256. */
  maxMasks: number
}

/** Defaults del AMG (Meta usa 0.88/0.95; acá un pelín laxos para no matar finos). */
export const AMG_DEFAULTS: Omit<AmgParams, 'imagePath' | 'outDir'> = {
  pointsPerSide: 48,
  model: 'mobilesam',
  cropLayers: 1,
  predIouThresh: 0.86,
  stabilityScoreThresh: 0.92,
  stabilityScoreOffset: 1.0,
  boxNmsThresh: 0.7,
  minMaskRegionArea: 0.0005,
  maxMasks: 256
}

/** Una máscara aceptada, ya a tamaño ORIGINAL, con su métrica y geometría. */
export interface AmgMask {
  /** Índice estable (orden de emisión). */
  index: number
  /** Ruta del PNG 1-bit (gris 0/255) de esta máscara, tamaño original. */
  maskPath: string
  /** Área en píxeles (a tamaño original). */
  area: number
  /** Fracción del total. */
  coverage: number
  /** Bounding box en px originales [x0,y0,x1,y1] (inclusivo). */
  bbox: [number, number, number, number]
  /** IoU predicho por SAM. */
  predIou: number
  /** Stability score calculado. */
  stabilityScore: number
  /** Score de ranking (predIou·stabilityScore) usado por el NMS. */
  score: number
  /** Punto de la grilla (px originales) que generó la máscara. */
  point: [number, number]
}

export interface AmgResult {
  outDir: string
  imageWidth: number
  imageHeight: number
  model: SamEncoderModel
  pointsPerSide: number
  cropLayers: number
  /** Cantidad de máscaras finales. */
  count: number
  /** PNG (gris) HxW donde cada pixel = índice+1 de su máscara top (0 = sin máscara). */
  labelMapPath: string
  /** JSON con el label map crudo (por si el consumidor prefiere índices directos). */
  summaryPath: string
  masks: AmgMask[]
  /** Tiempos en ms (encode total + grilla/decode + post). */
  timings: { encodeMs: number; gridMs: number; postMs: number; totalMs: number }
}

/** Máscara intermedia a AMG_RES: bitmap binario + métricas, antes de upscalear. */
export interface RawMask {
  /** Bitmap 0/1 a AMG_RES×AMG_RES. */
  bits: Uint8Array
  area: number
  bbox: [number, number, number, number]
  predIou: number
  stabilityScore: number
  score: number
  /** Punto generador en px ORIGINALES (ya destrasladado del crop). */
  point: [number, number]
}

/**
 * Stability score (def. de Meta): IoU entre la máscara umbralada a un logit ALTO
 * (mask_threshold + offset) y a uno BAJO (mask_threshold - offset). mask_threshold
 * es 0 (los logits del decoder). Una máscara "estable" casi no cambia de área al
 * mover el umbral → ratio ~1. Se calcula sobre los logits crudos a AMG_RES.
 */
function stabilityScore(logits: Float32Array, off: number, hi: number, lo: number): number {
  let inter = 0
  let union = 0
  for (let i = off; i < off + AMG_RES * AMG_RES; i++) {
    const v = logits[i]
    const aHi = v > hi // área a umbral alto (subconjunto)
    const aLo = v > lo // área a umbral bajo (superconjunto)
    if (aLo) union++
    if (aHi) inter++ // aHi ⊆ aLo ⇒ intersección = área alta
  }
  return union === 0 ? 0 : inter / union
}

/** Umbraliza un logit map (offset dentro de `logits`) a un bitmap 0/1 + área + bbox. */
function thresholdToBits(
  logits: Float32Array,
  off: number
): { bits: Uint8Array; area: number; bbox: [number, number, number, number] } {
  const bits = new Uint8Array(AMG_RES * AMG_RES)
  let area = 0
  let x0 = AMG_RES
  let y0 = AMG_RES
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < AMG_RES; y++) {
    for (let x = 0; x < AMG_RES; x++) {
      const i = y * AMG_RES + x
      if (logits[off + i] > 0) {
        bits[i] = 1
        area++
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
      }
    }
  }
  return { bits, area, bbox: [x0, y0, x1, y1] }
}

/** IoU de dos bitmaps 0/1 del mismo tamaño (AMG_RES²). */
function maskIou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0
  let union = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i]
    const bv = b[i]
    if (av | bv) union++
    if (av & bv) inter++
  }
  return union === 0 ? 0 : inter / union
}

/** ¿Los bbox (en AMG_RES) se solapan? Pre-filtro barato antes del IoU pixel a pixel. */
function bboxOverlap(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1])
}

/**
 * NMS por IoU de MÁSCARA (no de caja: una caja grande del cuerpo se solaparía con
 * la franja fina aunque sean regiones distintas; el IoU de máscara real no). Ordena
 * por score desc y descarta toda máscara cuyo IoU con una ya aceptada supere el
 * umbral. Conserva la de mejor score ⇒ preserva finos si no están CONTENIDOS en
 * otra (el IoU de la franja con el cuerpo es bajo aunque sus cajas se toquen).
 */
function nms(masks: RawMask[], iouThresh: number): RawMask[] {
  const order = masks.map((_, i) => i).sort((a, b) => masks[b].score - masks[a].score)
  const kept: number[] = []
  const dead = new Uint8Array(masks.length)
  for (const i of order) {
    if (dead[i]) continue
    kept.push(i)
    for (const j of order) {
      if (j === i || dead[j]) continue
      if (!bboxOverlap(masks[i].bbox, masks[j].bbox)) continue
      if (maskIou(masks[i].bits, masks[j].bits) > iouThresh) dead[j] = 1
    }
  }
  return kept.map((i) => masks[i])
}

/**
 * Evaluador de UN punto ya decodeado para un crop dado: aplica los filtros
 * (predIou / stability / área), elige la mejor candidata multimask y destraslada
 * bbox/punto a px ORIGINALES. Es una función PURA (sin estado compartido) — la usan
 * IDÉNTICA tanto el camino in-proceso como los worker_threads, así la calidad no
 * puede divergir entre ambos. Devuelve la RawMask ganadora del punto o null.
 *
 * El decoder devuelve K=4: el índice 0 es la "single mask" (suele tragarse finos);
 * Meta usa multimask_output=True y se queda con las 3 multimask. Saltamos el 0 cuando
 * hay 4 (si sólo hubiera 1, la usamos).
 */
export function createCropEvaluator(
  crop: [number, number, number, number],
  p: Pick<AmgParams, 'predIouThresh' | 'stabilityScoreThresh' | 'stabilityScoreOffset' | 'minMaskRegionArea'>
): (res: SamPointMasks, px: number, py: number) => RawMask | null {
  const [cx0, cy0, cx1, cy1] = crop
  const cropW = cx1 - cx0
  const cropH = cy1 - cy0
  const sx = cropW / AMG_RES
  const sy = cropH / AMG_RES
  const minArea = p.minMaskRegionArea * (AMG_RES * AMG_RES)
  const hi = p.stabilityScoreOffset
  const lo = -p.stabilityScoreOffset
  return (res: SamPointMasks, px: number, py: number): RawMask | null => {
    let best: RawMask | null = null
    const mStart = res.K >= 4 ? 1 : 0
    for (let m = mStart; m < res.K; m++) {
      const iou = res.ious[m]
      if (iou < p.predIouThresh) continue
      const off = m * AMG_RES * AMG_RES
      const stab = stabilityScore(res.logits, off, hi, lo)
      if (stab < p.stabilityScoreThresh) continue
      const { bits, area, bbox } = thresholdToBits(res.logits, off)
      if (area < minArea) continue
      const score = iou * stab
      if (!best || score > best.score) {
        const obx: [number, number, number, number] = [
          Math.round(cx0 + bbox[0] * sx),
          Math.round(cy0 + bbox[1] * sy),
          Math.round(cx0 + bbox[2] * sx),
          Math.round(cy0 + bbox[3] * sy)
        ]
        best = {
          bits,
          area,
          bbox: obx,
          predIou: iou,
          stabilityScore: stab,
          score,
          point: [Math.round(cx0 + px), Math.round(cy0 + py)]
        }
      }
    }
    return best
  }
}

/** Genera la grilla NxN de puntos (en px ORIGINALES) de un rectángulo [x,y,w,h]. */
export function gridPoints(x: number, y: number, w: number, h: number, n: number): Array<[number, number]> {
  // Centros de celda: (i+0.5)/n, igual que build_point_grid de Meta.
  const pts: Array<[number, number]> = []
  for (let j = 0; j < n; j++) {
    const py = y + ((j + 0.5) / n) * h
    for (let i = 0; i < n; i++) {
      const px = x + ((i + 0.5) / n) * w
      pts.push([px, py])
    }
  }
  return pts
}

/**
 * Rectángulos de crop por capa (en px originales). Capa 0 = imagen completa. Capa 1
 * = 2x2 crops con solape (overlap 1/3 del lado, como el AMG oficial con
 * crop_overlap_ratio≈512/1500). Capta regiones chicas/finas que la grilla global se
 * saltea por densidad insuficiente.
 */
function cropBoxes(W: number, H: number, layers: number): Array<[number, number, number, number]> {
  const boxes: Array<[number, number, number, number]> = [[0, 0, W, H]]
  for (let layer = 1; layer <= layers; layer++) {
    const nPerSide = 2 ** layer
    const overlap = Math.floor((512 / 1500) * Math.min(W, H))
    const cropW = Math.ceil((overlap * (nPerSide - 1) + W) / nPerSide)
    const cropH = Math.ceil((overlap * (nPerSide - 1) + H) / nPerSide)
    for (let yi = 0; yi < nPerSide; yi++) {
      for (let xi = 0; xi < nPerSide; xi++) {
        const x0 = Math.floor((cropW - overlap) * xi)
        const y0 = Math.floor((cropH - overlap) * yi)
        boxes.push([x0, y0, Math.min(W, x0 + cropW), Math.min(H, y0 + cropH)])
      }
    }
  }
  return boxes
}

/** Carpeta temporal del sidecar para embeddings/crops del AMG. */
function tmpBase(): string {
  return path.join(os.tmpdir(), 'sajaru-amg')
}

/**
 * Concurrencia del decode de la grilla: cuántos puntos se decodean A LA VEZ. Cada
 * worker corre `session.run` (que onnxruntime ejecuta en el threadpool de libuv),
 * así que el techo real es min(concurrency, UV_THREADPOOL_SIZE). El óptimo suele ser
 * ≈ cores físicos con intraOp=1 por sesión (cada decode usa 1 core → N decodes llenan
 * los N cores sin sobre-suscribir). Tuneable por env (`SAJARU_AMG_CONCURRENCY`) para
 * iterar sin recompilar. Default = cores físicos (os.cpus().length).
 */
function amgConcurrency(): number {
  const raw = Number(process.env.SAJARU_AMG_CONCURRENCY)
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw)
  return Math.max(1, os.cpus().length)
}

/**
 * Resuelve el archivo del worker del AMG. En producción es el bundle hermano
 * `core/amg-worker.js` (mismo dir que `dist/index.js`); en dev (tsx, sin bundle) es
 * el fuente `amg-worker.ts` junto a este módulo. `import.meta.url` apunta a este
 * archivo ya resuelto (dist/index.js bundleado, o src/core/amg.ts en dev).
 */
function workerEntry(): string {
  const here = fileURLToPath(import.meta.url)
  const dir = path.dirname(here)
  // Bundle: amg.ts queda dentro de dist/index.js ⇒ dir = dist/ ⇒ worker en dist/core/.
  const bundled = path.join(dir, 'core', 'amg-worker.js')
  if (existsSync(bundled)) return bundled
  // Dev (tsx): este módulo es src/core/amg.ts ⇒ worker hermano .ts.
  const devTs = path.join(dir, 'amg-worker.ts')
  if (existsSync(devTs)) return devTs
  // Fallback: hermano .js (por si el layout de bundle cambia y queda junto a amg.ts).
  return path.join(dir, 'amg-worker.js')
}

/** RawMask tal como llega de un worker: `bits` viaja como ArrayBuffer transferible. */
interface RawMaskFromWorker {
  bits: ArrayBuffer
  area: number
  bbox: [number, number, number, number]
  predIou: number
  stabilityScore: number
  score: number
  point: [number, number]
}

/**
 * Procesa UN crop: tira la grilla de puntos y la decodea EN PARALELO repartiéndola
 * entre N worker_threads (cada uno con su propia InferenceSession), juntando las
 * RawMask aceptadas (filtros de IoU/stability/área) ya destrasladadas a px ORIGINALES.
 *
 * Por qué worker_threads y no `Promise.all` en un hilo: `onnxruntime-node` corre
 * `session.run` SINCRÓNICO (bloquea el event loop, no usa el threadpool de libuv;
 * verificado). La única paralelización real del decode en CPU es por hilos OS. El
 * trabajo de filtrado (createCropEvaluator) lo hace cada worker con la MISMA función
 * pura que existía antes ⇒ calidad idéntica; sólo cambia el ORDEN de `out` (irrelevante:
 * el NMS ordena por score y el labelmap por área).
 */
async function processCrop(
  embPath: string,
  crop: [number, number, number, number],
  pointsPerSide: number,
  p: AmgParams,
  ctx: Ctx,
  baseProgress: number,
  spanProgress: number,
  onCount: () => number
): Promise<RawMask[]> {
  const [cx0, cy0, cx1, cy1] = crop
  const cropW = cx1 - cx0
  const cropH = cy1 - cy0

  // Grilla en coords del CROP (0..cropW/H); el decoder espera px del embedding (=crop).
  const pts = gridPoints(0, 0, cropW, cropH, pointsPerSide)
  const total = pts.length
  if (total === 0) return []

  // N workers ≈ cores físicos (tope: nº de puntos). Cada worker recibe un sub-rango
  // CONTIGUO de la grilla (reparto estático: el costo por punto es parejo).
  const nWorkers = Math.max(1, Math.min(amgConcurrency(), total))
  const params = {
    predIouThresh: p.predIouThresh,
    stabilityScoreThresh: p.stabilityScoreThresh,
    stabilityScoreOffset: p.stabilityScoreOffset,
    minMaskRegionArea: p.minMaskRegionArea
  }
  const entry = workerEntry()
  console.error(
    `[amg] decode paralelo: ${nWorkers} worker_thread(s) · ${total} puntos · intraOp=${process.env.SAJARU_AMG_DECODE_INTRAOP ?? '1'} · UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? '(default)'} · ${path.basename(entry)}`
  )

  const out: RawMask[] = []
  let done = 0 // puntos procesados a través de TODOS los workers (para el progreso)
  const workers: Worker[] = []
  let aborted = false

  // Chequeo de cancelación: si la UI aborta, terminamos los workers y lanzamos.
  const onAbort = (): void => {
    aborted = true
    for (const w of workers) void w.terminate()
  }
  if (ctx.signal.aborted) throw new SidecarError('E_CANCELLED', 'Cancelado')
  ctx.signal.addEventListener('abort', onAbort, { once: true })

  try {
    await new Promise<void>((resolve, reject) => {
      let finished = 0
      const fail = (err: Error): void => {
        for (const w of workers) void w.terminate()
        reject(err)
      }
      for (let wi = 0; wi < nWorkers; wi++) {
        // Rango contiguo [lo,hi) de esta tanda; los puntos se aplanan a Float64Array.
        const lo = Math.floor((wi * total) / nWorkers)
        const hi = Math.floor(((wi + 1) * total) / nWorkers)
        const slice = new Float64Array((hi - lo) * 2)
        for (let i = lo; i < hi; i++) {
          slice[(i - lo) * 2] = pts[i][0]
          slice[(i - lo) * 2 + 1] = pts[i][1]
        }
        const w = new Worker(entry, {
          workerData: { embPath, crop, points: slice, params },
          // Heredá el env (UV_THREADPOOL_SIZE / SAJARU_AMG_DECODE_INTRAOP) al worker.
          env: process.env
        })
        workers.push(w)
        w.on('message', (msg: { type: string; done?: number; masks?: RawMaskFromWorker[]; message?: string }) => {
          if (msg.type === 'tick') {
            // Cada worker reporta SU avance acumulado; aproximamos el global con +32.
            done = Math.min(total, done + 32)
            const frac = done / total
            ctx.progress('sam-everything', baseProgress + spanProgress * frac, `Grilla ${done}/${total} · ${onCount()} máscaras`)
          } else if (msg.type === 'done') {
            for (const m of msg.masks ?? []) {
              out.push({
                bits: new Uint8Array(m.bits),
                area: m.area,
                bbox: m.bbox,
                predIou: m.predIou,
                stabilityScore: m.stabilityScore,
                score: m.score,
                point: m.point
              })
            }
            finished++
            if (finished === nWorkers) resolve()
          } else if (msg.type === 'error') {
            fail(new SidecarError('E_DECODE', `Worker del AMG falló: ${msg.message ?? 'desconocido'}`))
          }
        })
        w.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
        w.on('exit', (code) => {
          if (aborted) return
          if (code !== 0 && finished < nWorkers) fail(new SidecarError('E_DECODE', `Worker del AMG salió con código ${code}`))
        })
      }
    })
  } finally {
    ctx.signal.removeEventListener('abort', onAbort)
    for (const w of workers) void w.terminate()
  }

  if (aborted || ctx.signal.aborted) throw new SidecarError('E_CANCELLED', 'Cancelado')
  return out
}

/**
 * Re-escala un bitmap binario (AMG_RES²) al tamaño original mapeando primero al
 * rectángulo del crop y luego pegándolo en un lienzo W×H (nearest, conserva 1-bit).
 * Devuelve el alfa 0/255 a tamaño original + área + bbox EXACTOS a esa resolución.
 */
function upscaleMaskToOriginal(
  bits: Uint8Array,
  crop: [number, number, number, number],
  W: number,
  H: number
): { alpha: Buffer; area: number; bbox: [number, number, number, number] } {
  const [cx0, cy0, cx1, cy1] = crop
  const cropW = cx1 - cx0
  const cropH = cy1 - cy0
  const alpha = Buffer.alloc(W * H) // 0 por defecto
  let area = 0
  let x0 = W
  let y0 = H
  let x1 = -1
  let y1 = -1
  for (let y = cy0; y < cy1; y++) {
    const by = Math.min(AMG_RES - 1, Math.floor(((y - cy0) / cropH) * AMG_RES))
    for (let x = cx0; x < cx1; x++) {
      const bx = Math.min(AMG_RES - 1, Math.floor(((x - cx0) / cropW) * AMG_RES))
      if (bits[by * AMG_RES + bx]) {
        alpha[y * W + x] = 255
        area++
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
      }
    }
  }
  return { alpha, area, bbox: [x0, y0, x1, y1] }
}

/**
 * Corre el AMG completo sobre una imagen y escribe el resultado en `outDir`:
 * un PNG por máscara, un `labelmap.png` (gris: índice+1 de la máscara top por
 * pixel) + `labelmap.json` (índices crudos) y `summary.json` (conteo, áreas, bboxes).
 */
export async function samEverything(p: AmgParams, ctx: Ctx): Promise<AmgResult> {
  const tStart = Date.now()
  if (!(await fileExists(p.imagePath))) {
    throw new SidecarError('E_INPUT_NOT_FOUND', `No existe la imagen: ${p.imagePath}`)
  }
  const buf = await fs.readFile(p.imagePath)
  const meta = await sharp(buf).metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  if (!W || !H) throw new SidecarError('E_IMAGE', 'No se pudieron leer las dimensiones de la imagen')

  await fs.mkdir(tmpBase(), { recursive: true })
  await fs.mkdir(p.outDir, { recursive: true })

  const crops = cropBoxes(W, H, Math.max(0, p.cropLayers))
  ctx.progress('sam-everything', 0.02, `Imagen ${W}x${H} · ${crops.length} crop(s) · grilla ${p.pointsPerSide}²`)

  // ── 1) ENCODE (caro): la imagen completa y cada crop. ──
  let encodeMs = 0
  const embPaths: string[] = []
  const encodeStart = Date.now()
  for (let c = 0; c < crops.length; c++) {
    const [x0, y0, x1, y1] = crops[c]
    const stamp = `${Date.now()}-${c}`
    const embPath = path.join(tmpBase(), `emb-${stamp}.bin`)
    if (c === 0) {
      // Crop global = la imagen completa: encodeá el archivo original tal cual.
      await samEncode(p.imagePath, embPath, subProgress(ctx, 0.03, 0.18 / crops.length + 0.03), p.model)
    } else {
      // Crop: extraé a un PNG temporal y encodealo (su origW/H = tamaño del crop).
      const cropPng = path.join(tmpBase(), `crop-${stamp}.png`)
      await sharp(buf, { limitInputPixels: false })
        .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
        .png()
        .toFile(cropPng)
      await samEncode(cropPng, embPath, subProgress(ctx, 0.03 + (0.18 * c) / crops.length, 0.03 + (0.18 * (c + 1)) / crops.length), p.model)
      await fs.rm(cropPng, { force: true })
    }
    embPaths.push(embPath)
  }
  encodeMs = Date.now() - encodeStart

  // ── 2-4) GRILLA + DECODE + FILTROS por crop. ──
  const gridStart = Date.now()
  let raws: RawMask[] = []
  const countRef = () => raws.length
  for (let c = 0; c < crops.length; c++) {
    const base = 0.22 + (0.6 * c) / crops.length
    const span = 0.6 / crops.length
    const cropRaws = await processCrop(embPaths[c], crops[c], p.pointsPerSide, p, ctx, base, span, countRef)
    raws = raws.concat(cropRaws)
  }
  const gridMs = Date.now() - gridStart

  // ── 5) NMS global (preserva finos: IoU de máscara, no de caja). ──
  const postStart = Date.now()
  ctx.progress('sam-everything', 0.84, `NMS sobre ${raws.length} candidatas`)
  let kept = nms(raws, p.boxNmsThresh)
  // Ranking por score; tope maxMasks.
  kept.sort((a, b) => b.score - a.score)
  if (kept.length > p.maxMasks) kept = kept.slice(0, p.maxMasks)

  // ── 6) Upscale de las que sobreviven + PNGs + label map + summary. ──
  ctx.progress('sam-everything', 0.88, `Generando ${kept.length} máscaras a tamaño original`)
  // Label map: por pixel, el índice (1-based) de la máscara de MENOR área que lo
  // cubre (las chicas/finas ganan al cuerpo grande ⇒ clickear la franja la elige).
  const labels = new Int32Array(W * H) // 0 = sin máscara
  const labelArea = new Float64Array(W * H).fill(Number.POSITIVE_INFINITY)

  const masks: AmgMask[] = []
  // Para que el label map favorezca finos, pintá de mayor a menor área (la chica
  // sobrescribe a la grande donde se solapan).
  const byAreaDesc = kept
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.area - a.m.area)

  for (let n = 0; n < kept.length; n++) {
    const rm = kept[n]
    // Encontrá a qué crop pertenece esta máscara por su punto generador.
    const crop = cropForPoint(crops, rm.point)
    const up = upscaleMaskToOriginal(rm.bits, crop, W, H)
    const maskPath = path.join(p.outDir, `mask-${String(n).padStart(3, '0')}.png`)
    const png = await sharp(up.alpha, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer()
    await writeOutput(maskPath, png)
    masks.push({
      index: n,
      maskPath,
      area: up.area,
      coverage: +(up.area / (W * H)).toFixed(5),
      bbox: up.bbox,
      predIou: +rm.predIou.toFixed(4),
      stabilityScore: +rm.stabilityScore.toFixed(4),
      score: +rm.score.toFixed(4),
      point: rm.point
    })
  }

  // Pintá el label map (mayor área primero ⇒ la menor sobrescribe).
  for (const { i } of byAreaDesc) {
    const rm = kept[i]
    const crop = cropForPoint(crops, rm.point)
    const up = upscaleMaskToOriginal(rm.bits, crop, W, H)
    for (let q = 0; q < W * H; q++) {
      if (up.alpha[q] && rm.area < labelArea[q]) {
        labels[q] = i + 1
        labelArea[q] = rm.area
      }
    }
  }

  // Label map como PNG gris de 8-bit (suficiente hasta 255 máscaras; con más, el
  // JSON crudo es la fuente de verdad). 0 = sin máscara.
  const labelGrey = Buffer.alloc(W * H)
  for (let q = 0; q < W * H; q++) labelGrey[q] = Math.min(255, labels[q])
  const labelMapPath = path.join(p.outDir, 'labelmap.png')
  await writeOutput(labelMapPath, await sharp(labelGrey, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer())
  const labelJsonPath = path.join(p.outDir, 'labelmap.json')
  await writeOutput(
    labelJsonPath,
    Buffer.from(JSON.stringify({ width: W, height: H, labels: Array.from(labels) }))
  )

  const summaryPath = path.join(p.outDir, 'summary.json')
  const totalMs = Date.now() - tStart
  const summary = {
    image: p.imagePath,
    imageWidth: W,
    imageHeight: H,
    model: p.model,
    pointsPerSide: p.pointsPerSide,
    cropLayers: p.cropLayers,
    count: masks.length,
    timings: { encodeMs, gridMs, postMs: Date.now() - postStart, totalMs },
    masks: masks.map((m) => ({
      index: m.index,
      area: m.area,
      coverage: m.coverage,
      bbox: m.bbox,
      predIou: m.predIou,
      stabilityScore: m.stabilityScore,
      score: m.score,
      point: m.point,
      file: path.basename(m.maskPath)
    }))
  }
  await writeOutput(summaryPath, Buffer.from(JSON.stringify(summary, null, 2)))

  // Limpiá los embeddings temporales (los crops ya se borraron).
  for (const e of embPaths) await fs.rm(e, { force: true })

  ctx.progress('sam-everything', 1, `${masks.length} máscaras`)
  return {
    outDir: p.outDir,
    imageWidth: W,
    imageHeight: H,
    model: p.model,
    pointsPerSide: p.pointsPerSide,
    cropLayers: p.cropLayers,
    count: masks.length,
    labelMapPath,
    summaryPath,
    masks,
    timings: { encodeMs, gridMs, postMs: Date.now() - postStart, totalMs }
  }
}

/** Encuentra el crop al que pertenece un punto (px originales); fallback al global. */
function cropForPoint(
  crops: Array<[number, number, number, number]>,
  point: [number, number]
): [number, number, number, number] {
  const [px, py] = point
  // El más chico que lo contiene (los crops de capa>0 son más chicos que el global).
  let chosen = crops[0]
  let chosenArea = (crops[0][2] - crops[0][0]) * (crops[0][3] - crops[0][1])
  for (const c of crops) {
    if (px >= c[0] && px < c[2] && py >= c[1] && py < c[3]) {
      const a = (c[2] - c[0]) * (c[3] - c[1])
      if (a < chosenArea) {
        chosen = c
        chosenArea = a
      }
    }
  }
  return chosen
}

/** Sub-contexto que mapea el 0..1 de samEncode a una franja [start,end] del AMG. */
function subProgress(ctx: Ctx, start: number, end: number): Ctx {
  return {
    signal: ctx.signal,
    progress: (_stage, value, message) => ctx.progress('sam-everything', start + (end - start) * value, message)
  }
}
