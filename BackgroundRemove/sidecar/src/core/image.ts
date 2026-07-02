import sharp from 'sharp'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ImageInfo } from './types'
import { SidecarError } from './errors'

// Short-lived process: don't keep a file cache holding handles open.
sharp.cache(false)

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function readInput(p: string): Promise<Buffer> {
  if (!(await fileExists(p))) {
    throw new SidecarError('E_INPUT_NOT_FOUND', `No existe el archivo de entrada: ${p}`)
  }
  return fs.readFile(p)
}

function metaToInfo(
  meta: import('sharp').Metadata,
  p: string,
  sizeBytes: number
): ImageInfo {
  return {
    path: p,
    format: meta.format ?? 'unknown',
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    channels: meta.channels ?? 0,
    hasAlpha: Boolean(meta.hasAlpha),
    space: meta.space ?? 'unknown',
    dpi: meta.density && meta.density > 0 ? meta.density : null,
    sizeBytes
  }
}

export async function imageInfo(p: string): Promise<ImageInfo> {
  const stat = await fs.stat(p).catch(() => {
    throw new SidecarError('E_INPUT_NOT_FOUND', `No existe el archivo de entrada: ${p}`)
  })
  const meta = await sharp(p).metadata()
  return metaToInfo(meta, p, stat.size)
}

export async function bufferInfo(buf: Buffer): Promise<ImageInfo> {
  const meta = await sharp(buf).metadata()
  return metaToInfo(meta, '<buffer>', buf.byteLength)
}

/** Decode to raw RGBA pixels for per-pixel work (alpha thresholds, dilation). */
export async function toRgbaRaw(
  buf: Buffer
): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** Re-encode raw RGBA back to a PNG buffer, optionally tagging DPI. */
export async function fromRgbaRaw(
  data: Buffer,
  width: number,
  height: number,
  dpi?: number
): Promise<Buffer> {
  let img = sharp(data, { raw: { width, height, channels: 4 } }).png()
  if (dpi && dpi > 0) img = img.withMetadata({ density: dpi })
  return img.toBuffer()
}

export async function writeOutput(p: string, buf: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, buf)
}

export function defaultOutputPath(input: string, suffix: string, ext?: string): string {
  const dir = path.dirname(input)
  const base = path.basename(input, path.extname(input))
  const e = ext ?? (path.extname(input).slice(1) || 'png')
  return path.join(dir, `${base}.${suffix}.${e}`)
}

/**
 * Encoge la región opaca hacia adentro `px` píxeles (erosión morfológica del
 * alfa). Cada iteración vuelve transparente todo píxel de sujeto que toque un
 * píxel de fondo → come el fringe semitransparente y los bordes raros que a
 * veces deja el recorte. Opera in place sobre RGBA crudo.
 */
export function erodeAlpha(data: Buffer, width: number, height: number, px: number, bgThreshold = 30): void {
  if (px <= 0) return
  const n = width * height
  const bg = new Uint8Array(n)
  for (let iter = 0; iter < px; iter++) {
    for (let p = 0; p < n; p++) bg[p] = data[p * 4 + 3] <= bgThreshold ? 1 : 0
    const clear: number[] = []
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x
        if (bg[p]) continue
        const nearBg =
          (x > 0 && bg[p - 1]) ||
          (x < width - 1 && bg[p + 1]) ||
          (y > 0 && bg[p - width]) ||
          (y < height - 1 && bg[p + width])
        if (nearBg) clear.push(p)
      }
    }
    if (clear.length === 0) break
    for (const p of clear) data[p * 4 + 3] = 0
  }
}

/**
 * Grow the opaque region by 1px (4-neighbour dilation) so printed edges don't
 * leave hairline gaps. Operates in place on raw RGBA; returns pixels grown.
 */
export function dilateAlpha1px(data: Buffer, width: number, height: number): number {
  const snapshot = new Uint8Array(width * height)
  for (let p = 0, a = 3; p < snapshot.length; p++, a += 4) snapshot[p] = data[a]

  let grown = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (snapshot[p] !== 0) continue
      const candidates: Array<[number, boolean]> = [
        [p - 1, x > 0],
        [p + 1, x < width - 1],
        [p - width, y > 0],
        [p + width, y < height - 1]
      ]
      for (const [np, inBounds] of candidates) {
        if (!inBounds) continue
        if (snapshot[np] > 0) {
          const src = np * 4
          const dst = p * 4
          data[dst] = data[src]
          data[dst + 1] = data[src + 1]
          data[dst + 2] = data[src + 2]
          data[dst + 3] = 255
          grown++
          break
        }
      }
    }
  }
  return grown
}

// ──────────────────────────────────────────────────────────────────────────
//  REFINAMIENTO DE ALFA DEL CAMINO IA — guided filter + snap a bordes.
//
//  Problema (fotos/personas): el matte blando de BiRefNet se infiere a 1024² y
//  se estira al tamaño original → la rampa del borde queda ANCHA y, como el alfa
//  se compone sobre el RGB ORIGINAL, arrastra fondo gris-beige en una banda de
//  ~2-15px (halo) alrededor del saco y la silueta. El PELO necesita esa rampa
//  (transición natural); el SACO no (su borde RGB es nítido y pegado).
//
//  Se resuelve en DOS pasos O(N) (ambos con tablas de suma acumulada, sin
//  importar el radio):
//   1) guidedFilterAlpha  — alinea el alfa a los bordes de la GUÍA (luma del
//      RGB) y lo suaviza de forma edge-aware (He et al. 2010). Por sí solo NO
//      aprieta el halo (un guided filter es un suavizador), pero deja el alfa
//      pegado a las estructuras del RGB y limpio de ruido del matte.
//   2) snapAlphaToEdges   — APRIETA la banda subiendo el contraste del alfa
//      alrededor de 0.5, pero SOLO donde hay un borde de CUERPO SÓLIDO (saco):
//      una apertura morfológica del alfa borra los mechones finos (más finos que
//      el elemento estructurante) y deja el cuerpo grueso, así el "gate" de
//      apriete vale ~1 en el borde del saco y ~0 en el pelo → el saco queda
//      nítido y el pelo conserva su semitransparencia (no se recorta "con
//      tijera"). El despill (defringeEdge) corre DESPUÉS, sobre la banda ya
//      apretada, para sacar el color beige residual.
// ──────────────────────────────────────────────────────────────────────────

/** Suma acumulada 2D (integral image) de un Float64Array WxH → (W+1)x(H+1). */
function integralImage(src: Float64Array, width: number, height: number): Float64Array {
  const iw = width + 1
  const sat = new Float64Array(iw * (height + 1))
  for (let y = 0; y < height; y++) {
    let rowSum = 0
    const o = (y + 1) * iw
    const po = y * iw
    for (let x = 0; x < width; x++) {
      rowSum += src[y * width + x]
      sat[o + x + 1] = sat[po + x + 1] + rowSum
    }
  }
  return sat
}

/**
 * Media de ventana (box mean) para cada píxel usando una integral image. La
 * ventana es cuadrada de radio `r` (lado 2r+1), recortada en los bordes; cada
 * píxel se divide por el área REAL de su ventana (sin sesgo en los márgenes).
 */
function boxMean(
  sat: Float64Array,
  width: number,
  height: number,
  r: number,
  out: Float64Array
): void {
  const iw = width + 1
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(height - 1, y + r)
    const top = y0 * iw
    const bot = (y1 + 1) * iw
    const rows = y1 - y0 + 1
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(width - 1, x + r)
      const area = rows * (x1 - x0 + 1)
      const sum = sat[bot + x1 + 1] - sat[bot + x0] - sat[top + x1 + 1] + sat[top + x0]
      out[y * width + x] = sum / area
    }
  }
}

/**
 * PASO 1 del refinamiento: guided filter (He et al.) sobre el canal ALFA de un
 * RGBA crudo, usando la LUMA del propio RGB como guía. Alinea el alfa a los
 * bordes del RGB de forma edge-aware y lo deja limpio. Opera IN PLACE sobre
 * `rgba` (solo toca el alfa). O(N) vía tablas de suma acumulada.
 *
 * Modelo local (ventana de radio r): q = a·I + b por ventana, con
 *   a = cov(I,p)/(var(I)+eps)   b = mean(p) − a·mean(I)
 * luego a y b se promedian por ventana y q = mean_a·I + mean_b.
 *
 * @param radius radio de la ventana en px (a tamaño original del alfa).
 * @param eps    regularización en unidades de alfa² (0..255). Más chico = sigue
 *               más los bordes de la guía; más grande = más suavizado.
 *
 * NOTA: un guided filter es un SUAVIZADOR — por sí solo no aprieta el halo
 * ancho. Para tightening, encadenar con `snapAlphaToEdges` (paso 2) y luego el
 * despill (`defringeEdge`).
 */
export function guidedFilterAlpha(
  rgba: Buffer,
  width: number,
  height: number,
  radius: number,
  eps: number
): void {
  if (radius <= 0) return
  const n = width * height

  // Guía I = luma (Rec.601) del RGB ya despilleado; entrada p = alfa. Ambas en
  // escala 0..255 para que `eps` esté en unidades de alfa intuitivas.
  const I = new Float64Array(n)
  const p = new Float64Array(n)
  const Ip = new Float64Array(n)
  const II = new Float64Array(n)
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const luma = 0.299 * rgba[d] + 0.587 * rgba[d + 1] + 0.114 * rgba[d + 2]
    const a = rgba[d + 3]
    I[i] = luma
    p[i] = a
    Ip[i] = luma * a
    II[i] = luma * luma
  }

  // Medias de ventana de I, p, I·p, I·I.
  const meanI = new Float64Array(n)
  const meanP = new Float64Array(n)
  const meanIp = new Float64Array(n)
  const meanII = new Float64Array(n)
  boxMean(integralImage(I, width, height), width, height, radius, meanI)
  boxMean(integralImage(p, width, height), width, height, radius, meanP)
  boxMean(integralImage(Ip, width, height), width, height, radius, meanIp)
  boxMean(integralImage(II, width, height), width, height, radius, meanII)

  // a = cov(I,p)/(var(I)+eps);  b = mean(p) − a·mean(I).  (reusamos buffers)
  const a = Ip // reuse
  const b = II // reuse
  for (let i = 0; i < n; i++) {
    const cov = meanIp[i] - meanI[i] * meanP[i]
    const varI = meanII[i] - meanI[i] * meanI[i]
    const ai = cov / (varI + eps)
    a[i] = ai
    b[i] = meanP[i] - ai * meanI[i]
  }

  // Promediá a y b por ventana y reconstruí q = mean_a·I + mean_b → alfa final.
  const meanA = meanIp // reuse
  const meanB = meanII // reuse
  boxMean(integralImage(a, width, height), width, height, radius, meanA)
  boxMean(integralImage(b, width, height), width, height, radius, meanB)
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const q = meanA[i] * I[i] + meanB[i]
    rgba[d + 3] = q < 0 ? 0 : q > 255 ? 255 : Math.round(q)
  }
}

/** Erosión binaria (min) separable de una máscara 0/1, radio `r`. O(N·r). */
function erodeMask(src: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const tmp = new Uint8Array(width * height)
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 1
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= width || !src[y * width + xx]) { v = 0; break }
      }
      tmp[y * width + x] = v
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 1
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= height || !tmp[yy * width + x]) { v = 0; break }
      }
      out[y * width + x] = v
    }
  }
  return out
}

/** Dilatación binaria (max) separable de una máscara 0/1, radio `r`. O(N·r). */
function dilateMask(src: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const tmp = new Uint8Array(width * height)
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx
        if (xx >= 0 && xx < width && src[y * width + xx]) { v = 1; break }
      }
      tmp[y * width + x] = v
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy
        if (yy >= 0 && yy < height && tmp[yy * width + x]) { v = 1; break }
      }
      out[y * width + x] = v
    }
  }
  return out
}

/** Opciones del snap a bordes (paso 2 del refinamiento del alfa IA). */
export interface SnapAlphaOptions {
  /** Ganancia de contraste del alfa alrededor de 0.5 en el borde del cuerpo. */
  gain: number
  /** Radio del elemento estructurante de la apertura: mata mechones < ~2·openR. */
  openRadius: number
  /** Radio de la ventana de "bimodalidad" que detecta el borde de cuerpo. */
  gateRadius: number
  /** Exponente del gate: >1 suprime más los bordes de cuerpo "dudosos" (pelo). */
  gatePower: number
  /** Umbral de alfa para considerar un píxel "sólido" al armar el cuerpo. */
  solidThreshold: number
}

/**
 * PASO 2 del refinamiento: APRIETA la banda de transición del alfa SOLO en los
 * bordes de CUERPO SÓLIDO (saco), dejando el PELO intacto. Opera IN PLACE sobre
 * el alfa de un RGBA crudo (no toca el RGB). O(N) — usa apertura morfológica
 * separable + medias de ventana (summed-area).
 *
 * Idea: un mechón es geométricamente igual a un borde de saco a escala de píxel,
 * así que ningún detector LOCAL de borde los separa. La diferencia es de ESCALA:
 * el saco bordea un cuerpo grueso; el pelo son hebras finas. Una APERTURA del
 * alfa (erosión→dilatación con radio `openRadius`) borra las hebras finas y deja
 * el cuerpo. El "gate" = bimodalidad del cuerpo abierto (mucho cuerpo de un lado,
 * mucho vacío del otro) vale ~1 en el borde del saco y ~0 en el pelo. Donde el
 * gate es alto se sube el contraste del alfa (snap al borde); donde es bajo el
 * alfa queda como lo dejó el guided filter (pelo natural, semitransparente).
 *
 * Llamar DESPUÉS de `guidedFilterAlpha` (que ya alineó el alfa al RGB) y ANTES
 * del despill (`defringeEdge`), que limpia el beige de la banda ya apretada.
 */
export function snapAlphaToEdges(
  rgba: Buffer,
  width: number,
  height: number,
  opts: SnapAlphaOptions
): void {
  const { gain, openRadius, gateRadius, gatePower, solidThreshold } = opts
  if (gain <= 1 || openRadius <= 0) return
  const n = width * height

  // Cuerpo sólido = apertura de la máscara (alfa >= umbral). Mata las hebras
  // finas del pelo (más finas que ~2·openRadius) y conserva el saco grueso.
  const solid = new Uint8Array(n)
  for (let i = 0, d = 3; i < n; i++, d += 4) solid[i] = rgba[d] >= solidThreshold ? 1 : 0
  const body = dilateMask(erodeMask(solid, width, height, openRadius), width, height, openRadius)

  // Gate = bimodalidad del cuerpo en una ventana: cuerpo·vacío, máximo 0.25 en un
  // borde 50/50 → normalizado a [0,1] y elevado a `gatePower`. Alto solo donde un
  // cuerpo grueso bordea el fondo (saco); ~0 en el pelo (sin cuerpo abierto cerca).
  const bodyF = new Float64Array(n)
  const voidF = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    bodyF[i] = body[i]
    voidF[i] = body[i] ? 0 : 1
  }
  const meanBody = new Float64Array(n)
  const meanVoid = new Float64Array(n)
  boxMean(integralImage(bodyF, width, height), width, height, gateRadius, meanBody)
  boxMean(integralImage(voidF, width, height), width, height, gateRadius, meanVoid)

  // Sube el contraste del alfa alrededor de 0.5 con ganancia modulada por el gate.
  for (let i = 0, d = 3; i < n; i++, d += 4) {
    let gate = (meanBody[i] * meanVoid[i]) / 0.25
    if (gate > 1) gate = 1
    if (gatePower !== 1) gate = Math.pow(gate, gatePower)
    const g = 1 + (gain - 1) * gate
    const t = rgba[d] / 255
    let tt = 0.5 + (t - 0.5) * g
    tt = tt < 0 ? 0 : tt > 1 ? 1 : tt
    rgba[d] = Math.round(tt * 255)
  }
}

/**
 * Defringe: descontamina el COLOR del borde. En un matte IA los píxeles
 * semitransparentes del borde conservan el color del fondo original (halo de
 * color). Sangramos el color de los vecinos MÁS opacos (primer plano) hacia esos
 * píxeles para que el borde tome el color del sujeto y no muestre fleco en ningún
 * fondo. Opera in place sobre RGBA crudo (solo cambia RGB, no el alfa).
 */
export function defringeEdge(data: Buffer, width: number, height: number, passes = 2): void {
  const n = width * height
  const OPAQUE = 250
  for (let iter = 0; iter < passes; iter++) {
    const src = Buffer.from(data) // snapshot: leemos el estado del pase anterior
    for (let p = 0; p < n; p++) {
      const i = p * 4
      const a = data[i + 3]
      if (a === 0 || a >= OPAQUE) continue // transparente puro u opaco: no tocar color
      const x = p % width
      const y = (p / width) | 0
      let r = 0
      let g = 0
      let b = 0
      let c = 0
      // Pase 1: vecinos claramente más opacos (a+8) = color de FG sin contaminar.
      // Pase 2 (fallback, SOLO si el pase 1 no halló ninguno): cualquier vecino
      // estrictamente más opaco. Robustece el rim EXTERIOR aislado que antes quedaba
      // sin corregir (con el color del fondo pegado). Si el pase 1 halla vecinos, el
      // pase 2 no corre → comportamiento idéntico al previo (cero riesgo de regresión).
      for (let relax = 0; relax <= 1 && c === 0; relax++) {
        const thr = relax === 0 ? a + 8 : a
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= height) continue
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue
            const xx = x + dx
            if (xx < 0 || xx >= width) continue
            const j = (yy * width + xx) * 4
            if (src[j + 3] > thr) {
              r += src[j]
              g += src[j + 1]
              b += src[j + 2]
              c++
            }
          }
        }
      }
      if (c > 0) {
        data[i] = (r / c) | 0
        data[i + 1] = (g / c) | 0
        data[i + 2] = (b / c) | 0
      }
    }
  }
}
