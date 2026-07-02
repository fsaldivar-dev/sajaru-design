import type * as Ort from 'onnxruntime-node'
import sharp from 'sharp'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { cacheDir } from './models/manager'
import type { Ctx } from './context'
import { SidecarError } from './errors'

/**
 * Superresolución con **Real-ESRGAN x4** (ONNX). Un upscaler IA real: reconstruye
 * bordes nítidos donde lanczos solo difumina — clave para logos de baja
 * resolución (y para vectorizar después con un trazo limpio).
 *
 * El modelo es totalmente convolucional (input dinámico), así que procesamos por
 * tiles con solape para no reventar la memoria en imágenes grandes. El alfa se
 * escala aparte (el modelo es RGB) y se recombina.
 */
export const SR_MODEL = {
  id: 'realesrgan-x4',
  name: 'Real-ESRGAN x4',
  url: 'https://huggingface.co/crj/dl-ws/resolve/main/real_esrgan_x4.onnx',
  fileName: 'realesrgan-x4.onnx',
  sizeMB: 70,
  scale: 4
}

const TILE = 256
const PAD = 16

export function srModelPath(): string {
  return path.join(cacheDir(), SR_MODEL.fileName)
}

export function isSrDownloaded(): boolean {
  return existsSync(srModelPath())
}

async function loadOrt(): Promise<typeof import('onnxruntime-node')> {
  try {
    return await import('onnxruntime-node')
  } catch {
    throw new SidecarError('E_ORT_MISSING', 'onnxruntime-node no está disponible.')
  }
}

let session: Ort.InferenceSession | null = null
async function getSession(ort: typeof import('onnxruntime-node')): Promise<Ort.InferenceSession> {
  if (session) return session
  session = await ort.InferenceSession.create(srModelPath())
  return session
}

/** Descarga el modelo SR (una vez) con progreso. */
export async function downloadSrModel(ctx: Ctx): Promise<void> {
  await fs.mkdir(cacheDir(), { recursive: true })
  const dest = srModelPath()
  const tmp = `${dest}.part`
  ctx.progress('upscale', 0, `Descargando modelo IA ${SR_MODEL.name} (~${SR_MODEL.sizeMB} MB)`)
  const res = await fetch(SR_MODEL.url).catch((e) => {
    throw new SidecarError('E_MODEL_DOWNLOAD', `Fallo de red descargando ${SR_MODEL.url}`, String(e))
  })
  if (!res.ok || !res.body) {
    throw new SidecarError('E_MODEL_DOWNLOAD', `No se pudo descargar el modelo (HTTP ${res.status})`)
  }
  const total = Number(res.headers.get('content-length') ?? 0)
  const file = await fs.open(tmp, 'w')
  let received = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (ctx.signal.aborted) throw new SidecarError('E_CANCELLED', 'Descarga cancelada')
      const b = Buffer.from(chunk)
      await file.write(b)
      received += b.length
      if (total > 0) ctx.progress('upscale', 0.3 * (received / total), `Descargando modelo IA ${(received / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB`)
    }
  } finally {
    await file.close()
  }
  await fs.rename(tmp, dest)
}

/** Corre el modelo sobre un tile RGB (raw, w×h×3) → Float32Array CHW [0,1] de w*4×h*4. */
async function runTile(
  ort: typeof import('onnxruntime-node'),
  sess: Ort.InferenceSession,
  rgb: Buffer,
  w: number,
  h: number
): Promise<{ data: Float32Array; ow: number; oh: number }> {
  const area = w * h
  const chw = new Float32Array(3 * area)
  for (let i = 0, p = 0; i < area; i++, p += 3) {
    chw[i] = rgb[p] / 255
    chw[area + i] = rgb[p + 1] / 255
    chw[2 * area + i] = rgb[p + 2] / 255
  }
  const t = new ort.Tensor('float32', chw, [1, 3, h, w])
  const out = await sess.run({ [sess.inputNames[0]]: t })
  const o = out[sess.outputNames[0]] as Ort.Tensor
  return { data: o.data as Float32Array, ow: o.dims[3] as number, oh: o.dims[2] as number }
}

/**
 * Recupera textura en las zonas que Real-ESRGAN dejó PLANAS (telas oscuras, fondos lisos),
 * que es donde sale el aspecto de "óleo / color mate". Estrategia adaptativa por píxel:
 *  - Detalle local de la IA = |luma(ai) − luma(blur(ai))|. Si es alto, la IA tiene detalle
 *    REAL (caras, bordes, pelo) → no se toca, se conserva su nitidez.
 *  - Si es bajo (zona plana), se inclina hacia el original upscaleado con lanczos (foto
 *    honesta, sin invención pictórica) y se suma un grano de luminancia muy sutil para
 *    romper la planicie → sensación de tela en vez de plástico.
 * `ai` se modifica in-place. O(n) + un blur (sharp).
 */
async function restoreTexture(ai: Buffer, origUp: Buffer, w: number, h: number): Promise<void> {
  if (process.env.SR_NO_TEXTURE === '1') return // interruptor A/B para comparar/ajustar
  const SIGMA = 1.1 // radio del blur para medir el detalle local de la IA
  const FLAT_T = 8 // detalle (luma) por debajo del cual la zona se considera plana
  const LEAN = 0.35 // máxima inclinación hacia el original en zonas 100% planas
  const GRAIN = 10 // amplitud máxima del grano de luminancia en zonas 100% planas
  const aiBlur = await sharp(ai, { raw: { width: w, height: h, channels: 3 } })
    .blur(SIGMA)
    .raw()
    .toBuffer()
  const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v)
  const n = w * h
  for (let p = 0; p < n; p++) {
    const i = p * 3
    const dr = ai[i] - aiBlur[i]
    const dg = ai[i + 1] - aiBlur[i + 1]
    const db = ai[i + 2] - aiBlur[i + 2]
    const detail = Math.abs(0.299 * dr + 0.587 * dg + 0.114 * db)
    if (detail >= FLAT_T) continue // la IA tiene detalle real acá → respetala
    const flat = 1 - detail / FLAT_T // 1 = totalmente plano (zona "óleo/mate")
    // El aspecto óleo/mate es un fenómeno de zonas OSCURAS (telas). El grano va ahí, NUNCA
    // en piel/tonos claros (donde se vería como ruido). darkW desvanece el grano con el brillo.
    const luma = 0.299 * ai[i] + 0.587 * ai[i + 1] + 0.114 * ai[i + 2]
    const darkW = luma <= 60 ? 1 : luma >= 150 ? 0 : (150 - luma) / 90
    const g = (Math.random() - 0.5) * 2 * GRAIN * flat * darkW // grano: solo plano + oscuro
    const lean = LEAN * flat
    ai[i] = Math.round(clamp(ai[i] * (1 - lean) + origUp[i] * lean + g))
    ai[i + 1] = Math.round(clamp(ai[i + 1] * (1 - lean) + origUp[i + 1] * lean + g))
    ai[i + 2] = Math.round(clamp(ai[i + 2] * (1 - lean) + origUp[i + 2] * lean + g))
  }
}

/**
 * Upscalea `buf` con Real-ESRGAN al factor `targetScale` (1..4). Descarga el
 * modelo si falta. Conserva el alfa (escalado aparte con lanczos).
 */
export async function upscaleAI(
  buf: Buffer,
  targetScale: number,
  ctx: Ctx
): Promise<{ buffer: Buffer; width: number; height: number }> {
  if (!isSrDownloaded()) await downloadSrModel(ctx)
  const ort = await loadOrt()
  const sess = await getSession(ort)

  const meta = await sharp(buf).metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  if (!W || !H) throw new SidecarError('E_IMAGE', 'No se pudieron leer las dimensiones')
  const hasAlpha = Boolean(meta.hasAlpha)
  const S = SR_MODEL.scale

  const rgb = await sharp(buf, { limitInputPixels: false }).removeAlpha().raw().toBuffer()
  const oW = W * S
  const oH = H * S
  const outRgb = Buffer.alloc(oW * oH * 3)
  const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

  const cols = Math.ceil(W / TILE)
  const rows = Math.ceil(H / TILE)
  let done = 0
  const totalTiles = cols * rows

  for (let ty = 0; ty < H; ty += TILE) {
    for (let tx = 0; tx < W; tx += TILE) {
      const tw = Math.min(TILE, W - tx)
      const th = Math.min(TILE, H - ty)
      // región con padding de contexto (recortada a la imagen)
      const px0 = Math.max(0, tx - PAD)
      const py0 = Math.max(0, ty - PAD)
      const px1 = Math.min(W, tx + tw + PAD)
      const py1 = Math.min(H, ty + th + PAD)
      const pw = px1 - px0
      const ph = py1 - py0
      const tile = Buffer.alloc(pw * ph * 3)
      for (let y = 0; y < ph; y++) {
        const src = ((py0 + y) * W + px0) * 3
        rgb.copy(tile, y * pw * 3, src, src + pw * 3)
      }
      const { data, ow } = await runTile(ort, sess, tile, pw, ph)
      // sub-región válida (el tile sin el padding) dentro del tile upscaleado
      const offx = (tx - px0) * S
      const offy = (ty - py0) * S
      const oarea = ow * ph * S
      for (let y = 0; y < th * S; y++) {
        for (let x = 0; x < tw * S; x++) {
          const si = (offy + y) * ow + (offx + x)
          const dx = tx * S + x
          const dy = ty * S + y
          const di = (dy * oW + dx) * 3
          outRgb[di] = clamp(data[si] * 255)
          outRgb[di + 1] = clamp(data[oarea + si] * 255)
          outRgb[di + 2] = clamp(data[2 * oarea + si] * 255)
        }
      }
      done++
      ctx.progress('upscale', 0.3 + 0.6 * (done / totalTiles), `Mejorando con IA (tile ${done}/${totalTiles})`)
    }
  }

  // Recuperar textura donde la IA quedó plana (telas/oscuros → evita el aspecto óleo/mate).
  ctx.progress('upscale', 0.9, 'Recuperando textura')
  const origUp = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .resize(oW, oH, { kernel: 'lanczos3' })
    .raw()
    .toBuffer()
  await restoreTexture(outRgb, origUp, oW, oH)

  ctx.progress('upscale', 0.92, 'Recomponiendo')
  let img: ReturnType<typeof sharp>
  if (hasAlpha) {
    const alphaUp = await sharp(buf, { limitInputPixels: false })
      .extractChannel(3)
      .resize(oW, oH, { kernel: 'lanczos3' })
      .raw()
      .toBuffer()
    const rgba = Buffer.alloc(oW * oH * 4)
    for (let i = 0; i < oW * oH; i++) {
      rgba[i * 4] = outRgb[i * 3]
      rgba[i * 4 + 1] = outRgb[i * 3 + 1]
      rgba[i * 4 + 2] = outRgb[i * 3 + 2]
      rgba[i * 4 + 3] = alphaUp[i]
    }
    img = sharp(rgba, { raw: { width: oW, height: oH, channels: 4 } })
  } else {
    img = sharp(outRgb, { raw: { width: oW, height: oH, channels: 3 } })
  }

  // el modelo es x4; si pidieron menos, reescalamos a targetScale× original
  let finalW = oW
  let finalH = oH
  if (targetScale < S) {
    finalW = Math.round(W * targetScale)
    finalH = Math.round(H * targetScale)
    img = sharp(await img.png().toBuffer(), { limitInputPixels: false }).resize(finalW, finalH, { kernel: 'lanczos3' })
  }
  const buffer = await img.png().toBuffer()
  ctx.progress('upscale', 1)
  return { buffer, width: finalW, height: finalH }
}
