/**
 * Selección de OBJETOS client-side: componente conectado del color clickeado, calculado
 * sobre el ImageData del resultado — instantáneo, sin ir al sidecar. La matemática es LA
 * MISMA que `area-fill --point` del sidecar (TOL² = 12², alpha ≥ 128, 4-conexión, anillo
 * de anti-alias 95² adyacente sin encadenar): lo que se RESALTA es exactamente lo que se
 * edita al confirmar.
 */

export type Raster = { data: Uint8ClampedArray; w: number; h: number }

export type Component = {
  /** Punto que lo seleccionó, en px de la imagen (semilla para el sidecar). */
  seed: { x: number; y: number }
  /** Color del componente. */
  hex: string
  /** Máscara 0/1 de w×h (comparte dimensiones con el raster). */
  mask: Uint8Array
  bbox: { x0: number; y0: number; x1: number; y1: number }
  area: number
}

const TOL2 = 12 * 12
const RING2 = 95 * 95

/** Carga el PNG del resultado como ImageData (blob URL local: sin taint de canvas). */
export async function loadRaster(url: string): Promise<Raster> {
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('No se pudo leer el resultado'))
    img.src = url
  })
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const g = c.getContext('2d', { willReadFrequently: true })
  if (!g) throw new Error('Canvas 2D no disponible')
  g.drawImage(img, 0, 0)
  const { data } = g.getImageData(0, 0, c.width, c.height)
  return { data, w: c.width, h: c.height }
}

/** Componente conectado bajo (x, y) — null si el píxel es transparente. */
export function floodComponent(raster: Raster, x: number, y: number): Component | null {
  const { data, w, h } = raster
  const px = Math.max(0, Math.min(w - 1, Math.round(x)))
  const py = Math.max(0, Math.min(h - 1, Math.round(y)))
  const pi = py * w + px
  if (data[pi * 4 + 3] < 128) return null
  const cr = data[pi * 4]
  const cg = data[pi * 4 + 1]
  const cb = data[pi * 4 + 2]
  const same = (i: number): boolean =>
    data[i * 4 + 3] >= 128 &&
    (data[i * 4] - cr) ** 2 + (data[i * 4 + 1] - cg) ** 2 + (data[i * 4 + 2] - cb) ** 2 < TOL2
  const mask = new Uint8Array(w * h)
  const st = [pi]
  mask[pi] = 1
  let x0 = px
  let y0 = py
  let x1 = px
  let y1 = py
  let area = 1
  while (st.length) {
    const p = st.pop() as number
    const xx = p % w
    const yy = (p / w) | 0
    if (xx < x0) x0 = xx
    if (xx > x1) x1 = xx
    if (yy < y0) y0 = yy
    if (yy > y1) y1 = yy
    for (const q of [xx > 0 ? p - 1 : -1, xx < w - 1 ? p + 1 : -1, yy > 0 ? p - w : -1, yy < h - 1 ? p + w : -1]) {
      if (q >= 0 && !mask[q] && same(q)) {
        mask[q] = 1
        area++
        st.push(q)
      }
    }
  }
  // Anillo de 1px para el anti-alias del borde (adyacente + parecido, sin encadenar).
  const ring: number[] = []
  for (let p = 0; p < w * h; p++) {
    if (mask[p] || data[p * 4 + 3] < 128) continue
    const xx = p % w
    const yy = (p / w) | 0
    const adj =
      (xx > 0 && mask[p - 1] === 1) ||
      (xx < w - 1 && mask[p + 1] === 1) ||
      (yy > 0 && mask[p - w] === 1) ||
      (yy < h - 1 && mask[p + w] === 1)
    if (!adj) continue
    const d = (data[p * 4] - cr) ** 2 + (data[p * 4 + 1] - cg) ** 2 + (data[p * 4 + 2] - cb) ** 2
    if (d < RING2) ring.push(p)
  }
  for (const p of ring) {
    mask[p] = 1
    area++
  }
  const hex = '#' + [cr, cg, cb].map((v) => v.toString(16).padStart(2, '0')).join('')
  return { seed: { x: px, y: py }, hex, mask, bbox: { x0, y0, x1, y1 }, area }
}

/** ¿El punto (px de imagen) cae dentro de alguno de estos componentes? Devuelve su índice. */
export function hitComponent(comps: Component[], w: number, x: number, y: number): number {
  const p = Math.round(y) * w + Math.round(x)
  for (let i = 0; i < comps.length; i++) if (comps[i].mask[p]) return i
  return -1
}

/** Tolerancia perceptual de la MARQUESINA (igual que el rect del sidecar: agrupa el AA). */
const MARQ_TOL2 = 48 * 48

/**
 * MARQUESINA por color (varita + marco): selecciona los píxeles del color DOMINANTE dentro
 * del rect — aunque no estén conectados (los 140 fragmentos de una letra texturizada) y
 * aunque el mismo color siga fuera del rect (el marco corta: la playera sin el gorro).
 */
export function marqueeMask(raster: Raster, rect: { x: number; y: number; w: number; h: number }): Component | null {
  const { data, w, h } = raster
  const x0 = Math.max(0, Math.round(rect.x))
  const y0 = Math.max(0, Math.round(rect.y))
  const x1 = Math.min(w, Math.round(rect.x + rect.w))
  const y1 = Math.min(h, Math.round(rect.y + rect.h))
  if (x1 - x0 < 1 || y1 - y0 < 1) return null
  // color dominante entre los píxeles OPACOS del rect (cuantizado 5 bits, como el sidecar)
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>()
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4
      if (data[i + 3] < 128) continue
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)
      const e = counts.get(key)
      if (e) e.n++
      else counts.set(key, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] })
    }
  }
  let dom = { n: 0, r: 0, g: 0, b: 0 }
  for (const e of counts.values()) if (e.n > dom.n) dom = e
  if (dom.n === 0) return null
  const mask = new Uint8Array(w * h)
  let area = 0
  let seed: { x: number; y: number } | null = null
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = y * w + x
      const i = p * 4
      if (data[i + 3] < 128) continue
      const d = (data[i] - dom.r) ** 2 + (data[i + 1] - dom.g) ** 2 + (data[i + 2] - dom.b) ** 2
      if (d >= MARQ_TOL2) continue
      mask[p] = 1
      area++
      if (!seed) seed = { x, y }
    }
  }
  if (!area || !seed) return null
  const hex = '#' + [dom.r, dom.g, dom.b].map((v) => v.toString(16).padStart(2, '0')).join('')
  return { seed, hex, mask, bbox: { x0, y0, x1: x1 - 1, y1: y1 - 1 }, area }
}

/** Máscara de TODOS los píxeles opacos del rect (para RESTAR una zona de la selección). */
export function rectMask(raster: Raster, rect: { x: number; y: number; w: number; h: number }): Uint8Array | null {
  const { data, w, h } = raster
  const x0 = Math.max(0, Math.round(rect.x))
  const y0 = Math.max(0, Math.round(rect.y))
  const x1 = Math.min(w, Math.round(rect.x + rect.w))
  const y1 = Math.min(h, Math.round(rect.y + rect.h))
  if (x1 - x0 < 1 || y1 - y0 < 1) return null
  const mask = new Uint8Array(w * h)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = y * w + x
      if (data[p * 4 + 3] >= 128) mask[p] = 1
    }
  }
  return mask
}

/** Máscara EFECTIVA de la selección: unión de los agregados menos las restas. */
export function effectiveMask(
  w: number,
  h: number,
  adds: Component[],
  subs: Uint8Array[]
): { mask: Uint8Array; area: number } | null {
  if (!adds.length) return null
  const mask = new Uint8Array(w * h)
  for (const c of adds) for (let p = 0; p < mask.length; p++) if (c.mask[p]) mask[p] = 1
  for (const s of subs) for (let p = 0; p < mask.length; p++) if (s[p]) mask[p] = 0
  let area = 0
  for (let p = 0; p < mask.length; p++) if (mask[p]) area++
  return area ? { mask, area } : null
}

/** Overlay de resaltado desde una máscara efectiva (tinte + borde de 1px). */
export function buildOverlayFromMask(w: number, h: number, mask: Uint8Array): HTMLCanvasElement | null {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g) return null
  const out = g.createImageData(w, h)
  const o = out.data
  for (let p = 0; p < w * h; p++) {
    if (!mask[p]) continue
    const x = p % w
    const y = (p / w) | 0
    const edge =
      x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w]
    const i = p * 4
    o[i] = 56
    o[i + 1] = 152
    o[i + 2] = 255
    o[i + 3] = edge ? 255 : 88
  }
  g.putImageData(out, 0, 0)
  return c
}

/** La máscara como PNG (alfa 255 en lo seleccionado) para mandar al sidecar (--mask). */
export async function maskToPngBytes(w: number, h: number, mask: Uint8Array): Promise<ArrayBuffer> {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g) throw new Error('Canvas 2D no disponible')
  const out = g.createImageData(w, h)
  for (let p = 0; p < w * h; p++) if (mask[p]) out.data[p * 4 + 3] = 255
  g.putImageData(out, 0, 0)
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'))
  if (!blob) throw new Error('No se pudo serializar la máscara')
  return blob.arrayBuffer()
}

/**
 * Canvas de RESALTADO (resolución nativa): tinte celeste sobre los componentes + borde de
 * 1px sólido — el sustituto honesto de las "hormigas marchantes". CompareView lo compone
 * sobre el resultado con el mismo transform.
 */
export function buildOverlay(w: number, h: number, comps: Component[]): HTMLCanvasElement | null {
  if (!comps.length) return null
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g) return null
  const out = g.createImageData(w, h)
  const o = out.data
  for (const comp of comps) {
    const m = comp.mask
    for (let y = Math.max(0, comp.bbox.y0); y <= Math.min(h - 1, comp.bbox.y1); y++) {
      const row = y * w
      for (let x = Math.max(0, comp.bbox.x0); x <= Math.min(w - 1, comp.bbox.x1); x++) {
        const p = row + x
        if (!m[p]) continue
        const edge =
          x === 0 || y === 0 || x === w - 1 || y === h - 1 || !m[p - 1] || !m[p + 1] || !m[p - w] || !m[p + w]
        const i = p * 4
        // celeste selección (sky-400-ish) — tinte en el interior, sólido en el borde
        o[i] = 56
        o[i + 1] = 152
        o[i + 2] = 255
        o[i + 3] = edge ? 255 : 88
      }
    }
  }
  g.putImageData(out, 0, 0)
  return c
}
