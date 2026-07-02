import type { ErrorEnvelope, ProgressEvent, ResultEnvelope } from './types'

/**
 * stdout = JSON only. stderr = human logs + errors.
 *
 * When streaming (--events): every event is one NDJSON line on stdout, ending
 * with a `result` (or `error`) line. Without --events: a single pretty JSON
 * object is printed and there are no progress lines.
 */

let streaming = false
export function setStreaming(on: boolean): void {
  streaming = on
}
export function isStreaming(): boolean {
  return streaming
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function writeStdoutLine(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/** Progress -> stdout NDJSON, only when streaming. No-op otherwise. */
export function emitProgress(stage: string, progress: number, message?: string): void {
  if (!streaming) return
  const ev: ProgressEvent = { type: 'progress', stage, progress: clamp01(progress) }
  if (message !== undefined) ev.message = message
  writeStdoutLine(ev)
}

/** Final success -> stdout. NDJSON line when streaming, pretty object otherwise. */
export function emitResult<T>(command: string, data: T): void {
  if (streaming) {
    const ev: ResultEnvelope<T> = { type: 'result', ok: true, command, data }
    writeStdoutLine(ev)
  } else {
    process.stdout.write(JSON.stringify({ ok: true, command, data }, null, 2) + '\n')
  }
}

/** Error -> stderr (always JSON). Never touches stdout. */
export function emitError(command: string, code: string, message: string, detail?: unknown): void {
  const env: ErrorEnvelope = { type: 'error', ok: false, command, code, message }
  if (detail !== undefined) env.detail = detail
  process.stderr.write(JSON.stringify(env) + '\n')
}

/** Human-readable logs -> stderr, to keep stdout a pure JSON stream. */
export function log(...args: unknown[]): void {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  process.stderr.write(line + '\n')
}
