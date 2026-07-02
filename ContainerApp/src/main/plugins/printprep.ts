import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { BrowserWindow, dialog, type IpcMain, type WebContents } from 'electron'
import type { BgProcessResult, PrintPrepConfig } from '@shared/types'
import { runSidecar, tmpRoot } from './sidecar'

/**
 * Adapter de "Preparar Sublimación": deja la imagen lista para transfer
 * (tamaño físico + 300 DPI + espejo) vía el comando `print-prep` del sidecar.
 */
const PROGRESS_CHANNEL = 'pp:progress'
const TMP = 'sajaru-prep'

let currentInput: string | null = null
let currentChild: ChildProcess | null = null
let lastResult: { path: string; format: string } | null = null
let counter = 0

async function setImage(bytes: ArrayBuffer, name: string): Promise<void> {
  const ext = path.extname(name) || '.png'
  await fs.mkdir(tmpRoot(TMP), { recursive: true })
  const p = path.join(tmpRoot(TMP), `input${ext}`)
  await fs.writeFile(p, Buffer.from(bytes))
  currentInput = p
}

async function runPrep(config: PrintPrepConfig, sender: WebContents): Promise<BgProcessResult> {
  if (!currentInput) return { ok: false, error: { code: 'E_NO_IMAGE', message: 'No hay imagen cargada' } }
  if (currentChild) {
    currentChild.kill('SIGTERM')
    currentChild = null
  }
  const out = path.join(tmpRoot(TMP), `transfer-${++counter}.${config.format}`)
  const args = [
    'print-prep',
    '-i', currentInput,
    '-o', out,
    '--width-in', String(config.widthIn),
    '--height-in', String(config.heightIn),
    '--format', config.format,
    '--events'
  ]
  if (config.mirror) args.push('--mirror')

  const r = await runSidecar(args, sender, PROGRESS_CHANNEL, (c) => {
    currentChild = c
  })
  currentChild = null
  if (!r.ok) return { ok: false, error: r.error }
  try {
    const file = String(r.data?.output ?? out)
    const buf = await fs.readFile(file)
    lastResult = { path: file, format: config.format }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return {
      ok: true,
      bytes: ab,
      outputName: path.basename(file),
      format: config.format,
      data: { width: r.data?.width, height: r.data?.height, dpi: r.data?.dpi, mirror: r.data?.mirror }
    }
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

export function registerPrintPrepIpc(ipcMain: IpcMain): void {
  ipcMain.handle('pp:setImage', (_e, bytes: ArrayBuffer, name: string) => setImage(bytes, name))
  ipcMain.handle('pp:process', (e, config: PrintPrepConfig) => runPrep(config, e.sender))
  ipcMain.handle('pp:saveResult', (_e, name: string) => saveResult(name))
}
