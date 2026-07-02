import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { BrowserWindow, dialog, type IpcMain, type WebContents } from 'electron'
import type { BgProgress, Video360Config, Video360Result } from '@shared/types'
import { tmpRoot } from './sidecar'

/**
 * Adapter de la mini app "Mockup 3D" para exportar un giro 360°. El renderer captura
 * los cuadros del visor WebGL (ya recortados a cuadrado) y los manda como ArrayBuffer[];
 * acá se escriben a PNG y se codifican con ffmpeg a MP4 (H.264, ideal para WhatsApp/redes)
 * y/o GIF (loop liviano). No usa el sidecar: ffmpeg es un binario del sistema.
 */
const PROGRESS_CHANNEL = 'm3d:progress'
const TMP = 'sajaru-mockup3d'

/** Resuelve el binario de ffmpeg (Homebrew/paths comunes o PATH). */
function ffmpegBin(): string {
  const candidates = [
    process.env.SAJARU_FFMPEG,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg'
  ].filter(Boolean) as string[]
  for (const c of candidates) if (existsSync(c)) return c
  return 'ffmpeg' // último recurso: que lo resuelva el PATH
}

function runFfmpeg(args: string[]): Promise<{ ok: boolean; code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegBin(), args, { env: process.env })
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString()
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    child.on('error', (e) => resolve({ ok: false, code: null, stderr: e.message }))
    child.on('close', (code) => resolve({ ok: code === 0, code, stderr }))
  })
}

async function renderVideo(
  frames: ArrayBuffer[],
  config: Video360Config,
  sender: WebContents
): Promise<Video360Result> {
  if (!frames?.length) {
    return { ok: false, error: { code: 'E_NO_FRAMES', message: 'No hay cuadros para exportar' } }
  }
  const prog = (progress: number, message: string): void => {
    const ev: BgProgress = { type: 'progress', stage: 'encode', progress, message }
    sender.send(PROGRESS_CHANNEL, ev)
  }

  const dir = path.join(tmpRoot(TMP), `frames-${Date.now()}`)
  await fs.mkdir(dir, { recursive: true })
  try {
    prog(0.1, 'Preparando cuadros…')
    for (let i = 0; i < frames.length; i++) {
      await fs.writeFile(path.join(dir, `f${String(i).padStart(4, '0')}.png`), Buffer.from(frames[i]))
    }

    const fps = Math.max(12, Math.min(60, Math.round(config.fps || 30)))
    const pattern = path.join(dir, 'f%04d.png')
    const wantMp4 = config.format === 'mp4' || config.format === 'both'
    const wantGif = config.format === 'gif' || config.format === 'both'
    const outputs: Array<{ fmt: 'mp4' | 'gif'; file: string }> = []

    if (wantMp4) {
      const out = path.join(dir, 'video.mp4')
      prog(0.4, 'Codificando MP4…')
      // yuv420p + dims pares = máxima compatibilidad (WhatsApp, iOS, navegadores).
      const r = await runFfmpeg([
        '-y', '-framerate', String(fps), '-i', pattern,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
        '-movflags', '+faststart', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', out
      ])
      if (!r.ok) return { ok: false, error: { code: 'E_FFMPEG', message: `MP4: ${r.stderr.slice(-300)}` } }
      outputs.push({ fmt: 'mp4', file: out })
    }
    if (wantGif) {
      const out = path.join(dir, 'video.gif')
      prog(0.7, 'Codificando GIF…')
      // palettegen/paletteuse = GIF nítido sin banding; escalado a 480px para peso razonable.
      const r = await runFfmpeg([
        '-y', '-framerate', String(fps), '-i', pattern,
        '-vf',
        `fps=${fps},scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=full[p];[s1][p]paletteuse=dither=sierra2_4a`,
        out
      ])
      if (!r.ok) return { ok: false, error: { code: 'E_FFMPEG', message: `GIF: ${r.stderr.slice(-300)}` } }
      outputs.push({ fmt: 'gif', file: out })
    }
    if (outputs.length === 0) {
      return { ok: false, error: { code: 'E_FORMAT', message: 'Formato inválido' } }
    }

    prog(0.95, 'Guardando…')
    const base = (config.name || 'mockup-360').replace(/\.[^.]+$/, '')
    const primary = outputs[0]
    const win = BrowserWindow.getFocusedWindow()
    const opts = {
      defaultPath: `${base}.${primary.fmt}`,
      filters: outputs.map((o) => ({ name: o.fmt.toUpperCase(), extensions: [o.fmt] }))
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { ok: true, saved: false, paths: [] }

    // Un solo diálogo: los demás formatos se guardan junto al elegido con el mismo nombre base.
    const chosenBase = res.filePath.replace(/\.[^.]+$/, '')
    const saved: string[] = []
    for (const o of outputs) {
      const dest = `${chosenBase}.${o.fmt}`
      await fs.copyFile(o.file, dest)
      saved.push(dest)
    }
    prog(1, 'Listo')
    return { ok: true, saved: true, paths: saved }
  } catch (e) {
    return { ok: false, error: { code: 'E_VIDEO', message: (e as Error).message } }
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export function registerMockup3DIpc(ipcMain: IpcMain): void {
  ipcMain.handle('m3d:renderVideo', (e, frames: ArrayBuffer[], config: Video360Config) =>
    renderVideo(frames, config, e.sender)
  )
}
