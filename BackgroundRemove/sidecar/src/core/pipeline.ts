import path from 'node:path'
import { analyzeStep } from '../commands/analyze'
import { autoCropStep } from '../commands/auto-crop'
import { bgFillStep } from '../commands/bg-fill'
import { cleanHaloStep } from '../commands/clean-halo'
import { enhanceStep } from '../commands/enhance'
import { exportStep } from '../commands/export'
import { fixColorStep } from '../commands/fix-color'
import { fixDpiStep } from '../commands/fix-dpi'
import { removeBackground } from '../commands/remove-bg'
import { detectFlatBackground } from '../commands/remove-bg-color'
import { upscaleInputStep } from '../commands/upscale-input'
import { analyzeContent, detectProfile, PROFILES, profileFromImageType } from './content'
import { subCtx, throwIfAborted, type Ctx } from './context'
import { bufferInfo, readInput, writeOutput } from './image'
import { DEFAULT_MODEL } from './models/registry'
import type { Profile, ProfilePreset, PipelineOptions, PipelineStep } from './types'

// — Auto-upscale del input de BAJA resolución (antes de quitar el fondo) —
// Tuneables. Sólo se dispara cuando el lado mayor del input < UPSCALE_BELOW;
// imágenes que ya son grandes (foto/personas) son NO-OP y su camino IA queda
// intacto.
/** Umbral de "baja resolución": si el lado mayor del input es menor a esto, se sube. */
const UPSCALE_BELOW = 1000
/** Lado mayor objetivo al subir un input chico (sin pasarse de este valor). */
const UPSCALE_TARGET = 1800

export function defaultSteps(enhance: boolean): PipelineStep[] {
  // 'upscale-input' va ANTES de 'remove-bg': sube logos chicos para keyear con
  // bordes limpios. Es NO-OP si el input ya es grande o si autoUpscaleLowRes=off,
  // así que listarlo siempre es inofensivo (y el container puede ignorar el id).
  const steps: PipelineStep[] = ['analyze', 'upscale-input', 'remove-bg', 'clean-halo', 'fix-color']
  // auto-crop usa el alfa → va ANTES de bg-fill (que lo aplana). Ambos siempre se
  // listan: cada step decide internamente si aplica (no-op si autoCrop/bgFill off).
  steps.push('auto-crop', 'bg-fill')
  if (enhance) steps.push('enhance')
  // El espejo para sublimación NO va acá: vive en "Preparar Sublimación" (toggle
  // Espejo). Quitar Fondo solo recorta — así no hay riesgo de doble espejo.
  steps.push('fix-dpi', 'export')
  return steps
}

export const DEFAULT_STEPS = defaultSteps(false)

export function resolvePipelineOptions(p: Partial<PipelineOptions>): PipelineOptions {
  const enhance = p.enhance ?? false
  return {
    product: p.product ?? 'playera',
    imageType: p.imageType ?? 'auto',
    // undefined = inferir el perfil (imageType o análisis); set = forzarlo.
    profile: p.profile,
    model: p.model ?? DEFAULT_MODEL,
    edgeMode: p.edgeMode ?? 'suave',
    softness: p.softness ?? 10,
    bgTolerance: p.bgTolerance ?? 10,
    contract: p.contract ?? 0,
    removeBgProvider: p.removeBgProvider ?? 'local',
    autoCrop: p.autoCrop ?? false,
    bgFill: p.bgFill ?? 'transparent',
    cleanArtifacts: p.cleanArtifacts ?? true,
    expandEdge: p.expandEdge ?? true,
    force300: p.force300 ?? true,
    upscaleIfLow: p.upscaleIfLow ?? true,
    autoUpscaleLowRes: p.autoUpscaleLowRes ?? true,
    enhance,
    format: p.format ?? 'png',
    steps: p.steps && p.steps.length ? p.steps : defaultSteps(enhance)
  }
}

export interface PipelineReport {
  input: string
  output: string | null
  dpi: number
  format: string
  steps: Array<{ step: PipelineStep; data: unknown }>
}

/**
 * Decide el PERFIL del contenido para rutear el quita-fondo:
 *  1) opts.profile (override explícito, ej. CLI --profile) gana.
 *  2) imageType != 'auto' → mapeo directo (persona→foto, logo→logo, …).
 *  3) 'auto' → analizar el contenido (paleta + textura + borde).
 */
async function resolveProfile(buffer: Buffer, opts: PipelineOptions): Promise<Profile> {
  if (opts.profile) return opts.profile
  const mapped = profileFromImageType(opts.imageType)
  if (mapped) return mapped
  return detectProfile(await analyzeContent(buffer))
}

/**
 * Runs the configured steps in order, threading one image buffer through them.
 * Each step gets a progress slice so the overall bar advances smoothly.
 */
export async function runPipeline(
  inputPath: string,
  opts: PipelineOptions,
  ctx: Ctx,
  outDir?: string
): Promise<PipelineReport> {
  const steps = opts.steps.length ? opts.steps : DEFAULT_STEPS
  let buffer = await readInput(inputPath)
  const report: PipelineReport = {
    input: inputPath,
    output: null,
    dpi: 300,
    format: opts.format,
    steps: []
  }

  // Perfil + preset resueltos en el paso 'remove-bg' y reusados por 'clean-halo'
  // (mismo perfil para todo el pipeline). Si 'remove-bg' no corre, 'clean-halo'
  // los resuelve perezosamente con el buffer que tenga.
  let preset: ProfilePreset | null = null
  const ensurePreset = async (): Promise<ProfilePreset> => {
    if (!preset) preset = PROFILES[await resolveProfile(buffer, opts)]
    return preset
  }

  const n = steps.length
  for (let idx = 0; idx < n; idx++) {
    throwIfAborted(ctx)
    const step = steps[idx]
    const c = subCtx(ctx, step, idx / n, (idx + 1) / n)

    switch (step) {
      case 'analyze': {
        const r = await analyzeStep(inputPath, c)
        report.steps.push({ step, data: r })
        break
      }
      case 'upscale-input': {
        // Gate: sólo subir si está habilitado Y el input es de baja resolución.
        // En imágenes grandes (foto/personas) esto es NO-OP → el camino IA del
        // perfil personas queda intacto.
        const info = await bufferInfo(buffer)
        const maxSide = Math.max(info.width, info.height)
        if (opts.autoUpscaleLowRes && maxSide > 0 && maxSide < UPSCALE_BELOW) {
          const r = await upscaleInputStep(buffer, UPSCALE_TARGET, c)
          buffer = r.buffer
          report.steps.push({
            step,
            data: {
              upscaled: r.upscaled,
              fromW: r.fromW,
              fromH: r.fromH,
              toW: r.toW,
              toH: r.toH,
              method: r.method
            }
          })
        } else {
          // NO-OP: registrá igual para que los eventos muestren upscaled:false.
          report.steps.push({
            step,
            data: {
              upscaled: false,
              fromW: info.width,
              fromH: info.height,
              toW: info.width,
              toH: info.height,
              method: null
            }
          })
        }
        break
      }
      case 'remove-bg': {
        const profile = await resolveProfile(buffer, opts)
        preset = PROFILES[profile]

        // Resolvé el motor del preset. 'autoflat' = detectFlatBackground ? color
        // : ai → una foto con pared lisa cae a IA (la textura interna manda),
        // pero un logo/ilustración sobre fondo plano usa flood-fill por color.
        let engine: 'ai' | 'color'
        if (preset.engine === 'autoflat') {
          engine = (await detectFlatBackground(buffer)) ? 'color' : 'ai'
        } else {
          engine = preset.engine
        }

        const r = await removeBackground(
          buffer,
          {
            // El provider recraft (IA premium) ignora `method` y resuelve aparte.
            method: engine,
            model: opts.model,
            tolerance: opts.bgTolerance,
            softness: opts.softness,
            edgeMode: opts.edgeMode,
            contract: opts.contract,
            provider: opts.removeBgProvider,
            // El matte del preset aplica al camino IA local; el de COLOR ya es
            // "crisp" por construcción (flood-fill + despill).
            matte: preset.matte,
            defringe: preset.defringe,
            // TIPO = Persona → matting de cabello (MODNet): recupera hebras finas que
            // BiRefNet aplana. Local-only; recraft (premium) lo ignora y resuelve aparte.
            matting: opts.imageType === 'persona'
          },
          c
        )
        buffer = r.buffer
        // Reportá qué decidió: perfil, motor real y modo de matte. Adjuntá el
        // MODELO DE COLOR DEL FONDO VERDADERO (histograma 24³ del RGB de la fuente
        // donde el matte está removido): el renderer lo usa para detectar "restos
        // de fondo" sin reconstruirlo del lienzo (que tiene el RGB removido en 0) ni
        // de la fuente des-alineada. Serializado en base64 (no rompe el NDJSON).
        report.steps.push({
          step,
          data: {
            profile,
            engine: r.method,
            matte: preset.matte,
            imageType: opts.imageType,
            bgHistogram: r.bgHistogram
          }
        })
        break
      }
      case 'clean-halo': {
        const p = await ensurePreset()
        const r = await cleanHaloStep(
          buffer,
          {
            tolerance: opts.bgTolerance,
            softness: opts.softness,
            // expandEdge del preset (en foto NO dilatar, para no tapar el pelo).
            expandEdge: opts.expandEdge && p.expandEdge,
            mode: p.cleanHalo
          },
          c
        )
        buffer = r.buffer
        report.steps.push({
          step,
          data: { changedPixels: r.changedPixels, grownPixels: r.grownPixels, cleanHalo: p.cleanHalo, expandEdge: opts.expandEdge && p.expandEdge }
        })
        break
      }
      case 'fix-color': {
        const r = await fixColorStep(buffer, c)
        buffer = r.buffer
        report.steps.push({ step, data: { from: r.from, to: r.to, converted: r.converted } })
        break
      }
      case 'auto-crop': {
        const r = await autoCropStep(buffer, { alphaThreshold: 0 }, c)
        buffer = r.buffer
        report.steps.push({ step, data: { cropped: r.cropped, width: r.width, height: r.height } })
        break
      }
      case 'bg-fill': {
        const r = await bgFillStep(buffer, opts.bgFill, c)
        buffer = r.buffer
        report.steps.push({ step, data: { filled: r.filled, fill: r.fill } })
        break
      }
      case 'enhance': {
        const r = await enhanceStep(buffer, { scale: 2, sharpen: true, method: 'classic' }, c)
        buffer = r.buffer
        report.steps.push({ step, data: { width: r.width, height: r.height, scale: r.scale } })
        break
      }
      case 'fix-dpi': {
        const r = await fixDpiStep(
          buffer,
          { target: 300, upscaleIfLow: opts.upscaleIfLow, printWidthIn: null },
          c
        )
        buffer = r.buffer
        report.dpi = r.dpi
        report.steps.push({ step, data: { dpi: r.dpi, upscaled: r.upscaled, width: r.width, height: r.height } })
        break
      }
      case 'export': {
        const r = await exportStep(buffer, { format: opts.format, dpi: report.dpi || 300 }, c)
        buffer = r.buffer
        const dir = outDir ?? path.dirname(inputPath)
        const base = path.basename(inputPath, path.extname(inputPath))
        const output = path.join(dir, `${base}.final.${opts.format}`)
        await writeOutput(output, buffer)
        report.output = output
        report.steps.push({ step, data: { output, format: r.format, dpi: r.dpi } })
        break
      }
    }
  }

  return report
}
