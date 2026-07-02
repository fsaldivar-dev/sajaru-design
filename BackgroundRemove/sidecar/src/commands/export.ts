import sharp from 'sharp'
import type { Ctx } from '../core/context'
import { defaultOutputPath, readInput, writeOutput } from '../core/image'
import type { OutputFormat } from '../core/types'

export interface ExportOptions {
  format: OutputFormat
  dpi: number
}

export interface ExportResult {
  buffer: Buffer
  format: OutputFormat
  dpi: number
}

/** Encode PNG or TIFF with correct DPI metadata (pHYs for PNG, xres/yres for TIFF). */
export async function exportStep(buf: Buffer, opts: ExportOptions, ctx: Ctx): Promise<ExportResult> {
  ctx.progress('export', 0.3, `Codificando ${opts.format.toUpperCase()} @ ${opts.dpi} DPI`)
  const base = sharp(buf).withMetadata({ density: opts.dpi })

  const pxPerMm = opts.dpi / 25.4
  const buffer =
    opts.format === 'tiff'
      ? await base.tiff({ compression: 'lzw', xres: pxPerMm, yres: pxPerMm }).toBuffer()
      : await base.png({ compressionLevel: 9 }).toBuffer()

  ctx.progress('export', 1)
  return { buffer, format: opts.format, dpi: opts.dpi }
}

export async function exportCommand(
  opts: { input: string; output?: string; format: OutputFormat; dpi: number },
  ctx: Ctx
): Promise<{ output: string; format: OutputFormat; dpi: number; bytes: number }> {
  const buf = await readInput(opts.input)
  const { buffer, format, dpi } = await exportStep(buf, { format: opts.format, dpi: opts.dpi }, ctx)
  const output = opts.output ?? defaultOutputPath(opts.input, 'final', format)
  await writeOutput(output, buffer)
  return { output, format, dpi, bytes: buffer.byteLength }
}
