import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { BrowserWindow, clipboard, dialog, nativeImage, type IpcMain, type WebContents } from 'electron'
import type { BgProcessResult, RgbColor, VectorAreaMode, VectorizeConfig } from '@shared/types'
import { runSidecar, tmpRoot } from './sidecar'

/**
 * Adapter de la mini app "Vectorizar": spawnea el comando `vectorize` del
 * sidecar (Potrace + separación de capas de color) y devuelve el PNG rasterizado a la
 * UI, guardando también el SVG vectorial para exportar. Mismo protocolo NDJSON
 * que los demás plugins, vía el helper compartido `sidecar.ts`.
 */

const PROGRESS_CHANNEL = 'vec:progress'
const TMP = 'sajaru-vec'

let currentInput: string | null = null
let currentChild: ChildProcess | null = null
let lastResult: { png: string; svg: string } | null = null
// SVG base (agrupado por color) del último vectorizado Premium (Recraft). Se cachea para
// editar las capas SOBRE ÉL (localmente, comando svg-edit) sin volver a llamar a la API.
let recraftBaseSvg: string | null = null
// Ediciones de zona (fundir/borrar/recolorear), en coords NORMALIZADAS (0..1) para sobrevivir
// cambios de tamaño. Se re-aplican sobre el PNG tras CADA trazado, así tocar una capa o un
// setting no borra las ediciones hechas. Se vacían al cargar otra imagen.
let areaFills: Array<{
  x: number
  y: number
  w: number
  h: number
  mode: VectorAreaMode
  /** Color destino (#rrggbb) cuando mode === 'recolor'. */
  to?: string
}> = []
let counter = 0

async function setImage(bytes: ArrayBuffer, name: string): Promise<void> {
  const ext = path.extname(name) || '.png'
  await fs.mkdir(tmpRoot(TMP), { recursive: true })
  const p = path.join(tmpRoot(TMP), `input${ext}`)
  await fs.writeFile(p, Buffer.from(bytes))
  currentInput = p
  lastResult = null
  recraftBaseSvg = null
  areaFills = []
}

/**
 * Re-aplica las limpiezas de zona guardadas sobre un PNG recién trazado. Cada limpieza está
 * en coords normalizadas → se escala a los px actuales del PNG (vía nativeImage) y se corre
 * `area-fill` en cadena. Devuelve la ruta del PNG final (o la original si no hay limpiezas).
 */
async function applyAreaFills(png: string, sender: WebContents): Promise<string> {
  let cur = png
  for (const f of areaFills) {
    const { width, height } = nativeImage.createFromPath(cur).getSize()
    if (!width || !height) break
    const out = path.join(tmpRoot(TMP), `vector-${++counter}.png`)
    const rectArg = `${Math.round(f.x * width)},${Math.round(f.y * height)},${Math.round(
      f.w * width
    )},${Math.round(f.h * height)}`
    const r = await runSidecar(
      [
        'area-fill', '-i', cur, '-o', out, '--rect', rectArg,
        '--mode', f.mode,
        ...(f.to ? ['--to', f.to] : []),
        '--events'
      ],
      sender,
      PROGRESS_CHANNEL
    )
    if (!r.ok) break
    cur = String((r.data as { output?: string } | undefined)?.output ?? out)
  }
  return cur
}

async function process(config: VectorizeConfig, sender: WebContents): Promise<BgProcessResult> {
  if (!currentInput) {
    return { ok: false, error: { code: 'E_NO_IMAGE', message: 'No hay imagen cargada' } }
  }
  // Cancela el job anterior (modo reactivo: cambiar settings re-vectoriza).
  if (currentChild) {
    currentChild.kill('SIGTERM')
    currentChild = null
  }

  const out = path.join(tmpRoot(TMP), `vector-${++counter}.png`)
  // Editar capas en Premium (Recraft): aplicá la edición sobre el SVG YA descargado (svg-edit,
  // local) → NO re-llama a Recraft, así no gasta créditos por cada toque del ojo/recolor.
  const editingRecraft = Boolean(
    config.method === 'recraft' && config.edit && config.edit.length > 0 && recraftBaseSvg
  )
  const args = editingRecraft
    ? [
        'svg-edit',
        '-i', recraftBaseSvg as string,
        '-o', out,
        '--size', String(config.size),
        '--edit', JSON.stringify(config.edit),
        '--events'
      ]
    : [
        'vectorize',
        '-i', currentInput,
        '-o', out,
        '--colors', String(config.colors),
        '--size', String(config.size),
        '--denoise', String(config.denoise ?? 0),
        '--method', config.method,
        '--events',
        ...(config.keepBackground ? ['--keep-background'] : []),
        ...(config.edit && config.edit.length ? ['--edit', JSON.stringify(config.edit)] : [])
      ]
  const r = await runSidecar(args, sender, PROGRESS_CHANNEL, (c) => {
    currentChild = c
  })
  currentChild = null

  if (!r.ok) return { ok: false, error: r.error }
  try {
    const data = r.data as { output?: string; svg?: string; palette?: RgbColor[] } | undefined
    const pngPath0 = String(data?.output ?? out)
    const svgPath = String(data?.svg ?? out.replace(/\.[^.]+$/, '.svg'))
    // Re-aplicá las limpiezas de zona sobre el PNG recién trazado (persisten entre re-trazados).
    const pngPath = areaFills.length ? await applyAreaFills(pngPath0, sender) : pngPath0
    const buf = await fs.readFile(pngPath)
    lastResult = { png: pngPath, svg: svgPath }
    // Cacheá el SVG base del vectorizado Premium (fresh, sin edición) para editar sin re-llamar.
    if (config.method === 'recraft' && !(config.edit && config.edit.length)) recraftBaseSvg = svgPath
    else if (config.method === 'local') recraftBaseSvg = null
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return {
      ok: true,
      bytes: ab,
      outputName: path.basename(pngPath),
      format: 'png',
      palette: data?.palette ?? []
    }
  } catch (e) {
    return { ok: false, error: { code: 'E_READ', message: (e as Error).message } }
  }
}

/**
 * "Fundir al color predominante" en un rectángulo: corre el comando `area-fill` sobre el PNG
 * del último resultado (raster) y lo reemplaza. Sirve para tapar artefactos (línea de borde,
 * franjas) seleccionando una zona donde el color bueno predomina. NO toca el SVG (queda como
 * base vectorial); limpia el PNG/PDF exportado. `rect` viene en píxeles del PNG del resultado.
 */
async function areaFill(
  rect: { x: number; y: number; w: number; h: number },
  mode: VectorAreaMode,
  to: string | undefined,
  sender: WebContents
): Promise<BgProcessResult> {
  if (!lastResult) return { ok: false, error: { code: 'E_NO_RESULT', message: 'No hay resultado' } }
  // Guardá la zona normalizada (0..1) para re-aplicarla tras futuros trazados.
  const { width, height } = nativeImage.createFromPath(lastResult.png).getSize()
  if (width && height) {
    areaFills.push({
      x: rect.x / width,
      y: rect.y / height,
      w: rect.w / width,
      h: rect.h / height,
      mode,
      to
    })
  }
  const out = path.join(tmpRoot(TMP), `vector-${++counter}.png`)
  const rectArg = `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`
  const r = await runSidecar(
    [
      'area-fill', '-i', lastResult.png, '-o', out, '--rect', rectArg,
      '--mode', mode,
      ...(to ? ['--to', to] : []),
      '--events'
    ],
    sender,
    PROGRESS_CHANNEL
  )
  if (!r.ok) return { ok: false, error: r.error }
  try {
    const data = r.data as { output?: string } | undefined
    const pngPath = String(data?.output ?? out)
    const buf = await fs.readFile(pngPath)
    // El SVG no cambia (área es raster); solo reemplazamos el PNG del resultado.
    lastResult = { png: pngPath, svg: lastResult.svg }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return { ok: true, bytes: ab, outputName: path.basename(pngPath), format: 'png' }
  } catch (e) {
    return { ok: false, error: { code: 'E_READ', message: (e as Error).message } }
  }
}

async function saveAs(
  kind: 'svg' | 'png',
  suggestedName: string
): Promise<{ saved: boolean; path?: string }> {
  if (!lastResult) return { saved: false }
  const src = kind === 'svg' ? lastResult.svg : lastResult.png
  const win = BrowserWindow.getFocusedWindow()
  const opts = {
    defaultPath: suggestedName,
    filters: [{ name: kind.toUpperCase(), extensions: [kind] }]
  }
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, opts)
    : await dialog.showSaveDialog(opts)
  if (canceled || !filePath) return { saved: false }
  await fs.copyFile(src, filePath)
  return { saved: true, path: filePath }
}

/**
 * Exporta SOLO la capa del color dado como su propio SVG. Lee el SVG del último
 * resultado (el mismo que usa `saveSvg`), conserva el header `<svg …>` y dentro de él
 * deja únicamente el `<g …data-color="{color}"…>…</g>` que coincide (match por
 * `data-color`, case-insensitive, robusto ante el orden de atributos). Guarda vía diálogo.
 */
async function saveLayerSvg(
  color: string,
  suggestedName: string
): Promise<{ saved: boolean; path?: string }> {
  if (!lastResult) return { saved: false }
  let svg: string
  try {
    svg = await fs.readFile(lastResult.svg, 'utf8')
  } catch (e) {
    void e
    return { saved: false }
  }

  // Header <svg …> de apertura (sin los grupos), para envolver la capa aislada.
  const open = svg.match(/<svg\b[^>]*>/i)
  if (!open) return { saved: false }

  // Grupo <g …data-color="{color}"…>…</g> del color pedido. Los grupos no anidan otros
  // <g>, así que hasta el primer </g> es seguro. Comparamos el color normalizado.
  const want = color.trim().toLowerCase()
  const groupRe = /<g\b[^>]*\bdata-color="([^"]*)"[^>]*>[\s\S]*?<\/g>/gi
  // Un color puede tener VARIAS corridas (Recraft: orden del documento preservado). Juntá todas.
  const parts: string[] = []
  for (let m = groupRe.exec(svg); m; m = groupRe.exec(svg)) {
    if (m[1].trim().toLowerCase() === want) parts.push(m[0])
  }
  if (!parts.length) return { saved: false }

  const layerSvg = `${open[0]}${parts.join('')}</svg>`

  const win = BrowserWindow.getFocusedWindow()
  const opts = {
    defaultPath: suggestedName,
    filters: [{ name: 'SVG', extensions: ['svg'] }]
  }
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, opts)
    : await dialog.showSaveDialog(opts)
  if (canceled || !filePath) return { saved: false }
  await fs.writeFile(filePath, layerSvg, 'utf8')
  return { saved: true, path: filePath }
}

let exportCounter = 0

/** Exporta el vector a PDF (vectorial) o EPS (Ghostscript, dentro del sidecar): corre el
 *  comando `svg2pdf` sobre el SVG del último resultado y guarda vía diálogo. Canal de
 *  progreso APARTE ('vec:exportProgress') para no clavar la barra del vectorizado. */
async function saveVector(
  format: 'pdf' | 'eps',
  suggestedName: string,
  sender: WebContents
): Promise<{ saved: boolean; path?: string; error?: string }> {
  if (!lastResult) return { saved: false }
  const tmp = path.join(tmpRoot(TMP), `export-${++exportCounter}.${format}`)
  const r = await runSidecar(
    ['svg2pdf', '-i', lastResult.svg, '-o', tmp, '--format', format, '--events'],
    sender,
    'vec:exportProgress'
  )
  if (!r.ok) return { saved: false, error: r.error?.message }
  const win = BrowserWindow.getFocusedWindow()
  const opts = {
    defaultPath: suggestedName,
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  }
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, opts)
    : await dialog.showSaveDialog(opts)
  if (canceled || !filePath) return { saved: false }
  await fs.copyFile(tmp, filePath)
  return { saved: true, path: filePath }
}

/** Copia el PNG vectorizado al portapapeles (para pegar en apps de diseño). */
function copyResult(): { copied: boolean } {
  if (!lastResult) return { copied: false }
  const img = nativeImage.createFromPath(lastResult.png)
  if (img.isEmpty()) return { copied: false }
  clipboard.writeImage(img)
  return { copied: true }
}

/** Borra todas las limpiezas de zona (el próximo trazado saldrá sin ellas). */
function clearAreaFills(): { ok: boolean } {
  areaFills = []
  return { ok: true }
}

export function registerVectorizeIpc(ipcMain: IpcMain): void {
  ipcMain.handle('vec:setImage', (_e, bytes: ArrayBuffer, name: string) => setImage(bytes, name))
  ipcMain.handle('vec:process', (e, config: VectorizeConfig) => process(config, e.sender))
  ipcMain.handle(
    'vec:areaFill',
    (e, rect: { x: number; y: number; w: number; h: number }, mode?: VectorAreaMode, to?: string) =>
      areaFill(rect, mode ?? 'fill', to, e.sender)
  )
  ipcMain.handle('vec:clearAreaFills', () => clearAreaFills())
  ipcMain.handle('vec:saveSvg', (_e, name: string) => saveAs('svg', name))
  ipcMain.handle('vec:savePng', (_e, name: string) => saveAs('png', name))
  ipcMain.handle('vec:saveLayerSvg', (_e, color: string, name: string) => saveLayerSvg(color, name))
  ipcMain.handle('vec:saveVector', (e, format: 'pdf' | 'eps', name: string) =>
    saveVector(format, name, e.sender)
  )
  ipcMain.handle('vec:copyResult', () => copyResult())
}
