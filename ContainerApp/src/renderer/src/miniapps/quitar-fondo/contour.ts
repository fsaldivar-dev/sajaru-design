/**
 * Borde de la SELECCIÓN para la herramienta Select & Mask (estilo Photoshop).
 *
 * ── PRINCIPIO (corrección de diseño) ──────────────────────────────────────────
 * La máscara ALFA del canvas principal ES la fuente de verdad. El borde NO se
 * edita por nodos: se DERIVA de la máscara a precisión de pixel y se muestra como
 * "marching ants" que calzan EXACTO sobre el objeto. El refinamiento se hace con
 * pincel +/− (edita el alfa); tras cada pincelada el borde se regenera desde acá.
 *
 * El enfoque viejo (polígono simplificado con RDP agresivo a ~100 nodos) SOBRE-
 * SIMPLIFICABA un borde que ya era exacto → tramos rectos cortando curvas. Acá el
 * borde sigue el límite real del alfa.
 *
 * Dos salidas, ambas en px de IMAGEN (mismo espacio que `canvas.width/height` y
 * `toCanvasPx`), por eso calzan 1:1 con los pixeles:
 *
 *  1. `traceContours()` → polilíneas vectoriales del límite con interpolación
 *     SUBPÍXEL (marching squares a iso=0.5) y RDP MÍNIMO (tol ~0.6px, solo para
 *     limpiar el dentado de pixel, sin recortar curvas). Útil si se quisiera la
 *     línea como vector.
 *  2. `buildEdgeRing()` → la fuente de verdad para el overlay: un canvas alfa con
 *     el anillo `mask − erode(mask)` (1px) por morfología. Calza EXACTO por
 *     construcción (cada pixel de frontera encendido) y es barato de animar como
 *     patrón de rayas. Es lo que usa `contourOverlay`.
 *
 * Limitaciones (documentadas):
 * - El anillo es de 1px (el borde fino exacto). En el overlay se puede engrosar el
 *   trazo de rayas sin perder exactitud (el ancla sigue siendo el anillo de 1px).
 * - `traceContours` traza contornos exteriores e interiores (huecos) por separado;
 *   no anida explícitamente (no hace falta para mostrar el borde).
 */

export type Point = { x: number; y: number }
export type Contour = Point[]

/** Alfa mínimo para considerar un pixel "opaco" (parte de la selección). */
const ALPHA_THRESHOLD = 128

/**
 * Tolerancia RDP MÍNIMA (px de imagen). Subpíxel ya da un borde exacto; esto solo
 * limpia el micro-dentado del muestreo. NO es un objetivo de cantidad de nodos.
 */
const RDP_TOLERANCE = 0.6

// ── Máscara binaria + morfología ──────────────────────────────────────────────

/** Binariza el canal alfa de un ImageData: 1 = opaco, 0 = transparente. */
function binarizeAlpha(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const bin = new Uint8Array(w * h)
  for (let p = 0, i = 3; p < bin.length; p++, i += 4) {
    bin[p] = data[i] > ALPHA_THRESHOLD ? 1 : 0
  }
  return bin
}

/**
 * Anillo de frontera de 1px por morfología: `mask AND NOT erode(mask)`.
 * Un pixel opaco está en el anillo si al menos un vecino 4-conexo es transparente
 * (o cae fuera del lienzo). Resultado EXACTO: justo los pixeles del límite.
 */
function borderRing(bin: Uint8Array, w: number, h: number): Uint8Array {
  const ring = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (bin[p] === 0) continue
      // Borde del lienzo cuenta como frontera (el objeto toca el margen).
      const up = y === 0 || bin[p - w] === 0
      const dn = y === h - 1 || bin[p + w] === 0
      const lf = x === 0 || bin[p - 1] === 0
      const rt = x === w - 1 || bin[p + 1] === 0
      if (up || dn || lf || rt) ring[p] = 1
    }
  }
  return ring
}

/** Bounding box (px) de los pixeles encendidos de una máscara; null si está vacía. */
function maskBounds(
  mask: Uint8Array,
  w: number,
  h: number
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (mask[row + x] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { minX, minY, maxX, maxY }
}

/** Resultado del anillo de borde: canvas alfa 1px recortado a su bounding box. */
export interface EdgeRing {
  /** Canvas (px de imagen) con el anillo: alfa=255 en la frontera, 0 fuera. */
  canvas: HTMLCanvasElement
  /** Offset del canvas dentro de la imagen completa (esquina sup-izq del bbox). */
  x: number
  y: number
  width: number
  height: number
  /** ¿Hay frontera (la máscara no está vacía ni llena todo)? */
  empty: boolean
}

/**
 * Construye el anillo de borde EXACTO (1px) desde el alfa, como canvas recortado a
 * su bounding box. Es la fuente de verdad para el overlay de marching-ants: cada
 * pixel del anillo es un pixel real de la frontera del recorte → calza perfecto.
 */
export function buildEdgeRing(data: Uint8ClampedArray, w: number, h: number): EdgeRing {
  const empty: EdgeRing = {
    canvas: document.createElement('canvas'),
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    empty: true
  }
  if (w <= 0 || h <= 0) return empty

  const bin = binarizeAlpha(data, w, h)
  const ring = borderRing(bin, w, h)
  const bounds = maskBounds(ring, w, h)
  if (!bounds) return empty

  const { minX, minY, maxX, maxY } = bounds
  const rw = maxX - minX + 1
  const rh = maxY - minY + 1
  const canvas = document.createElement('canvas')
  canvas.width = rw
  canvas.height = rh
  const ctx = canvas.getContext('2d')
  if (!ctx) return empty

  const out = ctx.createImageData(rw, rh)
  const od = out.data
  for (let y = 0; y < rh; y++) {
    const srcRow = (y + minY) * w + minX
    const dstRow = y * rw
    for (let x = 0; x < rw; x++) {
      if (ring[srcRow + x] === 1) {
        const i = (dstRow + x) * 4
        od[i] = 255
        od[i + 1] = 255
        od[i + 2] = 255
        od[i + 3] = 255
      }
    }
  }
  ctx.putImageData(out, 0, 0)
  return { canvas, x: minX, y: minY, width: rw, height: rh, empty: false }
}

// ── Trazado vectorial subpíxel (marching squares) ─────────────────────────────

/** Distancia perpendicular del punto `p` al segmento a–b. */
function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  const px = a.x + t * dx
  const py = a.y + t * dy
  return Math.hypot(p.x - px, p.y - py)
}

/** Ramer–Douglas–Peucker sobre una polilínea ABIERTA (iterativo, sin recursión). */
function rdp(points: Point[], eps: number): Point[] {
  const n = points.length
  if (n < 3) return points.slice()
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: Array<[number, number]> = [[0, n - 1]]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number]
    let maxD = 0
    let idx = -1
    const a = points[lo]
    const b = points[hi]
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(points[i], a, b)
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (idx !== -1 && maxD > eps) {
      keep[idx] = 1
      stack.push([lo, idx])
      stack.push([idx, hi])
    }
  }
  const out: Point[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i])
  return out
}

/**
 * Marching squares con interpolación lineal SUBPÍXEL a iso=0.5 sobre el campo del
 * alfa (0..1). Devuelve segmentos sueltos (cada celda 2×2 aporta 0–2 segmentos);
 * los unimos en polilíneas cerradas después.
 *
 * El campo se muestrea en los CENTROS de pixel; los vértices del contorno caen en
 * las aristas entre centros, interpolando dónde el alfa cruza 0.5 → borde suave y
 * exacto, sin escalones de pixel.
 */
function marchingSegments(field: Float32Array, w: number, h: number): Array<[Point, Point]> {
  const iso = 0.5
  const segs: Array<[Point, Point]> = []
  const at = (x: number, y: number): number => field[y * w + x]
  // Interpola la posición del cruce de iso entre dos muestras a y b (coord c0..c1).
  const lerp = (c0: number, c1: number, a: number, b: number): number => {
    const d = b - a
    if (Math.abs(d) < 1e-6) return (c0 + c1) / 2
    return c0 + ((iso - a) / d) * (c1 - c0)
  }

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = at(x, y)
      const tr = at(x + 1, y)
      const br = at(x + 1, y + 1)
      const bl = at(x, y + 1)
      let code = 0
      if (tl >= iso) code |= 8
      if (tr >= iso) code |= 4
      if (br >= iso) code |= 2
      if (bl >= iso) code |= 1
      if (code === 0 || code === 15) continue

      // Cruces en las 4 aristas de la celda (coords en px de imagen = centros).
      const top: Point = { x: lerp(x, x + 1, tl, tr), y }
      const right: Point = { x: x + 1, y: lerp(y, y + 1, tr, br) }
      const bottom: Point = { x: lerp(x, x + 1, bl, br), y: y + 1 }
      const left: Point = { x, y: lerp(y, y + 1, tl, bl) }

      switch (code) {
        case 1:
        case 14:
          segs.push([left, bottom])
          break
        case 2:
        case 13:
          segs.push([bottom, right])
          break
        case 3:
        case 12:
          segs.push([left, right])
          break
        case 4:
        case 11:
          segs.push([top, right])
          break
        case 5:
          // Caso ambiguo (silla): conectamos según el promedio de la celda.
          if ((tl + tr + br + bl) / 4 >= iso) {
            segs.push([left, top])
            segs.push([bottom, right])
          } else {
            segs.push([left, bottom])
            segs.push([top, right])
          }
          break
        case 6:
        case 9:
          segs.push([top, bottom])
          break
        case 7:
        case 8:
          segs.push([left, top])
          break
        case 10:
          if ((tl + tr + br + bl) / 4 >= iso) {
            segs.push([top, right])
            segs.push([left, bottom])
          } else {
            segs.push([left, top])
            segs.push([bottom, right])
          }
          break
        default:
          break
      }
    }
  }
  return segs
}

/** Une segmentos sueltos en polilíneas (cerradas cuando se puede) por extremos. */
function stitch(segs: Array<[Point, Point]>): Contour[] {
  // Cuantiza extremos a una grilla fina para emparejar puntos compartidos.
  const Q = 1000
  const key = (p: Point): string => `${Math.round(p.x * Q)},${Math.round(p.y * Q)}`
  const adj = new Map<string, Array<{ to: string; p0: Point; p1: Point; used: boolean }>>()
  const coord = new Map<string, Point>()
  const push = (a: Point, b: Point): void => {
    const ka = key(a)
    const kb = key(b)
    coord.set(ka, a)
    coord.set(kb, b)
    if (!adj.has(ka)) adj.set(ka, [])
    if (!adj.has(kb)) adj.set(kb, [])
    const e = { to: kb, p0: a, p1: b, used: false }
    const er = { to: ka, p0: b, p1: a, used: false }
    adj.get(ka)!.push(e)
    adj.get(kb)!.push(er)
  }
  for (const [a, b] of segs) push(a, b)

  const contours: Contour[] = []
  for (const [start, edges] of adj) {
    for (const startEdge of edges) {
      if (startEdge.used) continue
      const ring: Contour = [coord.get(start)!]
      let curKey = start
      let edge: typeof startEdge | undefined = startEdge
      let guard = 0
      const maxSteps = segs.length * 2 + 8
      while (edge && !edge.used && guard++ < maxSteps) {
        edge.used = true
        // Marca también la arista inversa como usada.
        const back = adj.get(edge.to)?.find((e) => e.to === curKey && !e.used)
        if (back) back.used = true
        ring.push(edge.p1)
        curKey = edge.to
        if (curKey === start) break
        edge = adj.get(curKey)?.find((e) => !e.used)
      }
      if (ring.length >= 4) contours.push(ring)
    }
  }
  return contours
}

/**
 * Traza el/los contorno(s) del recorte desde el alfa con precisión SUBPÍXEL.
 * Versión vectorial (polilíneas). El overlay usa `buildEdgeRing`, pero exponemos
 * esto por si se quisiera la línea como vector (export, futuro).
 *
 * @returns lista de polilíneas cerradas (px de imagen). RDP mínimo (limpia dentado).
 */
export function traceContours(data: Uint8ClampedArray, w: number, h: number): Contour[] {
  if (w <= 0 || h <= 0) return []
  // Campo continuo del alfa normalizado a 0..1 (subpíxel real, no binario).
  const field = new Float32Array(w * h)
  for (let p = 0, i = 3; p < field.length; p++, i += 4) field[p] = data[i] / 255
  const segs = marchingSegments(field, w, h)
  if (segs.length === 0) return []
  const rings = stitch(segs)
  const out: Contour[] = []
  for (const ring of rings) {
    // RDP mínimo sobre el anillo cerrado: limpia el micro-dentado sin recortar curvas.
    const open = ring.concat(ring[0])
    const simp = rdp(open, RDP_TOLERANCE)
    const closed = simp.length > 1 ? simp.slice(0, -1) : simp
    if (closed.length >= 3) out.push(closed)
  }
  return out
}
