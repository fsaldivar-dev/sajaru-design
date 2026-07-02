import { promises as fs } from 'node:fs'
import { BrowserWindow, clipboard, dialog, nativeImage, type IpcMain } from 'electron'

/**
 * Adapter mínimo del "Editor": la edición (ajustes/filtros/transformaciones) vive
 * en el canvas del renderer para preview en vivo; acá solo guardamos/copiamos los
 * bytes ya horneados que manda el renderer.
 */
async function save(bytes: ArrayBuffer, suggestedName: string): Promise<{ saved: boolean; path?: string }> {
  const win = BrowserWindow.getFocusedWindow()
  const opts = { defaultPath: suggestedName, filters: [{ name: 'PNG', extensions: ['png'] }] }
  const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (canceled || !filePath) return { saved: false }
  await fs.writeFile(filePath, Buffer.from(bytes))
  return { saved: true, path: filePath }
}

function copy(bytes: ArrayBuffer): { copied: boolean } {
  const img = nativeImage.createFromBuffer(Buffer.from(bytes))
  if (img.isEmpty()) return { copied: false }
  clipboard.writeImage(img)
  return { copied: true }
}

export function registerEditorIpc(ipcMain: IpcMain): void {
  ipcMain.handle('ed:save', (_e, bytes: ArrayBuffer, name: string) => save(bytes, name))
  ipcMain.handle('ed:copy', (_e, bytes: ArrayBuffer) => copy(bytes))
}
