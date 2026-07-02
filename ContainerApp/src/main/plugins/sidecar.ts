import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { app, type WebContents } from 'electron'

/**
 * Infra compartida para correr el sidecar CLI desde el main. Todos los plugins
 * (quitar fondo, vectorizar, upscale…) spawnean el mismo binario y hablan el
 * mismo protocolo NDJSON: progreso por stdout, resultado por stdout, errores
 * estructurados por stderr. Esto evita duplicar el parser en cada adapter.
 */

export interface RunOutcome {
  ok: boolean
  data?: { output?: string; format?: string; [k: string]: unknown }
  error?: { code: string; message: string }
}

export function sidecarEntry(): string {
  // Override manual (tests/CI).
  if (process.env.SAJARU_SIDECAR_ENTRY) return process.env.SAJARU_SIDECAR_ENTRY
  // Empaquetado: el sidecar viaja en `resources/sidecar` (ver electron-builder.yml,
  // extraResources). En dev vive en la carpeta hermana BackgroundRemove/sidecar.
  if (app.isPackaged) return path.join(process.resourcesPath, 'sidecar', 'dist', 'index.js')
  return path.resolve(__dirname, '../../../BackgroundRemove/sidecar/dist/index.js')
}

export function nodeBin(): string {
  return process.env.SAJARU_NODE ?? 'node'
}

/** Carpeta temporal por plugin (ej. 'sajaru-bg', 'sajaru-vec'). */
export function tmpRoot(sub: string): string {
  return path.join(os.tmpdir(), sub)
}

/**
 * Corre el sidecar con `args`, reenvía cada evento `progress` al renderer por
 * `progressChannel`, y resuelve con el evento `result` (o el `error` de stderr).
 * `onChild` permite al caller guardar el proceso para cancelarlo.
 */
export function runSidecar(
  args: string[],
  sender: WebContents,
  progressChannel: string,
  onChild?: (c: ChildProcess) => void
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(nodeBin(), [sidecarEntry(), ...args], { env: process.env })
    onChild?.(child)

    let stdout = ''
    let data: RunOutcome['data']
    let errorEvent: { code: string; message: string } | null = null

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t) continue
        try {
          const ev = JSON.parse(t)
          if (ev.type === 'progress') sender.send(progressChannel, ev)
          else if (ev.type === 'result') data = ev.data
        } catch {
          /* línea no-JSON: ignorar */
        }
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const ev = JSON.parse(t)
          if (ev.type === 'error') errorEvent = { code: ev.code, message: ev.message }
        } catch {
          /* log humano del sidecar */
        }
      }
    })

    child.on('error', (err) =>
      resolve({ ok: false, error: { code: 'E_SPAWN', message: err.message } })
    )
    child.on('close', (code) => {
      if (code === 0 && data) resolve({ ok: true, data })
      else
        resolve({
          ok: false,
          error: errorEvent ?? { code: 'E_EXIT', message: `El sidecar terminó con código ${code}` }
        })
    })
  })
}
