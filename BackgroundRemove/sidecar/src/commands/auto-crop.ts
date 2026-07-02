import sharp from 'sharp'
import type { Ctx } from '../core/context'
import { defaultOutputPath, readInput, toRgbaRaw, writeOutput } from '../core/image'

export interface AutoCropOptions {
  /** Alpha <= este umbral (0..255) se considera fondo transparente. */
  alphaThreshold: number
}

export interface AutoCropResult {
  buffer: Buffer
  /** true = recortó (la imagen tenía márgenes transparentes). */
  cropped: boolean
  width: number
  height: number
}

/**
 * Recorta los márgenes totalmente transparentes dejando un bounding-box ajustado
 * al contenido (alfa > umbral). Útil para sublimar: el diseño llena el área.
 *
 * Robustez: si la imagen quedó 100% transparente (bbox vacío) NO se recorta,
 * devolvemos el buffer tal cual. Recorrer el alfa manualmente nos da el bbox
 * exacto y nos deja decidir el no-op, en vez de depender del heurístico de
 * sharp.trim() (que mira esquinas y puede fallar con bordes ruidosos).
 */
export async function autoCropStep(
  buf: Buffer,
  opts: AutoCropOptions,
  ctx: Ctx
): Promise<AutoCropResult> {
  ctx.progress('auto-crop', 0.2, 'Buscando contenido')
  const { data, width, height } = await toRgbaRaw(buf)
  const thr = opts.alphaThreshold

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > thr) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  // Imagen totalmente transparente (o por debajo del umbral): no recortar.
  if (maxX < 0 || maxY < 0) {
    ctx.progress('auto-crop', 1)
    return { buffer: buf, cropped: false, width, height }
  }

  const cropW = maxX - minX + 1
  const cropH = maxY - minY + 1
  // Ya está ajustado: nada que recortar (evita reencodear sin necesidad).
  if (cropW === width && cropH === height) {
    ctx.progress('auto-crop', 1)
    return { buffer: buf, cropped: false, width, height }
  }

  ctx.progress('auto-crop', 0.6, 'Recortando a contenido')
  const buffer = await sharp(buf)
    .extract({ left: minX, top: minY, width: cropW, height: cropH })
    .png()
    .toBuffer()

  ctx.progress('auto-crop', 1)
  return { buffer, cropped: true, width: cropW, height: cropH }
}

export async function autoCropCommand(
  opts: { input: string; output?: string; alphaThreshold?: number },
  ctx: Ctx
): Promise<{ output: string; cropped: boolean; width: number; height: number }> {
  const buf = await readInput(opts.input)
  const { buffer, cropped, width, height } = await autoCropStep(
    buf,
    { alphaThreshold: opts.alphaThreshold ?? 0 },
    ctx
  )
  const output = opts.output ?? defaultOutputPath(opts.input, 'crop', 'png')
  await writeOutput(output, buffer)
  return { output, cropped, width, height }
}
