import sharp from 'sharp'
import type { Ctx } from '../core/context'
import { defaultOutputPath, readInput, writeOutput } from '../core/image'
import type { Product } from '../core/types'

// Products printed via a mirror transfer need the art flipped horizontally.
const MIRROR_BY_DEFAULT: Record<Product, boolean> = {
  playera: false, // DTF/direct: not mirrored
  taza: true, // sublimation wrap transfer: mirrored
  gorra: false,
  lona: false
}

export function shouldFlip(product: Product, force?: boolean | null): boolean {
  if (force === true) return true
  if (force === false) return false
  return MIRROR_BY_DEFAULT[product]
}

export async function flipStep(
  buf: Buffer,
  product: Product,
  ctx: Ctx,
  force?: boolean | null
): Promise<{ buffer: Buffer; flipped: boolean }> {
  const flipped = shouldFlip(product, force)
  ctx.progress('flip', 0.4, flipped ? 'Espejando horizontalmente' : 'Sin espejo para este producto')
  const buffer = flipped ? await sharp(buf).flop().toBuffer() : buf
  ctx.progress('flip', 1)
  return { buffer, flipped }
}

export async function flipCommand(
  opts: { input: string; output?: string; product: Product; force?: boolean | null },
  ctx: Ctx
): Promise<{ output: string; flipped: boolean; product: Product }> {
  const buf = await readInput(opts.input)
  const { buffer, flipped } = await flipStep(buf, opts.product, ctx, opts.force)
  const output = opts.output ?? defaultOutputPath(opts.input, 'flip')
  await writeOutput(output, buffer)
  return { output, flipped, product: opts.product }
}
