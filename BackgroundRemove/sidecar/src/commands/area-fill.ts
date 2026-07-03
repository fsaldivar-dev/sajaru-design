import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { Ctx } from '../core/context'

export type AreaMode = 'fill' | 'erase' | 'recolor'

/**
 * Herramientas de ZONA sobre el raster del resultado (rect en píxeles del PNG):
 *  - `fill`   (fundir):     todos los píxeles OPACOS del rect toman el color dominante de la
 *                           zona (tapa artefactos: franjas, líneas de borde).
 *  - `erase`  (borrar):     los píxeles del rect que MATCHEAN el color dominante se vuelven
 *                           transparentes (quitar fondo/esquinas sin llevarse los trazos de
 *                           otros colores que crucen el rect) — flujo "vectorizo todo y elimino".
 *  - `recolor`(recolorear): los píxeles del rect que matchean el dominante toman `to` (cambiar
 *                           el color de UNA región sin tocar el resto de ese color en el diseño).
 * `erase`/`recolor` operan SOLO sobre el color dominante del rect para ser seguros cuando la
 * selección roza trazos vecinos. La transparencia existente siempre se respeta.
 */
export async function areaFillCommand(
  opts: {
    input: string
    output: string
    rect: { x: number; y: number; w: number; h: number }
    mode?: AreaMode
    /** Color destino para `recolor` (r,g,b 0-255). */
    to?: { r: number; g: number; b: number }
  },
  ctx: Ctx
): Promise<{ output: string; color: string | null }> {
  const mode: AreaMode = opts.mode ?? 'fill'
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

  // ¿El píxel pertenece al color dominante? (tolerancia perceptual simple; agrupa anti-alias)
  const TOL2 = 48 * 48
  const matchesDom = (i: number): boolean =>
    (data[i] - dom.r) ** 2 + (data[i + 1] - dom.g) ** 2 + (data[i + 2] - dom.b) ** 2 < TOL2

  ctx.progress(
    'vectorize',
    0.7,
    mode === 'fill' ? 'Fundiendo al color predominante' : mode === 'erase' ? 'Borrando la zona' : 'Recoloreando la zona'
  )
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const i = (y * W + x) * 4
      if (data[i + 3] < 128) continue
      if (mode === 'fill') {
        data[i] = dom.r
        data[i + 1] = dom.g
        data[i + 2] = dom.b
      } else if (mode === 'erase') {
        if (matchesDom(i)) data[i + 3] = 0
      } else {
        // recolor: solo los píxeles del color dominante del rect
        if (matchesDom(i) && opts.to) {
          data[i] = opts.to.r
          data[i + 1] = opts.to.g
          data[i + 2] = opts.to.b
        }
      }
    }
  }

  const out = await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
  await fs.mkdir(path.dirname(opts.output), { recursive: true })
  await fs.writeFile(opts.output, out)
  const hex = '#' + [dom.r, dom.g, dom.b].map((v) => v.toString(16).padStart(2, '0')).join('')
  ctx.progress('vectorize', 1)
  return { output: opts.output, color: hex }
}
