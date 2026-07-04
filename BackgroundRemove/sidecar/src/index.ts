// Debe ir PRIMERO: fija UV_THREADPOOL_SIZE antes de inicializar libuv/onnx (ver boot.ts).
import './boot'
import { Command, Option } from 'commander'
import { rootCtx, type Ctx } from './core/context'
import { SidecarError } from './core/errors'
import { emitError, emitResult, setStreaming } from './core/io'
import { resolvePipelineOptions } from './core/pipeline'
import { DEFAULT_MODEL } from './core/models/registry'
import type { BgFill, PipelineOptions, PipelineStep, Profile } from './core/types'

import { analyzeCommand } from './commands/analyze'
import { analyzeContentCommand } from './commands/analyze-content'
import { autoCropCommand } from './commands/auto-crop'
import { bgFillCommand } from './commands/bg-fill'
import { cleanHaloCommand } from './commands/clean-halo'
import { contourCommand } from './commands/contour'
import { enhanceCommand } from './commands/enhance'
import { exportCommand } from './commands/export'
import { fixColorCommand } from './commands/fix-color'
import { fixDpiCommand } from './commands/fix-dpi'
import { flipCommand } from './commands/flip'
import { generateCommand } from './commands/generate'
import { printPrepCommand } from './commands/print-prep'
import { modelsCommand, type ModelsSub } from './commands/models'
import { removeBgCommand } from './commands/remove-bg'
import { samEncodeCommand } from './commands/sam-encode'
import { samDecodeCommand } from './commands/sam-decode'
import { samEverythingCommand } from './commands/sam-everything'
import { streamEventsCommand } from './commands/stream-events'
import { vectorizeCommand } from './commands/vectorize'
import { svg2pdfCommand } from './commands/svg2pdf'
import { svgEditCommand } from './commands/svg-edit'
import { areaFillCommand } from './commands/area-fill'
import { recraftAccount } from './core/recraft'
import type { SamBox, SamEncoderModel, SamPoint } from './core/sam'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Opts = Record<string, any>

function makeCtx(): Ctx {
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  return rootCtx(controller.signal)
}

/** Run a command handler and wrap its outcome in the stdout/stderr contract. */
async function runCmd(name: string, cmd: Command, fn: (ctx: Ctx) => Promise<unknown>): Promise<void> {
  if (cmd.optsWithGlobals().events) setStreaming(true)
  const ctx = makeCtx()
  try {
    emitResult(name, await fn(ctx))
  } catch (err) {
    const e = err as SidecarError
    emitError(name, e.code ?? 'E_RUNTIME', e.message ?? String(err), e.detail)
    process.exitCode = 1
  }
}

const num = (v: string): number => Number(v)

/**
 * Acumula `--point x,y[,label]` (repetible) en una lista de SamPoint. label por
 * defecto 1 (foreground); 0 = background, 2/3 = esquinas de box.
 */
function collectPoint(value: string, prev: SamPoint[] = []): SamPoint[] {
  const parts = value.split(',').map((s) => Number(s.trim()))
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`--point inválido: "${value}" (esperado x,y o x,y,label)`)
  }
  const [x, y, label] = parts
  return [...prev, { x, y, label: label === undefined ? 1 : label }]
}

/** Parsea `--box x0,y0,x1,y1` a SamBox. */
function parseBox(value: string): SamBox {
  const p = value.split(',').map((s) => Number(s.trim()))
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) {
    throw new Error(`--box inválido: "${value}" (esperado x0,y0,x1,y1)`)
  }
  return [p[0], p[1], p[2], p[3]]
}

/** Shared options for whole-pipeline commands (batch, stream-events). */
function withPipelineOptions(cmd: Command): Command {
  return cmd
    .addOption(new Option('--product <p>', 'producto').choices(['playera', 'taza', 'gorra', 'lona']).default('playera'))
    .addOption(new Option('--image-type <t>', 'tipo de imagen').choices(['auto', 'logo', 'persona', 'ilustracion']).default('auto'))
    .addOption(new Option('--profile <p>', 'forzar perfil de contenido (override de la detección)').choices(['logo', 'ilustracion', 'foto', 'producto']))
    .option('--model <id>', 'modelo de IA', DEFAULT_MODEL)
    .addOption(new Option('--edge-mode <m>', 'modo de borde').choices(['duro', 'suave']).default('suave'))
    .option('--softness <n>', 'suavidad 0..100', num, 10)
    .option('--bg-tolerance <n>', 'tolerancia de fondo 0..100', num, 10)
    .option('--contract <n>', 'encoger borde N px hacia adentro (quita fringe)', num, 0)
    .addOption(new Option('--bg-provider <p>', 'motor de fondo: local o recraft (IA premium)').choices(['local', 'recraft']).default('local'))
    .option('--auto-crop', 'recortar a contenido (bbox del alfa)', false)
    .option('--no-auto-crop', 'no recortar a contenido')
    .addOption(new Option('--bg-fill <c>', 'fondo del resultado: transparent | white | black').choices(['transparent', 'white', 'black']).default('transparent'))
    .option('--no-clean-artifacts', 'no limpiar artefactos')
    .option('--no-expand-edge', 'no expandir borde +1px')
    .option('--no-force-300', 'no forzar 300 DPI')
    .option('--no-upscale', 'no upscalear si DPI bajo')
    .option('--no-auto-upscale-input', 'no auto-subir el input de baja resolución antes de quitar fondo')
    .option('--enhance', 'mejorar imagen (upscale ×2 + nitidez)', false)
    .addOption(new Option('--format <f>', 'formato de salida').choices(['png', 'tiff']).default('png'))
    .option('--steps <list>', 'pasos separados por coma (analyze,remove-bg,...)')
}

function buildPipeline(opts: Opts): PipelineOptions {
  return resolvePipelineOptions({
    product: opts.product,
    imageType: opts.imageType,
    // --profile fuerza el perfil (override de la detección); undefined = inferir.
    profile: opts.profile as Profile | undefined,
    model: opts.model,
    edgeMode: opts.edgeMode,
    softness: Number(opts.softness),
    bgTolerance: Number(opts.bgTolerance),
    contract: Number(opts.contract),
    removeBgProvider: opts.bgProvider,
    autoCrop: Boolean(opts.autoCrop),
    bgFill: opts.bgFill as BgFill,
    cleanArtifacts: opts.cleanArtifacts,
    expandEdge: opts.expandEdge,
    force300: opts.force300,
    upscaleIfLow: opts.upscale,
    // commander: --no-auto-upscale-input → opts.autoUpscaleInput=false (default true)
    autoUpscaleLowRes: opts.autoUpscaleInput,
    enhance: opts.enhance,
    format: opts.format,
    steps: opts.steps
      ? (String(opts.steps).split(',').map((s) => s.trim()) as PipelineStep[])
      : undefined
  })
}

const program = new Command()
program
  .name('bg-sidecar')
  .description('Sajaru Design — sidecar de quitar fondo (pipeline de sublimado).')
  .version('0.1.0')
  .option('--events', 'emitir progreso NDJSON a stdout', false)

// 1. analyze
program
  .command('analyze')
  .requiredOption('-i, --input <path>', 'imagen de entrada')
  .action((opts: Opts, cmd: Command) =>
    runCmd('analyze', cmd, (ctx) => analyzeCommand({ input: opts.input }, ctx))
  )

// analyze-content — debug: features de contenido + perfil detectado (para tunear)
program
  .command('analyze-content')
  .requiredOption('-i, --input <path>', 'imagen de entrada')
  .action((opts: Opts, cmd: Command) =>
    runCmd('analyze-content', cmd, (ctx) => analyzeContentCommand({ input: opts.input }, ctx))
  )

// 2. remove-bg
program
  .command('remove-bg')
  .requiredOption('-i, --input <path>', 'imagen de entrada')
  .option('-o, --output <path>', 'PNG de salida')
  .option('--model <id>', 'modelo de IA', DEFAULT_MODEL)
  .addOption(new Option('--method <m>', 'método').choices(['ai', 'color', 'auto']).default('auto'))
  .addOption(new Option('--edge-mode <m>', 'borde').choices(['duro', 'suave']).default('suave'))
  .option('--tolerance <n>', 'tolerancia fondo 0..100 (color)', num, 10)
  .option('--softness <n>', 'suavidad 0..100', num, 10)
  .option('--contract <n>', 'encoger borde N px hacia adentro', num, 0)
  .option('--matting', 'PERSONA: matting de cabello con MODNet (recupera el pelo, reemplaza a BiRefNet)', false)
  .option('--hair', 'alias de --matting', false)
  .action((opts: Opts, cmd: Command) =>
    runCmd('remove-bg', cmd, (ctx) =>
      removeBgCommand(
        {
          input: opts.input,
          output: opts.output,
          model: opts.model,
          method: opts.method,
          edgeMode: opts.edgeMode,
          tolerance: Number(opts.tolerance),
          softness: Number(opts.softness),
          contract: Number(opts.contract),
          matting: Boolean(opts.matting || opts.hair)
        },
        ctx
      )
    )
  )

// 3. clean-halo
program
  .command('clean-halo')
  .requiredOption('-i, --input <path>', 'imagen de entrada')
  .option('-o, --output <path>', 'PNG de salida')
  .option('--tolerance <n>', 'alfa mínimo 0..100', num, 10)
  .option('--softness <n>', 'rampa suave 0..100', num, 10)
  .option('--expand-edge', 'expandir borde +1px', false)
  .action((opts: Opts, cmd: Command) =>
    runCmd('clean-halo', cmd, (ctx) =>
      cleanHaloCommand(
        {
          input: opts.input,
          output: opts.output,
          tolerance: Number(opts.tolerance),
          softness: Number(opts.softness),
          expandEdge: Boolean(opts.expandEdge)
        },
        ctx
      )
    )
  )

// 4. fix-color
program
  .command('fix-color')
  .requiredOption('-i, --input <path>', 'imagen de entrada')
  .option('-o, --output <path>', 'salida')
  .action((opts: Opts, cmd: Command) =>
    runCmd('fix-color', cmd, (ctx) => fixColorCommand({ input: opts.input, output: opts.output }, ctx))
  )

// 5. fix-dpi
program
  .command('fix-dpi')
  .requiredOption('-i, --input <path>', 'imagen de entrada')
  .option('-o, --output <path>', 'salida')
  .option('--target <n>', 'DPI objetivo', num, 300)
  .option('--upscale', 'upscalear si hace falta', false)
  .option('--print-width <in>', 'ancho de impresión en pulgadas', num)
  .action((opts: Opts, cmd: Command) =>
    runCmd('fix-dpi', cmd, (ctx) =>
      fixDpiCommand(
        {
          input: opts.input,
          output: opts.output,
          target: Number(opts.target),
          upscaleIfLow: Boolean(opts.upscale),
          printWidthIn: opts.printWidth != null ? Number(opts.printWidth) : null
        },
        ctx
      )
    )
  )

// 6. flip
program
  .command('flip')
  .requiredOption('-i, --input <path>', 'imagen de entrada')
  .option('-o, --output <path>', 'salida')
  .addOption(new Option('--product <p>', 'producto').choices(['playera', 'taza', 'gorra', 'lona']).default('playera'))
  .option('--force', 'forzar espejo horizontal')
  .option('--no-flip', 'forzar SIN espejo')
  .action((opts: Opts, cmd: Command) => {
    let force: boolean | null = null
    if (opts.force) force = true
    if (opts.flip === false) force = false
    return runCmd('flip', cmd, (ctx) =>
      flipCommand({ input: opts.input, output: opts.output, product: opts.product, force }, ctx)
    )
  })

// 7. export
program
  .command('export')
  .requiredOption('-i, --input <path>', 'imagen de entrada')
  .option('-o, --output <path>', 'salida')
  .addOption(new Option('--format <f>', 'formato').choices(['png', 'tiff']).default('png'))
  .option('--dpi <n>', 'DPI a escribir', num, 300)
  .action((opts: Opts, cmd: Command) =>
    runCmd('export', cmd, (ctx) =>
      exportCommand({ input: opts.input, output: opts.output, format: opts.format, dpi: Number(opts.dpi) }, ctx)
    )
  )

// auto-crop — recortar a contenido (bbox del alfa)
program
  .command('auto-crop')
  .requiredOption('-i, --input <path>', 'imagen de entrada')
  .option('-o, --output <path>', 'PNG de salida')
  .option('--alpha-threshold <n>', 'alfa <= umbral (0..255) cuenta como fondo', num, 0)
  .action((opts: Opts, cmd: Command) =>
    runCmd('auto-crop', cmd, (ctx) =>
      autoCropCommand(
        { input: opts.input, output: opts.output, alphaThreshold: Number(opts.alphaThreshold) },
        ctx
      )
    )
  )

// bg-fill — reemplazar fondo transparente por un color sólido (aplana el alfa)
program
  .command('bg-fill')
  .requiredOption('-i, --input <path>', 'imagen de entrada')
  .option('-o, --output <path>', 'PNG de salida')
  .addOption(new Option('--fill <c>', 'transparent | white | black').choices(['transparent', 'white', 'black']).default('transparent'))
  .action((opts: Opts, cmd: Command) =>
    runCmd('bg-fill', cmd, (ctx) =>
      bgFillCommand({ input: opts.input, output: opts.output, fill: opts.fill }, ctx)
    )
  )

// enhance — mejorar imagen (upscale + nitidez)
program
  .command('enhance')
  .requiredOption('-i, --input <path>', 'imagen de entrada')
  .option('-o, --output <path>', 'salida')
  .option('--scale <n>', 'factor de upscale', num, 2)
  .option('--no-sharpen', 'sin nitidez (solo método clásico)')
  .addOption(new Option('--method <m>', 'classic (lanczos), ai (Real-ESRGAN local) o recraft (IA premium)').choices(['classic', 'ai', 'recraft']).default('classic'))
  .action((opts: Opts, cmd: Command) =>
    runCmd('enhance', cmd, (ctx) =>
      enhanceCommand(
        { input: opts.input, output: opts.output, scale: Number(opts.scale), sharpen: opts.sharpen, method: opts.method },
        ctx
      )
    )
  )

// vectorize — trazar a vector (SVG) + rasterizar en alta resolución (nítido)
program
  .command('vectorize')
  .requiredOption('-i, --input <path>', 'imagen de entrada')
  .option('-o, --output <path>', 'PNG de salida (también escribe .svg)')
  .option('--colors <n>', 'máx. colores de la paleta 2..24 (se detectan los reales)', num, 10)
  .option('--size <n>', 'tamaño de salida en px', num, 2048)
  .option('--edit <json>', 'JSON [{r,g,b,to?,remove?}] para FIJAR/editar la paleta (reemplazar/quitar)')
  .option('--denoise <n>', 'reducir ruido 0..100 (mediana antes de detectar la paleta)', num, 0)
  .option('--no-merge-thin', 'no fundir colores-franja finos al color vecino')
  .option('--keep-background', 'NO quitar el fondo uniforme del borde (vectorizar el diseño completo)')
  .option('--assume-flat', 'la entrada ya es plana (consolidación): sin blur ni upscale, resolución nativa')
  .option('--palette-from-input', 'paleta = colores exactos de la entrada (consolidación fiel; ignora --colors/--edit)')
  .option('--protect-colors <list>', 'colores #rrggbb separados por coma que mergeThin no puede podar')
  .addOption(new Option('--method <m>', 'local (Potrace) o recraft (IA premium)').choices(['local', 'recraft']).default('local'))
  .action((opts: Opts, cmd: Command) =>
    runCmd('vectorize', cmd, (ctx) =>
      vectorizeCommand(
        {
          input: opts.input,
          output: opts.output,
          colors: Number(opts.colors),
          size: Number(opts.size),
          method: opts.method,
          edit: opts.edit ? JSON.parse(String(opts.edit)) : undefined,
          denoise: Number(opts.denoise),
          mergeThin: opts.mergeThin,
          keepBackground: Boolean(opts.keepBackground),
          assumeFlat: Boolean(opts.assumeFlat),
          paletteFromInput: Boolean(opts.paletteFromInput),
          protectColors: opts.protectColors
            ? String(opts.protectColors).split(',').map((h: string) => {
                const s = h.trim().replace('#', '')
                return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) }
              }).filter((c: {r:number,g:number,b:number}) => Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b))
            : undefined
        },
        ctx
      )
    )
  )

// generate — Crear Diseño (Recraft text-to-image, vector o raster)
program
  .command('generate')
  .requiredOption('--prompt <text>', 'descripción del diseño')
  .option('-o, --output <path>', 'salida (.svg si vector, .png si no)')
  .option('--model <m>', 'recraftv3 | recraftv3_vector | recraftv2', 'recraftv3')
  .option('--style <s>', 'vector_illustration | digital_illustration | realistic_image')
  .option('--size <s>', 'WxH', '1024x1024')
  .option('--n <n>', 'cantidad 1..6', num, 1)
  .action((opts: Opts, cmd: Command) =>
    runCmd('generate', cmd, (ctx) =>
      generateCommand(
        { prompt: opts.prompt, output: opts.output, model: opts.model, style: opts.style, size: opts.size, n: Number(opts.n) },
        ctx
      )
    )
  )

// account — saldo de Recraft (IA premium): unidades disponibles (lectura, NO gasta)
program
  .command('account')
  .description('saldo de Recraft (unidades disponibles)')
  .action((opts: Opts, cmd: Command) => runCmd('account', cmd, () => recraftAccount()))

// contour — contorno sticker/die-cut: borde de color parejo + binarizado para DTF
program
  .command('contour')
  .requiredOption('-i, --input <path>', 'recorte con alfa')
  .option('-o, --output <path>', 'PNG de salida')
  .option('--thickness <n>', 'grosor 0..100 (% del lado mayor)', num, 30)
  .option('--color <hex>', 'color del contorno #rrggbb', '#ffffff')
  .action((opts: Opts, cmd: Command) =>
    runCmd('contour', cmd, (ctx) =>
      contourCommand({ input: opts.input, output: opts.output, thickness: Number(opts.thickness), color: opts.color }, ctx)
    )
  )

// svg2pdf — exportar el SVG vectorizado a PDF (vectorial) o EPS (vía Ghostscript)
program
  .command('svg2pdf')
  .requiredOption('-i, --input <path>', 'SVG de entrada')
  .option('-o, --output <path>', 'salida (.pdf o .eps)')
  .addOption(new Option('--format <f>', 'pdf o eps').choices(['pdf', 'eps']).default('pdf'))
  .action((opts: Opts, cmd: Command) =>
    runCmd('svg2pdf', cmd, (ctx) =>
      svg2pdfCommand({ input: opts.input, output: opts.output, format: opts.format }, ctx)
    )
  )

// svg-edit — editar capas (recolorear/quitar) de un SVG agrupado y rasterizar, SIN re-trazar
// (para editar el vectorizado Premium sobre el SVG cacheado, sin re-llamar a la API).
program
  .command('svg-edit')
  .requiredOption('-i, --input <path>', 'SVG agrupado de entrada')
  .option('-o, --output <path>', 'PNG de salida (también escribe .svg)')
  .option('--edit <json>', 'JSON [{r,g,b,to?,remove?}]')
  .option('--size <n>', 'tamaño de salida px', num, 2048)
  .action((opts: Opts, cmd: Command) =>
    runCmd('svg-edit', cmd, (ctx) =>
      svgEditCommand(
        {
          input: opts.input,
          output: opts.output,
          edit: opts.edit ? JSON.parse(String(opts.edit)) : undefined,
          size: Number(opts.size)
        },
        ctx
      )
    )
  )

// area-fill — "fundir al color predominante" en un rectángulo del raster (limpia artefactos
// como la línea roja de borde: en la zona seleccionada todo opaco toma el color dominante).
program
  .command('area-fill')
  .requiredOption('-i, --input <path>', 'PNG de entrada')
  .requiredOption('-o, --output <path>', 'PNG de salida')
  .option('--rect <x,y,w,h>', 'ZONA rectangular en px del PNG: x,y,w,h')
  .option('--point <x,y>', 'OBJETO: click en px — selecciona el componente conectado de ese color')
  .option('--mask <path>', 'MÁSCARA: PNG con alfa>=128 en los píxeles a editar (selección libre)')
  .option('--mask-outside', 'aplicar el modo FUERA de la máscara (erase = extraer la partición)')
  .addOption(new Option('--mode <m>', 'fill (fundir) | erase (borrar) | recolor | colorize (teñir conservando sombreado)').choices(['fill', 'erase', 'recolor', 'colorize']).default('fill'))
  .option('--to <hex>', 'color destino para recolor/colorize (#rrggbb)')
  .action((opts: Opts, cmd: Command) =>
    runCmd('area-fill', cmd, (ctx) => {
      if (!opts.rect && !opts.point && !opts.mask) throw new Error('Falta --rect (zona), --point (objeto) o --mask (selección)')
      const rect = opts.rect
        ? (() => {
            const [x, y, w, h] = String(opts.rect).split(',').map(Number)
            return { x, y, w, h }
          })()
        : undefined
      const point = opts.point
        ? (() => {
            const [x, y] = String(opts.point).split(',').map(Number)
            return { x, y }
          })()
        : undefined
      const hex = opts.to ? String(opts.to).replace('#', '') : null
      const to =
        hex && /^[0-9a-fA-F]{6}$/.test(hex)
          ? { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) }
          : undefined
      return areaFillCommand(
        { input: opts.input, output: opts.output, rect, point, mask: opts.mask ? String(opts.mask) : undefined, maskOutside: Boolean(opts.maskOutside), mode: opts.mode, to },
        ctx
      )
    })
  )

// print-prep — preparar para transfer de sublimación (tamaño físico + 300 DPI + espejo)
program
  .command('print-prep')
  .requiredOption('-i, --input <path>', 'imagen de entrada')
  .option('-o, --output <path>', 'salida')
  .option('--width-in <n>', 'ancho físico en pulgadas', num)
  .option('--height-in <n>', 'alto físico en pulgadas', num)
  .option('--dpi <n>', 'DPI de salida', num, 300)
  .option('--mirror', 'espejo horizontal (para transfer)', false)
  .addOption(new Option('--format <f>', 'png o tiff').choices(['png', 'tiff']).default('png'))
  .action((opts: Opts, cmd: Command) =>
    runCmd('print-prep', cmd, (ctx) =>
      printPrepCommand(
        {
          input: opts.input,
          output: opts.output,
          widthIn: opts.widthIn !== undefined ? Number(opts.widthIn) : undefined,
          heightIn: opts.heightIn !== undefined ? Number(opts.heightIn) : undefined,
          dpi: Number(opts.dpi),
          mirror: Boolean(opts.mirror),
          format: opts.format
        },
        ctx
      )
    )
  )

// 9. models
program
  .command('models')
  .argument('<sub>', 'list | download | remove | path')
  .argument('[id]', 'id del modelo')
  .action((sub: ModelsSub, id: string | undefined, _opts: Opts, cmd: Command) =>
    runCmd('models', cmd, (ctx) => modelsCommand(sub, { id }, ctx))
  )

// sam-encode — SAM: imagen → embedding cacheado (1,256,64,64) + meta. --model elige
// el encoder: mobilesam (rápido, default) | sam-vitb (preciso). Mismo decoder.
program
  .command('sam-encode')
  .requiredOption('-i, --image <path>', 'imagen de entrada')
  .option('-o, --out <path>', 'archivo de embedding (.bin)')
  .addOption(new Option('--model <m>', 'encoder: mobilesam (rápido) | sam-vitb (preciso)').choices(['mobilesam', 'sam-vitb']).default('mobilesam'))
  .action((opts: Opts, cmd: Command) =>
    runCmd('sam-encode', cmd, (ctx) =>
      samEncodeCommand({ imagePath: opts.image, outPath: opts.out, model: opts.model as SamEncoderModel }, ctx)
    )
  )

// sam-decode — MobileSAM: embedding + prompt (puntos/box) → K PNGs de máscara + low-res
program
  .command('sam-decode')
  .requiredOption('-e, --embedding <path>', 'archivo de embedding de sam-encode')
  .option('-o, --out <path>', 'PNG de máscara de salida (las K candidatas usan sufijo .kN)')
  .option('--point <x,y[,label]>', 'punto de prompt (repetible). label: 1=fg,0=bg', collectPoint, [])
  .option('--box <x0,y0,x1,y1>', 'box de prompt en px originales', parseBox)
  .option('--orig-w <n>', 'ancho original (si no está en el embedding)', num)
  .option('--orig-h <n>', 'alto original (si no está en el embedding)', num)
  .option('--mask-input <path>', 'PNG low-res (256x256) del decode previo, para refinar')
  .option('--has-mask-input', 'realimentar el --mask-input (refinamiento iterativo)', false)
  .option('--mask-index <n>', 'cuál de las K candidatas usar como elegida (default argmax IoU)', num)
  .action((opts: Opts, cmd: Command) =>
    runCmd('sam-decode', cmd, (ctx) =>
      samDecodeCommand(
        {
          embeddingPath: opts.embedding,
          outMaskPath: opts.out,
          points: opts.point as SamPoint[],
          box: opts.box as SamBox | undefined,
          origW: opts.origW !== undefined ? Number(opts.origW) : undefined,
          origH: opts.origH !== undefined ? Number(opts.origH) : undefined,
          maskInputPath: opts.maskInput as string | undefined,
          hasMaskInput: Boolean(opts.hasMaskInput),
          maskIndex: opts.maskIndex !== undefined ? Number(opts.maskIndex) : undefined
        },
        ctx
      )
    )
  )

// sam-everything — "Segmentar todo" (Automatic Mask Generator): grilla de puntos →
// todas las regiones de la imagen como máscaras (estilo "Selección de objeto" de
// Affinity). Lento (decodea miles de puntos en CPU); emití --events para progreso.
program
  .command('sam-everything')
  .requiredOption('-i, --image <path>', 'imagen de entrada')
  .requiredOption('-o, --out-dir <dir>', 'carpeta de salida (máscaras + labelmap + summary)')
  .option('--points <n>', 'lado de la grilla NxN (más = más regiones, más lento)', num, 48)
  .addOption(new Option('--model <m>', 'encoder/decoder: mobilesam (rápido) | sam-vitb (preciso)').choices(['mobilesam', 'sam-vitb']).default('mobilesam'))
  .option('--crops <n>', 'capas de crop extra (0 = solo imagen completa; 1 = + 2x2 crops, mejora finos)', num, 1)
  .action((opts: Opts, cmd: Command) =>
    runCmd('sam-everything', cmd, (ctx) =>
      samEverythingCommand(
        {
          imagePath: opts.image,
          outDir: opts.outDir,
          pointsPerSide: Number(opts.points),
          model: opts.model as SamEncoderModel,
          cropLayers: Number(opts.crops)
        },
        ctx
      )
    )
  )

// 10. stream-events
const stream = withPipelineOptions(
  program
    .command('stream-events')
    .requiredOption('-i, --input <path>', 'imagen de entrada')
    .option('-o, --out-dir <dir>', 'carpeta de salida')
)
stream.action((opts: Opts, cmd: Command) =>
  runCmd('stream-events', cmd, (ctx) =>
    streamEventsCommand({ input: opts.input, outDir: opts.outDir, pipeline: buildPipeline(opts) }, ctx)
  )
)

program.parseAsync(process.argv).catch((err) => {
  emitError('cli', 'E_FATAL', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
