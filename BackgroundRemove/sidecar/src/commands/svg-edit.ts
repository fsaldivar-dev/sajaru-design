import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { Ctx } from '../core/context'
import { applyPaletteEditToSvg, type PaletteEdit } from '../core/svg-layers'

/**
 * Edita capas de un SVG YA agrupado por color (recolorear / quitar) y lo rasteriza —
 * LOCALMENTE, sin re-llamar a ningún vectorizador. Se usa para editar las capas del
 * vectorizado Premium (Recraft) sobre el SVG cacheado, así cada edición NO gasta créditos.
 */
export async function svgEditCommand(
  opts: { input: string; output: string; edit?: PaletteEdit[]; size?: number },
  ctx: Ctx
): Promise<{ output: string; svg: string }> {
  ctx.progress('vectorize', 0.2, 'Aplicando edición de capas')
  const base = await fs.readFile(opts.input, 'utf8')
  const edited = opts.edit && opts.edit.length ? applyPaletteEditToSvg(base, opts.edit) : base
  const size = opts.size ?? 2048
  ctx.progress('vectorize', 0.6, 'Rasterizando')
  const buffer = await sharp(Buffer.from(edited), { density: 300 })
    .resize(size, size, { fit: 'inside' })
    .png()
    .toBuffer()
  await fs.mkdir(path.dirname(opts.output), { recursive: true })
  await fs.writeFile(opts.output, buffer)
  const svgOut = opts.output.replace(/\.[^.]+$/, '.svg')
  await fs.writeFile(svgOut, edited, 'utf8')
  ctx.progress('vectorize', 1)
  return { output: opts.output, svg: svgOut }
}
