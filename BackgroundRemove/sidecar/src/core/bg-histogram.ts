import sharp from 'sharp'

/**
 * MODELO DE COLOR DEL FONDO VERDADERO — para que el renderer detecte "restos de
 * fondo" (objetos que el matte dejó pegados entre/dentro de los sujetos, ej. el
 * locker entre dos personas).
 *
 * POR QUÉ ACÁ (y no en el renderer): el modelo de fondo limpio = los colores de
 * la FUENTE donde el matte está REMOVIDO (alfa < 26 = fondo verdadero). En el
 * sidecar la FUENTE y el MATTE están ALINEADOS (mismo frame, antes del auto-crop
 * + upscale), así que el modelo sale limpio. En el renderer NO: el lienzo borra el
 * RGB del fondo (queda en 0/negro) y la fuente está des-alineada por el auto-crop
 * y el upscale del input — por eso construir el histograma allá daba falsos
 * positivos sobre las personas (validado en datos reales: locker 0.38 PERO
 * personas 0.66-0.73). El histograma del FONDO VERDADERO separa limpio:
 * locker avgBgMatch≈0.21 vs personas≈0.01.
 *
 * Un histograma de color es una DISTRIBUCIÓN (independiente del frame/posiciones),
 * así que pasárselo al renderer evita todo el mapeo de coordenadas: el renderer
 * sigue tomando el COLOR de cada región del lienzo (los pixeles conservados tienen
 * su RGB original) y lo consulta contra esta distribución.
 *
 * Binning EXACTO igual al renderer (ResultPanel.bgBinOf / BG_BINS): 24 bins por
 * canal, bin = (v*24)>>8 (= floor(v/256*24)), idx = (binR*24+binG)*24+binB.
 * El histograma se normaliza por el total de pixeles de fondo → frecuencias 0..1.
 */

/** Bins por canal del histograma de color (24³ = 13824 bins). Debe coincidir con el renderer. */
export const BG_BINS = 24

/** Umbral de alfa: < este valor = FONDO VERDADERO (matte removido). Coincide con el renderer. */
export const BG_REMOVED_ALPHA = 26

/** bin de un canal 0..255 → 0..BG_BINS-1. floor(v/256*BG_BINS) vía shift (= (v*24)>>8). */
function binOf(v: number): number {
  const b = (v * BG_BINS) >> 8
  return b < 0 ? 0 : b > BG_BINS - 1 ? BG_BINS - 1 : b
}

/** Histograma 24³ del fondo verdadero + su frecuencia máxima (para el bg-match del renderer). */
export interface BgHistogram {
  /** 24³ = 13824 frecuencias (0..1), normalizadas por el total de pixeles de fondo. */
  hist: Float32Array
  /** Frecuencia del bin más poblado (denominador del bg-match: freq/maxFreq*3). */
  maxFreq: number
  /** # de pixeles de fondo verdadero muestreados (alfa < BG_REMOVED_ALPHA). */
  bgPixels: number
  /** # de bins con frecuencia > 0 (sanidad: un histograma degenerado tiene poquísimos). */
  nonZeroBins: number
}

/**
 * Construye el histograma 24³ del FONDO VERDADERO a partir de dos buffers RGBA
 * crudos YA ALINEADOS (mismo W×H, mismo frame): `srcRgba` (RGB de la FUENTE) y
 * `matteRgba` (cuyo canal alfa es el matte). Muestrea el color de la fuente en los
 * pixeles donde el matte está removido (alfa < BG_REMOVED_ALPHA) → la distribución
 * de colores del fondo real (lockers/pared/piso), sin contaminación del sujeto.
 *
 * NO toca disco ni re-decodea: opera sobre los typed arrays que el caller ya tiene.
 */
export function buildBgHistogramFromRaw(
  srcRgba: Buffer,
  matteRgba: Buffer,
  width: number,
  height: number
): BgHistogram {
  const n = width * height
  const hist = new Float32Array(BG_BINS * BG_BINS * BG_BINS)
  let bgPixels = 0
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (matteRgba[d + 3] < BG_REMOVED_ALPHA) {
      const k = (binOf(srcRgba[d]) * BG_BINS + binOf(srcRgba[d + 1])) * BG_BINS + binOf(srcRgba[d + 2])
      hist[k] += 1
      bgPixels++
    }
  }
  let maxFreq = 0
  let nonZeroBins = 0
  if (bgPixels > 0) {
    for (let k = 0; k < hist.length; k++) {
      if (hist[k] > 0) {
        hist[k] /= bgPixels
        nonZeroBins++
        if (hist[k] > maxFreq) maxFreq = hist[k]
      }
    }
  }
  return { hist, maxFreq, bgPixels, nonZeroBins }
}

/**
 * Igual que `buildBgHistogramFromRaw` pero tomando el COLOR de la fuente original
 * (`srcBuf`, el buffer de entrada al quita-fondo) y el ALFA del recorte ya
 * compuesto (`compositedRgba`, RGBA crudo). Decodea `srcBuf` al MISMO tamaño que
 * el recorte (deben venir alineados: mismo frame, antes de auto-crop). Útil cuando
 * el caller tiene el buffer fuente y el RGBA con el matte por separado.
 */
export async function buildBgHistogram(
  srcBuf: Buffer,
  compositedRgba: Buffer,
  width: number,
  height: number
): Promise<BgHistogram> {
  // RGB de la FUENTE por su stride real (sharp puede devolver !=3 canales).
  const src = await sharp(srcBuf, { limitInputPixels: false })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  const sch = src.info.channels
  const n = width * height
  const hist = new Float32Array(BG_BINS * BG_BINS * BG_BINS)
  let bgPixels = 0
  for (let i = 0; i < n; i++) {
    if (compositedRgba[i * 4 + 3] < BG_REMOVED_ALPHA) {
      const s = i * sch
      const k = (binOf(src.data[s]) * BG_BINS + binOf(src.data[s + 1])) * BG_BINS + binOf(src.data[s + 2])
      hist[k] += 1
      bgPixels++
    }
  }
  let maxFreq = 0
  let nonZeroBins = 0
  if (bgPixels > 0) {
    for (let k = 0; k < hist.length; k++) {
      if (hist[k] > 0) {
        hist[k] /= bgPixels
        nonZeroBins++
        if (hist[k] > maxFreq) maxFreq = hist[k]
      }
    }
  }
  return { hist, maxFreq, bgPixels, nonZeroBins }
}

/**
 * Serializa el histograma a base64 (Float32 little-endian) para viajar en el JSON
 * del report → plugin → renderer sin romper el stream NDJSON. ~13824 floats = 54KB
 * crudos → ~72KB en base64 (se computa 1 sola vez por bg-removal).
 */
export function serializeBgHistogram(h: BgHistogram): SerializedBgHistogram {
  const buf = Buffer.from(h.hist.buffer, h.hist.byteOffset, h.hist.byteLength)
  return {
    bins: BG_BINS,
    maxFreq: h.maxFreq,
    bgPixels: h.bgPixels,
    nonZeroBins: h.nonZeroBins,
    histB64: buf.toString('base64')
  }
}

/** Forma serializable del histograma de fondo (en el report del pipeline). */
export interface SerializedBgHistogram {
  /** Bins por canal (24). El renderer valida que coincida con su BG_BINS. */
  bins: number
  maxFreq: number
  bgPixels: number
  nonZeroBins: number
  /** Float32Array(bins³) en base64 (little-endian). */
  histB64: string
}
