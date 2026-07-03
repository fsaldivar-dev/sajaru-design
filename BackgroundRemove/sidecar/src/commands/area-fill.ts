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
    /** Zona rectangular (modo zona). Alternativa: `point` (modo OBJETO). */
    rect?: { x: number; y: number; w: number; h: number }
    /**
     * Modo OBJETO (estilo Illustrator): el punto clickeado selecciona el COMPONENTE
     * CONECTADO de ese color (la isla), no todo el color global. Con esto "recolorear el
     * título" no toca la barba aunque ambos sean blancos.
     */
    point?: { x: number; y: number }
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

  // ---- MODO OBJETO: click → componente conectado del color clickeado ----
  if (opts.point) {
    const px = Math.max(0, Math.min(W - 1, Math.round(opts.point.x)))
    const py = Math.max(0, Math.min(H - 1, Math.round(opts.point.y)))
    const pi = py * W + px
    if (data[pi * 4 + 3] < 128) {
      await fs.copyFile(opts.input, opts.output)
      return { output: opts.output, color: null }
    }
    const cr = data[pi * 4]
    const cg = data[pi * 4 + 1]
    const cb = data[pi * 4 + 2]
    // El PNG vectorizado es de colores PLANOS: tolerancia corta alcanza y no salta de capa.
    const TOL2 = 40 * 40
    const same = (i: number): boolean =>
      data[i * 4 + 3] >= 128 &&
      (data[i * 4] - cr) ** 2 + (data[i * 4 + 1] - cg) ** 2 + (data[i * 4 + 2] - cb) ** 2 < TOL2
    ctx.progress('vectorize', 0.5, mode === 'erase' ? 'Borrando el objeto' : 'Recoloreando el objeto')
    const inComp = new Uint8Array(W * H)
    const st = [pi]
    inComp[pi] = 1
    while (st.length) {
      const p = st.pop() as number
      const x = p % W
      const y = (p / W) | 0
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q >= 0 && !inComp[q] && same(q)) {
          inComp[q] = 1
          st.push(q)
        }
      }
    }
    // Anillo de 1px para el anti-alias del borde del objeto (adjacente + parecido, sin encadenar).
    const RING2 = 95 * 95
    const ring: number[] = []
    for (let p = 0; p < W * H; p++) {
      if (inComp[p] || data[p * 4 + 3] < 128) continue
      const x = p % W
      const y = (p / W) | 0
      const adj =
        (x > 0 && inComp[p - 1]) || (x < W - 1 && inComp[p + 1]) || (y > 0 && inComp[p - W]) || (y < H - 1 && inComp[p + W])
      if (!adj) continue
      const d = (data[p * 4] - cr) ** 2 + (data[p * 4 + 1] - cg) ** 2 + (data[p * 4 + 2] - cb) ** 2
      if (d < RING2) ring.push(p)
    }
    for (const p of ring) inComp[p] = 1
    for (let p = 0; p < W * H; p++) {
      if (!inComp[p]) continue
      if (mode === 'erase') data[p * 4 + 3] = 0
      else if (opts.to) {
        data[p * 4] = opts.to.r
        data[p * 4 + 1] = opts.to.g
        data[p * 4 + 2] = opts.to.b
      }
    }
    const outBuf = await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
    await fs.mkdir(path.dirname(opts.output), { recursive: true })
    await fs.writeFile(opts.output, outBuf)
    ctx.progress('vectorize', 1)
    return {
      output: opts.output,
      color: '#' + [cr, cg, cb].map((v) => v.toString(16).padStart(2, '0')).join('')
    }
  }

  if (!opts.rect) {
    await fs.copyFile(opts.input, opts.output)
    return { output: opts.output, color: null }
  }

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
