import type * as Ort from 'onnxruntime-node'
import sharp from 'sharp'
import type { Ctx } from '../core/context'
import { SidecarError } from '../core/errors'
import { defaultOutputPath, defringeEdge, erodeAlpha, fromRgbaRaw, guidedFilterAlpha, readInput, snapAlphaToEdges, toRgbaRaw, writeOutput } from '../core/image'
import { getModel, isDownloaded, modelPath } from '../core/models/manager'
import { detectFlatBackground, removeBgColorStep } from './remove-bg-color'
import { removeBackgroundRecraft } from '../core/recraft'
import { runMatting } from '../core/matting'
import { buildBgHistogram, serializeBgHistogram, type SerializedBgHistogram } from '../core/bg-histogram'
import type { MatteMode } from '../core/types'

// ──────────────────────────────────────────────────────────────────────────
//  CONSTANTES TUNEABLES — consolidación del alfa (matte) por modo.
//  El matte IA se infiere a `size`² y se estira → rampa blanda. Cada modo
//  decide cuánto respetar esa rampa. LO = alfa que baja a 0 (fondo); HI = alfa
//  que sube a 255 (sujeto opaco). En medio:
//   - soft: PASS-THROUGH (alfa crudo) → pelo/semitransparencias intactas.
//   - medium/crisp: smoothstep [LO,HI] → borde consolidado (ancho/angosto).
//  (Los voy a iterar con imágenes reales.)
// ──────────────────────────────────────────────────────────────────────────

interface MatteParams {
  /** Alfa <= LO → 0 (fondo). */
  lo: number
  /** Alfa >= HI → 255 (sujeto opaco). */
  hi: number
  /**
   * 'pass' = mantener el alfa CRUDO en la banda (foto/pelo);
   * 'smooth' = smoothstep [LO,HI] (ilustración/producto/logo).
   */
  curve: 'pass' | 'smooth'
}

const MATTE: Record<MatteMode, MatteParams> = {
  // FOTO: banda muy ancha + pass-through. Solo lo MUY confiado va a opaco y solo
  // el fondo MUY claro a 0; el resto queda con el alfa del modelo → pelo intacto.
  soft: { lo: 13, hi: 217, curve: 'pass' },
  // ILUSTRACIÓN/PRODUCTO: smoothstep de banda más ancha que el logo → borde
  // limpio pero algo de antialias en diagonales/gradientes.
  medium: { lo: 20, hi: 150, curve: 'smooth' },
  // LOGO: comportamiento histórico (borde marcado, banda angosta).
  crisp: { lo: 35, hi: 110, curve: 'smooth' }
}

// ──────────────────────────────────────────────────────────────────────────
//  REFINAMIENTO DE ALFA — guided filter + snap a bordes (SOLO camino IA, foto).
//  Ataca el halo gris-beige ancho (~2-15px) del matte blando de BiRefNet:
//   1) guidedFilterAlpha: alinea el alfa a los bordes del RGB (guía = luma) de
//      forma edge-aware (suaviza, no aprieta solo).
//   2) snapAlphaToEdges: APRIETA la banda subiendo el contraste del alfa SOLO en
//      bordes de cuerpo sólido (saco), dejando el PELO intacto (gate por apertura
//      morfológica → mechones finos protegidos, cuerpo grueso afilado).
//   3) defringeEdge (despill, abajo): saca el beige de la banda ya apretada.
//  El matte 'soft' (pass-through) del perfil foto se mantiene; esto lo refina.
//
//  Valores tuneados sobre la foto de 3 personas (saco izq nítido + halo abajo +
//  pelo del centro natural). Medido en el .final.png: banda de transición media
//  23.1px → 5.9px y alfa parcial 1.75% → 0.58%, conservando la semitransparencia
//  del pelo (en la ventana del pelo quedan ~1.1k px de alfa parcial repartidos en
//  TODO el rango medio → NO binario).
// ──────────────────────────────────────────────────────────────────────────
/** [GF] Radio de ventana del guided filter sobre el alfa, en px a tamaño original. */
const GF_RADIUS = 12
/** [GF] Regularización en alfa² (guía/alfa en 0..255). Más chico = sigue más el borde. */
const GF_EPS = (0.012 * 255) ** 2 // ≈ 9.4
/**
 * [SNAP] Ganancia de contraste del alfa en el borde del saco. 10 colapsa la banda
 * a ~5px (saco nítido) sin tocar el pelo (el gate lo protege). Más alto endurece
 * apenas el borde grueso del pelo; más bajo deja algo de halo en el saco.
 */
const SNAP_GAIN = 10
/** [SNAP] Radio de la apertura morfológica: borra mechones más finos que ~2·este (px). */
const SNAP_OPEN_RADIUS = 3
/** [SNAP] Radio de la ventana de bimodalidad que detecta el borde de cuerpo sólido. */
const SNAP_GATE_RADIUS = 9
/** [SNAP] Exponente del gate: >1 suprime más los bordes de cuerpo dudosos (pelo). */
const SNAP_GATE_POWER = 2
/** [SNAP] Umbral de alfa para considerar un píxel "sólido" al armar el cuerpo. */
const SNAP_SOLID_THRESHOLD = 160

/** Aplica el modo de matte sobre el alfa de un RGBA crudo (in place). */
function applyMatte(rgba: Buffer, mode: MatteMode): void {
  const { lo, hi, curve } = MATTE[mode]
  for (let d = 3; d < rgba.length; d += 4) {
    const a = rgba[d]
    if (a <= lo) rgba[d] = 0
    else if (a >= hi) rgba[d] = 255
    else if (curve === 'pass') {
      // PASS-THROUGH: dejá el alfa crudo en la banda (clave para el pelo).
      // (no-op: el valor ya está en rgba[d])
    } else {
      const t = (a - lo) / (hi - lo)
      rgba[d] = Math.round(t * t * (3 - 2 * t) * 255)
    }
  }
}

// onnxruntime-node is a heavy native addon — load it lazily so the non-AI
// commands keep working even if it's missing/broken on this machine.
async function loadOrt(): Promise<typeof import('onnxruntime-node')> {
  try {
    return await import('onnxruntime-node')
  } catch (e) {
    throw new SidecarError(
      'E_ORT_MISSING',
      'onnxruntime-node no está disponible. Reinstalá las dependencias del sidecar.',
      String(e)
    )
  }
}

const sessions = new Map<string, Ort.InferenceSession>()

async function getSession(id: string, ort: typeof import('onnxruntime-node')): Promise<Ort.InferenceSession> {
  if (!isDownloaded(id)) {
    throw new SidecarError(
      'E_MODEL_MISSING',
      `Modelo "${id}" no descargado. Corré: bg-sidecar models download ${id}`
    )
  }
  const cached = sessions.get(id)
  if (cached) return cached
  const session = await ort.InferenceSession.create(modelPath(id))
  sessions.set(id, session)
  return session
}

export interface RemoveBgStepOptions {
  /** Modo de consolidación del alfa (soft=foto/pelo, medium, crisp=logo). */
  matte?: MatteMode
  /** Pasadas de defringeEdge antes de clipear (descontamina el color del borde). */
  defringe?: number
}

/** AI background removal: preprocess -> ONNX inference -> matte -> RGBA PNG. */
export async function removeBgStep(
  buf: Buffer,
  modelId: string,
  ctx: Ctx,
  opts: RemoveBgStepOptions = {}
): Promise<{ buffer: Buffer }> {
  const matte: MatteMode = opts.matte ?? 'crisp'
  const defringePasses = opts.defringe ?? 2
  const def = getModel(modelId)
  ctx.progress('remove-bg', 0.05, `Cargando modelo ${def.name}`)
  const ort = await loadOrt()
  const session = await getSession(modelId, ort)

  const meta = await sharp(buf).metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  if (!W || !H) throw new SidecarError('E_IMAGE', 'No se pudieron leer las dimensiones de la imagen')

  // — preprocess: RGB, resize to model input, normalize, HWC -> CHW —
  ctx.progress('remove-bg', 0.2, 'Preprocesando')
  const size = def.inputSize
  const area = size * size
  const resized = await sharp(buf).removeAlpha().resize(size, size, { fit: 'fill' }).raw().toBuffer()
  const chw = new Float32Array(3 * area)
  for (let i = 0, p = 0; i < area; i++, p += 3) {
    chw[i] = (resized[p] / 255 - def.mean[0]) / def.std[0]
    chw[area + i] = (resized[p + 1] / 255 - def.mean[1]) / def.std[1]
    chw[2 * area + i] = (resized[p + 2] / 255 - def.mean[2]) / def.std[2]
  }
  const input = new ort.Tensor('float32', chw, [1, 3, size, size])
  const feeds: Record<string, Ort.Tensor> = { [session.inputNames[0]]: input }

  // — inference —
  ctx.progress('remove-bg', 0.5, 'Inferencia (puede tardar)')
  const outputs = await session.run(feeds)
  const raw = (outputs[session.outputNames[0]] as Ort.Tensor).data as Float32Array

  // — postprocess: sigmoid / normalize -> 8-bit alpha -> resize to original —
  ctx.progress('remove-bg', 0.78, 'Postprocesando matte')
  const m = new Float32Array(area)
  if (def.sigmoid) {
    for (let i = 0; i < area; i++) m[i] = 1 / (1 + Math.exp(-raw[i]))
  } else {
    m.set(raw.subarray(0, area))
  }
  if (def.normalizeOutput) {
    let mn = Infinity
    let mx = -Infinity
    for (let i = 0; i < area; i++) {
      const v = m[i]
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    const span = mx - mn || 1
    for (let i = 0; i < area; i++) m[i] = (m[i] - mn) / span
  }
  const alphaSmall = Buffer.alloc(area)
  for (let i = 0; i < area; i++) {
    alphaSmall[i] = Math.max(0, Math.min(255, Math.round(m[i] * 255)))
  }

  // Redimensiona el matte a tamaño original. sharp puede devolver >1 canal al
  // rehacer el raw, así que leemos el stride REAL con resolveWithObject.
  const mask = await sharp(alphaSmall, { raw: { width: size, height: size, channels: 1 } })
    .resize(W, H, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const mch = mask.info.channels

  const base = await sharp(buf)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  const rch = base.info.channels

  // 1) Compón RGBA con el alfa CRUDO (rampa blanda), leyendo cada buffer por su
  //    stride real (evita el striping).
  const rgba = Buffer.alloc(W * H * 4)
  for (let i = 0, d = 0; i < W * H; i++, d += 4) {
    rgba[d] = base.data[i * rch]
    rgba[d + 1] = base.data[i * rch + 1]
    rgba[d + 2] = base.data[i * rch + 2]
    rgba[d + 3] = mask.data[i * mch]
  }

  // 2) Refinamiento del alfa — SOLO para el matte 'soft' (perfil FOTO/personas),
  //    que es el que sufre el halo gris-beige ancho del matte blando estirado.
  //    Primero el guided filter alinea el alfa a los bordes del RGB (guía = luma),
  //    luego el snap aprieta la banda SOLO en el borde del saco (cuerpo sólido),
  //    dejando el PELO natural. Ambos ANTES del defringe → el despill limpia el
  //    beige de la banda ya apretada. El matte 'soft' (pass-through) se mantiene:
  //    esto lo refina, no lo cambia. medium/crisp ya crispan vía smoothstep, así
  //    que no se tocan (su salida queda idéntica).
  if (matte === 'soft') {
    ctx.progress('remove-bg', 0.82, 'Afinando borde (guided filter)')
    guidedFilterAlpha(rgba, W, H, GF_RADIUS, GF_EPS)
    snapAlphaToEdges(rgba, W, H, {
      gain: SNAP_GAIN,
      openRadius: SNAP_OPEN_RADIUS,
      gateRadius: SNAP_GATE_RADIUS,
      gatePower: SNAP_GATE_POWER,
      solidThreshold: SNAP_SOLID_THRESHOLD
    })
  }

  // 3) Defringe: el matte IA usa el RGB ORIGINAL, así que el borde retiene el color
  //    del fondo (halo de color). Sangramos el color del sujeto hacia la banda
  //    semitransparente (la identificamos con el alfa crudo) → borde sin fleco.
  //    SIEMPRE antes de clipear el alfa (la banda blanda guía el sangrado).
  if (defringePasses > 0) {
    ctx.progress('remove-bg', 0.85, 'Descontaminando borde')
    defringeEdge(rgba, W, H, defringePasses)
  }

  // 4) Consolidar el alfa según el MODO de matte del perfil:
  //    - soft (foto): pass-through en la banda → preserva el alfa crudo del
  //      modelo (pelo/semitransparencias intactas), solo lleva a opaco lo muy
  //      confiado y a 0 el fondo muy claro.
  //    - medium / crisp: smoothstep [LO,HI]→[0,255] sesgado a opaco (banda
  //      ancha / angosta). NO usa contraste simétrico centrado en 128 (aplasta
  //      al sujeto con matte de alfa medio, ej. trajes oscuros).
  ctx.progress('remove-bg', 0.92, 'Consolidando matte')
  applyMatte(rgba, matte)

  const buffer = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()

  ctx.progress('remove-bg', 1)
  return { buffer }
}

// ──────────────────────────────────────────────────────────────────────────
//  MATTING DE CABELLO (MODNet) — ruta para PERSONAS.
//  MODNet es un matte de retrato COMPLETO: su alfa ES el recorte (con pelo), no
//  un refinador. Así que NO pasa por removeBgStep (BiRefNet): corremos MODNet,
//  componemos su alfa CRUDO (continuo → hebras intactas) sobre el RGB original y
//  dejamos el MISMO post-proceso de borde que el camino foto: despill
//  (defringeEdge) para sacar el color del fondo de la banda semitransparente del
//  pelo. NO binarizamos acá (el alfa continuo es justo lo que recupera el pelo);
//  si el perfil pide borde 'duro', removeBackground lo endurece al final como en
//  los demás caminos.
// ──────────────────────────────────────────────────────────────────────────
export interface MattingStepOptions {
  /** Pasadas de defringeEdge para descontaminar el color del borde del pelo. Default 2. */
  defringe?: number
}

/** Hair matting (MODNet): infiere el alfa de retrato → RGBA con el RGB original. */
export async function mattingStep(
  buf: Buffer,
  ctx: Ctx,
  opts: MattingStepOptions = {}
): Promise<{ buffer: Buffer }> {
  const defringePasses = opts.defringe ?? 2
  const { alpha, width: W, height: H } = await runMatting(buf, ctx)

  // RGB original (sin alfa, sRGB) por su stride real → componer con el alfa MODNet.
  const base = await sharp(buf)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  const rch = base.info.channels

  const rgba = Buffer.alloc(W * H * 4)
  for (let i = 0, d = 0; i < W * H; i++, d += 4) {
    rgba[d] = base.data[i * rch]
    rgba[d + 1] = base.data[i * rch + 1]
    rgba[d + 2] = base.data[i * rch + 2]
    rgba[d + 3] = alpha[i]
  }

  // Despill: el alfa MODNet usa el RGB ORIGINAL, así que la banda blanda del pelo
  // retiene el color del fondo (halo). Sangramos el color del sujeto hacia esa
  // banda (igual que el camino foto). NO toca el alfa → el pelo queda con su rampa.
  if (defringePasses > 0) {
    ctx.progress('matting', 0.95, 'Descontaminando borde')
    defringeEdge(rgba, W, H, defringePasses)
  }

  const buffer = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
  return { buffer }
}

export type RemoveMethod = 'ai' | 'color' | 'auto'

export interface RemoveParams {
  method: RemoveMethod
  model: string
  tolerance: number
  softness: number
  edgeMode: 'duro' | 'suave'
  /** Encoge el borde hacia adentro N px (quita fringe/bordes raros). 0 = off. */
  contract: number
  /** 'local' = rmbg/color local (gratis/privado); 'recraft' = IA premium (API). */
  provider: 'local' | 'recraft'
  /** Modo de matte para el camino IA (lo decide el perfil). Default 'crisp'. */
  matte?: MatteMode
  /** Pasadas de defringeEdge para el camino IA. Default 2. */
  defringe?: number
  /**
   * Ruta de MATTING DE CABELLO (MODNet) para PERSONAS: usa el alfa de retrato de
   * MODNet como matte del recorte EN VEZ del de BiRefNet (recupera el pelo).
   * Default OFF (BiRefNet sigue siendo el camino IA por defecto). Solo aplica al
   * provider 'local' (MODNet corre local). Ignora `method`/`model`.
   */
  matting?: boolean
}

/**
 * Despachador: elige IA (saliencia, para fotos) o color (flood-fill, para logos
 * sobre fondo plano). 'auto' detecta si el fondo es uniforme.
 */
/** Binariza el alfa: cada píxel queda 0 o 255 → borde nítido sin transparencia parcial. */
async function hardenAlpha(buf: Buffer, threshold = 128): Promise<Buffer> {
  const { data, width, height } = await toRgbaRaw(buf)
  for (let i = 3; i < data.length; i += 4) data[i] = data[i] >= threshold ? 255 : 0
  return fromRgbaRaw(data, width, height)
}

/** Encoge el borde del sujeto N px hacia adentro (quita fringe/bordes raros). */
async function contractAlpha(buf: Buffer, px: number): Promise<Buffer> {
  const { data, width, height } = await toRgbaRaw(buf)
  erodeAlpha(data, width, height, px)
  return fromRgbaRaw(data, width, height)
}

export async function removeBackground(
  buf: Buffer,
  params: RemoveParams,
  ctx: Ctx
): Promise<{ buffer: Buffer; method: 'ai' | 'color'; bgHistogram?: SerializedBgHistogram }> {
  let method: 'ai' | 'color' = 'ai'
  let buffer: Buffer
  if (params.provider === 'recraft') {
    ctx.progress('remove-bg', 0.2, 'Quitando fondo con Recraft (IA premium)… puede tardar ~10-15 s')
    buffer = await removeBackgroundRecraft(buf)
  } else if (params.matting) {
    // PERSONA: matting de cabello (MODNet) — su alfa ES el recorte, con pelo.
    // Reemplaza a BiRefNet como matte; el resto del post-proceso sigue igual.
    method = 'ai'
    const r = await mattingStep(buf, ctx, { defringe: params.defringe ?? 2 })
    buffer = r.buffer
  } else {
    if (params.method === 'auto') method = (await detectFlatBackground(buf)) ? 'color' : 'ai'
    else method = params.method
    if (method === 'color') {
      const r = await removeBgColorStep(
        buf,
        { tolerance: params.tolerance, softness: params.softness, edgeMode: params.edgeMode },
        ctx
      )
      buffer = r.buffer
      // Decontaminación de borde: saca el fleco claro del fondo que queda en la banda
      // semitransparente (halo sobre productos oscuros). NO baja la nitidez: sólo
      // recolorea el borde hacia el color del logo (no toca el alfa). Sobre el input
      // ya upscaleado el borde es fino, así que queda limpio y nítido, no "raro".
      {
        const { data, width, height } = await toRgbaRaw(buffer)
        defringeEdge(data, width, height, 4)
        // Erosión de 1px: corta el RIM claro EXTERIOR (opaco) que el defringe no
        // alcanza — es el "borde blanco" que se ve en las letras sobre fondo oscuro.
        erodeAlpha(data, width, height, 1)
        buffer = await fromRgbaRaw(data, width, height)
      }
    } else {
      const r = await removeBgStep(buf, params.model, ctx, {
        matte: params.matte ?? 'crisp',
        defringe: params.defringe ?? 2
      })
      buffer = r.buffer
    }
  }

  // MODELO DE COLOR DEL FONDO VERDADERO (para "restos de fondo" en el renderer):
  // se computa ACÁ porque la FUENTE (`buf`) y el MATTE (alfa del `buffer` recién
  // compuesto) están ALINEADOS (mismo frame, antes del auto-crop/upscale del
  // pipeline). Muestrea el RGB de la fuente donde el matte está removido (alfa<26 =
  // fondo verdadero) → distribución limpia que separa el locker de las personas.
  // ANTES de contract/harden: esos cambian el alfa del borde, pero el fondo
  // profundo (alfa<26) ya está decidido. 1 sola pasada por bg-removal.
  // Despill del fleco de color en el camino IA (persona/foto): el matte blando deja un
  // borde teñido con el color del fondo (halo claro). Lo recoloreamos hacia el sujeto SIN
  // tocar el alfa → mata el halo sin comerse el pelo. El camino 'color' ya lo hizo arriba;
  // Recraft entrega limpio, así que se salta.
  if (params.provider !== 'recraft' && method === 'ai') {
    const { data, width, height } = await toRgbaRaw(buffer)
    defringeEdge(data, width, height, 3)
    buffer = await fromRgbaRaw(data, width, height)
  }

  // Recraft entrega un recorte limpio → no hay "restos de fondo" que detectar; saltamos
  // el histograma (ahorra decodificar + barrer ~2M px en cada corrida). El renderer ya
  // cae a su heurística previa cuando falta. Solo se computa en el camino local.
  let bgHistogram: SerializedBgHistogram | undefined
  if (params.provider !== 'recraft') {
    try {
      const { data, width, height } = await toRgbaRaw(buffer)
      const h = await buildBgHistogram(buf, data, width, height)
      bgHistogram = serializeBgHistogram(h)
      // Sanidad en stderr (NO stdout): confirma que no es degenerado.
      console.error(
        `[bg-histogram] bgPixels=${h.bgPixels} nonZeroBins=${h.nonZeroBins} maxFreq=${h.maxFreq.toFixed(5)}`
      )
    } catch (e) {
      // El histograma es auxiliar (mejora la detección de restos): si falla, el
      // recorte sigue saliendo igual. Solo logueamos a stderr.
      console.error('[bg-histogram] no se pudo construir:', e instanceof Error ? e.message : String(e))
    }
  }

  // Contraer el borde hacia adentro (come fringe/bordes raros) antes de endurecer.
  if (params.contract > 0) buffer = await contractAlpha(buffer, params.contract)
  // Borde nítido (Duro): sin transparencia parcial, ideal para diseño/sublimado.
  if (params.edgeMode === 'duro') buffer = await hardenAlpha(buffer)

  return { buffer, method, bgHistogram }
}

export async function removeBgCommand(
  opts: {
    input: string
    output?: string
    model: string
    method?: RemoveMethod
    tolerance?: number
    softness?: number
    edgeMode?: 'duro' | 'suave'
    contract?: number
    provider?: 'local' | 'recraft'
    /** Ruta de matting de cabello (MODNet) para personas. Default OFF. */
    matting?: boolean
  },
  ctx: Ctx
): Promise<{ output: string; model: string; method: 'ai' | 'color' }> {
  const buf = await readInput(opts.input)
  const r = await removeBackground(
    buf,
    {
      method: opts.method ?? 'auto',
      model: opts.model,
      tolerance: opts.tolerance ?? 10,
      softness: opts.softness ?? 10,
      edgeMode: opts.edgeMode ?? 'suave',
      contract: opts.contract ?? 0,
      provider: opts.provider ?? 'local',
      matting: opts.matting ?? false
    },
    ctx
  )
  const output = opts.output ?? defaultOutputPath(opts.input, 'nobg', 'png')
  await writeOutput(output, r.buffer)
  return { output, model: opts.model, method: r.method }
}
