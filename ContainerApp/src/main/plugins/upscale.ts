import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { BrowserWindow, clipboard, dialog, nativeImage, type IpcMain, type WebContents } from 'electron'
import type { BgProcessResult, UpscaleConfig } from '@shared/types'
import { runSidecar, tmpRoot } from './sidecar'

/**
 * Adapter de la mini app "Mejorar / Aumentar resolución": spawnea el comando
 * `enhance` del sidecar (upscale lanczos + nitidez, preserva alfa) y devuelve el
 * PNG agrandado a la UI. Mismo protocolo NDJSON vía el helper compartido.
 * El día que metamos un upscaler IA (Real-ESRGAN) cambia solo el sidecar.
 */

const PROGRESS_CHANNEL = 'ups:progress'
const TMP = 'sajaru-ups'

let currentInput: string | null = null
let currentChild: ChildProcess | null = null
let lastResult: { path: string; width: number; height: number } | null = null
let counter = 0

async function setImage(bytes: ArrayBuffer, name: string): Promise<void> {
  const ext = path.extname(name) || '.png'
  await fs.mkdir(tmpRoot(TMP), { recursive: true })
  const p = path.join(tmpRoot(TMP), `input${ext}`)
  await fs.writeFile(p, Buffer.from(bytes))
  currentInput = p
  lastResult = null
}

async function process(config: UpscaleConfig, sender: WebContents): Promise<BgProcessResult> {
  if (!currentInput) {
    return { ok: false, error: { code: 'E_NO_IMAGE', message: 'No hay imagen cargada' } }
  }
  if (currentChild) {
    currentChild.kill('SIGTERM')
    currentChild = null
  }

  const out = path.join(tmpRoot(TMP), `up-${++counter}.png`)
  const args = ['enhance', '-i', currentInput, '-o', out, '--scale', String(config.scale), '--method', config.method, '--events']
  if (!config.sharpen) args.push('--no-sharpen')

  const r = await runSidecar(args, sender, PROGRESS_CHANNEL, (c) => {
    currentChild = c
  })
  currentChild = null

  if (!r.ok) return { ok: false, error: r.error }
  try {
    const outPath = String(r.data?.output ?? out)
    const buf = await fs.readFile(outPath)
    const width = Number(r.data?.width ?? 0)
    const height = Number(r.data?.height ?? 0)
    lastResult = { path: outPath, width, height }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return { ok: true, bytes: ab, outputName: path.basename(outPath), format: 'png', data: { width, height } }
  } catch (e) {
    return { ok: false, error: { code: 'E_READ', message: (e as Error).message } }
  }
}

async function saveResult(suggestedName: string): Promise<{ saved: boolean; path?: string }> {
  if (!lastResult) return { saved: false }
  const win = BrowserWindow.getFocusedWindow()
  const opts = { defaultPath: suggestedName, filters: [{ name: 'PNG', extensions: ['png'] }] }
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, opts)
    : await dialog.showSaveDialog(opts)
  if (canceled || !filePath) return { saved: false }
  await fs.copyFile(lastResult.path, filePath)
  return { saved: true, path: filePath }
}

function copyResult(): { copied: boolean } {
  if (!lastResult) return { copied: false }
  const img = nativeImage.createFromPath(lastResult.path)
  if (img.isEmpty()) return { copied: false }
  clipboard.writeImage(img)
  return { copied: true }
}

export function registerUpscaleIpc(ipcMain: IpcMain): void {
  ipcMain.handle('ups:setImage', (_e, bytes: ArrayBuffer, name: string) => setImage(bytes, name))
  ipcMain.handle('ups:process', (e, config: UpscaleConfig) => process(config, e.sender))
  ipcMain.handle('ups:saveResult', (_e, name: string) => saveResult(name))
  ipcMain.handle('ups:copyResult', () => copyResult())
}
