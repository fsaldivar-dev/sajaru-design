import type { Ctx } from '../core/context'
import { SidecarError } from '../core/errors'
import { cacheDir, downloadModel, listModels, removeModel } from '../core/models/manager'

export type ModelsSub = 'list' | 'download' | 'remove' | 'path'

/** `models list | download <id> | remove <id> | path` */
export async function modelsCommand(
  sub: ModelsSub,
  opts: { id?: string },
  ctx: Ctx
): Promise<unknown> {
  switch (sub) {
    case 'list':
      return { cacheDir: cacheDir(), models: listModels() }
    case 'path':
      return { cacheDir: cacheDir() }
    case 'download':
      if (!opts.id) throw new SidecarError('E_ARG', 'Falta el id. Ej: models download birefnet')
      return downloadModel(opts.id, ctx)
    case 'remove':
      if (!opts.id) throw new SidecarError('E_ARG', 'Falta el id. Ej: models remove birefnet')
      return removeModel(opts.id)
    default:
      throw new SidecarError('E_ARG', `Subcomando models inválido: ${String(sub)}`)
  }
}
