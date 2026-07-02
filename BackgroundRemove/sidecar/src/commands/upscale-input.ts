import sharp from 'sharp'
import type { Ctx } from '../core/context'
import { bufferInfo } from '../core/image'
import { isSrDownloaded, upscaleAI } from '../core/superres'

/**
 * Auto-upscale del INPUT *antes* de quitar el fondo, sólo para imágenes de BAJA
 * resolución (logos chicos, screenshots tipo 474px). Un input chico da bordes
 * dentados al keyear (el matte trabaja sobre poquísimos píxeles de borde);
 * subiéndolo primero, el alfa sale más limpio y la vectorización posterior traza
 * un borde nítido.
 *
 * Real-ESRGAN x4 reconstruye bordes (no sólo difumina). Si el modelo IA no está
 * disponible o falla, caemos a un resize lanczos3 de sharp al mismo target — peor
 * que la IA pero igual mejora el keying respecto del original chico.
 *
 * NO-OP para imágenes que ya son grandes: el camino foto/IA (perfil personas)
 * NO se altera. El gate vive en runPipeline (UPSCALE_BELOW).
 */

export type UpscaleMethod = 'esrgan' | 'lanczos'

export interface UpscaleInputResult {
  buffer: Buffer
  upscaled: boolean
  fromW: number
  fromH: number
  toW: number
  toH: number
  /** Motor usado cuando upscaled=true; null si fue NO-OP. */
  method: UpscaleMethod | null
}

/**
 * Sube `buf` para que su lado mayor quede ~`targetMaxSide` (sin pasarse). Asume
 * que el caller ya decidió que corresponde upscalear (input chico).
 *
 * Intenta Real-ESRGAN; si no está el modelo o tira error, hace lanczos3.
 */
export async function upscaleInputStep(
  buf: Buffer,
  targetMaxSide: number,
  ctx: Ctx
): Promise<UpscaleInputResult> {
  const info = await bufferInfo(buf)
  const fromW = info.width
  const fromH = info.height
  const maxSide = Math.max(fromW, fromH)

  // Defensa: sin dimensiones o ya en/sobre el target → NO-OP (el gate real está
  // en runPipeline, pero acá no rompemos si nos llaman de más).
  if (!maxSide || maxSide >= targetMaxSide) {
    return { buffer: buf, upscaled: false, fromW, fromH, toW: fromW, toH: fromH, method: null }
  }

  // Factor para llevar el lado mayor a ~targetMaxSide SIN pasarse. ESRGAN corre x4
  // internamente y reescala (lanczos) a este factor fraccionario.
  const targetScale = targetMaxSide / maxSide

  // Intento IA (Real-ESRGAN). Sólo si el modelo ya está; NO disparamos descarga
  // de ~70MB en medio del pipeline interactivo (sería una pausa sorpresa). Si
  // falta o falla, caemos a lanczos.
  if (isSrDownloaded()) {
    try {
      ctx.progress('upscale-input', 0.05, `Subiendo input chico (${maxSide}px) con IA…`)
      const r = await upscaleAI(buf, targetScale, ctx)
      return {
        buffer: r.buffer,
        upscaled: true,
        fromW,
        fromH,
        toW: r.width,
        toH: r.height,
        method: 'esrgan'
      }
    } catch (err) {
      // No abortamos el pipeline por un fallo de upscale: degradamos a lanczos.
      ctx.progress('upscale-input', 0.5, `IA no disponible (${(err as Error).message}); usando lanczos`)
    }
  }

  // Fallback: resize lanczos3 al target (preserva alfa).
  ctx.progress('upscale-input', 0.6, `Subiendo input chico (${maxSide}px) con lanczos…`)
  const toW = Math.round(fromW * targetScale)
  const toH = Math.round(fromH * targetScale)
  const buffer = await sharp(buf, { limitInputPixels: false })
    .resize(toW, toH, { kernel: 'lanczos3', fit: 'fill' })
    .png()
    .toBuffer()
  ctx.progress('upscale-input', 1)
  return { buffer, upscaled: true, fromW, fromH, toW, toH, method: 'lanczos' }
}
