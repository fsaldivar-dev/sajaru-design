import { app, shell, session, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { registerPluginIpc } from './ipc'
import { registerBackgroundRemoveIpc } from './plugins/background-remove'
import { registerVectorizeIpc } from './plugins/vectorize'
import { registerUpscaleIpc } from './plugins/upscale'
import { registerGenerateIpc } from './plugins/generate'
import { registerMockup3DIpc } from './plugins/mockup3d'
import { registerPrintPrepIpc } from './plugins/printprep'
import { registerEditorIpc } from './plugins/editor'
import { registerSegmentSelectIpc } from './plugins/segment-select'
import { registerRecraftIpc } from './plugins/recraft'
import { createSplash } from './splash'
import { registerUpdaterIpc, startUpdater } from './updater'

// Omarchy/Arch (Wayland/Hyprland): Chromium puede BLOQUEAR WebGL por la blocklist de
// GPU/Mesa y el visor 3D queda en NEGRO aunque el resto de la app funcione.
// - ignore-gpu-blocklist: habilita la GPU real cuando el driver es viable.
// - enable-unsafe-swiftshader: permite el fallback de WebGL por software si no lo es.
// Deben setearse ANTES de app.whenReady(). Solo Linux (en macOS/Windows no hace falta).
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
}

function createWindow(splash?: BrowserWindow, splashShownAt = 0): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'Sajaru Design',
    // Pre-pintado en el navy del tema oscuro (el default de la app) para no flashear blanco.
    backgroundColor: '#14161a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    const reveal = (): void => {
      win.show()
      if (splash && !splash.isDestroyed()) splash.close()
    }
    // Mantené el splash un mínimo de tiempo para que no "parpadee" si la app carga muy rápido.
    const MIN_SPLASH_MS = 1100
    const elapsed = splashShownAt ? Date.now() - splashShownAt : MIN_SPLASH_MS
    if (elapsed < MIN_SPLASH_MS) setTimeout(reveal, MIN_SPLASH_MS - elapsed)
    else reveal()
  })

  // Links externos -> navegador del sistema, nunca dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // En dev carga el server de Vite; en prod el HTML compilado.
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // CSP estricta solo en producción (en dev rompería el HMR de Vite).
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:"
          ]
        }
      })
    })
  }

  registerPluginIpc(ipcMain)
  registerBackgroundRemoveIpc(ipcMain)
  registerVectorizeIpc(ipcMain)
  registerUpscaleIpc(ipcMain)
  registerGenerateIpc(ipcMain)
  registerMockup3DIpc(ipcMain)
  registerPrintPrepIpc(ipcMain)
  registerEditorIpc(ipcMain)
  registerSegmentSelectIpc(ipcMain)
  registerRecraftIpc(ipcMain)
  registerUpdaterIpc(ipcMain)
  startUpdater()

  // Splash de arranque (estilo Ps/Corel) mientras el renderer principal monta.
  const splash = createSplash(app.getVersion())
  createWindow(splash, Date.now())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
