import type { Ctx } from '../core/context'
import type { CleanHaloMode } from '../core/types'
import {
  defaultOutputPath,
  dilateAlpha1px,
  fromRgbaRaw,
  readInput,
  toRgbaRaw,
  writeOutput
} from '../core/image'

export interface CleanHaloOptions {
  /** 0..100 — alpha below this % is forced fully transparent. */
  tolerance: number
  /** 0..100 — width of the soft ramp above the threshold. */
  softness: number
  /** Grow the opaque edge by 1px after cleaning. */
  expandEdge: boolean
  /**
   * Modo por perfil:
   *  - 'normal' (default): comportamiento actual.
   *  - 'gentle': umbral más suave → NO se come las semitransparencias del pelo.
   *  - 'off': no limpia halo (solo expandEdge si está activo).
   */
  mode?: CleanHaloMode
}

export interface CleanHaloResult {
  buffer: Buffer
  changedPixels: number
  grownPixels: number
}

// ──────────────────────────────────────────────────────────────────────────
//  CONSTANTES TUNEABLES — limpieza de halo por modo.
//  El umbral `lo` se deriva de la tolerancia de la UI; el FACTOR escala ese
//  umbral por modo. En 'gentle' bajamos el umbral para preservar pelo.
// ──────────────────────────────────────────────────────────────────────────

/** Multiplicador del umbral de tolerancia por modo (1 = sin cambio). */
const HALO_TOLERANCE_FACTOR: Record<Exclude<CleanHaloMode, 'off'>, number> = {
  normal: 1,
  // gentle: ~1/3 del umbral → solo mata el halo MUY tenue, deja el pelo.
  gentle: 0.34
}

/** Remove semi-transparent residual (halo) pixels left around a cut-out. */
export async function cleanHaloStep(
  buf: Buffer,
  opts: CleanHaloOptions,
  ctx: Ctx
): Promise<CleanHaloResult> {
  const mode: CleanHaloMode = opts.mode ?? 'normal'
  ctx.progress('clean-halo', 0.15, 'Decodificando alfa')
  const { data, width, height } = await toRgbaRaw(buf)

  let changed = 0
  if (mode !== 'off') {
    const factor = HALO_TOLERANCE_FACTOR[mode]
    const lo = Math.round((opts.tolerance / 100) * 255 * factor)
    const span = Math.max(1, Math.round((opts.softness / 100) * 64))
    const hi = Math.min(255, lo + span)

    ctx.progress('clean-halo', 0.45, mode === 'gentle' ? 'Limpiando halo (suave)' : 'Limpiando halo')
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i]
      if (a <= lo) {
        if (a !== 0) {
          data[i] = 0
          changed++
        }
      } else if (a < hi) {
        const t = (a - lo) / (hi - lo) // 0..1 soft ramp
        const na = Math.round(a * t)
        if (na !== a) {
          data[i] = na
          changed++
        }
      }
    }
  }

  let grown = 0
  if (opts.expandEdge) {
    ctx.progress('clean-halo', 0.7, 'Expandiendo borde +1px')
    grown = dilateAlpha1px(data, width, height)
  }

  ctx.progress('clean-halo', 0.9, 'Reescribiendo PNG')
  const buffer = await fromRgbaRaw(data, width, height)
  ctx.progress('clean-halo', 1)
  return { buffer, changedPixels: changed, grownPixels: grown }
}

export async function cleanHaloCommand(
  opts: { input: string; output?: string; tolerance: number; softness: number; expandEdge: boolean },
  ctx: Ctx
): Promise<{ output: string; changedPixels: number; grownPixels: number }> {
  const buf = await readInput(opts.input)
  const { buffer, changedPixels, grownPixels } = await cleanHaloStep(
    buf,
    { tolerance: opts.tolerance, softness: opts.softness, expandEdge: opts.expandEdge },
    ctx
  )
  const output = opts.output ?? defaultOutputPath(opts.input, 'clean')
  await writeOutput(output, buffer)
  return { output, changedPixels, grownPixels }
}
