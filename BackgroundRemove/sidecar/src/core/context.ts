import { emitProgress } from './io'

/**
 * Run context handed to every step. `progress` reports 0..1 for the step;
 * `signal` lets long work be cancelled (Electron kills the process, but steps
 * can also bail early).
 */
export interface Ctx {
  progress: (stage: string, value: number, message?: string) => void
  signal: AbortSignal
}

export function rootCtx(signal: AbortSignal): Ctx {
  return { progress: emitProgress, signal }
}

/**
 * Child context whose 0..1 progress is remapped into [start, end] of the parent
 * under a fixed stage name. Used by the pipeline so each step occupies a slice
 * of the overall bar.
 */
export function subCtx(parent: Ctx, stage: string, start: number, end: number): Ctx {
  return {
    signal: parent.signal,
    progress: (_childStage, value, message) =>
      parent.progress(stage, start + (end - start) * value, message)
  }
}

export function throwIfAborted(ctx: Ctx): void {
  if (ctx.signal.aborted) {
    throw new Error('Cancelado')
  }
}
