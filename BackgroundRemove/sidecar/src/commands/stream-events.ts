import type { Ctx } from '../core/context'
import { setStreaming } from '../core/io'
import { runPipeline, type PipelineReport } from '../core/pipeline'
import type { PipelineOptions } from '../core/types'

/**
 * Runs the full pipeline on one image and ALWAYS streams NDJSON progress to
 * stdout — this is the entry Electron spawns for interactive, real-time UI.
 */
export async function streamEventsCommand(
  opts: { input: string; outDir?: string; pipeline: PipelineOptions },
  ctx: Ctx
): Promise<PipelineReport> {
  setStreaming(true)
  return runPipeline(opts.input, opts.pipeline, ctx, opts.outDir)
}
