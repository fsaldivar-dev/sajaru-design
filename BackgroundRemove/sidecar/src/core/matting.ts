import type * as Ort from 'onnxruntime-node'
import sharp from 'sharp'
import os from 'node:os'
import type { Ctx } from './context'
import { SidecarError } from './errors'
import { getModel, isDownloaded, modelPath } from './models/manager'

/**
 * MODNet — matting fotográfico de retrato (Apache-2.0). Ruta de "MATTING DE
 * CABELLO" para personas: a diferencia de BiRefNet (saliencia → silueta dura),
 * su salida es un ALFA continuo que recupera las hebras/mechones del pelo. Su
 * alfa ES el recorte (es un matte de retrato COMPLETO, no un refinador), por eso
 * remove-bg lo usa como matte del recorte cuando el tipo es Persona, en vez del
 * de BiRefNet.
 *
 * ── Firma del ONNX (validada cargando la sesión) ──
 *   input  'input'  shape [batch,3,H,W] DINÁMICO, float32, RGB, NCHW planar.
 *   output 'output' shape [batch,1,H,W] = alfa 0..1.
 *
 * ── Receta de pre/post validada (da matte limpio CON pelo) ──
 *   1. resize MANTENIENDO ASPECTO para que max(W,H)→512.
 *   2. redondear CADA dim al múltiplo de 32 más cercano (mínimo 32) → tw×th.
 *      ⚠️ NO forzar 512×512 cuadrado: distorsiona el aspecto → bandas/rayas en el
 *      alfa. El input es dinámico; usamos aspecto-preservado múltiplo de 32.
 *   3. normalizar cada canal (x-127.5)/127.5  → [-1,1].
 *   4. NCHW planar RGB: chw[c*tw*th + y*tw + x].
 *   5. output alfa [1,1,th,tw] 0..1 → ×255 → resize de vuelta a W×H original.
 */

/** Id del modelo MODNet en el registry. */
const MODNET_ID = 'modnet'

/** Lado al que MODNet remuestrea el lado LARGO de la imagen (antes del snap a /32). */
const REF_SIZE = 512

/** El input/output del ONNX deben ser múltiplos de este valor. */
const STRIDE = 32

/** onnxruntime-node es un addon nativo pesado: cargalo perezoso (como remove-bg/sam). */
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
 * Opciones de sesión: fp32 en CPU e `intra_op_num_threads` a los cores físicos
 * (mismo criterio que core/sam.ts: la GEMM del backbone paraleliza bien hasta
 * los cores físicos; pasarse no ayuda).
 */
function sessionOptions(): Ort.InferenceSession.SessionOptions {
  const physical = Math.max(1, os.cpus().length)
  return {
    executionProviders: ['cpu'],
    intraOpNumThreads: physical,
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
  const session = await ort.InferenceSession.create(modelPath(id), sessionOptions())
  // Confirmá la firma real (input/output) en stderr para no ensuciar stdout JSON.
  console.error(
    `[matting] ${id} inputs=${JSON.stringify(session.inputNames)} outputs=${JSON.stringify(session.outputNames)}`
  )
  sessions.set(id, session)
  return session
}

/** Redondea `v` al múltiplo de `STRIDE` más cercano, con mínimo `STRIDE`. */
function snapToStride(v: number): number {
  const snapped = Math.round(v / STRIDE) * STRIDE
  return Math.max(STRIDE, snapped)
}

export interface MattingResult {
  /** Alfa del matte (8-bit, 1 canal) a tamaño ORIGINAL, row-major W·H. */
  alpha: Buffer
  width: number
  height: number
  /** Dims efectivas de inferencia (múltiplo de 32) — para logs/debug. */
  inferW: number
  inferH: number
}

/**
 * Corre MODNet sobre `buf` con la receta validada y devuelve el ALFA del matte
 * (8-bit, 1 canal) a tamaño ORIGINAL. No compone RGBA ni escribe nada: el caller
 * (remove-bg) decide cómo usar el alfa. El alfa es continuo (rampa del pelo
 * intacta), no binario.
 */
export async function runMatting(buf: Buffer, ctx: Ctx): Promise<MattingResult> {
  const def = getModel(MODNET_ID)
  ctx.progress('matting', 0.05, `Cargando modelo ${def.name}`)
  const ort = await loadOrt()
  const session = await getSession(MODNET_ID, ort)

  const meta = await sharp(buf).metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  if (!W || !H) throw new SidecarError('E_IMAGE', 'No se pudieron leer las dimensiones de la imagen')

  // — preprocess: resize aspecto-preservado a max→512, snap a /32, normalizar [-1,1], NCHW —
  ctx.progress('matting', 0.2, 'Preprocesando (resize aspecto + /32)')
  const scale = REF_SIZE / Math.max(W, H)
  const tw = snapToStride(W * scale)
  const th = snapToStride(H * scale)
  const area = tw * th

  // RGB crudo 0..255 al tamaño de inferencia (fit:'fill' = exactamente tw×th).
  const resized = await sharp(buf, { limitInputPixels: false })
    .removeAlpha()
    .resize(tw, th, { fit: 'fill' })
    .toColourspace('srgb')
    .raw()
    .toBuffer()

  // NCHW planar RGB; normalización (x-127.5)/127.5 → [-1,1].
  const chw = new Float32Array(3 * area)
  const gPlane = area
  const bPlane = 2 * area
  for (let i = 0, p = 0; i < area; i++, p += 3) {
    chw[i] = (resized[p] - 127.5) / 127.5
    chw[gPlane + i] = (resized[p + 1] - 127.5) / 127.5
    chw[bPlane + i] = (resized[p + 2] - 127.5) / 127.5
  }
  const input = new ort.Tensor('float32', chw, [1, 3, th, tw])

  // — inference —
  ctx.progress('matting', 0.5, 'Inferencia de matte (puede tardar)')
  const outputs = await session.run({ [session.inputNames[0]]: input })
  const raw = (outputs[session.outputNames[0]] as Ort.Tensor).data as Float32Array

  // — postprocess: alfa 0..1 → ×255 → resize de vuelta a W×H original —
  ctx.progress('matting', 0.85, 'Postprocesando matte')
  const alphaSmall = Buffer.alloc(area)
  for (let i = 0; i < area; i++) {
    const v = raw[i]
    alphaSmall[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)
  }
  // sharp puede devolver >1 canal al rehacer el raw → leé el stride real.
  const up = await sharp(alphaSmall, { raw: { width: tw, height: th, channels: 1 } })
    .resize(W, H, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const uch = up.info.channels
  const alpha = Buffer.alloc(W * H)
  if (uch === 1) {
    up.data.copy(alpha, 0, 0, W * H)
  } else {
    for (let i = 0; i < W * H; i++) alpha[i] = up.data[i * uch]
  }

  ctx.progress('matting', 1)
  return { alpha, width: W, height: H, inferW: tw, inferH: th }
}
