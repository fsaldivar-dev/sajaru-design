import sharp from 'sharp'
import type { Ctx } from '../core/context'
import { bufferInfo, defaultOutputPath, readInput, writeOutput } from '../core/image'

export interface FixColorResult {
  buffer: Buffer
  from: string
  to: string
  converted: boolean
}

/**
 * Convert CMYK → sRGB. If a source ICC profile is embedded, sharp honours it;
 * otherwise this is a straight colourspace conversion (good enough for screen
 * preview / RGB sublimation workflows).
 */
export async function fixColorStep(buf: Buffer, ctx: Ctx): Promise<FixColorResult> {
  ctx.progress('fix-color', 0.3, 'Inspeccionando espacio de color')
  const info = await bufferInfo(buf)
  const isCmyk = info.space === 'cmyk'

  ctx.progress('fix-color', 0.6, isCmyk ? 'Convirtiendo CMYK → sRGB' : 'Ya está en RGB')
  const buffer = isCmyk ? await sharp(buf).toColourspace('srgb').toBuffer() : buf

  ctx.progress('fix-color', 1)
  return { buffer, from: info.space, to: isCmyk ? 'srgb' : info.space, converted: isCmyk }
}

export async function fixColorCommand(
  opts: { input: string; output?: string },
  ctx: Ctx
): Promise<{ output: string; from: string; to: string; converted: boolean }> {
  const buf = await readInput(opts.input)
  const { buffer, from, to, converted } = await fixColorStep(buf, ctx)
  const output = opts.output ?? defaultOutputPath(opts.input, 'rgb')
  await writeOutput(output, buffer)
  return { output, from, to, converted }
}
