import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'

/**
 * Splash de arranque (estilo Photoshop / CorelDRAW): ventana chica, sin marco, con el logo
 * de marca + versión + barra de carga, mientras el renderer principal termina de montar.
 * Se muestra apenas la app abre y se cierra cuando la ventana principal está `ready-to-show`.
 *
 * El HTML va como `data:` URL (self-contained, sin problemas de rutas) y NO usa JavaScript
 * (solo CSS), así funciona bajo la CSP estricta de producción. Tema claro para que luzca el
 * logo (mascota navy + wordmark sobre los acentos teal/rosa de la marca).
 */

/** Devuelve el logo como data-URI (base64). En dev lo lee de build/, empaquetado de resources/. */
function logoDataUri(): string {
  try {
    const p = app.isPackaged
      ? path.join(process.resourcesPath, 'logo.png')
      : path.join(__dirname, '../../build/logo.png')
    return 'data:image/png;base64,' + readFileSync(p).toString('base64')
  } catch {
    return ''
  }
}

function splashHtml(version: string, logo: string): string {
  const logoImg = logo
    ? `<img src="${logo}" alt="Sajaru Design" style="height:210px;width:auto;object-fit:contain"/>`
    : `<div style="font-size:36px;font-weight:700;color:#2c303b">Sajaru Design</div>`
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #2c303b;
    background:
      radial-gradient(90% 70% at 12% 8%, rgba(82,154,157,0.16), transparent 60%),
      radial-gradient(90% 80% at 100% 100%, rgba(232,106,133,0.16), transparent 55%),
      #ffffff;
    -webkit-user-select: none; user-select: none;
  }
  .frame { position: absolute; inset: 0; border: 1px solid rgba(44,48,59,0.10); }
  .accent { position: absolute; top: 0; left: 0; right: 0; height: 5px;
    background: linear-gradient(90deg, #529a9d, #e86a85); }
  .wrap { position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; padding: 34px 40px 22px; }
  .head { display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; flex: 1; }
  .tag { font-size: 14px; color: #6b7080; font-weight: 500; }
  .foot { width: 100%; display: flex; flex-direction: column; gap: 11px; }
  .status { display: flex; align-items: center; justify-content: space-between;
    font-size: 12px; color: #8a8f9c; }
  .bar { position: relative; height: 4px; border-radius: 999px;
    background: rgba(44,48,59,0.08); overflow: hidden; }
  .bar::after { content: ''; position: absolute; top: 0; left: -40%; height: 100%; width: 40%;
    border-radius: 999px;
    background: linear-gradient(90deg, transparent, #529a9d 35%, #e86a85 65%, transparent);
    animation: slide 1.25s ease-in-out infinite; }
  @keyframes slide { 0% { left: -40%; } 100% { left: 100%; } }
  .copy { font-size: 11px; color: #a4a9b4; text-align: right; }
</style>
</head>
<body>
  <div class="accent"></div>
  <div class="frame"></div>
  <div class="wrap">
    <div class="head">
      ${logoImg}
      <div class="tag">Suite de sublimado y DTF</div>
    </div>
    <div class="foot">
      <div class="bar"></div>
      <div class="status"><span>Iniciando…</span><span>v${version}</span></div>
      <div class="copy">© Sajaru Design</div>
    </div>
  </div>
</body>
</html>`
}

/** Crea y muestra la ventana de splash. Devolvé el handle para cerrarlo cuando la app cargó. */
export function createSplash(version: string): BrowserWindow {
  const splash = new BrowserWindow({
    width: 560,
    height: 400,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    center: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#ffffff',
    title: 'Sajaru Design',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  splash.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(splashHtml(version, logoDataUri())))
  splash.once('ready-to-show', () => splash.show())
  return splash
}
