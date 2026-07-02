import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { BrowserWindow, clipboard, dialog, nativeImage, type IpcMain, type WebContents } from 'electron'
import type { BgProcessResult, GenerateConfig } from '@shared/types'
import { runSidecar, tmpRoot } from './sidecar'

/**
 * Adapter de la mini app "Crear Diseño": genera imágenes con Recraft (IA premium)
 * vía el comando `generate` del sidecar. Salida SVG (modelos *_vector) o PNG.
 * La API key vive en la env RECRAFT_API_TOKEN o en ~/.sajaru/recraft.key.
 */
const PROGRESS_CHANNEL = 'gen:progress'
const TMP = 'sajaru-gen'

let currentChild: ChildProcess | null = null
let lastResult: { path: string; format: string } | null = null
let counter = 0

function hasApiKey(): boolean {
  if ((process.env.RECRAFT_API_TOKEN || process.env.RECRAFT_API_KEY || '').trim()) return true
  return existsSync(path.join(os.homedir(), '.sajaru', 'recraft.key'))
}

async function runGenerate(config: GenerateConfig, sender: WebContents): Promise<BgProcessResult> {
  if (currentChild) {
    currentChild.kill('SIGTERM')
    currentChild = null
  }
  const vector = config.model.includes('vector')
  const ext = vector ? 'svg' : 'png'
  await fs.mkdir(tmpRoot(TMP), { recursive: true })
  const out = path.join(tmpRoot(TMP), `gen-${++counter}.${ext}`)
  const args = ['generate', '--prompt', config.prompt, '--model', config.model, '--size', config.size, '-o', out, '--events']
  if (config.style) args.push('--style', config.style)

  const r = await runSidecar(args, sender, PROGRESS_CHANNEL, (c) => {
    currentChild = c
  })
  currentChild = null
  if (!r.ok) return { ok: false, error: r.error }
  try {
    const outputs = (r.data?.outputs as string[] | undefined) ?? [out]
    const file = outputs[0] ?? out
    const buf = await fs.readFile(file)
    lastResult = { path: file, format: ext }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return { ok: true, bytes: ab, outputName: path.basename(file), format: ext }
  } catch (e) {
    return { ok: false, error: { code: 'E_READ', message: (e as Error).message } }
  }
}

async function saveResult(suggestedName: string): Promise<{ saved: boolean; path?: string }> {
  if (!lastResult) return { saved: false }
  const ext = lastResult.format
  const win = BrowserWindow.getFocusedWindow()
  const opts = { defaultPath: suggestedName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] }
  const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (canceled || !filePath) return { saved: false }
  await fs.copyFile(lastResult.path, filePath)
  return { saved: true, path: filePath }
}

function copyResult(): { copied: boolean } {
  if (!lastResult || lastResult.format !== 'png') return { copied: false }
  const img = nativeImage.createFromPath(lastResult.path)
  if (img.isEmpty()) return { copied: false }
  clipboard.writeImage(img)
  return { copied: true }
}

export function registerGenerateIpc(ipcMain: IpcMain): void {
  ipcMain.handle('gen:process', (e, config: GenerateConfig) => runGenerate(config, e.sender))
  ipcMain.handle('gen:saveResult', (_e, name: string) => saveResult(name))
  ipcMain.handle('gen:copyResult', () => copyResult())
  ipcMain.handle('gen:hasApiKey', () => hasApiKey())
}
