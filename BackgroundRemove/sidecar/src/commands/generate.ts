import type { Ctx } from '../core/context'
import { defaultOutputPath, writeOutput } from '../core/image'
import { generate } from '../core/recraft'

/**
 * "Crear Diseño": genera imágenes desde un prompt con Recraft. Si el modelo es
 * `*_vector` la salida es SVG (ideal para logos/sublimado); si no, PNG.
 */
export async function generateCommand(
  opts: {
    prompt: string
    output?: string
    model?: string
    style?: string
    size?: string
    n?: number
  },
  ctx: Ctx
): Promise<{ outputs: string[]; model: string; vector: boolean }> {
  ctx.progress('generate', 0.1, 'Generando con Recraft (IA premium)…')
  const model = opts.model ?? 'recraftv3'
  const vector = model.includes('vector')
  const bufs = await generate(opts.prompt, {
    model,
    style: opts.style,
    size: opts.size,
    n: opts.n
  })
  if (bufs.length === 0) {
    return { outputs: [], model, vector }
  }

  ctx.progress('generate', 0.85, 'Guardando')
  const ext = vector ? 'svg' : 'png'
  const outputs: string[] = []
  for (let i = 0; i < bufs.length; i++) {
    const out =
      opts.output && bufs.length === 1
        ? opts.output
        : opts.output
          ? opts.output.replace(/\.[^.]+$/, `-${i + 1}.${ext}`)
          : defaultOutputPath('design.png', `gen-${i + 1}`, ext)
    await writeOutput(out, bufs[i])
    outputs.push(out)
  }
  ctx.progress('generate', 1)
  return { outputs, model, vector }
}
