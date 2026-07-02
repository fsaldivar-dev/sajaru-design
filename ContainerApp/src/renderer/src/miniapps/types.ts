import type { ComponentType } from 'react'
import type { MiniAppManifest } from '@shared/types'

/**
 * Una entrada del registro de mini apps.
 * `load` trae la UI de la mini app de forma diferida (lazy). Las entradas
 * 'coming-soon' todavía no tienen UI, por eso `load` es opcional.
 */
export interface MiniAppEntry {
  manifest: MiniAppManifest
  load?: () => Promise<{ default: ComponentType }>
}
