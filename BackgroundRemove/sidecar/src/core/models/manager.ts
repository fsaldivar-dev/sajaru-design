import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Ctx } from '../context'
import { SidecarError } from '../errors'
import { DEFAULT_MODEL, MODELS, findModel, type ModelDef } from './registry'

/** Where model files live. Override with SAJARU_MODELS_DIR (e.g. app userData). */
export function cacheDir(): string {
  return process.env.SAJARU_MODELS_DIR || path.join(os.homedir(), '.sajaru', 'models')
}

export function getModel(id: string): ModelDef {
  const def = findModel(id)
  if (!def) {
    throw new SidecarError('E_MODEL_UNKNOWN', `Modelo desconocido: ${id}. Usá "models list".`)
  }
  return def
}

export function modelPath(id: string): string {
  return path.join(cacheDir(), getModel(id).fileName)
}

export function isDownloaded(id: string): boolean {
  return existsSync(modelPath(id))
}

export interface ModelStatus extends ModelDef {
  downloaded: boolean
  path: string
  default: boolean
}

export function listModels(): ModelStatus[] {
  const dir = cacheDir()
  return MODELS.map((m) => ({
    ...m,
    downloaded: existsSync(path.join(dir, m.fileName)),
    path: path.join(dir, m.fileName),
    default: m.id === DEFAULT_MODEL
  }))
}

export async function downloadModel(
  id: string,
  ctx: Ctx
): Promise<{ id: string; path: string; bytes: number }> {
  const def = getModel(id)
  await fs.mkdir(cacheDir(), { recursive: true })
  const dest = modelPath(id)
  const tmp = `${dest}.part`

  ctx.progress('download', 0, `Descargando ${def.name} (~${def.sizeMB} MB)`)
  const res = await fetch(def.url).catch((e) => {
    throw new SidecarError('E_MODEL_DOWNLOAD', `Fallo de red descargando ${def.url}`, String(e))
  })
  if (!res.ok || !res.body) {
    throw new SidecarError('E_MODEL_DOWNLOAD', `No se pudo descargar ${def.url} (HTTP ${res.status})`)
  }

  const total = Number(res.headers.get('content-length') ?? 0)
  const file = await fs.open(tmp, 'w')
  let received = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (ctx.signal.aborted) throw new SidecarError('E_CANCELLED', 'Descarga cancelada')
      const b = Buffer.from(chunk)
      await file.write(b)
      received += b.length
      if (total > 0) {
        ctx.progress(
          'download',
          received / total,
          `${(received / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB`
        )
      }
    }
  } finally {
    await file.close()
  }

  await fs.rename(tmp, dest)
  ctx.progress('download', 1, 'Descarga completa')
  return { id, path: dest, bytes: received }
}

export async function removeModel(id: string): Promise<{ id: string; removed: boolean }> {
  const p = modelPath(id)
  if (!existsSync(p)) return { id, removed: false }
  await fs.rm(p, { force: true })
  return { id, removed: true }
}
