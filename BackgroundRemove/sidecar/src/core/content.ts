import sharp from 'sharp'
import type { ContentFeatures, MatteMode, Profile, ProfilePreset } from './types'

/**
 * Análisis de contenido CONSCIENTE DEL PERFIL para rutear el quita-fondo.
 *
 * El problema que resuelve: el ruteo "auto" hoy solo mira si el borde es plano
 * (detectFlatBackground) → una FOTO con pared lisa de fondo cae al camino de
 * COLOR (flood-fill) y se rompe. Acá medimos la TEXTURA y la PALETA del contenido
 * para distinguir logo / ilustración / foto / producto, y elegir motor + matte.
 *
 * Todo es local y determinístico (sin IA): downscale a ~256px y unas pocas
 * métricas baratas sobre los píxeles.
 */

// ──────────────────────────────────────────────────────────────────────────
//  CONSTANTES TUNEABLES — análisis de contenido
//  (las voy a iterar con imágenes reales; centralizadas a propósito)
// ──────────────────────────────────────────────────────────────────────────

/** Lado mayor al que se reduce la imagen para analizar (velocidad). */
export const ANALYZE_SIZE = 256

/** Bits por canal al cuantizar para contar colores (4 bits = 16 niveles/canal). */
export const COLOR_QUANT_BITS = 4

/**
 * Umbral de magnitud de gradiente (Sobel, sobre luma 0..255) para contar un
 * píxel como "borde". Más alto = solo bordes marcados cuentan.
 */
export const EDGE_GRADIENT_THRESHOLD = 48

/**
 * Distancia RGB para considerar un píxel del borde "cerca" del color mediano.
 * Reusa el espíritu de detectFlatBackground (umbral 40 ahí).
 */
export const BORDER_NEAR_DIST = 40

/** Alfa previa por encima de esto cuenta como "tiene alfa significativa". */
export const ALPHA_PRESENT_THRESHOLD = 16
/** Fracción de píxeles semi/transparentes para marcar hasAlpha. */
export const ALPHA_PRESENT_FRACTION = 0.02

// ──────────────────────────────────────────────────────────────────────────
//  CONSTANTES TUNEABLES — detección de perfil (detectProfile)
//  Pensadas sobre las features ya normalizadas (0..1 salvo uniqueColors).
// ──────────────────────────────────────────────────────────────────────────

/** uniqueColors por encima de esto = paleta "rica" (fotos/productos). */
export const COLORS_MANY = 1500
/** uniqueColors por debajo de esto = paleta "pobre" (logos). */
export const COLORS_FEW = 90

/** edgeDensity por encima de esto = textura por todos lados (foto). */
export const EDGE_DENSITY_PHOTO = 0.16
/** edgeDensity por debajo de esto = bordes filosos y escasos (logo). */
export const EDGE_DENSITY_SPARSE = 0.07

/** borderUniformity por encima de esto = fondo muy plano (logo/ilustración). */
export const BORDER_UNIFORM_HIGH = 0.7
/** borderUniformity por encima de esto = fondo plano-ish (producto). */
export const BORDER_UNIFORM_MID = 0.45

// ──────────────────────────────────────────────────────────────────────────
//  TABLA DE PERFILES — único lugar para tunear el comportamiento por perfil.
//  engine 'autoflat' = detectFlatBackground ? color : ai (se resuelve en runtime).
// ──────────────────────────────────────────────────────────────────────────

export const PROFILES: Record<Profile, ProfilePreset> = {
  foto: { engine: 'ai', matte: 'soft', defringe: 2, expandEdge: false, cleanHalo: 'gentle' },
  producto: { engine: 'ai', matte: 'medium', defringe: 1, expandEdge: false, cleanHalo: 'normal' },
  ilustracion: { engine: 'autoflat', matte: 'medium', defringe: 1, expandEdge: true, cleanHalo: 'normal' },
  logo: { engine: 'autoflat', matte: 'crisp', defringe: 0, expandEdge: true, cleanHalo: 'normal' }
}

// ──────────────────────────────────────────────────────────────────────────
//  ANÁLISIS DE CONTENIDO
// ──────────────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)] ?? 0
}

/**
 * Calcula features baratas para decidir el perfil. Downscalea a ANALYZE_SIZE
 * (lado mayor) preservando el aspecto, decodifica RGBA crudo y mide:
 *  - uniqueColors  (paleta cuantizada a COLOR_QUANT_BITS bits/canal)
 *  - edgeDensity   (fracción de píxeles con |Sobel(luma)| > umbral)
 *  - borderUniformity (fracción del borde cerca del color mediano)
 *  - hasAlpha      (alfa previa significativa)
 */
export async function analyzeContent(buf: Buffer): Promise<ContentFeatures> {
  // Decodificá una versión chica con alfa para velocidad. `inside` mantiene
  // el aspecto y nunca agranda (sin upscale de imágenes ya pequeñas).
  const { data, info } = await sharp(buf)
    .resize(ANALYZE_SIZE, ANALYZE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  const n = w * h

  // — uniqueColors: cuantizá a COLOR_QUANT_BITS y contá llaves distintas —
  const shift = 8 - COLOR_QUANT_BITS // ej. 4 bits → shift 4
  const seen = new Set<number>()
  // — luma para Sobel + acumuladores de alfa —
  const luma = new Float32Array(n)
  let alphaPresent = 0
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const a = data[i + 3]
    // Cuantizá SOLO píxeles visibles para no contar el "color" del transparente.
    if (a > ALPHA_PRESENT_THRESHOLD) {
      const key = ((r >> shift) << (2 * COLOR_QUANT_BITS)) | ((g >> shift) << COLOR_QUANT_BITS) | (b >> shift)
      seen.add(key)
    }
    if (a < 255 - ALPHA_PRESENT_THRESHOLD) alphaPresent++
    luma[p] = 0.299 * r + 0.587 * g + 0.114 * b
  }

  // — edgeDensity: Sobel sobre luma; contá píxeles con magnitud alta —
  let edgePixels = 0
  let interior = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      const tl = luma[p - w - 1]
      const tc = luma[p - w]
      const tr = luma[p - w + 1]
      const ml = luma[p - 1]
      const mr = luma[p + 1]
      const bl = luma[p + w - 1]
      const bc = luma[p + w]
      const br = luma[p + w + 1]
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl)
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr)
      const mag = Math.abs(gx) + Math.abs(gy) // L1 aprox de Sobel (barato)
      if (mag > EDGE_GRADIENT_THRESHOLD) edgePixels++
      interior++
    }
  }
  const edgeDensity = interior > 0 ? edgePixels / interior : 0

  // — borderUniformity: mismo método que detectFlatBackground sobre la chica —
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  const step = Math.max(1, Math.floor((2 * (w + h)) / 240))
  const at = (x: number, y: number): void => {
    const i = (y * w + x) * 4
    rs.push(data[i])
    gs.push(data[i + 1])
    bs.push(data[i + 2])
  }
  for (let x = 0; x < w; x += step) {
    at(x, 0)
    at(x, h - 1)
  }
  for (let y = 0; y < h; y += step) {
    at(0, y)
    at(w - 1, y)
  }
  const med: [number, number, number] = [median([...rs]), median([...gs]), median([...bs])]
  let close = 0
  for (let k = 0; k < rs.length; k++) {
    const dr = rs[k] - med[0]
    const dg = gs[k] - med[1]
    const db = bs[k] - med[2]
    if (Math.sqrt(dr * dr + dg * dg + db * db) < BORDER_NEAR_DIST) close++
  }
  const borderUniformity = rs.length > 0 ? close / rs.length : 0

  return {
    uniqueColors: seen.size,
    edgeDensity,
    borderUniformity,
    hasAlpha: n > 0 && alphaPresent / n > ALPHA_PRESENT_FRACTION
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  DETECCIÓN DE PERFIL
// ──────────────────────────────────────────────────────────────────────────

/**
 * Mapea features → perfil. Orden de decisión:
 *  1) foto:    muchos colores Y alta edgeDensity (textura por todos lados).
 *  2) logo:    pocos colores Y borde muy uniforme Y bordes filosos escasos.
 *  3) producto: muchos colores PERO fondo plano-ish (objeto sobre estudio).
 *  4) ilustracion: el resto (colores moderados, regiones planas, gradientes).
 * Si algo es ambiguo entre producto/foto, cae a foto (matte blando = seguro
 * para no aplastar pelo/detalle).
 */
export function detectProfile(f: ContentFeatures): Profile {
  const manyColors = f.uniqueColors >= COLORS_MANY
  const fewColors = f.uniqueColors <= COLORS_FEW
  const textured = f.edgeDensity >= EDGE_DENSITY_PHOTO
  const flatBorder = f.borderUniformity >= BORDER_UNIFORM_HIGH
  const midBorder = f.borderUniformity >= BORDER_UNIFORM_MID

  // El discriminador FUERTE es el BORDE, no la textura: una FOTO (persona/escena)
  // tiene fondo NO uniforme; un GRÁFICO (logo/ilustración/producto) está sobre un
  // fondo limpio. Cuidado: "bordes filosos" (un logo detallado como KIFA) NO es
  // lo mismo que "textura fotográfica" — por eso no ruteamos por edgeDensity sola.

  // 1) Fondo PLANO ⇒ gráfico sobre fondo limpio. El flood-fill por color anda
  //    genial (borde crisp + despill). Subclasificá por paleta:
  //      pocos colores  → logo (matte crisp)
  //      más colores    → ilustración (KIFA): igual va a color vía 'autoflat'.
  //    NO es foto aunque tenga muchos bordes filosos.
  if (flatBorder) return fewColors ? 'logo' : 'ilustracion'

  // 2) Producto: objeto de paleta rica sobre fondo estudio-ish (borde medio) y
  //    SIN textura por todos lados (no es escena). Va a IA con matte medio.
  if (midBorder && manyColors && !textured) return 'producto'

  // 3) Resto (fondo no uniforme = escena/foto-persona) ⇒ foto: IA + matte blando
  //    (preserva pelo). Es el caso por defecto y el más seguro.
  return 'foto'
}

/** Mapea el imageType de la UI a un perfil cuando NO es 'auto'. */
export function profileFromImageType(imageType: string): Profile | null {
  switch (imageType) {
    case 'persona':
      return 'foto'
    case 'logo':
      return 'logo'
    case 'ilustracion':
      return 'ilustracion'
    case 'producto':
      return 'producto'
    default:
      return null // 'auto' u otro → detectar por contenido
  }
}

/** Type-guard barato para validar un --profile pasado por CLI. */
export function isProfile(v: string): v is Profile {
  return v === 'logo' || v === 'ilustracion' || v === 'foto' || v === 'producto'
}

export type { ContentFeatures, MatteMode, Profile, ProfilePreset }
