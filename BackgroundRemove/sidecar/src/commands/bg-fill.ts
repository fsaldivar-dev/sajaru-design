import sharp from 'sharp'
import type { Ctx } from '../core/context'
import { defaultOutputPath, readInput, writeOutput } from '../core/image'

/** Color de fondo para reemplazar la transparencia. 'transparent' = no-op. */
export type BgFill = 'transparent' | 'white' | 'black'

const SOLID: Record<Exclude<BgFill, 'transparent'>, { r: number; g: number; b: number }> = {
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 }
}

export interface BgFillResult {
  buffer: Buffer
  /** true = compuso sobre un fondo sólido (aplanó el alfa). */
  filled: boolean
  fill: BgFill
}

/**
 * Reemplaza el fondo transparente por un color sólido y APLANA (salida sin alfa).
 * Componemos el recorte sobre una base del color del mismo tamaño y removemos el
 * canal alfa. Con 'transparent' no toca nada (comportamiento actual del pipeline).
 */
export async function bgFillStep(buf: Buffer, fill: BgFill, ctx: Ctx): Promise<BgFillResult> {
  if (fill === 'transparent') {
    ctx.progress('bg-fill', 1)
    return { buffer: buf, filled: false, fill }
  }

  ctx.progress('bg-fill', 0.3, 'Aplicando fondo sólido')
  const meta = await sharp(buf).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  const { r, g, b } = SOLID[fill]

  const base = sharp({
    create: { width, height, channels: 3, background: { r, g, b } }
  })
  const composited = await base
    .composite([{ input: await sharp(buf).png().toBuffer(), blend: 'over' }])
    .removeAlpha()
    .png()
    .toBuffer()

  ctx.progress('bg-fill', 1)
  return { buffer: composited, filled: true, fill }
}

export async function bgFillCommand(
  opts: { input: string; output?: string; fill: BgFill },
  ctx: Ctx
): Promise<{ output: string; filled: boolean; fill: BgFill }> {
  const buf = await readInput(opts.input)
  const { buffer, filled, fill } = await bgFillStep(buf, opts.fill, ctx)
  const output = opts.output ?? defaultOutputPath(opts.input, 'bgfill', 'png')
  await writeOutput(output, buffer)
  return { output, filled, fill }
}
