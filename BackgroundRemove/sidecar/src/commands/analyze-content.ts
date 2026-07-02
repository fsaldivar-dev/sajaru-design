import type { Ctx } from '../core/context'
import { analyzeContent, detectProfile, PROFILES } from '../core/content'
import { readInput } from '../core/image'
import { detectFlatBackground } from './remove-bg-color'
import type { ContentFeatures, Profile, ProfilePreset } from '../core/types'

export interface AnalyzeContentResult {
  features: ContentFeatures
  /** Perfil que elegiría el ruteo automático. */
  profile: Profile
  /** Preset que aplicaría ese perfil (motor, matte, etc.). */
  preset: ProfilePreset
  /** ¿detectFlatBackground? (lo que decide 'autoflat' → color vs ai). */
  flatBackground: boolean
}

/**
 * Comando debug: imprime las features de contenido + el perfil detectado + el
 * preset que aplicaría. Sirve para tunear los thresholds con imágenes reales.
 */
export async function analyzeContentCommand(
  opts: { input: string },
  ctx: Ctx
): Promise<AnalyzeContentResult> {
  ctx.progress('analyze-content', 0.2, 'Decodificando y midiendo contenido')
  const buf = await readInput(opts.input)
  const features = await analyzeContent(buf)
  const profile = detectProfile(features)
  ctx.progress('analyze-content', 0.8, 'Detectando fondo plano')
  const flatBackground = await detectFlatBackground(buf)
  ctx.progress('analyze-content', 1, `Perfil: ${profile}`)
  return { features, profile, preset: PROFILES[profile], flatBackground }
}
