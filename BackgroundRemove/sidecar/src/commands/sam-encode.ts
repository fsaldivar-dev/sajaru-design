import type { Ctx } from '../core/context'
import { defaultOutputPath } from '../core/image'
import { samEncode, type SamEncoderModel, type SamEncodeResult } from '../core/sam'

/**
 * `sam-encode` — corre el encoder SAM elegido sobre una imagen y guarda el
 * embedding (1,256,64,64) + meta {origW,origH,model} en `outPath`. Caro: se hace
 * una vez por imagen; los clicks (`sam-decode`) reusan el embedding.
 *
 * `model`: 'mobilesam' (rápido, default) | 'sam-vitb' (preciso, encode más lento).
 * Ambos emiten el mismo embedding que consume el decoder MobileSAM (sin cambios).
 */
export async function samEncodeCommand(
  opts: { imagePath: string; outPath?: string; model?: SamEncoderModel },
  ctx: Ctx
): Promise<SamEncodeResult> {
  const outPath = opts.outPath ?? defaultOutputPath(opts.imagePath, 'sam-emb', 'bin')
  return samEncode(opts.imagePath, outPath, ctx, opts.model ?? 'mobilesam')
}
