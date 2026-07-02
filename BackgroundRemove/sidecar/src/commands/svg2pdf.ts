import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import PDFDocument from 'pdfkit'
import SVGtoPDF from 'svg-to-pdfkit'
import type { Ctx } from '../core/context'
import { SidecarError } from '../core/errors'

/**
 * Convierte un SVG VECTORIAL a PDF vectorial (pdfkit + svg-to-pdfkit): los paths siguen
 * siendo curvas escalables, no un raster. Con `--format eps` además pasa el PDF a EPS vía
 * Ghostscript (si `gs` está instalado; si no, error claro). Pensado para imprenta/plotter.
 */
export async function svg2pdfCommand(
  opts: { input: string; output: string; format: 'pdf' | 'eps' },
  ctx: Ctx
): Promise<{ output: string; format: string }> {
  ctx.progress('svg2pdf', 0.1, 'Leyendo SVG')
  const svg = await fs.readFile(opts.input, 'utf8')
  // Dimensiones: width/height explícitos o el viewBox; fallback 1024.
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
  const wm = /\bwidth="([\d.]+)"/.exec(svg)
  const hm = /\bheight="([\d.]+)"/.exec(svg)
  const W = wm ? parseFloat(wm[1]) : vb ? parseFloat(vb[1]) : 1024
  const H = hm ? parseFloat(hm[1]) : vb ? parseFloat(vb[2]) : 1024

  ctx.progress('svg2pdf', 0.4, 'Generando PDF vectorial')
  const pdfBuf = await new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: [W, H], margin: 0 })
      const chunks: Buffer[] = []
      doc.on('data', (c: Buffer) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)
      SVGtoPDF(doc, svg, 0, 0, { width: W, height: H, assumePt: true })
      doc.end()
    } catch (e) {
      reject(e)
    }
  })

  await fs.mkdir(path.dirname(opts.output), { recursive: true })

  if (opts.format === 'eps') {
    // EPS: PDF → EPS vía Ghostscript. El sidecar corre con el PATH de Electron (sin brew),
    // así que le sumamos las rutas típicas de gs. Si no está instalado, error accionable.
    const gsEnv = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` }
    const probe = spawnSync('gs', ['-v'], { stdio: 'ignore', env: gsEnv })
    if (probe.error || probe.status !== 0) {
      throw new SidecarError(
        'E_EPS_NO_GS',
        'EPS necesita Ghostscript. Instalalo con "brew install ghostscript" y reintentá (el PDF sí funciona).'
      )
    }
    const tmpPdf = opts.output.replace(/\.eps$/i, '') + '.tmp.pdf'
    await fs.writeFile(tmpPdf, pdfBuf)
    ctx.progress('svg2pdf', 0.7, 'Convirtiendo a EPS (Ghostscript)')
    const r = spawnSync(
      'gs',
      ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=eps2write', `-sOutputFile=${opts.output}`, tmpPdf],
      { stdio: 'ignore', env: gsEnv }
    )
    await fs.rm(tmpPdf, { force: true })
    if (r.status !== 0) throw new SidecarError('E_EPS', 'Falló la conversión a EPS con Ghostscript')
    ctx.progress('svg2pdf', 1)
    return { output: opts.output, format: 'eps' }
  }

  await fs.writeFile(opts.output, pdfBuf)
  ctx.progress('svg2pdf', 1)
  return { output: opts.output, format: 'pdf' }
}
