import sharp from 'sharp'
import type { Ctx } from '../core/context'
import { defaultOutputPath, readInput, writeOutput } from '../core/image'

/**
 * "Preparar Sublimación": deja la imagen lista para imprimir en papel de transfer.
 *  - Redimensiona al tamaño FÍSICO del producto (pulgadas → px a 300 DPI).
 *  - Marca 300 DPI en la metadata (para que la impresora respete el tamaño).
 *  - ESPEJO horizontal (flop): en sublimación el diseño se imprime invertido para
 *    que quede correcto al transferirlo. Esto es lo que más se olvida.
 *
 * Si se dan ancho y alto, encaja el diseño dentro (contain, centrado, fondo
 * transparente) para no deformarlo. Salida PNG o TIFF a 300 DPI.
 */
export async function printPrepCommand(
  opts: {
    input: string
    output?: string
    widthIn?: number
    heightIn?: number
    dpi?: number
    mirror?: boolean
    format?: 'png' | 'tiff'
  },
  ctx: Ctx
): Promise<{ output: string; width: number; height: number; dpi: number; mirror: boolean }> {
  const dpi = opts.dpi ?? 300
  const mirror = opts.mirror ?? false
  ctx.progress('print-prep', 0.2, 'Cargando')
  const buf = await readInput(opts.input)
  let img = sharp(buf, { limitInputPixels: false })

  ctx.progress('print-prep', 0.5, 'Redimensionando a tamaño físico')
  if (opts.widthIn && opts.heightIn) {
    const wPx = Math.round(opts.widthIn * dpi)
    const hPx = Math.round(opts.heightIn * dpi)
    img = img.resize(wPx, hPx, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  } else if (opts.widthIn) {
    img = img.resize({ width: Math.round(opts.widthIn * dpi) })
  } else if (opts.heightIn) {
    img = img.resize({ height: Math.round(opts.heightIn * dpi) })
  }

  if (mirror) {
    ctx.progress('print-prep', 0.7, 'Aplicando espejo')
    img = img.flop()
  }

  img = img.withMetadata({ density: dpi })
  ctx.progress('print-prep', 0.85, 'Exportando a 300 DPI')
  const out = opts.format === 'tiff' ? await img.tiff().toBuffer() : await img.png().toBuffer()
  const m = await sharp(out).metadata()

  const output = opts.output ?? defaultOutputPath(opts.input, 'transfer', opts.format ?? 'png')
  await writeOutput(output, out)
  ctx.progress('print-prep', 1)
  return { output, width: m.width ?? 0, height: m.height ?? 0, dpi, mirror }
}
