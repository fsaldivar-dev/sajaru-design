import sharp from 'sharp'
import type { Ctx } from '../core/context'
import { defaultOutputPath, readInput, writeOutput } from '../core/image'

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '').padEnd(6, '0')
  return { r: parseInt(h.slice(0, 2), 16) || 0, g: parseInt(h.slice(2, 4), 16) || 0, b: parseInt(h.slice(4, 6), 16) || 0 }
}

/**
 * Contorno "sticker / die-cut": expande el alfa un grosor UNIFORME (transformada de
 * distancia chamfer — abraza el contorno parejo, sin blobs), lo rellena de color, pone
 * el sujeto encima y BINARIZA el alfa. El binarizado es clave para DTF: los medios tonos
 * (semitransparencia) no se imprimen bien → dejamos cada pixel 100% opaco o 100%
 * transparente. `thickness` 0..100 = grosor relativo (% del lado mayor); `color` = #rrggbb.
 */
export async function contourStep(
  buf: Buffer,
  opts: { thickness: number; color: string },
  ctx?: Ctx
): Promise<Buffer> {
  const meta = await sharp(buf).metadata()
  const maxDim = Math.max(meta.width ?? 0, meta.height ?? 0)
  const t = Math.max(0, Math.min(100, opts.thickness))
  const B = Math.max(1, Math.round((maxDim * t) / 100 * 0.05)) // 100 → 5% del lado mayor
  const pad = B + Math.ceil(B * 0.6)
  ctx?.progress('contour', 0.15, 'Calculando contorno')

  const padded = await sharp(buf)
    .ensureAlpha()
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  const { data, info } = await sharp(padded).raw().toBuffer({ resolveWithObject: true })
  const W = info.width
  const H = info.height
  const ch = info.channels

  // Transformada de distancia chamfer (2 pasadas): distancia de cada pixel al sujeto.
  const dist = new Float32Array(W * H)
  for (let p = 0; p < W * H; p++) dist[p] = data[p * ch + 3] >= 128 ? 0 : 1e9
  const d1 = 1
  const d2 = 1.4142136
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = y * W + x
      if (dist[p] === 0) continue
      let m = dist[p]
      if (x > 0) m = Math.min(m, dist[p - 1] + d1)
      if (y > 0) m = Math.min(m, dist[p - W] + d1)
      if (x > 0 && y > 0) m = Math.min(m, dist[p - W - 1] + d2)
      if (x < W - 1 && y > 0) m = Math.min(m, dist[p - W + 1] + d2)
      dist[p] = m
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const p = y * W + x
      if (dist[p] === 0) continue
      let m = dist[p]
      if (x < W - 1) m = Math.min(m, dist[p + 1] + d1)
      if (y < H - 1) m = Math.min(m, dist[p + W] + d1)
      if (x < W - 1 && y < H - 1) m = Math.min(m, dist[p + W + 1] + d2)
      if (x > 0 && y < H - 1) m = Math.min(m, dist[p + W - 1] + d2)
      dist[p] = m
    }

  ctx?.progress('contour', 0.7, 'Aplicando color y binarizando')
  const borderA = Buffer.alloc(W * H)
  for (let p = 0; p < W * H; p++) borderA[p] = dist[p] <= B ? 255 : 0

  const { r, g, b } = hexToRgb(opts.color)
  const colorLayer = await sharp({ create: { width: W, height: H, channels: 3, background: { r, g, b } } })
    .joinChannel(borderA, { raw: { width: W, height: H, channels: 1 } })
    .png()
    .toBuffer()
  const composed = await sharp(colorLayer).composite([{ input: padded }]).png().toBuffer()

  // Binarizar el alfa → 0% semitransparencia (DTF-ready).
  const rgb = await sharp(composed).removeAlpha().toBuffer()
  const binA = await sharp(composed).extractChannel(3).threshold(128).png().toBuffer()
  const out = await sharp(rgb).joinChannel(binA).png().toBuffer()
  ctx?.progress('contour', 1)
  return out
}

export async function contourCommand(
  opts: { input: string; output?: string; thickness: number; color: string },
  ctx: Ctx
): Promise<{ output: string; width: number; height: number }> {
  const buf = await readInput(opts.input)
  const out = await contourStep(buf, { thickness: opts.thickness, color: opts.color }, ctx)
  const output = opts.output ?? defaultOutputPath(opts.input, 'contour')
  await writeOutput(output, out)
  const m = await sharp(out).metadata()
  return { output, width: m.width ?? 0, height: m.height ?? 0 }
}
