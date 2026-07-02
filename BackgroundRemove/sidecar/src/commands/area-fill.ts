import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { Ctx } from '../core/context'

/**
 * "Fundir al color predominante" en un rectángulo: dentro del área, todos los píxeles OPACOS
 * toman el color dominante de esa zona (la transparencia se respeta). Sirve para tapar
 * artefactos como la línea roja de borde: seleccionás un rectángulo donde el color bueno
 * predomina y la franja artefacto se funde a ese color. Opera sobre el raster del resultado
 * (limpia el PNG/PDF exportado). `rect` viene en píxeles del PNG.
 */
export async function areaFillCommand(
  opts: { input: string; output: string; rect: { x: number; y: number; w: number; h: number } },
  ctx: Ctx
): Promise<{ output: string; color: string | null }> {
  ctx.progress('vectorize', 0.2, 'Leyendo resultado')
  const src = sharp(opts.input)
  const meta = await src.metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  const { data } = await src.ensureAlpha().raw().toBuffer({ resolveWithObject: true })

  const rx = Math.max(0, Math.min(W, Math.round(opts.rect.x)))
  const ry = Math.max(0, Math.min(H, Math.round(opts.rect.y)))
  const rw = Math.max(0, Math.min(W - rx, Math.round(opts.rect.w)))
  const rh = Math.max(0, Math.min(H - ry, Math.round(opts.rect.h)))
  if (rw === 0 || rh === 0) {
    await fs.copyFile(opts.input, opts.output)
    return { output: opts.output, color: null }
  }

  // Color dominante entre los píxeles OPACOS del rect (cuantizado para agrupar casi-iguales).
  ctx.progress('vectorize', 0.4, 'Buscando color predominante')
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>()
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const i = (y * W + x) * 4
      if (data[i + 3] < 128) continue
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)
      const e = counts.get(key)
      if (e) e.n++
      else counts.set(key, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] })
    }
  }
  let dom = { n: 0, r: 0, g: 0, b: 0 }
  for (const e of counts.values()) if (e.n > dom.n) dom = e
  if (dom.n === 0) {
    await fs.copyFile(opts.input, opts.output)
    return { output: opts.output, color: null }
  }

  // Funde: todos los opacos del rect → color dominante (respeta transparencia).
  ctx.progress('vectorize', 0.7, 'Fundiendo al color predominante')
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const i = (y * W + x) * 4
      if (data[i + 3] < 128) continue
      data[i] = dom.r
      data[i + 1] = dom.g
      data[i + 2] = dom.b
    }
  }

  const out = await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
  await fs.mkdir(path.dirname(opts.output), { recursive: true })
  await fs.writeFile(opts.output, out)
  const hex = '#' + [dom.r, dom.g, dom.b].map((v) => v.toString(16).padStart(2, '0')).join('')
  ctx.progress('vectorize', 1)
  return { output: opts.output, color: hex }
}
