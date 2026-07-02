import type { Ctx } from '../core/context'
import { SidecarError } from '../core/errors'
import { samEverything, AMG_DEFAULTS, type AmgResult } from '../core/amg'
import type { SamEncoderModel } from '../core/sam'

/**
 * `sam-everything` — "Segmentar todo" (SAM Automatic Mask Generator). Particiona
 * TODA la imagen en sus regiones (grilla de puntos → una máscara por región), como
 * la "Selección de objeto" de Affinity: el usuario elige después. A diferencia de
 * `sam-decode` (un click elige el objeto dominante), esto sí aísla regiones finas
 * si un punto de la grilla cae sobre ellas.
 *
 * Escribe en `outDir`: un PNG por máscara, `labelmap.png`/`.json` (índice de la
 * máscara top por pixel, para lookup O(1) en el click) y `summary.json`.
 */
export async function samEverythingCommand(
  opts: {
    imagePath: string
    outDir: string
    pointsPerSide?: number
    model?: SamEncoderModel
    cropLayers?: number
  },
  ctx: Ctx
): Promise<AmgResult> {
  if (!opts.imagePath) throw new SidecarError('E_ARG', 'Falta --image <ruta>.')
  if (!opts.outDir) throw new SidecarError('E_ARG', 'Falta --out-dir <carpeta>.')
  return samEverything(
    {
      ...AMG_DEFAULTS,
      imagePath: opts.imagePath,
      outDir: opts.outDir,
      pointsPerSide: opts.pointsPerSide ?? AMG_DEFAULTS.pointsPerSide,
      model: opts.model ?? AMG_DEFAULTS.model,
      cropLayers: opts.cropLayers ?? AMG_DEFAULTS.cropLayers
    },
    ctx
  )
}
