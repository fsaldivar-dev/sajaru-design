import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { BrowserWindow, clipboard, dialog, nativeImage, type IpcMain, type WebContents } from 'electron'
import type { BgConfig, BgHistogram, BgProcessResult } from '@shared/types'
import { runSidecar, tmpRoot } from './sidecar'

/**
 * Adapter del plugin "remove-background": spawnea el sidecar CLI (vía el helper
 * compartido `sidecar.ts`), parsea su NDJSON y reenvía el progreso al renderer.
 * El main de Electron nunca corre sharp/onnx: solo orquesta.
 */

const PROGRESS_CHANNEL = 'bg:progress'
const TMP = 'sajaru-bg'

function configToArgs(c: BgConfig): string[] {
  const args = [
    '--image-type', c.imageType,
    '--model', c.model,
    '--edge-mode', c.edgeMode,
    '--softness', String(c.softness),
    '--bg-tolerance', String(c.bgTolerance),
    '--contract', String(c.contract),
    '--bg-provider', c.bgProvider,
    '--format', c.format,
    // Quitar Fondo = puro recorte: nunca sube resolución (eso vive en Mejorar) ni
    // hace enhance. El tag de 300 DPI lo deja el default del sidecar (inofensivo).
    '--no-upscale'
  ]
  args.push(c.autoCrop ? '--auto-crop' : '--no-auto-crop')
  if (!c.cleanArtifacts) args.push('--no-clean-artifacts')
  if (!c.expandEdge) args.push('--no-expand-edge')
  return args
}

let currentInput: string | null = null
let currentChild: ChildProcess | null = null
let lastOutput: { path: string; format: string } | null = null
let vecCounter = 0

interface RawStep {
  step: string
  data?: Record<string, unknown>
}

/** ¿El paso hizo trabajo real, o corrió sin aplicar nada? (para el ✓/– honesto). */
function stepActive(step: string, data?: Record<string, unknown>): boolean {
  switch (step) {
    case 'clean-halo':
      return Number(data?.changedPixels ?? 0) > 0 || Number(data?.grownPixels ?? 0) > 0
    case 'fix-color':
      return Boolean(data?.converted)
    case 'auto-crop':
      return Boolean(data?.cropped)
    case 'bg-fill':
      return Boolean(data?.filled)
    default:
      // remove-bg, fix-dpi, enhance, export: siempre hacen trabajo.
      return true
  }
}

async function setImage(bytes: ArrayBuffer, name: string): Promise<void> {
  const ext = path.extname(name) || '.png'
  await fs.mkdir(tmpRoot(TMP), { recursive: true })
  const p = path.join(tmpRoot(TMP), `input${ext}`)
  await fs.writeFile(p, Buffer.from(bytes))
  currentInput = p
}

async function processImage(config: BgConfig, sender: WebContents): Promise<BgProcessResult> {
  if (!currentInput) {
    return { ok: false, error: { code: 'E_NO_IMAGE', message: 'No hay imagen cargada' } }
  }
  // Cancela el job anterior (clave para el modo reactivo).
  if (currentChild) {
    currentChild.kill('SIGTERM')
    currentChild = null
  }

  const outDir = path.join(tmpRoot(TMP), 'out')
  const args = ['stream-events', '--events', '-i', currentInput, '-o', outDir, ...configToArgs(config)]
  const r = await runSidecar(args, sender, PROGRESS_CHANNEL, (c) => {
    currentChild = c
  })
  currentChild = null

  if (!r.ok) return { ok: false, error: r.error }
  try {
    const outPath = String(r.data?.output)
    const buf = await fs.readFile(outPath)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const format = r.data?.format ?? 'png'
    lastOutput = { path: outPath, format }
    const allSteps = (r.data as { steps?: RawStep[] } | undefined)?.steps ?? []
    const rawSteps = allSteps.filter((s) => s.step !== 'analyze')
    const steps = rawSteps.map((s) => ({ step: s.step, active: stepActive(s.step, s.data) }))
    // Modelo de color del fondo verdadero (histograma 24³) que computó el sidecar en
    // el paso 'remove-bg'. Lo reenviamos tal cual (ya serializado en base64) para que
    // el renderer detecte "restos de fondo" sin reconstruirlo del lienzo.
    const bgHistogram = allSteps.find((s) => s.step === 'remove-bg')?.data?.bgHistogram as
      | BgHistogram
      | undefined
    // Perfil de contenido EFECTIVO que resolvió el sidecar (manual o auto-detect):
    // 'logo' | 'ilustracion' | 'producto' | 'foto'. El renderer sugiere acciones por
    // tipo (ej. vectorizar logos/ilustraciones) en base a esto.
    const detectedType = allSteps.find((s) => s.step === 'remove-bg')?.data?.profile as
      | string
      | undefined
    return {
      ok: true,
      bytes: ab,
      outputName: path.basename(outPath),
      format,
      steps,
      bgHistogram,
      detectedType
    }
  } catch (e) {
    return { ok: false, error: { code: 'E_READ', message: (e as Error).message } }
  }
}

/** Guarda el último resultado procesado vía un diálogo "Guardar como". */
async function saveResult(suggestedName: string): Promise<{ saved: boolean; path?: string }> {
  if (!lastOutput) return { saved: false }
  const ext = lastOutput.format === 'tiff' ? 'tiff' : 'png'
  const win = BrowserWindow.getFocusedWindow()
  const opts = {
    defaultPath: suggestedName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  }
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, opts)
    : await dialog.showSaveDialog(opts)
  if (canceled || !filePath) return { saved: false }
  await fs.copyFile(lastOutput.path, filePath)
  return { saved: true, path: filePath }
}

async function modelsList(sender: WebContents): Promise<BgProcessResult> {
  const r = await runSidecar(['models', 'list', '--events'], sender, PROGRESS_CHANNEL)
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error }
}

async function modelsDownload(id: string, sender: WebContents): Promise<BgProcessResult> {
  const r = await runSidecar(['models', 'download', id, '--events'], sender, PROGRESS_CHANNEL)
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error }
}

/** Copia el último resultado al portapapeles (para pegar en apps de diseño). */
function copyResult(): { copied: boolean } {
  if (!lastOutput) return { copied: false }
  const img = nativeImage.createFromPath(lastOutput.path)
  if (img.isEmpty()) return { copied: false }
  clipboard.writeImage(img)
  return { copied: true }
}

/** Sobrescribe el último resultado con bytes editados (borrador del renderer). */
async function updateResult(bytes: ArrayBuffer): Promise<void> {
  if (!lastOutput) return
  await fs.writeFile(lastOutput.path, Buffer.from(bytes))
}

/** Vectoriza el último resultado (Potrace por capas) → PNG nítido en alta resolución. */
async function vectorizeResult(sender: WebContents): Promise<BgProcessResult> {
  if (!lastOutput) {
    return { ok: false, error: { code: 'E_NO_RESULT', message: 'No hay resultado para vectorizar' } }
  }
  const out = path.join(tmpRoot(TMP), `vector-${++vecCounter}.png`)
  const r = await runSidecar(
    ['vectorize', '-i', lastOutput.path, '-o', out, '--size', '2048', '--events'],
    sender,
    PROGRESS_CHANNEL
  )
  if (!r.ok) return { ok: false, error: r.error }
  try {
    const buf = await fs.readFile(out)
    lastOutput = { path: out, format: 'png' }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return { ok: true, bytes: ab, outputName: path.basename(out), format: 'png' }
  } catch (e) {
    return { ok: false, error: { code: 'E_READ', message: (e as Error).message } }
  }
}

let contourCounter = 0

/** Aplica un contorno sticker/die-cut al último recorte. NO pisa lastOutput → re-aplicable
 *  con otro grosor/color sin acumular (siempre parte del recorte base). */
async function contourResult(
  config: { thickness: number; color: string },
  sender: WebContents
): Promise<BgProcessResult> {
  if (!lastOutput) {
    return { ok: false, error: { code: 'E_NO_RESULT', message: 'No hay recorte para el contorno' } }
  }
  const out = path.join(tmpRoot(TMP), `contour-${++contourCounter}.png`)
  // Canal APARTE: el contorno NO debe usar 'bg:progress' — si lo hace, sus eventos dejan
  // la barra de progreso del recorte clavada en "Procesando…" y traban los botones.
  const r = await runSidecar(
    ['contour', '-i', lastOutput.path, '-o', out, '--thickness', String(config.thickness), '--color', config.color, '--events'],
    sender,
    'bg:contourProgress'
  )
  if (!r.ok) return { ok: false, error: r.error }
  try {
    const buf = await fs.readFile(out)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return { ok: true, bytes: ab, outputName: path.basename(out), format: 'png' }
  } catch (e) {
    return { ok: false, error: { code: 'E_READ', message: (e as Error).message } }
  }
}

let loadCounter = 0

/**
 * Inyecta un resultado YA procesado como `lastOutput` (sin correr el sidecar). Lo usa el
 * modo multi-imagen de Quitar Fondo: al cambiar de imagen activa se re-sincroniza el
 * backend con el recorte (posiblemente editado) de ESA imagen, para que Guardar/Copiar/
 * Contorno/Vectorizar/retoques operen sobre ella y no sobre la anterior.
 */
async function loadResult(bytes: ArrayBuffer, format: string): Promise<void> {
  const ext = format === 'tiff' ? 'tiff' : 'png'
  const outDir = path.join(tmpRoot(TMP), 'out')
  await fs.mkdir(outDir, { recursive: true })
  const p = path.join(outDir, `loaded-${++loadCounter}.${ext}`)
  await fs.writeFile(p, Buffer.from(bytes))
  lastOutput = { path: p, format }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Guarda VARIOS recortes de una vez: pide UNA carpeta y escribe cada resultado ahí,
 * evitando colisiones de nombre. Reemplaza a "Procesar en lote" (ahora Quitar Fondo
 * procesa varias imágenes independientes y exporta todas juntas).
 */
async function saveAll(
  items: Array<{ name: string; bytes: ArrayBuffer; format: string }>
): Promise<{ saved: boolean; dir?: string; count?: number }> {
  if (!items?.length) return { saved: false }
  const win = BrowserWindow.getFocusedWindow()
  const properties: Array<'openDirectory' | 'createDirectory'> = ['openDirectory', 'createDirectory']
  const opts = { properties }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths[0]) return { saved: false }
  const dir = res.filePaths[0]
  let count = 0
  for (const it of items) {
    const ext = it.format === 'tiff' ? 'tiff' : 'png'
    const base = it.name.replace(/\.[^.]+$/, '') || 'recorte'
    let dest = path.join(dir, `${base}.${ext}`)
    let n = 1
    while (await fileExists(dest)) dest = path.join(dir, `${base}-${n++}.${ext}`)
    await fs.writeFile(dest, Buffer.from(it.bytes))
    count++
  }
  return { saved: true, dir, count }
}

export function registerBackgroundRemoveIpc(ipcMain: IpcMain): void {
  ipcMain.handle('bg:setImage', (_e, bytes: ArrayBuffer, name: string) => setImage(bytes, name))
  ipcMain.handle('bg:process', (e, config: BgConfig) => processImage(config, e.sender))
  ipcMain.handle('bg:loadResult', (_e, bytes: ArrayBuffer, format: string) => loadResult(bytes, format))
  ipcMain.handle(
    'bg:saveAll',
    (_e, items: Array<{ name: string; bytes: ArrayBuffer; format: string }>) => saveAll(items)
  )
  ipcMain.handle('bg:modelsList', (e) => modelsList(e.sender))
  ipcMain.handle('bg:modelsDownload', (e, id: string) => modelsDownload(id, e.sender))
  ipcMain.handle('bg:saveResult', (_e, suggestedName: string) => saveResult(suggestedName))
  ipcMain.handle('bg:copyResult', () => copyResult())
  ipcMain.handle('bg:updateResult', (_e, bytes: ArrayBuffer) => updateResult(bytes))
  ipcMain.handle('bg:vectorizeResult', (e) => vectorizeResult(e.sender))
  ipcMain.handle('bg:contourResult', (e, config: { thickness: number; color: string }) =>
    contourResult(config, e.sender)
  )
}
