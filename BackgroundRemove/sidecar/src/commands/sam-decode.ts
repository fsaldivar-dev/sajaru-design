import path from 'node:path'
import type { Ctx } from '../core/context'
import { SidecarError } from '../core/errors'
import { samDecode, type SamBox, type SamDecodeResult, type SamPoint } from '../core/sam'

/**
 * `sam-decode` — decodifica un embedding cacheado + un prompt (puntos/box) a las K
 * máscaras candidatas del multimask (cada una como PNG, tamaño original) + el
 * low-res (256x256) de la elegida para refinamiento iterativo estilo Affinity.
 *
 * Para refinar: pasá `maskInputPath` (el low-res del decode previo) + `hasMaskInput`
 * y SAM afina la forma con los puntos nuevos. `maskIndex` fuerza cuál de las K
 * candidatas es la "elegida" (ciclar formas); si no, se usa argmax(IoU).
 */
export async function samDecodeCommand(
  opts: {
    embeddingPath: string
    origW?: number
    origH?: number
    points?: SamPoint[]
    box?: SamBox
    outMaskPath?: string
    maskInputPath?: string
    hasMaskInput?: boolean
    maskIndex?: number
  },
  ctx: Ctx
): Promise<SamDecodeResult> {
  if ((!opts.points || opts.points.length === 0) && !opts.box) {
    throw new SidecarError('E_ARG', 'Falta el prompt: pasá --point <x>,<y> (repetible) o --box.')
  }
  const outMaskPath =
    opts.outMaskPath ??
    path.join(
      path.dirname(opts.embeddingPath),
      `${path.basename(opts.embeddingPath, path.extname(opts.embeddingPath))}.mask.png`
    )
  return samDecode(
    opts.embeddingPath,
    {
      origW: opts.origW ?? 0,
      origH: opts.origH ?? 0,
      points: opts.points,
      box: opts.box,
      maskInputPath: opts.maskInputPath,
      hasMaskInput: opts.hasMaskInput
    },
    outMaskPath,
    ctx,
    opts.maskIndex
  )
}
