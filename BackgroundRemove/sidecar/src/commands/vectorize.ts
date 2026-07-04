import { Potrace } from 'potrace'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Ctx } from '../core/context'
import { defaultOutputPath, readInput, writeOutput } from '../core/image'
import { isSrDownloaded, upscaleAI } from '../core/superres'
import { vectorizeRecraft } from '../core/recraft'
import { groupSvgByColor } from '../core/svg-layers'

/**
 * Vectoriza a calidad profesional (referencia: Adobe Illustrator / Vector Magic).
 *
 * Motor = **Potrace** (el mismo de Inkscape): ajusta curvas Bézier con una
 * optimización GLOBAL O(n²) → curvas mucho más suaves que VTracer (local O(n)).
 * Como Potrace es bi-nivel, hacemos **separación de color por capas**: detectamos
 * la paleta real → una máscara por color → Potrace cada una → apilamos.
 *
 * Lo clave es que el preprocesado es **adaptativo a la calidad de la entrada**:
 *  - Imagen "nacida de vectores" (bordes nítidos, multicolor): se detecta como
 *    limpia → NO se difumina y se respetan sus colores exactos. (Difuminar acá
 *    redondea las esquinas y mezcla colores → arruina el logo.)
 *  - Logo chico/ruidoso (ej. 120px anti-aliased): se difumina proporcional al
 *    upscale para fundir la escalera antes de trazar.
 *
 * La paleta se detecta por PICOS de histograma (no se re-cuantiza con un
 * quantizer genérico, que inventaba colores intermedios y mataba la fidelidad).
 */
/** Edición de un color de la paleta (para reemplazar o quitar en vivo). */
export interface PaletteEdit {
  r: number
  g: number
  b: number
  /** Reemplazo del color (el fill); si falta, se usa el original {r,g,b}. */
  to?: { r: number; g: number; b: number }
  /** Quitar este color: sus píxeles se vuelven transparentes. */
  remove?: boolean
}

export interface VectorizeOptions {
  /** Máximo de colores de la paleta (2..24). Se detectan los reales y se capan a esto. */
  colors: number
  /** Tamaño del PNG rasterizado de salida. */
  size: number
  /**
   * Si viene, se FIJA la paleta (sin re-detectar): se etiqueta cada píxel con el color
   * original {r,g,b}, se rellena con `to` (o el original) y los `remove` se vuelven
   * transparentes. Es lo que permite editar la paleta en vivo desde la UI.
   */
  edit?: PaletteEdit[]
  /** Reducir ruido 0..100 (filtro de mediana antes de detectar la paleta + más turdSize). */
  denoise?: number
  /** Fundir "bordes": colores-franja finos se funden al color vecino dominante (default true). */
  mergeThin?: boolean
  /**
   * NO quitar el fondo uniforme del borde (default false = se quita). El flujo profesional
   * "vectorizo todo y después elimino" necesita el diseño FIEL con su fondo: en carteles el
   * fondo es parte del arte, y en logos con blancos el flood puede encadenarse por zonas
   * blancas legítimas (aro→alas) y comerse tinta imprimible (DTF sobre prenda oscura).
   */
  keepBackground?: boolean
  /**
   * La entrada YA es un póster plano (salida de un trazado previo): NO difuminar, NO
   * upscalear con IA y trabajar a resolución nativa. Lo usa la CONSOLIDACIÓN de ediciones
   * de zona/objeto al vector (re-trazar el raster editado con paleta fija, fiel 1:1).
   */
  assumeFlat?: boolean
  /**
   * Paleta = los colores EXACTOS presentes en la entrada (posterizada): sin detección, sin
   * fusiones, sin cap del slider. La consolidación la usa para que NINGÚN color del raster
   * editado (incluidos los tonos que mergeThin fundió y los colores nuevos de los recolores)
   * se aplaste a otro. Ignora `edit` y `colors`.
   */
  paletteFromInput?: boolean
  /**
   * Colores que mergeThin NO puede podar (los 'to' de los recolores del usuario): un objeto
   * recoloreado con textura fina erosiona <35% y sin esto se fundiría al vecino.
   */
  protectColors?: Array<{ r: number; g: number; b: number }>
}

interface Color {
  r: number
  g: number
  b: number
  count: number
}

const dist2 = (r: number, g: number, b: number, c: Color): number =>
  (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2

/**
 * Máscara binaria suave: blur + umbral. Con sigma 0 solo binariza.
 * Footgun de sharp: el blur de 1 canal puede devolver >1 → leemos el stride real.
 */
async function smoothMask(buf: Buffer, w: number, h: number, sigma: number): Promise<Uint8Array> {
  if (sigma <= 0) {
    const o = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) o[i] = buf[i] >= 128 ? 255 : 0
    return o
  }
  const { data, info } = await sharp(buf, { raw: { width: w, height: h, channels: 1 } })
    .blur(sigma)
    .raw()
    .toBuffer({ resolveWithObject: true })
  const stride = info.channels
  const o = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) o[i] = data[i * stride] >= 128 ? 255 : 0
  return o
}

/** Reduce la paleta a `target` fusionando los pares de colores más cercanos. */
function reduceTo(pal: Color[], target: number): void {
  while (pal.length > target) {
    let bi = 0
    let bj = 1
    let bd = Infinity
    for (let i = 0; i < pal.length; i++) {
      for (let j = i + 1; j < pal.length; j++) {
        const d = dist2(pal[i].r, pal[i].g, pal[i].b, pal[j])
        if (d < bd) {
          bd = d
          bi = i
          bj = j
        }
      }
    }
    const a = pal[bi]
    const b = pal[bj]
    const t = a.count + b.count
    a.r = Math.round((a.r * a.count + b.r * b.count) / t)
    a.g = Math.round((a.g * a.count + b.g * b.count) / t)
    a.b = Math.round((a.b * a.count + b.b * b.count) / t)
    a.count = t
    pal.splice(bj, 1)
  }
}

/**
 * Snap de primitiva: si la máscara es un círculo limpio devuelve {cx,cy,r},
 * si no, null. Es ESTRICTO a propósito (bbox cuadrado + fill ≈ π/4 + baja
 * varianza radial del borde) para no convertir formas orgánicas en círculos.
 * Cierra el último tramo hacia geometría perfecta tipo Illustrator/Vector Magic.
 */
function circleFit(mask: Uint8Array, W: number, H: number): { cx: number; cy: number; r: number } | null {
  let cx = 0
  let cy = 0
  let area = 0
  let minx = W
  let miny = H
  let maxx = 0
  let maxy = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue
      area++
      cx += x
      cy += y
      if (x < minx) minx = x
      if (x > maxx) maxx = x
      if (y < miny) miny = y
      if (y > maxy) maxy = y
    }
  }
  if (area < 200) return null
  cx /= area
  cy /= area
  const bw = maxx - minx + 1
  const bh = maxy - miny + 1
  const aspect = bw / bh
  const fill = area / (bw * bh)
  const r = Math.sqrt(area / Math.PI)
  // desviación de los píxeles de borde respecto al radio
  let sum = 0
  let sum2 = 0
  let n = 0
  for (let y = miny; y <= maxy; y++) {
    for (let x = minx; x <= maxx; x++) {
      const i = y * W + x
      if (!mask[i]) continue
      if (x > 0 && y > 0 && x < W - 1 && y < H - 1 && mask[i - 1] && mask[i + 1] && mask[i - W] && mask[i + W]) continue
      const d = Math.hypot(x - cx, y - cy)
      sum += d
      sum2 += d * d
      n++
    }
  }
  if (n === 0) return null
  const mean = sum / n
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean))
  if (aspect > 0.93 && aspect < 1.07 && fill > 0.74 && fill < 0.83 && std / mean < 0.045 && Math.abs(mean - r) / r < 0.06) {
    return { cx, cy, r: (mean + r) / 2 }
  }
  return null
}

/** Etiqueta componentes conectados (4-conn) de una máscara binaria. */
function components(mask: Uint8Array, W: number, H: number): {
  lab: Int32Array
  comps: Array<{ id: number; area: number; minx: number; miny: number; maxx: number; maxy: number }>
} {
  const lab = new Int32Array(W * H).fill(-1)
  const comps: Array<{ id: number; area: number; minx: number; miny: number; maxx: number; maxy: number }> = []
  const st: number[] = []
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || lab[s] !== -1) continue
    const id = comps.length
    let area = 0
    let minx = W
    let miny = H
    let maxx = 0
    let maxy = 0
    lab[s] = id
    st.push(s)
    while (st.length) {
      const p = st.pop() as number
      area++
      const x = p % W
      const y = (p / W) | 0
      if (x < minx) minx = x
      if (x > maxx) maxx = x
      if (y < miny) miny = y
      if (y > maxy) maxy = y
      if (x > 0 && mask[p - 1] && lab[p - 1] === -1) { lab[p - 1] = id; st.push(p - 1) }
      if (x < W - 1 && mask[p + 1] && lab[p + 1] === -1) { lab[p + 1] = id; st.push(p + 1) }
      if (y > 0 && mask[p - W] && lab[p - W] === -1) { lab[p - W] = id; st.push(p - W) }
      if (y < H - 1 && mask[p + W] && lab[p + W] === -1) { lab[p + W] = id; st.push(p + W) }
    }
    comps.push({ id, area, minx, miny, maxx, maxy })
  }
  return { lab, comps }
}

/** Test de círculo sobre un componente etiquetado (lab==id). Devuelve {cx,cy,r} o null. */
function circleFitComp(
  lab: Int32Array,
  id: number,
  c: { area: number; minx: number; miny: number; maxx: number; maxy: number },
  W: number,
  H: number
): { cx: number; cy: number; r: number } | null {
  let cx = 0
  let cy = 0
  for (let y = c.miny; y <= c.maxy; y++) {
    for (let x = c.minx; x <= c.maxx; x++) {
      if (lab[y * W + x] === id) { cx += x; cy += y }
    }
  }
  cx /= c.area
  cy /= c.area
  const bw = c.maxx - c.minx + 1
  const bh = c.maxy - c.miny + 1
  const aspect = bw / bh
  const fill = c.area / (bw * bh)
  const r = Math.sqrt(c.area / Math.PI)
  let sum = 0
  let sum2 = 0
  let n = 0
  for (let y = c.miny; y <= c.maxy; y++) {
    for (let x = c.minx; x <= c.maxx; x++) {
      const i = y * W + x
      if (lab[i] !== id) continue
      if (x > 0 && y > 0 && x < W - 1 && y < H - 1 && lab[i - 1] === id && lab[i + 1] === id && lab[i - W] === id && lab[i + W] === id) continue
      const d = Math.hypot(x - cx, y - cy)
      sum += d
      sum2 += d * d
      n++
    }
  }
  if (!n) return null
  const mean = sum / n
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean))
  if (aspect > 0.91 && aspect < 1.1 && fill > 0.73 && fill < 0.84 && std / mean < 0.055 && Math.abs(mean - r) / r < 0.07) {
    return { cx, cy, r: (mean + r) / 2 }
  }
  return null
}

/**
 * Agujeros de una región exacta: píxeles opacos (ha) NO en `exact` y encerrados
 * por ella (no alcanzables desde el borde sin cruzar `exact`). El disco celeste
 * de la "a" es el agujero circular del cuenco navy — y se detecta aunque el disco
 * comparta color con el fondo.
 */
function holesOf(exact: Uint8Array, ha: Uint8Array, W: number, H: number): Uint8Array | null {
  const reach = new Uint8Array(W * H)
  const st: number[] = []
  const seed = (i: number): void => {
    if (!exact[i] && !reach[i]) { reach[i] = 1; st.push(i) }
  }
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x) }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1) }
  while (st.length) {
    const p = st.pop() as number
    const x = p % W
    const y = (p / W) | 0
    if (x > 0 && !exact[p - 1] && !reach[p - 1]) { reach[p - 1] = 1; st.push(p - 1) }
    if (x < W - 1 && !exact[p + 1] && !reach[p + 1]) { reach[p + 1] = 1; st.push(p + 1) }
    if (y > 0 && !exact[p - W] && !reach[p - W]) { reach[p - W] = 1; st.push(p - W) }
    if (y < H - 1 && !exact[p + W] && !reach[p + W]) { reach[p + W] = 1; st.push(p + W) }
  }
  const hole = new Uint8Array(W * H)
  let any = false
  for (let i = 0; i < W * H; i++) {
    if (!exact[i] && !reach[i] && ha[i]) { hole[i] = 255; any = true }
  }
  return any ? hole : null
}

/** Traza una máscara (región blanca = 255) con Potrace y devuelve el `<path>` con su color. */
function tracePath(
  maskPng: Buffer,
  color: string,
  alphaMax: number,
  optTolerance: number,
  turdSize: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = new Potrace({ blackOnWhite: false, threshold: 128, turdSize, alphaMax, optCurve: true, optTolerance, color })
    t.loadImage(maskPng, (err) => (err ? reject(err) : resolve(t.getPathTag())))
  })
}

export async function vectorizeStep(
  buf: Buffer,
  opts: VectorizeOptions,
  ctx: Ctx
): Promise<{ svg: string; buffer: Buffer; palette: Array<{ r: number; g: number; b: number }> }> {
  ctx.progress('vectorize', 0.05, 'Preparando imagen')
  // Entrada BAJA-RES → upscale IA (Real-ESRGAN) antes de trazar: reconstruye bordes nítidos.
  // Sin esto, agrandar 5-7× con lanczos difumina los detalles finos (p.ej. el pelo en spikes de
  // un dibujo) y el trazo sale sucio / con colores mal asignados. Cacheado en disco por hash:
  // editar la paleta NO vuelve a upscalear (re-vectorizado rápido).
  const meta0 = await sharp(buf).metadata()
  if (!opts.assumeFlat && Math.max(meta0.width ?? 512, meta0.height ?? 512) < 700 && isSrDownloaded()) {
    try {
      const hash = createHash('md5').update(buf).digest('hex').slice(0, 16)
      const cdir = path.join(os.tmpdir(), 'sajaru-vec-up')
      const cpath = path.join(cdir, `${hash}.png`)
      if (existsSync(cpath)) {
        buf = await fs.readFile(cpath)
      } else {
        ctx.progress('vectorize', 0.12, 'Mejorando con IA (baja resolución)…')
        const up = await upscaleAI(buf, 4, ctx)
        buf = up.buffer
        await fs.mkdir(cdir, { recursive: true })
        await fs.writeFile(cpath, buf)
      }
    } catch {
      // si el upscale IA falla (sin modelo, OOM, etc.), seguimos con la original (lanczos)
    }
  }
  const meta = await sharp(buf).metadata()
  const maxDim = Math.max(meta.width ?? 512, meta.height ?? 512)
  const target = opts.assumeFlat ? Math.min(2048, maxDim) : Math.min(1536, Math.max(1280, maxDim))
  const palMax = Math.max(2, Math.min(24, Math.round(opts.colors)))

  // Reducir ruido: filtro de MEDIANA (quita grano / textura "distressed" preservando bordes)
  // ANTES de detectar la paleta → la paleta sale más limpia (sin tonos de grano) y los
  // trazos no salen moteados. turdSize de Potrace sube en paralelo (descarta trazos-mota).
  const denoise = Math.max(0, Math.min(100, Math.round(opts.denoise ?? 0)))
  const medSize = denoise <= 0 ? 0 : 3 + 2 * Math.min(4, Math.floor(denoise / 20)) // 3..11 (impar)
  let prep = sharp(buf).resize(target, target, { fit: 'inside', kernel: 'lanczos3' }).ensureAlpha()
  if (medSize >= 3) prep = prep.median(medSize)
  const { data, info } = await prep.raw().toBuffer({ resolveWithObject: true })
  const W = info.width
  const H = info.height
  const N = W * H

  // --- paleta por picos de histograma (respeta los colores reales) ---
  ctx.progress('vectorize', 0.3, 'Detectando colores')
  const alpha = new Uint8Array(N)
  let opaque = 0
  for (let i = 0; i < N; i++) {
    alpha[i] = data[i * 4 + 3]
    if (alpha[i] >= 128) opaque++
  }

  // --- fondo uniforme → transparente (logo sobre color sólido, ej. JPEG) ---
  // Si la imagen es casi 100% opaca y el BORDE es un color uniforme, ese color es el
  // fondo. Lo inundamos desde el borde y lo volvemos transparente para que la paleta se
  // detecte del SUJETO. Sin esto, un fondo que ocupa el ~90% se come el presupuesto de
  // colores (cada color del logo cae bajo el umbral 0.4%) y el logo colapsa a 1-2 colores.
  // La inundación es por CONECTIVIDAD: respeta zonas del mismo color ENCERRADAS en el
  // logo (p.ej. un hocico claro) porque no tocan el borde.
  let transparent = 0
  for (let i = 0; i < N; i++) if (alpha[i] < 128) transparent++
  if (!opts.keepBackground && transparent < N * 0.05) {
    const bsamp: Array<[number, number, number]> = []
    const samp = (x: number, y: number): void => {
      const i = (y * W + x) * 4
      bsamp.push([data[i], data[i + 1], data[i + 2]])
    }
    for (let x = 0; x < W; x++) { samp(x, 0); samp(x, H - 1) }
    for (let y = 0; y < H; y++) { samp(0, y); samp(W - 1, y) }
    const medOf = (k: number): number => {
      const v = bsamp.map((c) => c[k]).sort((a, b) => a - b)
      return v[v.length >> 1]
    }
    const bgR = medOf(0)
    const bgG = medOf(1)
    const bgB = medOf(2)
    let near = 0
    for (const c of bsamp) {
      if ((c[0] - bgR) ** 2 + (c[1] - bgG) ** 2 + (c[2] - bgB) ** 2 < 45 * 45) near++
    }
    if (near / bsamp.length > 0.85) {
      // Dos fases para no COMERSE el arte:
      //  1) Inundación ADAPTATIVA: la tolerancia se MIDE del ruido real del borde (p95 de la
      //     distancia al color mediano) en vez de un valor fijo. Un fondo limpio (PNG upscaleado,
      //     ruido ≤7) recibe tol ~13 y el arte casi-negro sobre negro SOBREVIVE; un JPEG ruidoso
      //     (±15-20) recibe tol ~25 y el fondo sale completo. La tolerancia fija vieja (52) se
      //     ENCADENABA por tonos cercanos al fondo y se tragaba los verdes sombra del jersey.
      //  2) Anillo anti-halo (tol 52, 2 pasadas SIN encadenar): solo píxeles PEGADOS a lo ya
      //     borrado — mata la franja de anti-alias sin poder avanzar hacia el interior del arte.
      const bdists = bsamp
        .map((c) => Math.sqrt((c[0] - bgR) ** 2 + (c[1] - bgG) ** 2 + (c[2] - bgB) ** 2))
        .sort((a, b) => a - b)
      const p95 = bdists[Math.min(bdists.length - 1, Math.floor(bdists.length * 0.95))]
      const tolCore = Math.max(10, Math.min(34, Math.round(p95 * 1.3) + 4))
      const TOL_CORE = tolCore * tolCore
      const TOL_EDGE = 52 * 52
      const bgDist2 = (i: number): number =>
        (data[i * 4] - bgR) ** 2 + (data[i * 4 + 1] - bgG) ** 2 + (data[i * 4 + 2] - bgB) ** 2
      const st: number[] = []
      const visit = (i: number): void => {
        if (alpha[i] !== 0 && bgDist2(i) < TOL_CORE) {
          alpha[i] = 0
          st.push(i)
        }
      }
      for (let x = 0; x < W; x++) { visit(x); visit((H - 1) * W + x) }
      for (let y = 0; y < H; y++) { visit(y * W); visit(y * W + W - 1) }
      while (st.length) {
        const p = st.pop() as number
        const x = p % W
        const y = (p / W) | 0
        if (x > 0) visit(p - 1)
        if (x < W - 1) visit(p + 1)
        if (y > 0) visit(p - W)
        if (y < H - 1) visit(p + W)
      }
      for (let pass = 0; pass < 2; pass++) {
        const ring: number[] = []
        for (let p = 0; p < N; p++) {
          if (alpha[p] === 0 || bgDist2(p) >= TOL_EDGE) continue
          const x = p % W
          const y = (p / W) | 0
          if (
            (x > 0 && alpha[p - 1] === 0) ||
            (x < W - 1 && alpha[p + 1] === 0) ||
            (y > 0 && alpha[p - W] === 0) ||
            (y < H - 1 && alpha[p + W] === 0)
          ) {
            ring.push(p)
          }
        }
        for (const p of ring) alpha[p] = 0
        if (ring.length === 0) break
      }
      opaque = 0
      for (let i = 0; i < N; i++) if (alpha[i] >= 128) opaque++
    }
  }

  // --- paleta: FIJADA por el usuario (edición en vivo) o detectada por picos ---
  let palette: Color[]
  let fills: Array<{ r: number; g: number; b: number }>
  const dropped = new Set<number>()
  if (opts.paletteFromInput) {
    // Paleta = colores EXACTOS de la entrada posterizada (los blends de anti-alias quedan
    // fuera por el umbral de área). Sin fusiones ni caps: nada se aplasta a otro color.
    const exact = new Map<number, { r: number; g: number; b: number; c: number }>()
    for (let i = 0; i < N; i++) {
      if (alpha[i] < 128) continue
      const r = data[i * 4]
      const g = data[i * 4 + 1]
      const b = data[i * 4 + 2]
      const k = (r << 16) | (g << 8) | b
      const e = exact.get(k)
      if (e) e.c++
      else exact.set(k, { r, g, b, c: 1 })
    }
    // Los colores PROTEGIDOS (los que el usuario pintó) entran SIEMPRE, aunque su área sea
    // ínfima: una edición de 40 px no puede desaparecer en silencio al exportar.
    const protectedKeys = new Set((opts.protectColors ?? []).map((c) => (c.r << 16) | (c.g << 8) | c.b))
    palette = [...exact.values()]
      .filter((e) => e.c > opaque * 0.0001 || protectedKeys.has((e.r << 16) | (e.g << 8) | e.b))
      .sort((a, b) => b.c - a.c)
      .slice(0, 64)
      .map((e) => ({ r: e.r, g: e.g, b: e.b, count: e.c }))
    if (palette.length === 0) palette.push({ r: 0, g: 0, b: 0, count: opaque })
    fills = palette.map((c) => ({ r: c.r, g: c.g, b: c.b }))
  } else if (opts.edit && opts.edit.length) {
    palette = opts.edit.map((e) => ({ r: e.r, g: e.g, b: e.b, count: 0 }))
    fills = opts.edit.map((e) => e.to ?? { r: e.r, g: e.g, b: e.b })
    opts.edit.forEach((e, i) => {
      if (e.remove) dropped.add(i)
    })
  } else {
    const buckets = new Map<number, { r: number; g: number; b: number; c: number }>()
    for (let i = 0; i < N; i++) {
      if (alpha[i] < 128) continue
      const r = data[i * 4]
      const g = data[i * 4 + 1]
      const b = data[i * 4 + 2]
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
      let e = buckets.get(k)
      if (!e) {
        e = { r: 0, g: 0, b: 0, c: 0 }
        buckets.set(k, e)
      }
      e.r += r
      e.g += g
      e.b += b
      e.c++
    }
    const cand = [...buckets.values()]
      .map((e) => ({ r: Math.round(e.r / e.c), g: Math.round(e.g / e.c), b: Math.round(e.b / e.c), count: e.c }))
      // Umbral BAJO: deja pasar acentos chicos pero reales (tomates, gota) que un color
      // dominante haría caer bajo un umbral alto. El grano ya lo quitó el denoise; la
      // fusión de casi-idénticos + reduceTo(palMax) capan igual al nº de colores pedido.
      .filter((c) => c.count > opaque * 0.0006)
      .sort((a, b) => b.count - a.count)
      .slice(0, 80) // cap de candidatos (acota el costo O(n²) de reduceTo)
    // fusiona casi-idénticos (variantes AA), preservando colores de marca distintos. Con
    // paletas grandes (≥14) fusiona MÁS FINO: el sombreado pictórico son pasos de ~24-30
    // de distancia y la fusión a 32 los aplastaba (pedías 16 y recibías 12).
    const nearTol = palMax >= 20 ? 16 : palMax >= 14 ? 24 : 32
    palette = []
    for (const c of cand) {
      const near = palette.find((p) => dist2(c.r, c.g, c.b, p) < nearTol * nearTol)
      if (near) {
        const t = near.count + c.count
        near.r = Math.round((near.r * near.count + c.r * c.count) / t)
        near.g = Math.round((near.g * near.count + c.g * c.count) / t)
        near.b = Math.round((near.b * near.count + c.b * c.count) / t)
        near.count = t
      } else {
        palette.push({ ...c })
      }
    }
    // --- rescate de acentos CONTIGUOS (p.ej. la gota azul) ---
    // Un color distinto pero chico y con degradado se fragmenta en el histograma y no pasa el
    // umbral. Buscamos píxeles LEJOS de toda la paleta; si forman un BLOB contiguo grande,
    // agregamos su color promedio. El ruido disperso (moteado) NO se rescata: son componentes
    // chicos. Esto distingue ESPACIALMENTE el acento real del grano (el histograma no podía).
    {
      const far = new Uint8Array(N)
      for (let i = 0; i < N; i++) {
        if (alpha[i] < 128) continue
        const r = data[i * 4]
        const g = data[i * 4 + 1]
        const b = data[i * 4 + 2]
        let bd = Infinity
        for (const p of palette) {
          const d = dist2(r, g, b, p)
          if (d < bd) bd = d
        }
        if (bd > 48 * 48) far[i] = 255
      }
      const { lab, comps } = components(far, W, H)
      const minArea = Math.max(200, Math.round(opaque * 0.0012))
      for (const cp of comps) {
        if (cp.area < minArea) continue
        let sr = 0
        let sg = 0
        let sb = 0
        let n = 0
        for (let y = cp.miny; y <= cp.maxy; y++) {
          for (let x = cp.minx; x <= cp.maxx; x++) {
            const idx = y * W + x
            if (lab[idx] !== cp.id) continue
            sr += data[idx * 4]
            sg += data[idx * 4 + 1]
            sb += data[idx * 4 + 2]
            n++
          }
        }
        if (!n) continue
        const col = { r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n), count: cp.area }
        if (!palette.find((p) => dist2(col.r, col.g, col.b, p) < 32 * 32)) palette.push(col)
      }
    }
    reduceTo(palette, palMax)
    palette.sort((a, b) => b.count - a.count)
    if (palette.length === 0) palette.push({ r: 0, g: 0, b: 0, count: opaque })
    fills = palette.map((c) => ({ r: c.r, g: c.g, b: c.b }))
  }

  // --- asigna cada pixel al color más cercano + mide cuán "anti-aliased" es ---
  const label = new Int16Array(N).fill(-1)
  let far = 0
  for (let i = 0; i < N; i++) {
    if (alpha[i] < 128) continue
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    let best = 0
    let bd = Infinity
    for (let p = 0; p < palette.length; p++) {
      const d = dist2(r, g, b, palette[p])
      if (d < bd) {
        bd = d
        best = p
      }
    }
    label[i] = best
    if (bd > 30 * 30) far++
  }
  // Quitar: los píxeles de un color marcado `remove` se vuelven transparentes (no se trazan).
  if (dropped.size) {
    for (let i = 0; i < N; i++) if (alpha[i] >= 128 && dropped.has(label[i])) alpha[i] = 0
  }
  // Fundir bordes: colores que son casi todos "línea fina" (se erosionan a <35% de su área y
  // ocupan poco) se funden a su color VECINO dominante (espacial) — mata la franja roja/marrón
  // entre dos colores SIN tocar blobs (gota, acentos) ni detalles de un color grande (un marco
  // fino que es del mismo color que un área grande no es "franja").
  const killedColors = new Set<number>()
  if (opts.mergeThin ?? true) {
    const areaByColor = new Int32Array(palette.length)
    const erodedByColor = new Int32Array(palette.length)
    for (let i = 0; i < N; i++) if (alpha[i] >= 128 && label[i] >= 0) areaByColor[label[i]]++
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x
        if (alpha[i] < 128) continue
        const l = label[i]
        if (l >= 0 && label[i - 1] === l && label[i + 1] === l && label[i - W] === l && label[i + W] === l) {
          erodedByColor[l]++
        }
      }
    }
    const protectedIdx = new Set<number>()
    for (const pc of opts.protectColors ?? []) {
      for (let c = 0; c < palette.length; c++) {
        if (palette[c].r === pc.r && palette[c].g === pc.g && palette[c].b === pc.b) protectedIdx.add(c)
      }
    }
    for (let c = 0; c < palette.length; c++) {
      if (protectedIdx.has(c)) continue // color editado por el usuario: intocable
      if (areaByColor[c] > 0 && areaByColor[c] < opaque * 0.05 && erodedByColor[c] / areaByColor[c] < 0.35) {
        killedColors.add(c)
      }
    }
    // Region-grow: cada píxel de un color-franja toma el label vecino NO-franja más común.
    for (let pass = 0; pass < 40 && killedColors.size > 0; pass++) {
      const updates: Array<[number, number]> = []
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x
          if (alpha[i] < 128 || label[i] < 0 || !killedColors.has(label[i])) continue
          const cnt = new Map<number, number>()
          let bestL = -1
          let bestC = 0
          const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]
          for (const j of nb) {
            if (j < 0 || alpha[j] < 128 || label[j] < 0 || killedColors.has(label[j])) continue
            const cc = (cnt.get(label[j]) ?? 0) + 1
            cnt.set(label[j], cc)
            if (cc > bestC) {
              bestC = cc
              bestL = label[j]
            }
          }
          if (bestL >= 0) updates.push([i, bestL])
        }
      }
      if (updates.length === 0) break
      for (const [i, l] of updates) label[i] = l
    }
  }
  const aaFraction = far / Math.max(1, opaque)
  // limpio = bordes nítidos Y no es low-res (un logo de 120px upscaleado igual
  // necesita blur aunque su fracción AA sea baja: su escalera quedó estirada).
  const lowRes = maxDim < 600
  const clean = opts.assumeFlat || (aaFraction < 0.12 && !lowRes)

  // blur adaptativo
  const scale = target / maxDim
  const aSig = clean ? 1 : Math.min(16, Math.max(1, Math.round(scale * 1.6)))
  const cSig = clean ? 0 : Math.min(11, Math.max(1, Math.round(scale * 1.0)))
  const turd = 4 + Math.round((denoise / 100) * 16) // 4..20: más denoise → descarta trazos-mota

  ctx.progress('vectorize', 0.5, 'Limpiando silueta')
  const alphaBuf = Buffer.alloc(N)
  for (let i = 0; i < N; i++) alphaBuf[i] = alpha[i]
  const ha = await smoothMask(alphaBuf, W, H, aSig)

  // --- máscaras ACUMULATIVAS (capa i cubre colores i..N-1) → sin gaps entre capas ---
  ctx.progress('vectorize', 0.6, 'Trazando capas (Potrace)')
  const layers: string[] = []
  for (let i = 0; i < palette.length; i++) {
    if (dropped.has(i)) continue // color quitado: sin capa (sus píxeles ya son transparentes)
    // Color "franja" fundido por mergeThin: NO emitir su capa. Antes se emitía igual y el
    // SVG tenía capas fantasma que el panel (que lista la paleta devuelta) no podía ver ni
    // editar; además la consolidación con paleta fija las aplastaba a colores ajenos. Sus
    // píxeles rezagados los cubre el apilado acumulativo de las capas anteriores.
    if (killedColors.has(i)) continue
    const layerPaths: string[] = []
    const m = Buffer.alloc(N)
    for (let j = 0; j < N; j++) {
      if (ha[j] && label[j] >= i) m[j] = 255
    }
    const sm = await smoothMask(m, W, H, cSig)
    const c = fills[i]
    const col = `rgb(${c.r},${c.g},${c.b})`
    // Snap de primitiva: nunca la base (i>0); si la capa es un círculo limpio
    // emitimos un <circle> exacto en vez del path trazado.
    const circ = i > 0 ? circleFit(sm, W, H) : null
    if (circ) {
      layerPaths.push(`<circle cx="${circ.cx.toFixed(1)}" cy="${circ.cy.toFixed(1)}" r="${circ.r.toFixed(1)}" fill="${col}"/>`)
    } else {
      const png = await sharp(Buffer.from(sm), { raw: { width: W, height: H, channels: 1 } }).png().toBuffer()
      layerPaths.push(await tracePath(png, col, clean ? 1.0 : 1.2, clean ? 0.2 : 0.4, turd))
    }
    // Snap de AGUJEROS circulares: el disco que es un hueco circular en esta
    // forma (ej. el cuenco de la "a") se tapa con un <circle> del color interior,
    // dibujado encima de esta capa (las capas más chicas siguen yendo arriba).
    const exact = new Uint8Array(N)
    for (let j = 0; j < N; j++) if (ha[j] && label[j] === i) exact[j] = 255
    const hole = holesOf(exact, ha, W, H)
    if (hole) {
      const { lab, comps } = components(hole, W, H)
      for (const cp of comps) {
        if (cp.area < 200) continue
        const hc = circleFitComp(lab, cp.id, cp, W, H)
        if (!hc) continue
        // color de relleno = color dominante dentro del agujero (distinto a i)
        const cnt = new Map<number, number>()
        for (let y = cp.miny; y <= cp.maxy; y++) {
          for (let x = cp.minx; x <= cp.maxx; x++) {
            const idx = y * W + x
            if (lab[idx] !== cp.id) continue
            const l = label[idx]
            if (l !== i && l >= 0) cnt.set(l, (cnt.get(l) ?? 0) + 1)
          }
        }
        let bl = -1
        let bc = 0
        for (const [l, n] of cnt) if (n > bc) { bc = n; bl = l }
        const fc = bl >= 0 ? fills[bl] : c
        layerPaths.push(`<circle cx="${hc.cx.toFixed(1)}" cy="${hc.cy.toFixed(1)}" r="${hc.r.toFixed(1)}" fill="rgb(${fc.r},${fc.g},${fc.b})"/>`)
      }
    }
    // Cada color = UNA capa nombrada (<g>): el SVG sale descompuesto por capas, editable
    // en Illustrator/Inkscape (inkscape:groupmode="layer") y parseable por el panel in-app.
    if (layerPaths.length > 0) {
      const hx = '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')
      layers.push(
        `<g id="capa-${i + 1}" inkscape:groupmode="layer" inkscape:label="Capa ${i + 1}" data-color="${hx}">${layerPaths.join('')}</g>`
      )
    }
    ctx.progress('vectorize', 0.6 + 0.25 * ((i + 1) / palette.length))
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${layers.join('')}</svg>`

  ctx.progress('vectorize', 0.9, 'Rasterizando alta resolución')
  const buffer = await sharp(Buffer.from(svg)).resize(opts.size, opts.size, { fit: 'inside' }).png().toBuffer()
  ctx.progress('vectorize', 1)
  return { svg, buffer, palette: palette.filter((_, i) => !killedColors.has(i)).map((c) => ({ r: c.r, g: c.g, b: c.b })) }
}

export async function vectorizeCommand(
  opts: {
    input: string
    output?: string
    colors?: number
    size?: number
    method?: 'local' | 'recraft'
    edit?: PaletteEdit[]
    denoise?: number
    mergeThin?: boolean
    keepBackground?: boolean
    assumeFlat?: boolean
    paletteFromInput?: boolean
    protectColors?: Array<{ r: number; g: number; b: number }>
  },
  ctx: Ctx
): Promise<{
  output: string
  svg: string
  colors: number
  method: string
  palette: Array<{ r: number; g: number; b: number }>
}> {
  const buf = await readInput(opts.input)
  const colors = opts.colors ?? 10
  const size = opts.size ?? 2048
  const method = opts.method ?? 'local'

  let svg: string
  let buffer: Buffer
  let palette: Array<{ r: number; g: number; b: number }> = []
  if (method === 'recraft') {
    // IA premium: Recraft devuelve el SVG directo; lo rasterizamos para preview.
    // Recraft exige dimensión mínima ≥ 256 px; si la entrada es chica, la mejoramos antes
    // (IA si el modelo está, si no lanczos) — además le da material más nítido para vectorizar.
    let rbuf = buf
    const rmeta = await sharp(buf).metadata()
    if (Math.min(rmeta.width ?? 0, rmeta.height ?? 0) < 512) {
      ctx.progress('vectorize', 0.12, 'Mejorando entrada para IA premium…')
      try {
        rbuf = isSrDownloaded()
          ? (await upscaleAI(buf, 4, ctx)).buffer
          : await sharp(buf).resize(1024, 1024, { fit: 'inside', kernel: 'lanczos3' }).png().toBuffer()
      } catch {
        rbuf = await sharp(buf).resize(1024, 1024, { fit: 'inside', kernel: 'lanczos3' }).png().toBuffer()
      }
    }
    ctx.progress('vectorize', 0.3, 'Vectorizando con Recraft (IA premium)… puede tardar ~10-15 s')
    const svgBuf = await vectorizeRecraft(rbuf)
    // DEBUG opcional: volcar el SVG CRUDO de Recraft (antes de agrupar) para diagnosticar.
    if (process.env.SAJARU_DUMP_RAW) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(process.env.SAJARU_DUMP_RAW, svgBuf)
    }
    // Separar en capas por color (igual que el motor local) → habilita el panel de capas y
    // exportar-por-capa en Premium. Las ediciones luego se aplican sobre ESTE SVG (comando
    // svg-edit), sin volver a llamar a Recraft.
    ctx.progress('vectorize', 0.75, 'Separando capas por color')
    const grouped = groupSvgByColor(svgBuf.toString('utf8'))
    svg = grouped.svg
    palette = grouped.palette
    ctx.progress('vectorize', 0.85, 'Rasterizando alta resolución')
    buffer = await sharp(Buffer.from(svg), { density: 300 }).resize(size, size, { fit: 'inside' }).png().toBuffer()
    ctx.progress('vectorize', 1)
  } else {
    const r = await vectorizeStep(buf, { colors, size, edit: opts.edit, denoise: opts.denoise, mergeThin: opts.mergeThin, keepBackground: opts.keepBackground, assumeFlat: opts.assumeFlat, paletteFromInput: opts.paletteFromInput, protectColors: opts.protectColors }, ctx)
    svg = r.svg
    buffer = r.buffer
    palette = r.palette
  }

  const output = opts.output ?? defaultOutputPath(opts.input, 'vector', 'png')
  await writeOutput(output, buffer)
  const svgOut = output.replace(/\.[^.]+$/, '.svg')
  await writeOutput(svgOut, Buffer.from(svg))
  return { output, svg: svgOut, colors, method, palette }
}
