import { app, BrowserWindow, shell, type IpcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/types'

/**
 * Actualizaciones automáticas con GitHub Releases (repo público, sin token):
 *
 *  - AppImage (Linux): auto-update COMPLETO vía electron-updater — descarga en segundo
 *    plano y la UI ofrece "Reiniciar y actualizar" (quitAndInstall). El manifiesto
 *    latest-linux.yml lo genera electron-builder (bloque `publish` del yml) y el CI lo
 *    adjunta al Release.
 *  - Instalación .pacman o dev: electron-updater no puede instalar ahí → NOTIFICACIÓN:
 *    consultamos el último Release por la API de GitHub y, si hay versión nueva, la UI
 *    muestra "vX.Y.Z disponible" con link a la página de descarga.
 *
 * El estado viaja al renderer por 'upd:status' (push) y 'upd:get' (pull inicial).
 */

const REPO = 'fsaldivar-dev/sajaru-design'

let status: UpdateState = { state: 'idle', current: app.getVersion() }
let started = false

function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('upd:status', status)
}

function set(next: Partial<UpdateState>): void {
  status = { ...status, current: app.getVersion(), ...next }
  broadcast()
}

/** Comparación semver simple (mayor.menor.parche numéricos). >0 si a > b. */
function cmpVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

/** ¿Podemos auto-instalar? Solo AppImage empaquetado. (.pacman y dev → notificar.) */
const canAutoUpdate = (): boolean =>
  app.isPackaged && process.platform === 'linux' && Boolean(process.env.APPIMAGE)

/** Camino NOTIFICACIÓN: último release por la API pública de GitHub. 404 = todavía no
 *  hay releases → silencio (state 'none'), no es un error. */
async function checkViaGithub(): Promise<void> {
  set({ state: 'checking' })
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'sajaru-design' }
    })
    if (res.status === 404) {
      set({ state: 'none' })
      return
    }
    if (!res.ok) throw new Error(`GitHub respondió ${res.status}`)
    const j = (await res.json()) as { tag_name?: string; html_url?: string }
    const latest = String(j.tag_name ?? '').replace(/^v/, '')
    if (latest && cmpVersions(latest, app.getVersion()) > 0) {
      set({
        state: 'available-manual',
        latest,
        url: j.html_url ?? `https://github.com/${REPO}/releases/latest`
      })
    } else {
      set({ state: 'none' })
    }
  } catch (e) {
    // Sin red o rate-limit: silencioso — reintentamos en el próximo ciclo.
    set({ state: 'error', message: (e as Error).message })
  }
}

/** Camino AUTO (AppImage): electron-updater contra el Release de GitHub. */
function checkViaUpdater(): void {
  set({ state: 'checking' })
  void autoUpdater.checkForUpdates().catch((e: Error) => {
    // Si el manifiesto falla (release viejo sin latest-linux.yml, etc.), degradamos a
    // notificación por API: el usuario igual se entera de la versión nueva.
    set({ state: 'error', message: e.message })
    void checkViaGithub()
  })
}

export function checkForUpdates(): void {
  if (canAutoUpdate()) checkViaUpdater()
  else void checkViaGithub()
}

export function registerUpdaterIpc(ipcMain: IpcMain): void {
  ipcMain.handle('upd:get', () => status)
  ipcMain.handle('upd:check', () => {
    checkForUpdates()
    return status
  })
  ipcMain.handle('upd:install', () => {
    if (status.state !== 'ready') return { ok: false }
    // setImmediate: que el reply del IPC salga antes de bajar la app.
    setImmediate(() => autoUpdater.quitAndInstall())
    return { ok: true }
  })
  ipcMain.handle('upd:open', () => {
    void shell.openExternal(status.url ?? `https://github.com/${REPO}/releases/latest`)
    return { ok: true }
  })
}

export function startUpdater(): void {
  if (started) return
  started = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', latest: info.version, percent: 0 }))
  autoUpdater.on('update-not-available', () => set({ state: 'none' }))
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', latest: info.version }))
  autoUpdater.on('error', (e) => {
    set({ state: 'error', message: e.message })
    void checkViaGithub()
  })
  // Chequeo al arrancar (con respiro para no competir con el arranque) + cada 6 horas.
  // Solo empaquetado: en dev no molesta (el botón manual del pill sigue funcionando).
  if (app.isPackaged) {
    setTimeout(() => checkForUpdates(), 10_000)
    setInterval(() => checkForUpdates(), 6 * 60 * 60 * 1000)
  }
}
