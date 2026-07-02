import sharp from 'sharp'
import type { Ctx } from '../core/context'
import { bufferInfo, defaultOutputPath, readInput, writeOutput } from '../core/image'
import { upscaleAI } from '../core/superres'
import { crispUpscaleRecraft } from '../core/recraft'

/**
 * Mejora la imagen. Dos métodos:
 *  - `classic`: upscale lanczos + nitidez (rápido, sin dependencias).
 *  - `ai`: Real-ESRGAN x4 (reconstruye bordes nítidos; descarga el modelo la
 *    primera vez). Mucho mejor para logos de baja resolución.
 * Preserva el alfa en ambos.
 */
export interface EnhanceOptions {
  /** Factor de escala (1..4). */
  scale: number
  sharpen: boolean
  method: 'classic' | 'ai' | 'recraft'
}

export async function enhanceStep(
  buf: Buffer,
  opts: EnhanceOptions,
  ctx: Ctx
): Promise<{ buffer: Buffer; width: number; height: number; scale: number }> {
  const info = await bufferInfo(buf)
  const scale = Math.max(1, Math.min(4, opts.scale || 2))

  if (opts.method === 'recraft') {
    ctx.progress('enhance', 0.2, 'Mejorando con Recraft (IA premium)… puede tardar ~10-15 s')
    const out = await crispUpscaleRecraft(buf)
    const m = await sharp(out).metadata()
    ctx.progress('enhance', 1)
    return { buffer: out, width: m.width ?? info.width, height: m.height ?? info.height, scale }
  }

  if (opts.method === 'ai') {
    const r = await upscaleAI(buf, scale, ctx)
    return { buffer: r.buffer, width: r.width, height: r.height, scale }
  }

  const width = Math.round(info.width * scale)
  const height = Math.round(info.height * scale)
  ctx.progress('enhance', 0.2, `Upscale ×${scale}`)
  let img = sharp(buf, { limitInputPixels: false })
  if (scale > 1) img = img.resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
  if (opts.sharpen) {
    ctx.progress('enhance', 0.6, 'Nitidez')
    img = img.sharpen({ sigma: 1 })
  }
  const buffer = await img.png().toBuffer()
  ctx.progress('enhance', 1)
  return { buffer, width, height, scale }
}

export async function enhanceCommand(
  opts: { input: string; output?: string; scale?: number; sharpen?: boolean; method?: 'classic' | 'ai' | 'recraft' },
  ctx: Ctx
): Promise<{ output: string; width: number; height: number; scale: number }> {
  const buf = await readInput(opts.input)
  const r = await enhanceStep(
    buf,
    { scale: opts.scale ?? 2, sharpen: opts.sharpen ?? true, method: opts.method ?? 'classic' },
    ctx
  )
  const output = opts.output ?? defaultOutputPath(opts.input, 'enhanced', 'png')
  await writeOutput(output, r.buffer)
  return { output, width: r.width, height: r.height, scale: r.scale }
}
