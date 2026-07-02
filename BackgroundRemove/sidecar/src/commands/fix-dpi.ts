import sharp from 'sharp'
import type { Ctx } from '../core/context'
import { bufferInfo, defaultOutputPath, readInput, writeOutput } from '../core/image'

export interface FixDpiOptions {
  /** Target DPI to stamp (default 300). */
  target: number
  /** Resample up when the pixel size can't reach the target at the print size. */
  upscaleIfLow: boolean
  /** Intended print width in inches; needed to know how many pixels = target DPI. */
  printWidthIn?: number | null
}

export interface FixDpiResult {
  buffer: Buffer
  dpi: number
  upscaled: boolean
  width: number
  height: number
  previousDpi: number | null
}

/**
 * Stamp the target DPI, and optionally upscale (lanczos) when the image is too
 * small to hit that DPI at the intended print width. A dedicated AI upscaler
 * can replace the resample later without changing this interface.
 */
export async function fixDpiStep(buf: Buffer, opts: FixDpiOptions, ctx: Ctx): Promise<FixDpiResult> {
  ctx.progress('fix-dpi', 0.2, 'Leyendo DPI actual')
  const info = await bufferInfo(buf)
  const target = opts.target > 0 ? opts.target : 300

  let buffer = buf
  let upscaled = false
  let width = info.width
  let height = info.height

  if (opts.upscaleIfLow && opts.printWidthIn && opts.printWidthIn > 0) {
    const neededWidth = Math.round(opts.printWidthIn * target)
    if (info.width < neededWidth) {
      const scale = neededWidth / info.width
      width = neededWidth
      height = Math.round(info.height * scale)
      ctx.progress('fix-dpi', 0.5, `Upscale ${info.width}→${width}px`)
      buffer = await sharp(buf).resize(width, height, { kernel: 'lanczos3' }).toBuffer()
      upscaled = true
    }
  }

  ctx.progress('fix-dpi', 0.85, `Forzando ${target} DPI`)
  buffer = await sharp(buffer).withMetadata({ density: target }).toBuffer()

  ctx.progress('fix-dpi', 1)
  return { buffer, dpi: target, upscaled, width, height, previousDpi: info.dpi }
}

export async function fixDpiCommand(
  opts: {
    input: string
    output?: string
    target: number
    upscaleIfLow: boolean
    printWidthIn?: number | null
  },
  ctx: Ctx
): Promise<{ output: string; dpi: number; upscaled: boolean; width: number; height: number }> {
  const buf = await readInput(opts.input)
  const r = await fixDpiStep(
    buf,
    { target: opts.target, upscaleIfLow: opts.upscaleIfLow, printWidthIn: opts.printWidthIn },
    ctx
  )
  const output = opts.output ?? defaultOutputPath(opts.input, 'dpi')
  await writeOutput(output, r.buffer)
  return { output, dpi: r.dpi, upscaled: r.upscaled, width: r.width, height: r.height }
}
