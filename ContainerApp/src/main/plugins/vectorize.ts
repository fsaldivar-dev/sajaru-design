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
// Raster de EDICIONES (1ª generación): las ediciones de zona/objeto encadenan SIEMPRE sobre
// este raster (trazado + area-fills), nunca sobre un consolidado — así la consolidación es
// siempre de una sola generación y el arte no se degrada edición tras edición.
let editedRaster: string | null = null
// Metadatos del último trazado (para CONSOLIDAR ediciones al vector): la paleta fija con la
// que re-trazar fiel, el tamaño de salida y el motor (solo local; no re-trazamos curvas Recraft).
let lastTrace: { palette: RgbColor[]; size: number; method: 'local' | 'recraft' } | null = null
// SVG base (agrupado por color) del último vectorizado Premium (Recraft). Se cachea para
// editar las capas SOBRE ÉL (localmente, comando svg-edit) sin volver a llamar a la API.
let recraftBaseSvg: string | null = null
// Ediciones de zona/objeto (fundir/borrar/recolorear), en coords NORMALIZADAS (0..1) para
// sobrevivir cambios de tamaño. Zona = rect {x,y,w,h}; objeto = punto {px,py} (componente
// conectado del color clickeado). Se re-aplican sobre el PNG tras CADA trazado, así tocar
// una capa o un setting no borra las ediciones hechas. Se vacían al cargar otra imagen.
let areaFills: Array<{
  x?: number
  y?: number
  w?: number
  h?: number
  /** Punto normalizado del modo OBJETO (excluyente con el rect). */
  px?: number
  py?: number
  mode: VectorAreaMode
  /** Color destino (#rrggbb) cuando mode === 'recolor'. */
  to?: string
}> = []
type AreaFillEntry = (typeof areaFills)[number]
// Pila de REHACER por PASOS: cada paso es el lote de ediciones de UNA acción del usuario
// (un rect = 1 entrada; recolorear un grupo de 8 letras = 8 entradas juntas). Se vacía
// cuando el usuario hace una edición nueva (historial lineal clásico).
let redoFills: AreaFillEntry[][] = []
// Raster BASE del último trazado (primera generación, SIN ediciones) + su resultado: es el
// punto de partida para re-aplicar `areaFills` al deshacer de a una.
let baseRaster: string | null = null
let baseResult: { png: string; svg: string } | null = null
// GRUPOS con nombre del diseñador ("Letras", "Gorro"…): semillas normalizadas de objetos.
// Viven acá (no en el renderer) para sobrevivir cambios de mini app, igual que areaFills.
let groups: Array<{
  id: string
  name: string
  color?: string
  seeds: Array<{ px: number; py: number }>
}> = []
let counter = 0

async function setImage(bytes: ArrayBuffer, name: string): Promise<void> {
  const ext = path.extname(name) || '.png'
  await fs.mkdir(tmpRoot(TMP), { recursive: true })
  const p = path.join(tmpRoot(TMP), `input${ext}`)
  await fs.writeFile(p, Buffer.from(bytes))
  currentInput = p
  editedRaster = null
  lastResult = null
  recraftBaseSvg = null
  areaFills = []
  redoFills = []
  baseRaster = null
  baseResult = null
  groups = []
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
    const region =
      f.px !== undefined && f.py !== undefined
        ? ['--point', `${Math.round(f.px * width)},${Math.round(f.py * height)}`]
        : [
            '--rect',
            `${Math.round((f.x ?? 0) * width)},${Math.round((f.y ?? 0) * height)},${Math.round(
              (f.w ?? 0) * width
            )},${Math.round((f.h ?? 0) * height)}`
          ]
    const r = await runSidecar(
      [
        'area-fill', '-i', cur, '-o', out, ...region,
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
    let svgPath = String(data?.svg ?? out.replace(/\.[^.]+$/, '.svg'))
    // Metadatos para consolidar ediciones al vector (paleta fija del trazado actual).
    lastTrace = { palette: data?.palette ?? [], size: config.size, method: config.method }
    // Base del deshacer de a una: el trazado limpio ANTES de re-aplicar ediciones.
    baseRaster = pngPath0
    baseResult = { png: pngPath0, svg: svgPath }
    // Re-aplicá las ediciones de zona/objeto sobre el PNG recién trazado (persisten entre
    // re-trazados) y CONSOLIDALAS al vector: el SVG exportado refleja lo que se ve.
    // SOLO con motor local: estamparlas sobre el PNG de Recraft dejaría un preview que el
    // SVG premium (que no se re-traza) no puede exportar — quedan "en pausa" hasta volver.
    const applyFills = areaFills.length > 0 && config.method === 'local'
    let pngPath = applyFills ? await applyAreaFills(pngPath0, sender) : pngPath0
    editedRaster = applyFills ? pngPath : null
    if (applyFills) {
      const c = await consolidateToVector(pngPath, sender)
      if (c) {
        pngPath = c.png
        svgPath = c.svg
      }
    }
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
 * Herramienta de ZONA (rect): fundir/borrar/recolorear sobre el raster del resultado, y
 * CONSOLIDACIÓN al vector: tras aplicar, se re-traza con paleta fija para que el SVG (y
 * PDF/EPS) exporten exactamente lo que se ve. `rect` en píxeles del PNG del resultado.
 */
async function areaFill(
  rect: { x: number; y: number; w: number; h: number },
  mode: VectorAreaMode,
  to: string | undefined,
  sender: WebContents
): Promise<BgProcessResult> {
  if (!lastResult) return { ok: false, error: { code: 'E_NO_RESULT', message: 'No hay resultado' } }
  redoFills = [] // edición nueva: el rehacer deja de tener sentido (historial lineal)
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
  // El rect llega en px del PNG que VE el usuario (lastResult, consolidado) pero se aplica
  // sobre el raster de 1ª generación — pueden diferir de tamaño (p.ej. salida 4096 con
  // consolidación tope 2048). Escalamos al espacio del raster de entrada.
  const input = editedRaster ?? lastResult.png
  const inSize = nativeImage.createFromPath(input).getSize()
  const k = width && inSize.width ? inSize.width / width : 1
  const rectArg = `${Math.round(rect.x * k)},${Math.round(rect.y * k)},${Math.round(rect.w * k)},${Math.round(rect.h * k)}`
  const r = await runSidecar(
    [
      'area-fill', '-i', input, '-o', out, '--rect', rectArg,
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
    // La cadena de ediciones vive en el raster de 1ª generación (nunca un consolidado).
    editedRaster = pngPath
    // CONSOLIDAR al vector: el SVG (y el PNG del preview) reflejan la edición.
    const c = await consolidateToVector(pngPath, sender)
    const finalPng = c?.png ?? pngPath
    const finalSvg = c?.svg ?? lastResult.svg
    const buf = await fs.readFile(finalPng)
    lastResult = { png: finalPng, svg: finalSvg }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return { ok: true, bytes: ab, outputName: path.basename(finalPng), format: 'png' }
  } catch (e) {
    return { ok: false, error: { code: 'E_READ', message: (e as Error).message } }
  }
}

/**
 * CONSOLIDA las ediciones de zona/objeto AL VECTOR: re-traza el raster editado en modo
 * entrada-plana (--assume-flat: sin blur/upscale; --no-merge-thin: no matar los colores
 * editados; --palette-from-input: paleta = colores exactos presentes, nada se aplasta). El
 * resultado es un SVG/PNG consistentes con lo que se ve — "Guardar SVG/PDF/EPS" exporta
 * las ediciones. Solo motor local (las curvas Premium de Recraft no se pisan).
 */
async function consolidateToVector(
  pngPath: string,
  sender: WebContents
): Promise<{ png: string; svg: string } | null> {
  if (!lastTrace || lastTrace.method !== 'local') return null
  // Los colores que el usuario PINTÓ no pueden ser podados por mergeThin (un objeto
  // recoloreado con textura fina erosiona <35% y sin esto se fundiría al vecino).
  const protect = [...new Set(areaFills.filter((f) => f.mode === 'recolor' && f.to).map((f) => f.to as string))]
  const out = path.join(tmpRoot(TMP), `vector-${++counter}.png`)
  const r = await runSidecar(
    [
      'vectorize', '-i', pngPath, '-o', out,
      '--size', String(lastTrace.size),
      '--denoise', '0',
      '--keep-background',
      '--assume-flat',
      // Paleta = colores EXACTOS del raster editado (incluye los tonos del sombreado y los
      // colores nuevos de los recolores): nada se aplasta a otro color al consolidar.
      // mergeThin queda ENCENDIDO: poda los cascarones de anti-alias del re-etiquetado
      // (sin él, el consolidado se llena de flecos de 1px).
      '--palette-from-input',
      ...(protect.length ? ['--protect-colors', protect.join(',')] : []),
      '--events'
    ],
    sender,
    PROGRESS_CHANNEL
  )
  if (!r.ok) return null
  const data = r.data as { output?: string; svg?: string } | undefined
  const png = String(data?.output ?? out)
  const svg = String(data?.svg ?? out.replace(/\.[^.]+$/, '.svg'))
  return { png, svg }
}

/** Modo OBJETO: borra/recolorea el componente conectado de CADA punto (la selección puede
 *  tener N objetos — un grupo entero). Aplica los puntos en cadena sobre el raster de 1ª
 *  generación y consolida al vector UNA sola vez al final. `points` en px del PNG. */
async function objectEdit(
  points: Array<{ x: number; y: number }>,
  mode: 'erase' | 'recolor',
  to: string | undefined,
  sender: WebContents
): Promise<BgProcessResult> {
  if (!lastResult) return { ok: false, error: { code: 'E_NO_RESULT', message: 'No hay resultado' } }
  if (!points.length) return { ok: false, error: { code: 'E_NO_POINT', message: 'Sin objetos seleccionados' } }
  redoFills = [] // edición nueva: historial lineal
  const { width, height } = nativeImage.createFromPath(lastResult.png).getSize()
  if (width && height) {
    for (const p of points) areaFills.push({ px: p.x / width, py: p.y / height, mode, to })
  }
  // Los puntos llegan en px del PNG que VE el usuario (lastResult) pero se aplican sobre el
  // raster de 1ª generación, que puede tener otro tamaño (salida 4096, consolidación 2048).
  let cur = editedRaster ?? lastResult.png
  const inSize = nativeImage.createFromPath(cur).getSize()
  const k = width && inSize.width ? inSize.width / width : 1
  for (const p of points) {
    const out = path.join(tmpRoot(TMP), `vector-${++counter}.png`)
    const r = await runSidecar(
      [
        'area-fill', '-i', cur, '-o', out,
        '--point', `${Math.round(p.x * k)},${Math.round(p.y * k)}`,
        '--mode', mode,
        ...(to ? ['--to', to] : []),
        '--events'
      ],
      sender,
      PROGRESS_CHANNEL
    )
    if (!r.ok) return { ok: false, error: r.error }
    cur = String((r.data as { output?: string } | undefined)?.output ?? out)
  }
  try {
    // La cadena de ediciones vive en el raster de 1ª generación (nunca un consolidado).
    editedRaster = cur
    // CONSOLIDAR al vector: el SVG (y el PNG del preview) reflejan la edición.
    const c = await consolidateToVector(cur, sender)
    const finalPng = c?.png ?? cur
    const finalSvg = c?.svg ?? lastResult.svg
    const buf = await fs.readFile(finalPng)
    lastResult = { png: finalPng, svg: finalSvg }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return { ok: true, bytes: ab, outputName: path.basename(finalPng), format: 'png' }
  } catch (e) {
    return { ok: false, error: { code: 'E_READ', message: (e as Error).message } }
  }
}

/** Deshace LA ÚLTIMA acción de zona/objeto (`count` = cuántas entradas formaron esa acción:
 *  un grupo de 8 letras se deshace como UN paso). Re-aplica las restantes desde el raster
 *  base y re-consolida. Devuelve el PNG resultante y cuántas ediciones quedan. */
async function undoLastFill(
  count: number,
  sender: WebContents
): Promise<BgProcessResult & { remaining?: number }> {
  if (!baseRaster || !baseResult) {
    return { ok: false, error: { code: 'E_NO_RESULT', message: 'No hay resultado' } }
  }
  if (!areaFills.length) {
    return { ok: false, error: { code: 'E_EMPTY', message: 'No hay ediciones para deshacer' } }
  }
  const n = Math.max(1, Math.min(Math.round(count) || 1, areaFills.length))
  const step = areaFills.splice(areaFills.length - n, n)
  redoFills.push(step)
  return rebuildFromBase(sender)
}

/** Rehace el último paso deshecho (vuelve del redo stack y re-aplica desde la base). */
async function redoLastFill(sender: WebContents): Promise<BgProcessResult & { remaining?: number }> {
  const step = redoFills.pop()
  if (!step) return { ok: false, error: { code: 'E_EMPTY', message: 'No hay ediciones para rehacer' } }
  areaFills.push(...step)
  return rebuildFromBase(sender)
}

/** Re-aplica `areaFills` desde el raster base y consolida (o restaura el trazado limpio). */
async function rebuildFromBase(sender: WebContents): Promise<BgProcessResult & { remaining?: number }> {
  if (!baseRaster || !baseResult) {
    return { ok: false, error: { code: 'E_NO_RESULT', message: 'No hay resultado' } }
  }
  try {
    if (!areaFills.length) {
      editedRaster = null
      lastResult = { ...baseResult }
      const buf = await fs.readFile(baseResult.png)
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      return { ok: true, bytes: ab, outputName: path.basename(baseResult.png), format: 'png', remaining: 0 }
    }
    const cur = await applyAreaFills(baseRaster, sender)
    editedRaster = cur
    const c = await consolidateToVector(cur, sender)
    const finalPng = c?.png ?? cur
    const finalSvg = c?.svg ?? baseResult.svg
    const buf = await fs.readFile(finalPng)
    lastResult = { png: finalPng, svg: finalSvg }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return { ok: true, bytes: ab, outputName: path.basename(finalPng), format: 'png', remaining: areaFills.length }
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
  redoFills = []
  return { ok: true }
}

// COLA de serialización: process/areaFill/objectEdit/undo/redo mutan editedRaster/lastResult
// en secuencia de awaits — dos corriendo en paralelo (debounce de settings + una edición)
// dejarían el estado del main según el orden de llegada y "Guardar SVG" exportaría otra
// generación que la pantalla. Un solo carril: cada operación espera a la anterior.
let opChain: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = opChain.then(fn, fn)
  opChain = next.catch(() => undefined)
  return next
}

/** Las ediciones raster consolidan re-trazando LOCAL: con curvas Premium no aplican. */
function rasterGuard(): { ok: false; error: { code: string; message: string } } | null {
  if (lastTrace && lastTrace.method !== 'local') {
    return {
      ok: false,
      error: { code: 'E_ENGINE', message: 'La edición de objetos/zonas está disponible con motor Local' }
    }
  }
  return null
}

export function registerVectorizeIpc(ipcMain: IpcMain): void {
  ipcMain.handle('vec:setImage', (_e, bytes: ArrayBuffer, name: string) =>
    enqueue(() => setImage(bytes, name))
  )
  ipcMain.handle('vec:process', (e, config: VectorizeConfig) => enqueue(() => process(config, e.sender)))
  ipcMain.handle(
    'vec:areaFill',
    (e, rect: { x: number; y: number; w: number; h: number }, mode?: VectorAreaMode, to?: string) =>
      enqueue(async () => rasterGuard() ?? areaFill(rect, mode ?? 'fill', to, e.sender))
  )
  ipcMain.handle(
    'vec:objectEdit',
    (e, points: Array<{ x: number; y: number }>, mode: 'erase' | 'recolor', to?: string) =>
      enqueue(async () => rasterGuard() ?? objectEdit(points, mode, to, e.sender))
  )
  ipcMain.handle('vec:undoLastFill', (e, count?: number) =>
    enqueue(async () => rasterGuard() ?? undoLastFill(count ?? 1, e.sender))
  )
  ipcMain.handle('vec:redoLastFill', (e) => enqueue(async () => rasterGuard() ?? redoLastFill(e.sender)))
  ipcMain.handle('vec:groupsGet', () => groups)
  ipcMain.handle('vec:groupsSet', (_e, gs: typeof groups) => {
    groups = Array.isArray(gs) ? gs : []
    return { ok: true }
  })
  ipcMain.handle('vec:clearAreaFills', () => clearAreaFills())
  ipcMain.handle('vec:saveSvg', (_e, name: string) => saveAs('svg', name))
  ipcMain.handle('vec:savePng', (_e, name: string) => saveAs('png', name))
  ipcMain.handle('vec:saveLayerSvg', (_e, color: string, name: string) => saveLayerSvg(color, name))
  ipcMain.handle('vec:saveVector', (e, format: 'pdf' | 'eps', name: string) =>
    saveVector(format, name, e.sender)
  )
  ipcMain.handle('vec:copyResult', () => copyResult())
}
