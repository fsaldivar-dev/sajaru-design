import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { FileCheck2, ImageOff } from 'lucide-react'

import type { BgHistogram, SamBoxInput, SamPointInput } from '@shared/types'
import { CHECKER } from '@renderer/lib/image'
import { createContourOverlay, type ContourOverlay } from './contourOverlay'
import {
  samPrecisionModel,
  type BrushParams,
  type EditorMode,
  type EditorView,
  type SamEverythingState,
  type SamMode,
  type SamPrecision,
  type SamSessionInfo,
  type SelectBrushOp
} from './types'

export interface ResultState {
  url: string
  format?: string
}

/** Acciones imperativas que la barra de opciones de herramienta dispara sobre el canvas. */
export interface ResultHandle {
  undo: () => void
  reset: () => void
  featherEdge: () => void
  /** Borra la basura semi-transparente que quedó FUERA del/los sujeto(s). */
  cleanOutside: () => void
  zoomIn: () => void
  zoomOut: () => void
  /** Selección inteligente (SAM): cicla entre las K formas candidatas en el preview. */
  samCycleShape: () => void
  /** Selección inteligente (SAM): hornea el preview al alfa según Sumar/Quitar. */
  samApply: () => void
  /** Selección inteligente (SAM): descarta la sesión (limpia preview, no toca el alfa). */
  samDiscard: () => void
  /** "Analizar todo" (sam-everything): segmenta toda la imagen → labelmap cacheado. */
  samAnalyzeAll: () => void
  /** "Analizar todo": aplica al alfa las regiones acumuladas (Shift+click) según Sumar/Quitar. */
  samEverythingApply: () => void
  /** "Analizar todo": limpia las regiones acumuladas (no toca el alfa). */
  samEverythingClear: () => void
  /** "Analizar todo": QUITA del recorte los "restos de fondo" detectados (banner [Quitar]). */
  samEverythingRemoveCandidates: () => void
  /** "Analizar todo": descarta los "restos de fondo" detectados (banner [Descartar], no toca el alfa). */
  samEverythingDismissCandidates: () => void
  /** Niveles (#2 Pulir): snapshot del alfa actual como base al entrar a la herramienta. */
  levelsEnter: () => void
  /** Niveles (#2 Pulir): previsualiza el ajuste de niveles del alfa desde la base (sin commitear). */
  previewLevels: (black: number, white: number, gamma: number) => void
  /** Niveles (#2 Pulir): al salir, commitea si hubo cambio o descarta el snapshot si no. */
  levelsLeave: () => void
  /** dataURL del lienzo ACTUAL (con los retoques) — para recortar a contenido sin reprocesar. */
  currentDataURL: () => string | null
  /** Recuperar pelo (#1 Pulir): toma base + carga el original alineado al entrar. */
  peloEnter: () => void
  /** Recuperar pelo (#1 Pulir): preview de la máscara B/N (afinar) o del pelo recuperado. */
  previewHair: (channel: 'auto' | 'r' | 'g' | 'b', contrast: number, invert: boolean, showMask: boolean) => void
  /** Recuperar pelo (#1 Pulir): suma el pelo recuperado al recorte (commit). */
  peloApply: (channel: 'auto' | 'r' | 'g' | 'b', contrast: number, invert: boolean) => void
  /** Recuperar pelo (#1 Pulir): al salir, descarta el preview si no sumaste nada. */
  peloLeave: () => void
}

const clampScale = (n: number): number => Math.min(16, Math.max(1, n))
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/**
 * Limpieza "fuera del sujeto": borra píxeles semi-transparentes de BASURA (hebras de
 * fondo tenues que dejó el motor) que quedan FUERA del/los sujeto(s), preservando el
 * sujeto y su borde suave. Opera in-place sobre el canal ALFA de un buffer RGBA.
 *
 * Algoritmo (todo en typed arrays, una pasada global; el zoom/coords no aplican):
 *  1. `solid` = alfa ≥ 128 → el cuerpo sólido del sujeto (no el feather del borde).
 *  2. Componentes conexas de `solid` por flood-fill iterativo 8-conexo; se calcula el
 *     área de cada una. Se conservan SOLO las significativas (área ≥ max(64 px, 0.05%
 *     del total)); las chicas son motas y se descartan.
 *  3. `keepRegion` = dilatación (chebyshev / cuadrado) de la unión de los sujetos
 *     significativos por `dilate` px (~3) → margen que PRESERVA el anti-aliasing del
 *     borde del sujeto.
 *  4. Todo pixel que NO cae en `keepRegion` → alfa = 0. Los píxeles DENTRO de
 *     `keepRegion` NO se tocan (no se re-thresholdea: se preserva el feather del sujeto).
 *
 * @returns true si modificó algún pixel (para decidir si vale la pena commitear).
 */
function cleanOutsideAlpha(data: Uint8ClampedArray, W: number, H: number, dilate = 3): boolean {
  const N = W * H
  if (N === 0) return false

  // (1) Máscara del cuerpo sólido del sujeto.
  const solid = new Uint8Array(N)
  for (let p = 0, i = 3; p < N; p++, i += 4) solid[p] = data[i] >= 128 ? 1 : 0

  // (2) Componentes conexas (8-conn) de `solid`; quedarse con las significativas.
  const minArea = Math.max(64, Math.floor(N * 0.0005)) // 0.05% del total, piso 64 px.
  const label = new Int32Array(N).fill(-1) // -1 = sin etiquetar; -2 = fondo (no sólido).
  const stack = new Int32Array(N) // pila reutilizable para el flood-fill iterativo.
  const compKeep: boolean[] = [] // por componente: ¿es un sujeto significativo?
  let nextLabel = 0

  for (let s = 0; s < N; s++) {
    if (solid[s] === 0) {
      label[s] = -2
      continue
    }
    if (label[s] !== -1) continue
    const id = nextLabel++
    let area = 0
    let sp = 0
    stack[sp++] = s
    label[s] = id
    while (sp > 0) {
      const p = stack[--sp]
      area++
      const x = p % W
      const y = (p / W) | 0
      // 8 vecinos: cardinales + diagonales.
      const x0 = x > 0
      const x1 = x < W - 1
      const y0 = y > 0
      const y1 = y < H - 1
      if (x0 && solid[p - 1] === 1 && label[p - 1] === -1) { label[p - 1] = id; stack[sp++] = p - 1 }
      if (x1 && solid[p + 1] === 1 && label[p + 1] === -1) { label[p + 1] = id; stack[sp++] = p + 1 }
      if (y0 && solid[p - W] === 1 && label[p - W] === -1) { label[p - W] = id; stack[sp++] = p - W }
      if (y1 && solid[p + W] === 1 && label[p + W] === -1) { label[p + W] = id; stack[sp++] = p + W }
      if (x0 && y0 && solid[p - W - 1] === 1 && label[p - W - 1] === -1) { label[p - W - 1] = id; stack[sp++] = p - W - 1 }
      if (x1 && y0 && solid[p - W + 1] === 1 && label[p - W + 1] === -1) { label[p - W + 1] = id; stack[sp++] = p - W + 1 }
      if (x0 && y1 && solid[p + W - 1] === 1 && label[p + W - 1] === -1) { label[p + W - 1] = id; stack[sp++] = p + W - 1 }
      if (x1 && y1 && solid[p + W + 1] === 1 && label[p + W + 1] === -1) { label[p + W + 1] = id; stack[sp++] = p + W + 1 }
    }
    compKeep[id] = area >= minArea
  }

  // Sin ningún sujeto significativo (imagen vacía/sin recorte sólido): no tocar nada
  // para no borrar todo el contenido por error.
  let anyKeptComp = false
  for (let k = 0; k < nextLabel; k++) if (compKeep[k]) { anyKeptComp = true; break }
  if (!anyKeptComp) return false

  // Semilla de la dilatación: los píxeles sólidos de las componentes significativas.
  const seed = new Uint8Array(N)
  for (let p = 0; p < N; p++) {
    const l = label[p]
    if (l >= 0 && compKeep[l]) seed[p] = 1
  }

  // (3) keepRegion = dilatar `seed` por `dilate` px (chebyshev). Dilatación separable:
  // una pasada horizontal + una vertical por paso, repetida `dilate` veces. Cada paso
  // expande 1 px en las 8 direcciones, así que `dilate` pasos = radio `dilate` (cuadrado).
  // Doble buffer (`keep` ↔ `other`); `seed` queda intacto (entrada inmutable).
  const r = Math.max(0, Math.floor(dilate))
  let keep = seed
  if (r > 0) {
    let keepBuf = new Uint8Array(seed) // copia de trabajo (no mutamos `seed`).
    let other = new Uint8Array(N)
    const tmp = new Uint8Array(N)
    for (let step = 0; step < r; step++) {
      // Horizontal: a[p] = max(a[p-1], a[p], a[p+1]) por fila.
      for (let y = 0; y < H; y++) {
        const row = y * W
        for (let x = 0; x < W; x++) {
          const p = row + x
          let v = keepBuf[p]
          if (x > 0 && keepBuf[p - 1]) v = 1
          if (x < W - 1 && keepBuf[p + 1]) v = 1
          tmp[p] = v
        }
      }
      // Vertical: a[p] = max(a[p-W], a[p], a[p+W]) por columna → `other`.
      for (let y = 0; y < H; y++) {
        const row = y * W
        for (let x = 0; x < W; x++) {
          const p = row + x
          let v = tmp[p]
          if (y > 0 && tmp[p - W]) v = 1
          if (y < H - 1 && tmp[p + W]) v = 1
          other[p] = v
        }
      }
      // El resultado de este paso (`other`) es la entrada del siguiente.
      const swap = keepBuf
      keepBuf = other
      other = swap
    }
    keep = keepBuf
  }

  // (4) Fuera de keepRegion → alfa 0. DENTRO no se toca (se preserva el feather).
  let changed = false
  for (let p = 0, i = 3; p < N; p++, i += 4) {
    if (keep[p] === 0 && data[i] !== 0) {
      data[i] = 0
      changed = true
    }
  }
  return changed
}

/**
 * Modos donde el ZOOM + PAN están habilitados. Antes solo 'mover' podía hacer zoom;
 * ahora la Selección y los pinceles también, para poder refinar el borde pixel a
 * pixel. El transform (translate+scale) se aplica al MISMO contenedor que envuelve
 * canvas + overlay de máscara + overlay Konva, así todo escala/panea alineado y el
 * borde marching-ants sigue calzando exacto.
 */
const ZOOMABLE: ReadonlySet<EditorMode> = new Set<EditorMode>([
  'mover',
  'seleccion',
  'borrar',
  'restaurar',
  'color',
  'sam',
  'niveles',
  'pelo'
])
/** Modos de pincel (el arrastre pinta). En estos, el pan va con la barra ESPACIADORA. */
const BRUSH_MODES: ReadonlySet<EditorMode> = new Set<EditorMode>(['seleccion', 'borrar', 'restaurar'])

/**
 * Resultado editable: el lienzo + overlay de máscara. TODA la lógica de canvas
 * (eraseAt/restoreAt/magicErase/featherEdge/undo/reset/commit/renderMask/mapPoint)
 * vive acá; el estado de SELECCIÓN de herramienta (mode/view/pincel/op) ahora llega
 * por props desde QuitarFondo, y las acciones se exponen por `ref`.
 */
export const ResultPanel = forwardRef<ResultHandle, {
  result?: ResultState | null
  onEdited?: (dataUrl: string) => void
  /** Cambia al cargar una imagen NUEVA (no al reprocesar). Resetea la vista. */
  sourceKey?: string | null
  mode: EditorMode
  view: EditorView
  brush: BrushParams
  /** Dirección del pincel de Selección: Sumar (+) o Quitar (−). */
  selectOp: SelectBrushOp
  /**
   * Imagen FUENTE (la que produjo el resultado). Se usa para (a) encodear con
   * MobileSAM al entrar a "Selección inteligente" y (b) tomar su RGBA cuando se
   * SUMA un objeto (revelar). Puede estar upscaleada vs el recorte → reescalamos.
   */
  sourceFile?: File | null
  /**
   * Modelo de color del FONDO VERDADERO (histograma 24³) que computó el sidecar en
   * el recorte: RGB de la FUENTE donde el matte está removido (alfa<26). Es la fuente
   * CORRECTA para "restos de fondo" — en el sidecar fuente y matte están alineados, así
   * que separa limpio el locker de las personas (validado: locker≈0.21 vs personas≈0.01).
   * El renderer NO puede reconstruirlo bien (el lienzo borra el RGB del fondo a 0; la
   * fuente está des-alineada por auto-crop/upscale). null = caer a la heurística previa.
   */
  bgHistogram?: BgHistogram | null
  /** Selección inteligente (SAM): precisión del encoder ('fast'=MobileSAM / 'precise'=SAM ViT-B). */
  samPrecision?: SamPrecision
  /** Selección inteligente (SAM): sub-modo Click/box ('prompt') vs "Analizar todo" ('everything'). */
  samMode?: SamMode
  /** Selección inteligente (SAM): reporta si hay un encode/decode en curso. */
  onSamBusy?: (busy: boolean) => void
  /** Selección inteligente (SAM): reporta un hint/estado para la barra de opciones. */
  onSamHint?: (hint: string | null) => void
  /** Selección inteligente (SAM): estado de la sesión interactiva (preview) o null. */
  onSamSession?: (session: SamSessionInfo | null) => void
  /** "Analizar todo" (sam-everything): reporta su estado (analizando / listo / acumuladas). */
  onSamEverything?: (state: SamEverythingState | null) => void
  /** A/B (#12): URL de la imagen ORIGINAL para superponerla a tamaño real al comparar. */
  sourceUrl?: string | null
  /** A/B (#12): mostrar el ORIGINAL sobre el recorte (mantené para comparar). */
  compareOriginal?: boolean
}>(function ResultPanel(
  { result, onEdited, sourceKey, mode, view, brush, selectOp, sourceFile, bgHistogram, samPrecision = 'fast', samMode = 'prompt', onSamBusy, onSamHint, onSamSession, onSamEverything, sourceUrl, compareOriginal },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Overlay para la vista de MÁSCARA (alfa en B/N). No destructivo: nunca toca el RGBA real.
  const maskRef = useRef<HTMLCanvasElement>(null)
  // Overlay de PREVIEW de la Selección inteligente (SAM): tinte azul semi-transparente
  // de la candidata mostrada. No destructivo: el alfa real solo cambia al APLICAR.
  const samPreviewRef = useRef<HTMLCanvasElement>(null)
  // Contenedor del overlay de SELECCIÓN (Konva). Encima de todo; solo activo en mode==='seleccion'.
  const contourHostRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Contenedor que recibe el transform (translate+scale). Envuelve canvas + máscara +
  // overlay Konva para que escalen/paneen JUNTOS y el borde siga calzando exacto.
  const viewportRef = useRef<HTMLDivElement>(null)
  const contour = useRef<ContourOverlay | null>(null)
  const original = useRef<ImageData | null>(null)
  // Copia del recorte original en un canvas, para el pincel Restaurar (pintar de vuelta por zona).
  const originalCanvas = useRef<HTMLCanvasElement | null>(null)
  const drawing = useRef(false)
  const pan = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const history = useRef<string[]>([])
  // Niveles (#2 — Pulir): base = snapshot del alfa al entrar; buf = copia de trabajo reusada para
  // el preview no destructivo; changed = si hubo ajuste real (para commitear o descartar al salir).
  const levelsBase = useRef<ImageData | null>(null)
  const levelsBuf = useRef<ImageData | null>(null)
  const levelsChanged = useRef(false)
  // Recuperar pelo (#1 — Pulir): base = snapshot del alfa al entrar; source = RGB del ORIGINAL
  // alineado al lienzo (para la técnica de canales); applied = si ya sumó pelo (commit vs revertir).
  const peloBase = useRef<ImageData | null>(null)
  const peloSource = useRef<ImageData | null>(null)
  const peloApplied = useRef(false)
  // Última imagen (result.url) para la que ya se corrió la limpieza-fuera automática al
  // entrar a Selección. Garantiza que el auto-run pase UNA sola vez por imagen (no en
  // cada toggle de herramienta). Se resetea al cargar una imagen nueva / reprocesar.
  const cleanedFor = useRef<string | null>(null)

  // ── Selección inteligente (SAM) ─────────────────────────────────────────────
  // Cache del embedding POR (IMAGEN FUENTE + MODELO): el encode es caro y se hace 1 vez
  // por combinación. La key es identidad-de-la-fuente + precisión (mobilesam/sam-vitb):
  // así cambiar Rápido↔Preciso re-encodea, y volver atrás vuelve a pegar en cache.
  // {embeddingPath, origW, origH} = tamaño de la FUENTE (no del recorte), espacio en el
  // que viven las coords del prompt.
  const samEmb = useRef<{ key: string; embeddingPath: string; origW: number; origH: number } | null>(null)
  // Canvas con el RGBA de la imagen FUENTE (lazy): fuente de píxeles al SUMAR (revelar).
  const samSourceCanvas = useRef<HTMLCanvasElement | null>(null)
  const samSourceKey = useRef<string | null>(null)
  // Modelo de color del FONDO VERDADERO para "restos de fondo": histograma 24³. La FUENTE
  // de verdad es el histograma que computa el SIDECAR (prop `bgHistogram`): RGB de la fuente
  // donde el MATTE está removido (alfa<26), con fuente y matte ALINEADOS (mismo frame, antes
  // de auto-crop/upscale) → separa limpio el locker de las personas. Acá solo lo decodeamos
  // de base64 una vez y lo cacheamos por identidad de la fuente. FALLBACK (si el sidecar no lo
  // dio, ej. provider recraft): histograma del marco exterior de la fuente (heurística previa,
  // peor: el sujeto puede tocar los bordes). Cacheado por identidad de la fuente.
  const samBgModel = useRef<{ key: string; hist: Float64Array; maxFreq: number } | null>(null)
  // Token monotónico: descarta respuestas de encode/decode viejas (imagen/herramienta
  // cambió mientras una llamada estaba en vuelo).
  const samToken = useRef(0)
  // Drag para el box-prompt (px de PANTALLA del wrap, para dibujar el rectángulo).
  const samBox = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  // Intención del gesto SAM en curso: ¿es un punto EXCLUIR (−)? (Alt o click-derecho al
  // apretar). Un EXCLUIR siempre es un CLICK (no abre box). Se resetea en cada pointerUp.
  const samExclude = useRef(false)
  const [samBoxRect, setSamBoxRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [samWorking, setSamWorking] = useState(false)

  // ── Sesión INTERACTIVA de SAM (estilo Affinity) ─────────────────────────────
  // El primer click/box arranca una sesión: muestra la selección en PREVIEW (sin
  // aplicar). Los clicks siguientes ACUMULAN puntos (+ incluir / − excluir) y se
  // re-decodea con TODOS los puntos (realimentando el low-res previo). "Otra forma"
  // cicla entre las K candidatas; "Aplicar" hornea al alfa; "Descartar" limpia.
  //  · points/box: el prompt acumulado, en px de la FUENTE (espacio del embedding).
  //  · candidates: las K máscaras (PNG bytes) + IoU; chosen = la mostrada en preview.
  //  · lowResPath: low-res de la elegida (lo reenvía al refinar como maskInputPath).
  // Vive en un ref (la lógica de canvas lo lee sin re-render); `samUI` es el espejo
  // de estado que dispara el re-render del preview y el reporte a la barra.
  const samSession = useRef<{
    points: SamPointInput[]
    box: SamBoxInput | null
    candidates: { bytes: ArrayBuffer; iou: number; coverage: number }[]
    chosen: number
    lowResPath: string | null
  } | null>(null)
  // Espejo mínimo en estado para re-renderizar el preview y reportar a la barra.
  const [samUI, setSamUI] = useState<SamSessionInfo | null>(null)

  // ── "Analizar todo" (sam-everything) ────────────────────────────────────────
  // Segmenta TODA la imagen FUENTE en regiones de una pasada (~50s). El labelmap
  // (PNG 8-bit, tamaño FUENTE: pixel = índice 1-based de su región, 0 = ninguna) se
  // decodea a UN solo array a tamaño CANVAS (nearest-neighbor) → `labelMapCanvas`: el
  // hover-lookup, el resaltado y el componer leen el MISMO espacio que el canvas (sin
  // remapear coords más que puntero→px-canvas vía toCanvasPx). Cacheado por imagen
  // FUENTE: re-analizar lo pisa; cambiar de imagen lo limpia.
  const samEvery = useRef<{
    key: string
    sw: number // ancho de la FUENTE (labelmap nativo): el lookup/región viven en este espacio
    sh: number // alto de la FUENTE
    cw: number // tamaño del canvas/recorte al analizar (para mapear canvas→fuente igual que el modo prompt)
    ch: number
    label: Uint8Array // sw*sh (FUENTE): valor = índice 1-based de la región, 0 = ninguna
    count: number
  } | null>(null)
  // Regiones acumuladas con Shift+click (a la espera de Aplicar) + la región actualmente
  // bajo el cursor (hover). El overlay azul = unión de (pinned ∪ hover). En refs: la
  // lógica de canvas las lee sin re-render; `samEveryUI` es el espejo que reporta a la barra.
  const samEveryPinned = useRef<Set<number>>(new Set())
  const samEveryHover = useRef<number>(0) // índice 1-based bajo el cursor (0 = ninguno)
  // "Restos de fondo" DETECTADOS por la heurística bg-color-match tras "Analizar todo":
  // regiones que el matte conservó (keptFrac alto) pero cuyo color coincide con el del
  // fondo REMOVIDO (avgBgMatch alto) → objetos de fondo pegados entre/dentro de los
  // sujetos (ej. el locker entre dos personas). Se resaltan en ÁMBAR (distinto del azul
  // del hover/pinned) y la barra ofrece [Quitar]/[Descartar]. Es un set SEPARADO del
  // `samEveryPinned` manual: el hover/click manual sigue funcionando sin pisarse. Se
  // computa UNA vez por análisis (cacheado) y se limpia al re-analizar / cambiar imagen.
  const samEveryCandidates = useRef<Set<number>>(new Set())
  const [samEveryUI, setSamEveryUI] = useState<SamEverythingState | null>(null)

  const [scale, setScale] = useState(1)
  const [off, setOff] = useState({ x: 0, y: 0 })
  // Espejo en refs de scale/off: zoomAtCursor lee SIEMPRE el valor vigente aunque lleguen
  // muchos eventos de rueda en el mismo frame (closures de evento serían stale), y evita
  // anidar setters. Se sincronizan abajo en un efecto.
  const scaleRef = useRef(1)
  const offRef = useRef({ x: 0, y: 0 })
  // Barra ESPACIADORA mantenida → en modos de pincel el arrastre PANEA (estilo
  // Photoshop) en vez de pintar; el cursor pasa a "mano". Se libera al soltar Space.
  const [spaceHeld, setSpaceHeld] = useState(false)
  // Posición en pantalla (px del wrap) del cursor de pincel, para dibujar su círculo.
  // null = no mostrar (fuera del lienzo o en un modo sin pincel).
  const [brushCursor, setBrushCursor] = useState<{ x: number; y: number } | null>(null)

  // Params de pincel/refinado (lift de estado): se leen de props.
  const { size: brushSize, hardness, flow, colorTol, colorGlobal, feather } = brush

  const isTiff = result?.format === 'tiff'
  const editable = Boolean(result && !isTiff)

  // Redibuja el overlay de máscara desde el canal ALFA del canvas principal (rgb=(a,a,a), alpha=255).
  const renderMask = useCallback((): void => {
    const c = canvasRef.current
    const m = maskRef.current
    if (!c || !m) return
    if (m.width !== c.width || m.height !== c.height) {
      m.width = c.width
      m.height = c.height
    }
    const sctx = c.getContext('2d')
    const mctx = m.getContext('2d')
    if (!sctx || !mctx) return
    const src = sctx.getImageData(0, 0, c.width, c.height)
    const out = mctx.createImageData(c.width, c.height)
    const sd = src.data
    const od = out.data
    for (let i = 0; i < sd.length; i += 4) {
      const a = sd[i + 3]
      od[i] = a
      od[i + 1] = a
      od[i + 2] = a
      od[i + 3] = 255
    }
    mctx.putImageData(out, 0, 0)
  }, [])

  useEffect(() => {
    if (!result || isTiff) return
    const img = new Image()
    img.onload = () => {
      const c = canvasRef.current
      if (!c) return
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.drawImage(img, 0, 0)
      original.current = ctx.getImageData(0, 0, c.width, c.height)
      // Fuente del pincel Restaurar = la FOTO ORIGINAL (no el recorte). Así "Restaurar"
      // puede traer de vuelta píxeles que el quitado AUTOMÁTICO removió (en el recorte están
      // transparentes), además de deshacer tus borrados. Se dibuja al tamaño del recorte
      // (coinciden con auto-crop apagado, igual que el A/B "Comparar"). Fallback: el recorte.
      const oc = originalCanvas.current ?? document.createElement('canvas')
      oc.width = c.width
      oc.height = c.height
      const octx = oc.getContext('2d')
      if (octx) {
        octx.clearRect(0, 0, oc.width, oc.height)
        if (sourceUrl) {
          const simg = new Image()
          simg.onload = (): void => {
            octx.clearRect(0, 0, oc.width, oc.height)
            octx.drawImage(simg, 0, 0, oc.width, oc.height)
          }
          simg.src = sourceUrl
        } else {
          octx.drawImage(img, 0, 0)
        }
        originalCanvas.current = oc
      }
      history.current = []
      // Imagen/resultado nuevo → habilitar de nuevo la limpieza-fuera automática.
      cleanedFor.current = null
      renderMask()
      // Si Selección está activa y cambió la imagen (nuevo tamaño), re-alinear el
      // overlay al nuevo object-contain y regenerar el borde desde el alfa nuevo.
      if (contour.current) {
        syncLayout()
        refreshEdge()
      }
    }
    img.src = result.url
    setScale(1)
    setOff({ x: 0, y: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.url, isTiff, renderMask, sourceUrl])

  // Cuando se activa la vista de máscara (o cambia la imagen), sincronizar el overlay.
  useEffect(() => {
    if (editable && view === 'mask') renderMask()
  }, [view, editable, renderMask])

  // Imagen NUEVA (cambia sourceKey, NO al reprocesar) → resetear vista/zoom.
  useEffect(() => {
    setScale(1)
    setOff({ x: 0, y: 0 })
  }, [sourceKey])

  // Mantener los refs sincronizados con el estado (los lee zoomAtCursor).
  useEffect(() => {
    scaleRef.current = scale
  }, [scale])
  useEffect(() => {
    offRef.current = off
  }, [off])

  // ANTES: al salir de Mover se reseteaba zoom/pan → imposible refinar a nivel de pixel
  // (el pincel forzaba scale=1). AHORA el zoom se CONSERVA al cambiar de herramienta:
  // todos los modos editables comparten zoom+pan, así podés acercar y refinar el borde
  // sin perder el encuadre. Solo se resetea al cargar imagen nueva (sourceKey/result.url).

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Pan estilo Photoshop: barra ESPACIADORA mantenida → mano + arrastre panea (no pinta).
  // Solo importa en modos de pincel (ahí el arrastre normal pinta). Listeners en window
  // con cleanup; ignoramos el repeat del teclado para no re-setear estado en cada frame.
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' && e.key !== ' ') return
      // No robar el espacio si el foco está en un input/área de texto/botón.
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return
      if (e.repeat) {
        e.preventDefault()
        return
      }
      e.preventDefault()
      setSpaceHeld(true)
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' && e.key !== ' ') return
      setSpaceHeld(false)
    }
    // Si la ventana pierde el foco con Space apretado, soltarlo para no quedar en pan.
    const blur = (): void => setSpaceHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // Convierte clientX/clientY del puntero a px INTRÍNSECOS de un canvas mostrado con
  // object-contain. Núcleo compartido: el overlay de Contorno usa la MISMA cuenta
  // (en su `layout`) para alinear su capa, por eso un nodo cae en el pixel correcto.
  function toCanvasPx(c: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number; s: number } {
    const rect = c.getBoundingClientRect()
    const s = Math.min(rect.width / c.width, rect.height / c.height)
    const padX = (rect.width - c.width * s) / 2
    const padY = (rect.height - c.height * s) / 2
    return { x: (clientX - rect.left - padX) / s, y: (clientY - rect.top - padY) / s, s }
  }

  // Mapea el puntero a píxeles del canvas teniendo en cuenta el object-contain.
  function mapPoint(e: React.PointerEvent): { x: number; y: number; r: number } {
    const { x, y, s } = toCanvasPx(canvasRef.current!, e.clientX, e.clientY)
    return { x, y, r: brushSize / s }
  }

  // Gradiente radial reutilizable para pinceles suaves: alfa=peso en el centro -> 0 en el borde.
  // dureza alta = núcleo sólido amplio (caída corta); dureza baja = pluma amplia.
  function softGradient(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, weight: number): CanvasGradient {
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(0.01, r))
    const core = clamp01(hardness / 100)
    g.addColorStop(0, `rgba(0,0,0,${weight})`)
    if (core > 0 && core < 1) g.addColorStop(core, `rgba(0,0,0,${weight})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    return g
  }

  function eraseAt(e: React.PointerEvent): void {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const { x, y, r } = mapPoint(e)
    const weight = clamp01(flow / 100)
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = softGradient(ctx, x, y, r, weight)
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    if (view === 'mask') renderMask()
  }

  // Restaurar: pinta de vuelta el recorte ORIGINAL (color + alfa) bajo el pincel, con caída suave.
  // Sirve para recuperar lo que se borró de más, localmente y con transparencia parcial.
  function restoreAt(e: React.PointerEvent): void {
    const ctx = canvasRef.current?.getContext('2d')
    const src = originalCanvas.current
    if (!ctx || !src) return
    const { x, y, r } = mapPoint(e)
    const weight = clamp01(flow / 100)
    const rr = Math.max(1, Math.ceil(r))
    // Estampa el original en un buffer del tamaño del pincel y lo recorta con una máscara radial.
    const tmp = document.createElement('canvas')
    tmp.width = rr * 2
    tmp.height = rr * 2
    const tctx = tmp.getContext('2d')
    if (!tctx) return
    tctx.drawImage(src, x - rr, y - rr, rr * 2, rr * 2, 0, 0, rr * 2, rr * 2)
    tctx.globalCompositeOperation = 'destination-in'
    tctx.fillStyle = softGradient(tctx, rr, rr, r, weight)
    tctx.beginPath()
    tctx.arc(rr, rr, r, 0, Math.PI * 2)
    tctx.fill()
    ctx.drawImage(tmp, x - rr, y - rr)
    if (view === 'mask') renderMask()
  }

  // Varita: borra el color CONECTADO bajo el click (flood-fill por similitud).
  // Así clickeás el celeste y se va solo ese color; la estrella y el navy quedan.
  function magicErase(e: React.PointerEvent): void {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const { x, y } = mapPoint(e)
    const W = c.width
    const H = c.height
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= W || py >= H) return

    const img = ctx.getImageData(0, 0, W, H)
    const data = img.data
    const start = py * W + px
    if (data[start * 4 + 3] === 0) return
    const tr = data[start * 4]
    const tg = data[start * 4 + 1]
    const tb = data[start * 4 + 2]

    pushHistory()
    if (colorGlobal) {
      // "Todo el color": borra TODOS los píxeles opacos dentro de la tolerancia del color
      // clickeado (no solo los conectados) → limpia un piso/fondo partido en parches de un click.
      for (let p = 0; p < W * H; p++) {
        const i = p * 4
        if (data[i + 3] === 0) continue
        const dr = data[i] - tr
        const dg = data[i + 1] - tg
        const db = data[i + 2] - tb
        if (Math.sqrt(dr * dr + dg * dg + db * db) <= colorTol) data[i + 3] = 0
      }
    } else {
      // Contiguo (default): flood-fill por similitud desde el click (borra solo el color conectado).
      const visited = new Uint8Array(W * H)
      const stack = [start]
      visited[start] = 1
      while (stack.length > 0) {
        const p = stack.pop() as number
        const i = p * 4
        if (data[i + 3] === 0) continue
        const dr = data[i] - tr
        const dg = data[i + 1] - tg
        const db = data[i + 2] - tb
        if (Math.sqrt(dr * dr + dg * dg + db * db) > colorTol) continue
        data[i + 3] = 0
        const xx = p % W
        const yy = (p / W) | 0
        if (xx > 0 && !visited[p - 1]) { visited[p - 1] = 1; stack.push(p - 1) }
        if (xx < W - 1 && !visited[p + 1]) { visited[p + 1] = 1; stack.push(p + 1) }
        if (yy > 0 && !visited[p - W]) { visited[p - W] = 1; stack.push(p - W) }
        if (yy < H - 1 && !visited[p + W]) { visited[p + W] = 1; stack.push(p + W) }
      }
    }
    ctx.putImageData(img, 0, 0)
    commit()
  }

  // Suavizar borde: desenfoque box separable aplicado SOLO al canal ALFA (RGB intacto).
  // Suaviza cortes duros para que el pelo/recorte se vea natural. Sutil (radio 1..3 px).
  function featherEdge(): void {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const radius = Math.round(feather)
    if (radius < 1) return
    pushHistory()
    const W = c.width
    const H = c.height
    const img = ctx.getImageData(0, 0, W, H)
    const data = img.data
    const a = new Float32Array(W * H)
    for (let i = 0, p = 0; i < data.length; i += 4, p++) a[p] = data[i + 3]
    const tmp = new Float32Array(W * H)
    const win = radius * 2 + 1
    // Pasada horizontal.
    for (let y = 0; y < H; y++) {
      const row = y * W
      let sum = 0
      for (let k = -radius; k <= radius; k++) sum += a[row + Math.min(W - 1, Math.max(0, k))]
      for (let x = 0; x < W; x++) {
        tmp[row + x] = sum / win
        const add = row + Math.min(W - 1, x + radius + 1)
        const sub = row + Math.max(0, x - radius)
        sum += a[add] - a[sub]
      }
    }
    // Pasada vertical.
    for (let x = 0; x < W; x++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) sum += tmp[Math.min(H - 1, Math.max(0, k)) * W + x]
      for (let y = 0; y < H; y++) {
        a[y * W + x] = sum / win
        const add = Math.min(H - 1, y + radius + 1) * W + x
        const sub = Math.max(0, y - radius) * W + x
        sum += tmp[add] - tmp[sub]
      }
    }
    for (let i = 0, p = 0; i < data.length; i += 4, p++) data[i + 3] = a[p]
    ctx.putImageData(img, 0, 0)
    commit()
  }

  // Limpiar afuera: borra los píxeles semi-transparentes de basura (hebras de fondo que
  // dejó el motor) que quedan FUERA del/los sujeto(s), conservando el sujeto y su borde
  // suave. Pasada global sobre el alfa (componentes + dilatación ~3px + clear-afuera);
  // ver `cleanOutsideAlpha`. Undoable (pushHistory) y regenera el borde marching-ants.
  // `silent` evita un pushHistory propio cuando el auto-run ya hizo el snapshot.
  function cleanOutside(silent = false): void {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    if (!silent) pushHistory()
    const W = c.width
    const H = c.height
    const img = ctx.getImageData(0, 0, W, H)
    const changed = cleanOutsideAlpha(img.data, W, H, 3)
    if (!changed) {
      // No había basura afuera: revertir el snapshot vacío para no inflar el historial.
      if (!silent) history.current.pop()
      return
    }
    ctx.putImageData(img, 0, 0)
    commit()
    if (contour.current) refreshEdge()
  }

  function pushHistory(): void {
    const c = canvasRef.current
    if (!c) return
    history.current.push(c.toDataURL('image/png'))
    if (history.current.length > 20) history.current.shift()
  }

  // ── Niveles del recorte (#2 — Pulir) ─────────────────────────────────────────
  // Niveles de Photoshop aplicados al canal ALFA. Preview NO destructivo: al entrar se
  // toma una BASE (snapshot) + un punto de undo; cada cambio re-mapea el alfa desde la base
  // (RGB intacto) reusando un buffer; al salir, commitea si hubo cambio o descarta el snapshot.
  function levelsEnter(): void {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const base = ctx.getImageData(0, 0, c.width, c.height)
    levelsBase.current = base
    levelsBuf.current = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height)
    levelsChanged.current = false
    pushHistory() // undo = estado PRE-niveles (se descarta al salir si no hubo cambio)
  }
  function previewLevels(black: number, white: number, gamma: number): void {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    const base = levelsBase.current
    const buf = levelsBuf.current
    if (!c || !ctx || !base || !buf) return
    const span = Math.max(1, white - black)
    const invG = 1 / Math.max(0.01, gamma)
    const lut = new Uint8ClampedArray(256)
    for (let a = 0; a < 256; a++) {
      const t = Math.min(1, Math.max(0, (a - black) / span))
      lut[a] = Math.round(255 * Math.pow(t, invG))
    }
    const src = base.data
    const dst = buf.data
    for (let i = 3; i < src.length; i += 4) dst[i] = lut[src[i]]
    ctx.putImageData(buf, 0, 0)
    levelsChanged.current = !(black === 0 && white === 255 && Math.abs(gamma - 1) < 0.001)
    if (view === 'mask') renderMask()
  }
  function levelsLeave(): void {
    if (!levelsBase.current) return
    if (levelsChanged.current) {
      commit() // persistí el alfa nivelado (el snapshot de levelsEnter queda como punto de undo)
      if (contour.current) refreshEdge()
    } else {
      history.current.pop() // sin cambios: sacá el snapshot inútil
    }
    levelsBase.current = null
    levelsBuf.current = null
    levelsChanged.current = false
  }

  // ── Recuperar pelo por canales (#1 — Pulir) ──────────────────────────────────
  // Técnica clásica: tomar un CANAL del ORIGINAL (donde el pelo separa más del fondo), subirle el
  // CONTRASTE hasta que el pelo quede blanco y el fondo negro → esa máscara B/N se SUMA al alfa para
  // recuperar las hebras que el AI aplanó (con el COLOR real del original). El usuario afina con
  // "Ver máscara". Preview no destructivo desde una base (snapshot al entrar).
  function peloEnter(): void {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    const f = sourceFile
    if (!c || !ctx || !f) return
    peloBase.current = ctx.getImageData(0, 0, c.width, c.height)
    peloApplied.current = false
    peloSource.current = null
    pushHistory() // undo = estado PRE-pelo (se descarta al salir si no sumaste nada)
    // Cargá el ORIGINAL escalado al tamaño del lienzo (autoCrop está off por defecto → alineado).
    const url = URL.createObjectURL(f)
    const img = new Image()
    img.onload = (): void => {
      const sc = document.createElement('canvas')
      sc.width = c.width
      sc.height = c.height
      const sx = sc.getContext('2d', { willReadFrequently: true })
      if (sx) {
        sx.drawImage(img, 0, 0, c.width, c.height)
        peloSource.current = sx.getImageData(0, 0, c.width, c.height)
      }
      URL.revokeObjectURL(url)
    }
    img.onerror = (): void => URL.revokeObjectURL(url)
    img.src = url
  }
  /** Máscara B/N (0-255, blanco=pelo) del canal elegido con contraste centrado en la media + invert. */
  function peloMask(channel: 'auto' | 'r' | 'g' | 'b', contrast: number, invert: boolean): Uint8ClampedArray | null {
    const src = peloSource.current
    if (!src) return null
    const d = src.data
    const n = src.width * src.height
    let ch = channel === 'r' ? 0 : channel === 'g' ? 1 : channel === 'b' ? 2 : -1
    if (ch < 0) {
      // Auto: el canal de mayor varianza (más contraste pelo↔fondo).
      const sum = [0, 0, 0]
      const sum2 = [0, 0, 0]
      for (let i = 0; i < n; i++)
        for (let k = 0; k < 3; k++) {
          const v = d[i * 4 + k]
          sum[k] += v
          sum2[k] += v * v
        }
      let bestVar = -1
      for (let k = 0; k < 3; k++) {
        const m = sum[k] / n
        const va = sum2[k] / n - m * m
        if (va > bestVar) {
          bestVar = va
          ch = k
        }
      }
    }
    let mean = 0
    for (let i = 0; i < n; i++) mean += d[i * 4 + ch]
    mean /= n
    const gain = 1 + (contrast / 100) * 5
    const mask = new Uint8ClampedArray(n)
    for (let i = 0; i < n; i++) {
      let v = (d[i * 4 + ch] - mean) * gain + 128
      v = v < 0 ? 0 : v > 255 ? 255 : v
      mask[i] = invert ? 255 - v : v
    }
    return mask
  }
  /**
   * RGBA = base + pelo recuperado. Donde la máscara supera al alfa actual usamos el COLOR del
   * original, con DOS salvaguardas (técnica clásica de canales, automatizada):
   *  1. Banda: solo dentro de R px del recorte sólido (la máscara se limita a la franja del pelo,
   *     nunca al fondo lejano). Se desvanece al final de la banda.
   *  2. Compuerta de color: solo si el píxel se parece más al SUJETO (vecino sólido más cercano)
   *     que al FONDO (vecino transparente más cercano). Así el fondo pegado al borde (p.ej. un halo
   *     claro junto al hombro) no entra, pero el pelo —que sí matchea al sujeto— sí.
   * Ambas usan una transformada de rasgos (Voronoi aprox., chamfer 2 pasadas, O(n)).
   */
  function peloRecovered(base: ImageData, mask: Uint8ClampedArray): Uint8ClampedArray {
    const out = new Uint8ClampedArray(base.data)
    const src = peloSource.current
    if (!src) return out
    const sd = src.data
    const w = base.width
    const h = base.height
    const n = w * h
    const R = Math.min(60, Math.max(10, Math.round(Math.max(w, h) * 0.02)))
    const FEATHER = Math.max(4, Math.round(R / 4))
    const INF = 1 << 28
    // Rasgos: distancia + índice del vecino sólido (fg, alfa>128) y transparente (bg, alfa<16).
    const dFg = new Int32Array(n)
    const nFg = new Int32Array(n)
    const dBg = new Int32Array(n)
    const nBg = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      const a = out[i * 4 + 3]
      dFg[i] = a > 128 ? 0 : INF
      nFg[i] = a > 128 ? i : -1
      dBg[i] = a < 16 ? 0 : INF
      nBg[i] = a < 16 ? i : -1
    }
    const relax = (d: Int32Array, nn: Int32Array): void => {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x
          if (d[i] === 0) continue
          if (x > 0 && d[i - 1] + 1 < d[i]) {
            d[i] = d[i - 1] + 1
            nn[i] = nn[i - 1]
          }
          if (y > 0 && d[i - w] + 1 < d[i]) {
            d[i] = d[i - w] + 1
            nn[i] = nn[i - w]
          }
        }
      for (let y = h - 1; y >= 0; y--)
        for (let x = w - 1; x >= 0; x--) {
          const i = y * w + x
          if (d[i] === 0) continue
          if (x < w - 1 && d[i + 1] + 1 < d[i]) {
            d[i] = d[i + 1] + 1
            nn[i] = nn[i + 1]
          }
          if (y < h - 1 && d[i + w] + 1 < d[i]) {
            d[i] = d[i + w] + 1
            nn[i] = nn[i + w]
          }
        }
    }
    relax(dFg, nFg)
    relax(dBg, nBg)
    for (let i = 0; i < n; i++) {
      const dv = dFg[i]
      if (dv > R) continue // fuera de la banda del borde: jamás metemos fondo lejano
      let m = mask[i]
      if (dv > R - FEATHER) m = Math.round((m * (R - dv)) / FEATHER) // desvanecé al final de la banda
      if (m <= out[i * 4 + 3]) continue
      // Compuerta de color: ¿se parece más al sujeto o al fondo?
      const fi = nFg[i]
      const bi = nBg[i]
      if (fi >= 0 && bi >= 0) {
        const cr = sd[i * 4]
        const cg = sd[i * 4 + 1]
        const cb = sd[i * 4 + 2]
        const dfr = out[fi * 4] - cr
        const dfg2 = out[fi * 4 + 1] - cg
        const dfb = out[fi * 4 + 2] - cb
        const dbr = sd[bi * 4] - cr
        const dbg2 = sd[bi * 4 + 1] - cg
        const dbb = sd[bi * 4 + 2] - cb
        const distFg = dfr * dfr + dfg2 * dfg2 + dfb * dfb
        const distBg = dbr * dbr + dbg2 * dbg2 + dbb * dbb
        if (distBg < distFg) continue // se parece más al fondo → es fondo, no pelo
      }
      out[i * 4] = sd[i * 4]
      out[i * 4 + 1] = sd[i * 4 + 1]
      out[i * 4 + 2] = sd[i * 4 + 2]
      out[i * 4 + 3] = m
    }
    return out
  }
  function previewHair(channel: 'auto' | 'r' | 'g' | 'b', contrast: number, invert: boolean, showMask: boolean): void {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    const base = peloBase.current
    if (!c || !ctx || !base) return
    const mask = peloMask(channel, contrast, invert)
    if (!mask) return // el original aún está cargando
    const out = ctx.createImageData(c.width, c.height)
    if (showMask) {
      const o = out.data
      for (let i = 0; i < mask.length; i++) {
        o[i * 4] = mask[i]
        o[i * 4 + 1] = mask[i]
        o[i * 4 + 2] = mask[i]
        o[i * 4 + 3] = 255
      }
    } else {
      out.data.set(peloRecovered(base, mask))
    }
    ctx.putImageData(out, 0, 0)
  }
  function peloApply(channel: 'auto' | 'r' | 'g' | 'b', contrast: number, invert: boolean): void {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    const base = peloBase.current
    if (!c || !ctx || !base) return
    const mask = peloMask(channel, contrast, invert)
    if (!mask) return
    const out = ctx.createImageData(c.width, c.height)
    out.data.set(peloRecovered(base, mask))
    ctx.putImageData(out, 0, 0)
    commit()
    if (contour.current) refreshEdge()
    peloApplied.current = true
    peloBase.current = ctx.getImageData(0, 0, c.width, c.height) // re-base para otra pasada
  }
  function peloLeave(): void {
    if (!peloBase.current) return
    if (!peloApplied.current) {
      const c = canvasRef.current
      const ctx = c?.getContext('2d')
      if (c && ctx) ctx.putImageData(peloBase.current, 0, 0) // revertí el preview a la base
      history.current.pop() // no sumaste pelo: sacá el snapshot inútil
    }
    peloBase.current = null
    peloSource.current = null
    peloApplied.current = false
  }

  function undo(): void {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    const prev = history.current.pop()
    if (!c || !ctx || !prev) return
    const img = new Image()
    img.onload = () => {
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.drawImage(img, 0, 0)
      commit()
      // El alfa cambió: si Selección está activa, regenerar el borde marching-ants.
      if (contour.current) refreshEdge()
    }
    img.src = prev
  }

  function commit(): void {
    const c = canvasRef.current
    if (c && onEdited) onEdited(c.toDataURL('image/png'))
    if (view === 'mask') renderMask()
  }

  function reset(): void {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (c && ctx && original.current) {
      pushHistory()
      ctx.putImageData(original.current, 0, 0)
      commit()
      if (contour.current) refreshEdge()
    }
  }

  // ── Selección inteligente (MobileSAM) ──────────────────────────────────────
  // Identidad estable de la imagen FUENTE: si cambia, hay que re-encodear y re-tomar
  // su RGBA. (No usamos el objeto File por referencia: el padre puede recrearlo.)
  function sourceIdentity(f: File | null | undefined): string | null {
    return f ? `${f.name}:${f.size}:${f.lastModified}` : null
  }

  function setSamStatus(working: boolean, hint: string | null): void {
    setSamWorking(working)
    onSamBusy?.(working)
    onSamHint?.(hint)
  }

  // Publica el estado de la sesión interactiva (puntos +/−, candidatas, IoU) hacia la
  // barra de opciones, y guarda el espejo de estado que re-renderiza el preview.
  function emitSamSession(): void {
    const s = samSession.current
    if (!s || s.candidates.length === 0) {
      setSamUI(null)
      onSamSession?.(null)
      return
    }
    const includes = s.points.filter((p) => (p.label ?? 1) === 1).length
    const excludes = s.points.filter((p) => p.label === 0).length
    const info: SamSessionInfo = {
      includes,
      excludes,
      candidates: s.candidates.length,
      chosen: s.chosen,
      iou: s.candidates[s.chosen]?.iou ?? 0
    }
    setSamUI(info)
    onSamSession?.(info)
  }

  // Encode (caro) de la imagen FUENTE → embedding cacheado en el main. UNA vez por
  // imagen: si ya tenemos el embedding de esta fuente, no re-encodea. Reporta progreso
  // por la barra de opciones ("Preparando selección IA…"). Devuelve el embedding o null.
  const samEnsureEmbedding = useCallback(
    async (): Promise<{ embeddingPath: string; origW: number; origH: number } | null> => {
      const f = sourceFile
      const id = sourceIdentity(f)
      if (!f || !id) {
        setSamStatus(false, 'No hay imagen fuente para la selección IA')
        return null
      }
      const model = samPrecisionModel(samPrecision)
      // Key = identidad de la fuente + modelo: distinto encoder → distinto embedding.
      const key = `${id}::${model}`
      if (samEmb.current && samEmb.current.key === key) return samEmb.current
      const token = ++samToken.current
      // El encode "Preciso" (SAM ViT-B) es bastante más lento → avisalo en el spinner.
      setSamStatus(true, model === 'sam-vitb' ? 'Preparando selección IA (preciso)…' : 'Preparando selección IA…')
      try {
        const ab = await f.arrayBuffer()
        const r = await window.api.samSelect.encode(ab, f.name, model)
        if (token !== samToken.current) return null
        if (!r.ok || !r.embeddingPath || !r.origW || !r.origH) {
          setSamStatus(false, r.error?.message ?? 'No se pudo preparar la selección IA')
          return null
        }
        samEmb.current = { key, embeddingPath: r.embeddingPath, origW: r.origW, origH: r.origH }
        setSamStatus(false, model === 'sam-vitb' ? 'Modo preciso listo — clickeá un objeto fino' : 'Clickeá un objeto (o arrastrá un recuadro)')
        return samEmb.current
      } catch (e) {
        if (token !== samToken.current) return null
        setSamStatus(false, e instanceof Error ? e.message : 'Error preparando la selección IA')
        return null
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceFile, samPrecision, onSamBusy, onSamHint]
  )

  // Carga (lazy) el RGBA de la imagen FUENTE en un canvas, para tomar sus píxeles al
  // SUMAR (revelar el objeto). Cacheada por identidad de la fuente.
  async function samGetSourceCanvas(): Promise<HTMLCanvasElement | null> {
    const f = sourceFile
    const key = sourceIdentity(f)
    if (!f || !key) return null
    if (samSourceCanvas.current && samSourceKey.current === key) return samSourceCanvas.current
    const url = URL.createObjectURL(f)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image()
        im.onload = () => resolve(im)
        im.onerror = () => reject(new Error('No se pudo cargar la imagen fuente'))
        im.src = url
      })
      const oc = document.createElement('canvas')
      oc.width = img.naturalWidth
      oc.height = img.naturalHeight
      const octx = oc.getContext('2d')
      if (!octx) return null
      octx.drawImage(img, 0, 0)
      samSourceCanvas.current = oc
      samSourceKey.current = key
      return oc
    } catch {
      return null
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  // Tamaño de bin del histograma de color (24³): floor(canal/256*24), canal∈[0,255] → bin∈[0,23].
  const BG_BINS = 24
  const bgBinOf = (v: number): number => {
    const b = (v * BG_BINS) >> 8
    return b < 0 ? 0 : b > BG_BINS - 1 ? BG_BINS - 1 : b
  }

  // Decodifica el histograma 24³ del sidecar (base64 Float32 LE) a un Float64Array.
  // Valida que el binning coincida con el del renderer (BG_BINS) y que no sea degenerado
  // (≥1 bin no-cero, maxFreq>0). Devuelve null si no sirve → caer al fallback del marco.
  function decodeSidecarBgHistogram(h: BgHistogram): { hist: Float64Array; maxFreq: number } | null {
    if (h.bins !== BG_BINS) return null
    if (!(h.maxFreq > 0) || !(h.bgPixels > 0) || !(h.nonZeroBins > 0)) return null
    try {
      const bin = atob(h.histB64)
      const expected = BG_BINS * BG_BINS * BG_BINS
      if (bin.length !== expected * 4) return null
      const bytes = new Uint8Array(expected * 4)
      for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i)
      const f32 = new Float32Array(bytes.buffer)
      const hist = new Float64Array(expected)
      for (let k = 0; k < expected; k++) hist[k] = f32[k]
      return { hist, maxFreq: h.maxFreq }
    } catch {
      return null
    }
  }

  // Modelo de color del FONDO VERDADERO para "restos de fondo". FUENTE PRIMARIA: el
  // histograma que computó el SIDECAR (prop `bgHistogram`) — RGB de la fuente donde el
  // matte está removido (alfa<26), con fuente y matte ALINEADOS (mismo frame). Es lo que
  // separa limpio el locker de las personas; el renderer no puede reconstruirlo bien (el
  // lienzo borra el RGB del fondo a 0, y la fuente está des-alineada por auto-crop/upscale).
  // FALLBACK (sidecar sin histograma, ej. provider recraft): histograma del MARCO EXTERIOR
  // de la fuente (heurística previa). Histograma 24³ normalizado; maxFreq = bin más alto.
  // Cacheado por identidad de la fuente. null si no hay fuente ni histograma.
  async function samBuildBgModelFromSource(): Promise<{ hist: Float64Array; maxFreq: number } | null> {
    const key = sourceIdentity(sourceFile)
    // PRIMARIO: histograma del sidecar (no necesita la fuente ni su canvas). La clave de
    // cache incluye una firma del histograma (bgPixels/maxFreq/nonZeroBins) → un reproceso
    // de la MISMA imagen (nuevo histograma, mismo sourceFile) invalida el cache y re-decodea.
    if (bgHistogram) {
      const sig = `${bgHistogram.bgPixels}:${bgHistogram.maxFreq}:${bgHistogram.nonZeroBins}`
      const cacheKey = `sidecar:${key ?? 'anon'}:${sig}`
      if (samBgModel.current && samBgModel.current.key === cacheKey) {
        return { hist: samBgModel.current.hist, maxFreq: samBgModel.current.maxFreq }
      }
      const decoded = decodeSidecarBgHistogram(bgHistogram)
      if (decoded) {
        samBgModel.current = { key: cacheKey, hist: decoded.hist, maxFreq: decoded.maxFreq }
        console.info(
          `[restos-de-fondo] modelo de fondo del SIDECAR · bgPixels=${bgHistogram.bgPixels} nonZeroBins=${bgHistogram.nonZeroBins} maxFreq=${bgHistogram.maxFreq.toFixed(5)}`
        )
        return decoded
      }
      // histograma inválido/degenerado → seguimos al fallback del marco.
    }
    if (!key) return null
    if (samBgModel.current && samBgModel.current.key === key) {
      return { hist: samBgModel.current.hist, maxFreq: samBgModel.current.maxFreq }
    }
    // FALLBACK: marco exterior de la fuente (peor; el sujeto puede tocar los bordes).
    const oc = await samGetSourceCanvas()
    if (!oc) return null
    const octx = oc.getContext('2d')
    if (!octx) return null
    const W = oc.width
    const H = oc.height
    if (W === 0 || H === 0) return null
    const px = octx.getImageData(0, 0, W, H).data
    // Recuadro CENTRAL excluido (el sujeto): [0.225W, 0.225H] .. [0.775W, 0.775H]. Todo lo
    // de afuera = marco exterior = la muestra de fondo.
    const cx0 = Math.floor(W * 0.225)
    const cy0 = Math.floor(H * 0.225)
    const cx1 = Math.ceil(W * 0.775)
    const cy1 = Math.ceil(H * 0.775)
    const hist = new Float64Array(BG_BINS * BG_BINS * BG_BINS)
    let sampled = 0
    for (let y = 0; y < H; y++) {
      const inCenterY = y >= cy0 && y < cy1
      const row = y * W
      for (let x = 0; x < W; x++) {
        // Solo el MARCO EXTERIOR: saltá los pixeles dentro del recuadro central.
        if (inCenterY && x >= cx0 && x < cx1) {
          x = cx1 - 1 // avanzá al final de la franja central de esta fila
          continue
        }
        const i = (row + x) * 4
        const k = (bgBinOf(px[i]) * BG_BINS + bgBinOf(px[i + 1])) * BG_BINS + bgBinOf(px[i + 2])
        hist[k] += 1
        sampled++
      }
    }
    if (sampled === 0) return null
    let maxFreq = 0
    for (let k = 0; k < hist.length; k++) {
      hist[k] /= sampled // normalizá a frecuencia
      if (hist[k] > maxFreq) maxFreq = hist[k]
    }
    samBgModel.current = { key, hist, maxFreq }
    return { hist, maxFreq }
  }

  // Rasteriza el PNG de máscara (tamaño FUENTE) a un buffer de alfa REESCALADO al
  // tamaño del canvas/recorte (W×H). Devuelve un Uint8ClampedArray de W*H con el alfa
  // de la máscara (0..255) ya en el espacio del recorte, listo para componer.
  async function samMaskToCropAlpha(maskBytes: ArrayBuffer, W: number, H: number): Promise<Uint8ClampedArray | null> {
    const blob = new Blob([maskBytes], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image()
        im.onload = () => resolve(im)
        im.onerror = () => reject(new Error('No se pudo leer la máscara'))
        im.src = url
      })
      // Dibujá la máscara (tamaño fuente) escalada EXACTAMENTE al tamaño del recorte.
      const mc = document.createElement('canvas')
      mc.width = W
      mc.height = H
      const mctx = mc.getContext('2d')
      if (!mctx) return null
      mctx.clearRect(0, 0, W, H)
      mctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, W, H)
      const data = mctx.getImageData(0, 0, W, H).data
      // La máscara es gris (r=g=b=alfa-objeto, a=255). Tomamos el canal R como "activo".
      const out = new Uint8ClampedArray(W * H)
      for (let p = 0, i = 0; p < W * H; p++, i += 4) out[p] = data[i]
      return out
    } catch {
      return null
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  // Compone la máscara SAM (alfa ya REESCALADO al recorte) en el alfa del canvas:
  //  · Quitar (−): alfa = 0 donde la máscara está activa (borra el objeto).
  //  · Sumar (+): revela el objeto pintando el RGBA de la FUENTE (reescalado al
  //    recorte) donde la máscara está activa; si no hay fuente, al menos alfa = 255.
  // El "peso" usa el valor de la máscara (suaviza el borde al reescalar). Tras componer:
  // pushHistory + commit + (si Selección activa) refreshEdge. `op` decide sumar/quitar
  // (lo pasa el APPLY de la sesión: el toggle Quitar/Sumar de la barra).
  async function samCompose(mask: Uint8ClampedArray, op: SelectBrushOp): Promise<boolean> {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return false
    const W = c.width
    const H = c.height

    pushHistory()
    const img = ctx.getImageData(0, 0, W, H)
    const d = img.data

    if (op === 'subtract') {
      // Borra el objeto: baja el alfa PROPORCIONAL a la máscara (soporta bordes suaves
      // anti-aliased — 255 borra del todo, valores intermedios = transición de borde).
      let changed = false
      for (let p = 0, i = 3; p < W * H; p++, i += 4) {
        const m = mask[p]
        if (m > 0 && d[i] !== 0) {
          const na = Math.round(d[i] * (1 - m / 255))
          if (na !== d[i]) {
            d[i] = na
            changed = true
          }
        }
      }
      if (!changed) {
        history.current.pop()
        return false
      }
      ctx.putImageData(img, 0, 0)
    } else {
      // Suma: revela el objeto desde la FUENTE. Tomamos su RGBA reescalado al recorte.
      const src = await samGetSourceCanvas()
      if (src) {
        const sc = document.createElement('canvas')
        sc.width = W
        sc.height = H
        const sctx = sc.getContext('2d')
        if (!sctx) {
          history.current.pop()
          return false
        }
        // Fuente reescalada EXACTO al tamaño del recorte (mismo mapeo que la máscara).
        sctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, W, H)
        const sd = sctx.getImageData(0, 0, W, H).data
        for (let p = 0, i = 0; p < W * H; p++, i += 4) {
          const m = mask[p]
          if (m === 0) continue
          // Donde la máscara pega, pintá el color de la fuente y subí el alfa al de la
          // máscara (borde suave preservado). Si ya había contenido, lo sobreescribe.
          d[i] = sd[i]
          d[i + 1] = sd[i + 1]
          d[i + 2] = sd[i + 2]
          d[i + 3] = Math.max(d[i + 3], m)
        }
      } else {
        // Sin fuente disponible: al menos revelá el alfa donde la máscara pega.
        for (let p = 0, i = 3; p < W * H; p++, i += 4) {
          if (mask[p] > d[i]) d[i] = mask[p]
        }
      }
      ctx.putImageData(img, 0, 0)
    }

    commit()
    if (contour.current) refreshEdge()
    return true
  }

  // ── PREVIEW de la sesión SAM ───────────────────────────────────────────────
  // Pinta la candidata mostrada como un tinte AZUL semi-transparente sobre el canvas
  // (sin tocar el alfa real). Reescala la máscara (tamaño fuente) al recorte y dibuja
  // azul con alfa proporcional al valor de la máscara. Vacía el overlay si no hay sesión.
  const clearSamPreview = useCallback((): void => {
    const m = samPreviewRef.current
    const mctx = m?.getContext('2d')
    if (m && mctx) mctx.clearRect(0, 0, m.width, m.height)
  }, [])

  async function renderSamPreview(): Promise<void> {
    const c = canvasRef.current
    const m = samPreviewRef.current
    const s = samSession.current
    if (!c || !m) return
    if (m.width !== c.width || m.height !== c.height) {
      m.width = c.width
      m.height = c.height
    }
    const mctx = m.getContext('2d')
    if (!mctx) return
    mctx.clearRect(0, 0, m.width, m.height)
    if (!s || s.candidates.length === 0) return
    const cand = s.candidates[s.chosen]
    if (!cand) return
    const W = c.width
    const H = c.height
    const mask = await samMaskToCropAlpha(cand.bytes, W, H)
    if (!mask) return
    // Tinte azul (≈ accent): RGB fijo, alfa = ~55% del valor de la máscara.
    const out = mctx.createImageData(W, H)
    const od = out.data
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      const a = mask[p]
      if (a === 0) continue
      od[i] = 56
      od[i + 1] = 132
      od[i + 2] = 255
      od[i + 3] = Math.round(a * 0.55)
    }
    mctx.putImageData(out, 0, 0)
  }

  // Limpia la sesión interactiva: descarta puntos/preview/candidatas (NO toca el alfa).
  function samResetSession(): void {
    samSession.current = null
    clearSamPreview()
    setSamUI(null)
    onSamSession?.(null)
  }

  // ── DECODE de la sesión (crear / refinar) ──────────────────────────────────
  // Corre sam:decode con TODOS los puntos acumulados (+ el box inicial, si lo hubo) y,
  // si ya hay una sesión, realimenta el low-res previo (refinamiento iterativo). Guarda
  // las K candidatas en la sesión y muestra el PREVIEW (sin aplicar). `keepChosen`
  // conserva el índice de candidata mostrada (al refinar); si no, vuelve a la mejor IoU.
  async function samRunDecode(opts?: { keepChosen?: boolean; maskIndex?: number }): Promise<void> {
    const emb = await samEnsureEmbedding()
    const s = samSession.current
    if (!emb || !s) return
    if (s.points.length === 0 && !s.box) return

    const prevLowRes = s.lowResPath
    const refine = Boolean(prevLowRes) // ya hay un decode previo en esta sesión
    const token = ++samToken.current
    setSamStatus(true, refine ? 'Refinando selección…' : 'Detectando objeto…')
    try {
      const r = await window.api.samSelect.decode({
        embeddingPath: emb.embeddingPath,
        points: s.points.length > 0 ? s.points : undefined,
        box: s.box ?? undefined,
        maskInputPath: refine && prevLowRes ? prevLowRes : undefined,
        hasMaskInput: refine,
        maskIndex: opts?.maskIndex
      })
      if (token !== samToken.current) return
      if (!r.ok || !r.candidates || r.candidates.length === 0) {
        // Si era el PRIMER decode y falló, descartá la sesión a medio armar.
        if (!refine) samResetSession()
        setSamStatus(false, r.error?.message ?? 'La selección IA no devolvió máscara')
        return
      }
      // Mantené el índice mostrado al refinar (si sigue siendo válido); si no, la mejor.
      let chosen = typeof r.chosen === 'number' ? r.chosen : 0
      if (opts?.maskIndex !== undefined) chosen = Math.min(opts.maskIndex, r.candidates.length - 1)
      else if (opts?.keepChosen) chosen = Math.min(s.chosen, r.candidates.length - 1)
      samSession.current = {
        ...s,
        candidates: r.candidates,
        chosen,
        lowResPath: r.lowResPath ?? prevLowRes ?? null
      }
      await renderSamPreview()
      emitSamSession()
      const iou = r.candidates[chosen]?.iou ?? 0
      const cov = r.candidates[chosen]?.coverage ?? 0
      if (cov <= 0) {
        setSamStatus(false, 'La forma quedó vacía — probá otro punto o "Otra forma"')
      } else {
        setSamStatus(
          false,
          `Vista previa · IoU ${iou.toFixed(2)} · ${r.candidates.length} forma${r.candidates.length === 1 ? '' : 's'} — refiná con +/− y Aplicá`
        )
      }
    } catch (e) {
      if (token !== samToken.current) return
      if (!refine) samResetSession()
      setSamStatus(false, e instanceof Error ? e.message : 'Error en la selección IA')
    }
  }

  // CLICK / BOX en el canvas (modo SAM) → arranca o REFINA la sesión (preview, sin
  // aplicar). Convierte el puntero a px de la FUENTE:
  //  (a) puntero → px del canvas/recorte vía toCanvasPx (respeta object-contain+zoom/pan);
  //  (b) px del recorte → px de la fuente: × (origW/canvas.width, origH/canvas.height).
  // `include` (click normal) = punto +/label 1; `exclude` (Alt/click-derecho) = − /label 0.
  // El box solo abre sesión (no se acumula con clicks de otra sesión).
  async function samPrompt(
    prompt:
      | { point: { x: number; y: number }; include: boolean }
      | { box: { x0: number; y0: number; x1: number; y1: number } }
  ): Promise<void> {
    const c = canvasRef.current
    if (!c) return
    const emb = await samEnsureEmbedding()
    if (!emb) return
    const sx = emb.origW / c.width // factor recorte → fuente (X)
    const sy = emb.origH / c.height // factor recorte → fuente (Y)

    if ('point' in prompt) {
      const fx = prompt.point.x * sx
      const fy = prompt.point.y * sy
      const label = prompt.include ? 1 : 0
      // Sin sesión, un punto EXCLUIR no tiene sentido (no hay nada que recortar): tratalo
      // como INCLUIR para arrancar. Con sesión, acumulá el punto tal cual.
      if (!samSession.current) {
        samSession.current = { points: [{ x: fx, y: fy, label: 1 }], box: null, candidates: [], chosen: 0, lowResPath: null }
        await samRunDecode()
      } else {
        samSession.current.points.push({ x: fx, y: fy, label })
        // Mantené la forma mostrada al refinar (el usuario está afinándola, no ciclando).
        await samRunDecode({ keepChosen: true })
      }
    } else if ('box' in prompt) {
      const b = prompt.box
      const x0 = Math.min(b.x0, b.x1) * sx
      const y0 = Math.min(b.y0, b.y1) * sy
      const x1 = Math.max(b.x0, b.x1) * sx
      const y1 = Math.max(b.y0, b.y1) * sy
      // El box abre una sesión nueva (descarta la anterior si la hubiera).
      samSession.current = { points: [], box: [x0, y0, x1, y1], candidates: [], chosen: 0, lowResPath: null }
      await samRunDecode()
    }
  }

  // "Otra forma": cicla entre las K candidatas y re-renderiza el preview con la otra
  // máscara (mismo prompt: no re-decodea salvo para alinear índice; acá basta con
  // cambiar el chosen ya que tenemos todas las candidatas en memoria).
  function samCycleShape(): void {
    const s = samSession.current
    if (!s || s.candidates.length <= 1) return
    s.chosen = (s.chosen + 1) % s.candidates.length
    void renderSamPreview()
    emitSamSession()
    const cand = s.candidates[s.chosen]
    setSamStatus(false, `Forma ${s.chosen + 1}/${s.candidates.length} · IoU ${(cand?.iou ?? 0).toFixed(2)}`)
  }

  // "Aplicar": hornea la candidata mostrada al alfa según el toggle Quitar/Sumar
  // (selectOp). Quitar = alfa 0 donde la máscara pega; Sumar = revela de la fuente.
  // Tras aplicar: la sesión se resetea (puntos + preview).
  async function samApply(): Promise<void> {
    const c = canvasRef.current
    const s = samSession.current
    if (!c || !s || s.candidates.length === 0) return
    const cand = s.candidates[s.chosen]
    if (!cand) return
    const mask = await samMaskToCropAlpha(cand.bytes, c.width, c.height)
    if (!mask) {
      setSamStatus(false, 'No se pudo leer la máscara')
      return
    }
    const op = selectOp
    const ok = await samCompose(mask, op)
    samResetSession()
    setSamStatus(false, ok ? (op === 'subtract' ? 'Quitado ✓ — clickeá otro objeto' : 'Sumado ✓ — clickeá otro objeto') : 'La selección no tocó nada visible')
  }

  // "Descartar": limpia la sesión sin tocar el alfa.
  function samDiscard(): void {
    samResetSession()
    setSamStatus(false, 'Clickeá un objeto (o arrastrá un recuadro)')
  }

  // ── "Analizar todo" (sam-everything) ───────────────────────────────────────
  // Reporta a la barra el estado del "Analizar todo" (analizando / listo / acumuladas).
  function emitSamEvery(analyzing: boolean): void {
    const ev = samEvery.current
    const state: SamEverythingState = {
      analyzing,
      ready: Boolean(ev),
      count: ev?.count ?? 0,
      pinned: samEveryPinned.current.size,
      candidates: samEveryCandidates.current.size
    }
    setSamEveryUI(state)
    onSamEverything?.(state)
  }

  // Decodea el PNG del labelmap (8-bit, tamaño FUENTE: pixel = índice 1-based de la
  // región) a un array EN SU RESOLUCIÓN NATIVA (FUENTE), sin reescalar. El lookup/región
  // viven en espacio FUENTE y se reescalan al canvas con el MISMO mapeo que el modo prompt
  // (samMaskToCropAlpha), que sí cae sobre el pixel correcto aunque el recorte esté en otra
  // resolución (upscaled). Devuelve {label, w, h} o null.
  async function samDecodeLabelMap(pngBytes: ArrayBuffer): Promise<{ label: Uint8Array; w: number; h: number } | null> {
    const blob = new Blob([pngBytes], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image()
        im.onload = () => resolve(im)
        im.onerror = () => reject(new Error('No se pudo leer el labelmap'))
        im.src = url
      })
      const w = img.naturalWidth
      const h = img.naturalHeight
      const lc = document.createElement('canvas')
      lc.width = w
      lc.height = h
      const lctx = lc.getContext('2d')
      if (!lctx) return null
      lctx.imageSmoothingEnabled = false // índices = etiquetas, no intensidades
      lctx.clearRect(0, 0, w, h)
      lctx.drawImage(img, 0, 0)
      const data = lctx.getImageData(0, 0, w, h).data
      // El labelmap es gris (r=g=b=índice, a=255): tomamos el canal R como el índice.
      const out = new Uint8Array(w * h)
      for (let p = 0, i = 0; p < w * h; p++, i += 4) out[p] = data[i]
      return { label: out, w, h }
    } catch {
      return null
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  // "Analizar todo": manda los bytes de la imagen FUENTE a sam:everything (sam-vitb/40/
  // crops0), decodea el labelmap a `labelMapCanvas` (tamaño del recorte) y lo cachea por
  // identidad de la fuente. ~50s; el progreso real lo pinta el listener de onEverythingProgress.
  async function samAnalyzeAll(): Promise<void> {
    const f = sourceFile
    const id = sourceIdentity(f)
    const c = canvasRef.current
    if (!f || !id || !c) {
      setSamStatus(false, 'No hay imagen fuente para analizar')
      return
    }
    const key = id
    const token = ++samToken.current
    // Limpiá selección/preview previos del "Analizar todo" al re-analizar (incluidos los
    // candidatos a resto detectados en un análisis anterior).
    samEveryPinned.current = new Set()
    samEveryHover.current = 0
    samEveryCandidates.current = new Set()
    clearSamPreview()
    setSamStatus(true, 'Analizando toda la imagen… (~1 min)')
    emitSamEvery(true)
    try {
      // Analizamos el LIENZO (el recorte mostrado), NO la fuente: el quitar-fondo aplica
      // auto-crop al resultado, así que la fuente y el recorte NO están alineados (offset del
      // crop). Mandando el lienzo, el labelmap sale en el MISMO frame que se ve → alineado 1:1.
      const blob = await new Promise<Blob | null>((resolve) => c.toBlob((b) => resolve(b), 'image/png'))
      if (token !== samToken.current) return
      if (!blob) {
        setSamStatus(false, 'No se pudo leer el lienzo para analizar')
        emitSamEvery(false)
        return
      }
      const ab = await blob.arrayBuffer()
      const r = await window.api.samSelect.everything(ab, `${f.name}-canvas.png`, 'sam-vitb')
      if (token !== samToken.current) return
      if (!r.ok || !r.labelMapBytes || !r.width || !r.height) {
        setSamStatus(false, r.error?.message ?? 'No se pudo analizar la imagen')
        emitSamEvery(false)
        return
      }
      const decoded = await samDecodeLabelMap(r.labelMapBytes)
      if (token !== samToken.current) return
      if (!decoded) {
        setSamStatus(false, 'No se pudo leer el labelmap')
        emitSamEvery(false)
        return
      }
      const count = r.masks?.length ?? 0
      samEvery.current = { key, sw: decoded.w, sh: decoded.h, cw: c.width, ch: c.height, label: decoded.label, count }
      // DETECCIÓN AUTOMÁTICA: con el labelmap ya cacheado, computá UNA vez los "restos de
      // fondo" (heurística bg-color-match). Si hay ≥1, auto-resaltalos en ámbar y mostrá el
      // banner [Quitar]/[Descartar] (vía emitSamEvery → samEverything.candidates). El usuario
      // confirma; no borramos en silencio. El hover/click manual sigue intacto.
      // El MODELO de color del fondo VERDADERO lo computa el SIDECAR durante el recorte
      // (histograma 24³ del RGB de la fuente donde el matte está removido) y llega por prop;
      // samBuildBgModelFromSource lo decodea/cachea (o cae al marco exterior si el sidecar
      // no lo dio). Es la fuente alineada que separa el locker de las personas.
      const bgModel = await samBuildBgModelFromSource()
      if (token !== samToken.current) return
      const residue = bgModel ? samEveryDetectResidue(bgModel) : new Set<number>()
      samEveryCandidates.current = residue
      renderSamEveryOverlay()
      if (residue.size > 0) {
        setSamStatus(false, `${count} regiones · detecté ${residue.size} resto${residue.size === 1 ? '' : 's'} de fondo (en ámbar) — Quitar o Descartar`)
      } else {
        setSamStatus(false, `${count} regiones — pasá el mouse y clickeá la que quieras`)
      }
      emitSamEvery(false)
    } catch (e) {
      if (token !== samToken.current) return
      setSamStatus(false, e instanceof Error ? e.message : 'Error analizando la imagen')
      emitSamEvery(false)
    }
  }

  // Mapea un punto en px del canvas/recorte al índice de región del labelMap FUENTE.
  // Mismo factor que el modo prompt (sw/cw): así un click sobre un objeto fino (el locker)
  // cae sobre su región aunque el recorte esté en otra resolución que la fuente.
  function samEveryIdxAtCanvas(x: number, y: number): number {
    const ev = samEvery.current
    if (!ev) return 0
    const sx = Math.floor((x * ev.sw) / ev.cw)
    const sy = Math.floor((y * ev.sh) / ev.ch)
    if (sx < 0 || sy < 0 || sx >= ev.sw || sy >= ev.sh) return 0
    return ev.label[sy * ev.sw + sx]
  }

  // Construye un Uint8ClampedArray (tamaño CANVAS) con el alfa de la UNIÓN de las regiones
  // `indices`: arma la máscara en resolución FUENTE (label==idx) y la reescala al canvas con
  // el MISMO drawImage NN que usa samMaskToCropAlpha — el mapeo probado del modo prompt, que
  // cae sobre el pixel correcto aunque el recorte esté upscaled. 255 dentro, 0 fuera.
  function samEveryRegionsAlpha(indices: Set<number>): Uint8ClampedArray | null {
    const ev = samEvery.current
    const c = canvasRef.current
    if (!ev || !c || indices.size === 0) return null
    // (1) máscara binaria a resolución FUENTE
    const sc = document.createElement('canvas')
    sc.width = ev.sw
    sc.height = ev.sh
    const sctx = sc.getContext('2d')
    if (!sctx) return null
    const srcImg = sctx.createImageData(ev.sw, ev.sh)
    const sd = srcImg.data
    const lab = ev.label
    const n = ev.sw * ev.sh
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      if (indices.has(lab[p])) {
        sd[i] = 255
        sd[i + 1] = 255
        sd[i + 2] = 255
        sd[i + 3] = 255
      }
    }
    sctx.putImageData(srcImg, 0, 0)
    // (2) reescalá FUENTE → CANVAS (NN, sin difuminar el borde de etiqueta)
    const W = c.width
    const H = c.height
    const dc = document.createElement('canvas')
    dc.width = W
    dc.height = H
    const dctx = dc.getContext('2d')
    if (!dctx) return null
    dctx.imageSmoothingEnabled = false
    dctx.drawImage(sc, 0, 0, ev.sw, ev.sh, 0, 0, W, H)
    const dd = dctx.getImageData(0, 0, W, H).data
    const out = new Uint8ClampedArray(W * H)
    for (let p = 0, i = 3; p < W * H; p++, i += 4) out[p] = dd[i]
    return out
  }

  // ── DETECCIÓN AUTOMÁTICA de "restos de fondo" (heurística bg-color-match) ───────
  // Tras "Analizar todo", busca regiones que el quitado dejó pegadas (entre/dentro de los
  // sujetos) y que son FONDO: el matte las conservó pero su color coincide con el del fondo
  // REAL (ej. un locker entre dos personas). Heurística VALIDADA por el usuario:
  //  1. Modelo de color del fondo (`bgModel`, lo arma samBuildBgModelFromSource): viene del
  //     SIDECAR (RGB de la FUENTE donde el matte está removido, alfa<26, con fuente y matte
  //     ALINEADOS) → separa limpio el locker de las personas. NO se reconstruye del lienzo (el
  //     quitado deja el RGB del fondo en CERO/negro → degenera el match) ni de la fuente
  //     des-alineada por auto-crop/upscale (el sujeto toca los bordes → falsos positivos en las
  //     personas). El histograma es 3D 24³ (bin=floor(canal/256*24)), normalizado. maxFreq=bin más alto.
  //  2. bg-match por color: min(1, freq[bin(color)]/maxFreq * 3). Alto = el color existe /
  //     es común en el fondo real.
  //  3. Por región (del labelMap): avgBgMatch = promedio del bg-match de sus pixeles, tomando
  //     el COLOR de cada pixel del LIENZO (los conservados sí tienen su RGB original — el
  //     locker conservado tiene su beige). keptFrac = fracción con alfa > 128 (¿conservada?).
  //  4. Es RESTO DE FONDO si keptFrac > 0.5 (conservada) Y avgBgMatch > 0.1 (color de fondo).
  //     Los de bg-match alto pero keptFrac≈0 son fondo YA removido → se ignoran (no son resto).
  //     Robustez extra: además exige avgBgMatch > 3× (mediana de avgBgMatch de las conservadas).
  // O(N) en pixeles del lienzo: una sola pasada para acumular por región (el histograma del
  // fondo se construye aparte, una vez por imagen, desde la fuente).
  // Devuelve el set de índices 1-based candidatos (vacío = no detectó nada) y, para el modo
  // de prueba separado, loguea los candidatos (índice/bbox/avgBgMatch/keptFrac) por consola.
  function samEveryDetectResidue(bgModel: { hist: Float64Array; maxFreq: number }): Set<number> {
    const ev = samEvery.current
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    const empty = new Set<number>()
    if (!ev || !c || !ctx) return empty
    const W = c.width
    const H = c.height
    const px = ctx.getImageData(0, 0, W, H).data

    // (1) Modelo de color del fondo REAL: histograma 24³ del marco exterior de la FUENTE
    // (ya construido por samBuildBgModelFromSource). Sin un bin poblado no hay match posible.
    const { hist, maxFreq } = bgModel
    if (maxFreq <= 0) return empty
    // bg-match de un color = min(1, freq(su bin)/maxFreq * 3). Alto = color común del fondo.
    // El color sale del LIENZO (px): los pixeles CONSERVADOS tienen su RGB real.
    const bgMatchAt = (i: number): number => {
      const k = (bgBinOf(px[i]) * BG_BINS + bgBinOf(px[i + 1])) * BG_BINS + bgBinOf(px[i + 2])
      const m = (hist[k] / maxFreq) * 3
      return m > 1 ? 1 : m
    }

    // (3) Acumular por región (índice 1-based del labelMap FUENTE; mapeo canvas→fuente
    // idéntico a samEveryIdxAtCanvas: sx=floor(x*sw/cw), sy=floor(y*sh/ch)). Por región:
    // suma de bg-match, conteo total, conteo conservado (alfa>128), y bbox en px de canvas.
    const count = ev.count
    const sumMatch = new Float64Array(count + 1)
    const total = new Uint32Array(count + 1)
    const kept = new Uint32Array(count + 1)
    const bx0 = new Int32Array(count + 1).fill(W)
    const by0 = new Int32Array(count + 1).fill(H)
    const bx1 = new Int32Array(count + 1).fill(-1)
    const by1 = new Int32Array(count + 1).fill(-1)
    const lab = ev.label
    for (let y = 0; y < H; y++) {
      const sy = Math.floor((y * ev.sh) / ev.ch)
      const syRow = (sy < 0 ? 0 : sy >= ev.sh ? ev.sh - 1 : sy) * ev.sw
      for (let x = 0; x < W; x++) {
        const sx = Math.floor((x * ev.sw) / ev.cw)
        const idx = lab[syRow + (sx < 0 ? 0 : sx >= ev.sw ? ev.sw - 1 : sx)]
        if (idx === 0 || idx > count) continue
        const i = (y * W + x) * 4
        sumMatch[idx] += bgMatchAt(i)
        total[idx]++
        if (px[i + 3] > 128) kept[idx]++
        if (x < bx0[idx]) bx0[idx] = x
        if (y < by0[idx]) by0[idx] = y
        if (x > bx1[idx]) bx1[idx] = x
        if (y > by1[idx]) by1[idx] = y
      }
    }

    // Métricas por región SÓLIDA (keptFrac ≥ 0.8): avgBgMatch + bbox. Un resto de fondo real
    // (objeto / contador de letra no removido) es OPACO → keptFrac≈1. Las regiones de BORDE
    // BLANDO (keptFrac 0.5-0.7: anti-alias / halo del upscale IA) son near-blancas y matchean el
    // fondo, pero NO son restos: filtrarlas acá mata el falso positivo en logos upscaleados
    // (validado en vivo: FPs kf=0.51-0.67 vs sujeto/resto sólido kf=0.98-1.0). Las ya-removidas
    // (keptFrac≈0) también quedan fuera.
    const SOLID_MIN = 0.8
    type Stat = { idx: number; avgBgMatch: number; keptFrac: number; bbox: [number, number, number, number] }
    const kestats: Stat[] = []
    for (let idx = 1; idx <= count; idx++) {
      const t = total[idx]
      if (t === 0) continue
      const keptFrac = kept[idx] / t
      if (keptFrac < SOLID_MIN) continue
      kestats.push({
        idx,
        avgBgMatch: sumMatch[idx] / t,
        keptFrac,
        bbox: [bx0[idx], by0[idx], bx1[idx], by1[idx]]
      })
    }
    if (kestats.length === 0) return empty

    // Umbral: avgBgMatch > 0.1 (absoluto, validado: locker 0.21 vs personas 0.01) Y, para
    // robustez, > 3× la mediana de avgBgMatch de las conservadas (separa el resto del ruido
    // de los sujetos cuando hay muchas regiones). EXCEPCIÓN: un match CLARAMENTE de fondo
    // (≥ STRONG) es resto aunque la mediana esté inflada — con pocas regiones (ej. 2 sujetos
    // + 1 resto perfecto) la mediana sube y el 3× solo suprimiría un resto evidente. Así el
    // gate relativo endurece la zona dudosa sin tapar una señal absoluta fuerte.
    const STRONG = 0.18
    const sorted = kestats.map((s) => s.avgBgMatch).sort((a, b) => a - b)
    const mid = sorted.length >> 1
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    const relThresh = median * 3
    const candidates = new Set<number>()
    const chosenLog: Stat[] = []
    for (const s of kestats) {
      if (s.avgBgMatch > 0.1 && (s.avgBgMatch > relThresh || s.avgBgMatch >= STRONG)) {
        candidates.add(s.idx)
        chosenLog.push(s)
      }
    }

    // Modo de prueba separado (sin levantar Electron): loguea por consola lo detectado y el
    // panorama de regiones conservadas (para validar la heurística contra una foto real).
    if (typeof console !== 'undefined') {
      console.info(
        `[restos-de-fondo] ${chosenLog.length} candidato(s) · medianaAvgBgMatch=${median.toFixed(3)} relThresh=${relThresh.toFixed(3)} · regionesConservadas=${kestats.length}`,
        chosenLog.map((s) => ({ idx: s.idx, avgBgMatch: +s.avgBgMatch.toFixed(3), keptFrac: +s.keptFrac.toFixed(3), bbox: s.bbox }))
      )
    }
    return candidates
  }

  // Pinta el overlay (samPreviewRef) del "Analizar todo": candidatos a resto = ÁMBAR, la
  // unión (pinned ∪ hover) manual = AZUL. Instantáneo: solo lee el labelMapCanvas cacheado.
  function renderSamEveryOverlay(): void {
    const c = canvasRef.current
    const m = samPreviewRef.current
    const ev = samEvery.current
    if (!c || !m) return
    if (m.width !== c.width || m.height !== c.height) {
      m.width = c.width
      m.height = c.height
    }
    const mctx = m.getContext('2d')
    if (!mctx) return
    mctx.clearRect(0, 0, m.width, m.height)
    if (!ev) return
    const pinned = samEveryPinned.current
    const hover = samEveryHover.current
    // Candidatos a resto que el usuario NO sumó a su selección manual (esos pasan a azul).
    const cand = samEveryCandidates.current
    const candOnly = cand.size > 0 ? new Set([...cand].filter((idx) => !pinned.has(idx))) : null
    if (pinned.size === 0 && hover === 0 && (!candOnly || candOnly.size === 0)) return
    const W = c.width
    const H = c.height
    // Alfa de cada capa, en espacio CANVAS (reescalado desde la FUENTE = alineado al recorte).
    const pinnedAlpha = pinned.size > 0 ? samEveryRegionsAlpha(pinned) : null
    const hoverAlpha = hover > 0 && !pinned.has(hover) ? samEveryRegionsAlpha(new Set([hover])) : null
    const candAlpha = candOnly && candOnly.size > 0 ? samEveryRegionsAlpha(candOnly) : null
    if (!pinnedAlpha && !hoverAlpha && !candAlpha) return
    const out = mctx.createImageData(W, H)
    const od = out.data
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      const isPinned = pinnedAlpha ? pinnedAlpha[p] >= 128 : false
      const isHover = hoverAlpha ? hoverAlpha[p] >= 128 : false
      const isCand = candAlpha ? candAlpha[p] >= 128 : false
      // El AZUL (selección manual) manda sobre el ámbar donde se solapan: si el usuario está
      // por encima de un candidato, ve su selección. El candidato-solo se pinta en ÁMBAR.
      if (isPinned || isHover) {
        // Pinned = azul más sólido (≈70%); hover-solo = más tenue (≈45%), como Affinity.
        od[i] = 56
        od[i + 1] = 132
        od[i + 2] = 255
        od[i + 3] = isPinned ? 180 : 115
      } else if (isCand) {
        // Candidato a "resto de fondo": ámbar/naranja (distinto del azul del hover/pinned).
        od[i] = 245
        od[i + 1] = 158
        od[i + 2] = 11
        od[i + 3] = 150
      }
    }
    mctx.putImageData(out, 0, 0)
  }

  // Box blur separable O(N) (running sum), radio r. Núcleo del guided filter de abajo.
  function boxBlur(src: Float32Array, W: number, H: number, r: number): Float32Array {
    const tmp = new Float32Array(W * H)
    const out = new Float32Array(W * H)
    for (let y = 0; y < H; y++) {
      let s = 0
      const row = y * W
      for (let x = 0; x <= r && x < W; x++) s += src[row + x]
      for (let x = 0; x < W; x++) {
        const cnt = Math.min(x + r, W - 1) - Math.max(x - r, 0) + 1
        tmp[row + x] = s / cnt
        const add = x + r + 1
        const sub = x - r
        if (add < W) s += src[row + add]
        if (sub >= 0) s -= src[row + sub]
      }
    }
    for (let x = 0; x < W; x++) {
      let s = 0
      for (let y = 0; y <= r && y < H; y++) s += tmp[y * W + x]
      for (let y = 0; y < H; y++) {
        const cnt = Math.min(y + r, H - 1) - Math.max(y - r, 0) + 1
        out[y * W + x] = s / cnt
        const add = y + r + 1
        const sub = y - r
        if (add < H) s += tmp[add * W + x]
        if (sub >= 0) s -= tmp[sub * W + x]
      }
    }
    return out
  }

  // Refina el borde de una máscara binaria (0/255) para que sea SUAVE (anti-aliased, sin
  // escalones del upscale 256²→lienzo) y se PEGUE al borde real del objeto, usando la
  // luminancia del lienzo como guía (guided filter de He et al.) + un smoothstep angosto
  // que re-nitidiza el cruce 0.5 (borde de ~1-2px). Devuelve alfa 0..255 suave.
  function samRefineRegionEdge(binary: Uint8ClampedArray): Uint8ClampedArray | null {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return null
    const W = c.width
    const H = c.height
    const N = W * H
    const px = ctx.getImageData(0, 0, W, H).data
    const I = new Float32Array(N)
    for (let p = 0, i = 0; p < N; p++, i += 4) I[p] = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255
    // máscara 0..1 con micro-dilatación (1px) para cubrir sub-cobertura (slivers de borde).
    const pm = new Float32Array(N)
    for (let p = 0; p < N; p++) pm[p] = binary[p] >= 128 ? 1 : 0
    const dil = boxBlur(pm, W, H, 1)
    for (let p = 0; p < N; p++) pm[p] = dil[p] > 0.05 ? 1 : 0
    // guided filter: q = a*I + b con a/b locales (preserva los bordes de la guía).
    const r = 5
    const eps = 0.0004
    const Ip = new Float32Array(N)
    const II = new Float32Array(N)
    for (let p = 0; p < N; p++) {
      Ip[p] = I[p] * pm[p]
      II[p] = I[p] * I[p]
    }
    const mI = boxBlur(I, W, H, r)
    const mP = boxBlur(pm, W, H, r)
    const mIp = boxBlur(Ip, W, H, r)
    const mII = boxBlur(II, W, H, r)
    const a = new Float32Array(N)
    const b = new Float32Array(N)
    for (let p = 0; p < N; p++) {
      const varI = mII[p] - mI[p] * mI[p]
      const cov = mIp[p] - mI[p] * mP[p]
      a[p] = cov / (varI + eps)
      b[p] = mP[p] - a[p] * mI[p]
    }
    const mA = boxBlur(a, W, H, r)
    const mB = boxBlur(b, W, H, r)
    const w = 0.16
    const e0 = 0.5 - w
    const e1 = 0.5 + w
    const out = new Uint8ClampedArray(N)
    for (let p = 0; p < N; p++) {
      const q = mA[p] * I[p] + mB[p]
      let t = (q - e0) / (e1 - e0)
      t = t < 0 ? 0 : t > 1 ? 1 : t
      out[p] = Math.round(t * t * (3 - 2 * t) * 255)
    }
    return out
  }

  // Compone al alfa del canvas la UNIÓN de regiones (Sumar revela de la fuente / Quitar
  // borra). Al QUITAR, refina el borde (anti-alias + pegado al borde real) para que el
  // recorte NO quede escalonado. Reusa `samCompose`: pushHistory + commit + refreshEdge.
  // `op` permite forzar la dirección (la detección de resto SIEMPRE quita); por defecto usa
  // el toggle Quitar/Sumar de la barra (`selectOp`), como antes.
  async function samEveryComposeRegions(indices: Set<number>, op: SelectBrushOp = selectOp): Promise<boolean> {
    const alpha = samEveryRegionsAlpha(indices)
    if (!alpha) return false
    // El refinado usa la guía del lienzo (válida donde es opaco): aplica al QUITAR (la
    // región está visible). Al SUMAR la zona está transparente → guía no fiable → binario.
    const final = op === 'subtract' ? samRefineRegionEdge(alpha) ?? alpha : alpha
    return samCompose(final, op)
  }

  // HOVER (modo 'everything'): puntero → px del canvas (toCanvasPx) → índice de la región
  // en labelMapCanvas → resaltar. Solo re-renderiza si cambió la región bajo el cursor
  // (hover instantáneo). `clientX/Y` son px de pantalla del puntero.
  function samEveryHover_(clientX: number, clientY: number): void {
    const c = canvasRef.current
    const ev = samEvery.current
    if (!c || !ev) return
    const { x, y } = toCanvasPx(c, clientX, clientY)
    const idx = samEveryIdxAtCanvas(x, y)
    if (idx === samEveryHover.current) return
    samEveryHover.current = idx
    renderSamEveryOverlay()
  }

  // CLICK (modo 'everything'): la región bajo el cursor. Sin Shift → aplica esa región al
  // toque (Sumar/Quitar) y limpia. Con Shift → la ACUMULA al set (no aplica todavía; el
  // usuario aplica con el botón). Vacío (idx 0) = no hay región ahí: ignorar.
  async function samEveryClick(clientX: number, clientY: number, shift: boolean): Promise<void> {
    const c = canvasRef.current
    const ev = samEvery.current
    if (!c || !ev) return
    const { x, y } = toCanvasPx(c, clientX, clientY)
    const idx = samEveryIdxAtCanvas(x, y)
    if (idx === 0) {
      setSamStatus(false, 'No hay región ahí — pasá el mouse sobre el objeto')
      return
    }
    if (shift) {
      // Acumular: toggle la región en el set (volver a Shift+click la saca).
      const set = samEveryPinned.current
      if (set.has(idx)) set.delete(idx)
      else set.add(idx)
      renderSamEveryOverlay()
      emitSamEvery(false)
      setSamStatus(false, set.size > 0 ? `${set.size} región${set.size === 1 ? '' : 'es'} seleccionada${set.size === 1 ? '' : 's'} — Aplicá o Shift+click para sumar` : 'Pasá el mouse y clickeá una región')
      return
    }
    // Click simple: aplicá esa sola región (más las acumuladas, si las hubiera) y limpiá.
    const set = new Set(samEveryPinned.current)
    set.add(idx)
    const op = selectOp
    const ok = await samEveryComposeRegions(set)
    samEveryPinned.current = new Set()
    samEveryHover.current = 0
    renderSamEveryOverlay()
    emitSamEvery(false)
    setSamStatus(false, ok ? (op === 'subtract' ? 'Quitado ✓ — seguí con otra región' : 'Sumado ✓ — seguí con otra región') : 'La región no tocó nada visible')
  }

  // Aplica las regiones acumuladas (Shift+click) y limpia. Lo dispara el botón "Aplicar".
  async function samEverythingApply(): Promise<void> {
    const set = samEveryPinned.current
    if (set.size === 0) return
    const op = selectOp
    const ok = await samEveryComposeRegions(new Set(set))
    samEveryPinned.current = new Set()
    samEveryHover.current = 0
    renderSamEveryOverlay()
    emitSamEvery(false)
    setSamStatus(false, ok ? (op === 'subtract' ? 'Quitado ✓ — seguí con otra región' : 'Sumado ✓ — seguí con otra región') : 'La selección no tocó nada visible')
  }

  // Limpia las regiones acumuladas + el hover (no toca el alfa). Botón "Limpiar".
  function samEverythingClear(): void {
    samEveryPinned.current = new Set()
    samEveryHover.current = 0
    renderSamEveryOverlay()
    emitSamEvery(false)
    setSamStatus(false, 'Pasá el mouse y clickeá una región')
  }

  // [Quitar] del banner de "restos de fondo": QUITA del recorte los candidatos detectados
  // (SIEMPRE en modo subtract — el resto es fondo, se borra — independiente del toggle
  // Sumar/Quitar de la barra; reusa el borde refinado de samEveryComposeRegions). Tras
  // aplicar, limpia los candidatos (deja de resaltarlos). Undoable (Ctrl/Cmd+Z).
  async function samEverythingRemoveCandidates(): Promise<void> {
    const cand = samEveryCandidates.current
    if (cand.size === 0) return
    const n = cand.size
    const ok = await samEveryComposeRegions(new Set(cand), 'subtract')
    samEveryCandidates.current = new Set()
    renderSamEveryOverlay()
    emitSamEvery(false)
    setSamStatus(false, ok ? `Quité ${n} resto${n === 1 ? '' : 's'} de fondo ✓ — seguí con otra región` : 'No había nada visible que quitar')
  }

  // [Descartar] del banner: limpia los candidatos a resto (no toca el alfa). El usuario
  // sigue pudiendo hover/click manual como siempre.
  function samEverythingDismissCandidates(): void {
    if (samEveryCandidates.current.size === 0) return
    samEveryCandidates.current = new Set()
    renderSamEveryOverlay()
    emitSamEvery(false)
    setSamStatus(false, 'Listo — pasá el mouse y clickeá la región que quieras')
  }

  // Resetea TODO el "Analizar todo" (labelmap + acumuladas + candidatos + overlay). Se llama
  // al cambiar de imagen y al salir del modo: el labelmap es por imagen, no debe sobrevivir.
  function samEveryReset(): void {
    samEvery.current = null
    samEveryPinned.current = new Set()
    samEveryHover.current = 0
    samEveryCandidates.current = new Set()
    clearSamPreview()
    setSamEveryUI(null)
    onSamEverything?.(null)
  }

  // Encode al ENTRAR a "Selección inteligente" (1 vez por imagen+modelo, vía cache).
  // Re-dispara si cambia la imagen fuente O la PRECISIÓN (Rápido↔Preciso) mientras la
  // herramienta está activa: al cambiar de modelo, el embedding y el preview previos ya
  // no aplican, así que descartamos la sesión y re-encodeamos con el modelo elegido.
  useEffect(() => {
    if (!editable || mode !== 'sam') {
      // Al salir, limpiá el hint/busy de la barra (no toca el cache del embedding) y
      // descartá la sesión interactiva (preview + puntos) para no dejarla colgada.
      if (samWorking) setSamStatus(false, null)
      else onSamHint?.(null)
      setSamBoxRect(null)
      samBox.current = null
      if (samSession.current) samResetSession()
      // El "Analizar todo" también se descarta al salir de la herramienta (labelmap por
      // imagen; el overlay se comparte con el preview de la sesión y no debe quedar colgado).
      if (samEvery.current || samEveryUI) samEveryReset()
      return
    }
    // Cambió la precisión con una sesión abierta: el preview es del modelo viejo → tiralo.
    if (samSession.current) samResetSession()
    // En sub-modo "Analizar todo" NO encodeamos el embedding interactivo (es otro flujo):
    // solo reportá el estado y repintá el overlay de regiones acumuladas. En "prompt" sí.
    if (samMode === 'everything') {
      renderSamEveryOverlay()
      emitSamEvery(false)
    } else {
      // Volver a Click/recuadro: limpiá el overlay de regiones (sin tirar el labelmap
      // cacheado: volver a "Analizar todo" es instantáneo) y prepará el embedding.
      samEveryHover.current = 0
      clearSamPreview()
      void samEnsureEmbedding()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, editable, result?.url, sourceFile, samPrecision, samMode])

  // Imagen NUEVA / reprocesada → descartá la sesión interactiva (el preview viejo no
  // corresponde al canvas nuevo). El embedding se recachea por identidad de la fuente.
  // El "Analizar todo" también se resetea: el labelmap es por imagen (tamaño/contenido
  // distinto) → hay que re-analizar.
  useEffect(() => {
    if (samSession.current) samResetSession()
    if (samEvery.current || samEveryUI) samEveryReset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.url, sourceKey])

  // Progreso del "Analizar todo" (sam-everything, ~50s): reenvía el mensaje del sidecar
  // al hint de la barra mientras hay un análisis en curso (solo en sub-modo 'everything').
  useEffect(() => {
    return window.api.samSelect.onEverythingProgress((ev) => {
      if (samMode === 'everything' && samWorking) {
        onSamHint?.(ev.message ?? 'Analizando toda la imagen… (~1 min)')
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samMode, samWorking, onSamHint])

  // ── SELECCIÓN (Select & Mask, overlay Konva) ──────────────────────────────
  // El borde marching-ants se DERIVA del alfa (fuente de verdad). No hay nodos: el
  // refinamiento es por pincel +/− (abajo). Tras cada pincelada se regenera el borde.
  //
  // Alinea el Stage/Layer al object-contain ACTUAL del canvas (mismo cálculo que
  // toCanvasPx). Se llama al crear el overlay, al cambiar imagen y al redimensionar.
  const syncLayout = useCallback((): void => {
    const o = contour.current
    const c = canvasRef.current
    const wrap = wrapRef.current
    if (!o || !c || !wrap) return
    // IMPORTANTE: medimos el wrap EXTERIOR (nunca transformado), no el viewport con el
    // zoom. La capa Konva se alinea al object-contain en escala BASE (sin zoom); el
    // zoom lo aplica el transform CSS del viewport, que escala canvas+overlays juntos.
    // Así el borde marching-ants escala con el canvas y sigue calzando exacto.
    const rect = wrap.getBoundingClientRect()
    o.layout({ width: rect.width, height: rect.height }, c.width, c.height)
  }, [])

  // Regenera el borde marching-ants desde el alfa ACTUAL del canvas. Es la única
  // forma de actualizar el borde: la máscara manda y el borde la sigue 1:1.
  const refreshEdge = useCallback((): void => {
    const o = contour.current
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (!o || !c || !ctx) return
    const img = ctx.getImageData(0, 0, c.width, c.height)
    o.refresh(img.data, c.width, c.height)
  }, [])

  // Crea/destruye el overlay según la herramienta. Solo vive en mode==='seleccion';
  // al entrar GENERA el borde desde el alfa; al salir se libera.
  useEffect(() => {
    if (!editable || mode !== 'seleccion') {
      contour.current?.destroy()
      contour.current = null
      return
    }
    const host = contourHostRef.current
    if (!host) return
    const overlay = createContourOverlay(host)
    contour.current = overlay
    // Alinear y generar el borde desde el alfa actual al entrar al modo.
    syncLayout()
    refreshEdge()
    return () => {
      overlay.destroy()
      contour.current = null
    }
    // result?.url para recrear el overlay si cambia la imagen mientras Selección está activa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, editable, result?.url])

  // Auto-limpieza al ENTRAR a Selección, UNA sola vez por imagen: cuando el borde ya
  // identifica al sujeto, todo lo de afuera (hebras tenues que dejó el motor) "no debería
  // existir" → lo borramos automáticamente. `cleanedFor` recuerda qué result.url ya se
  // limpió, así no se repite en cada toggle de herramienta. Es undoable (Ctrl/Cmd+Z) y
  // se rehabilita al cargar/reprocesar (cleanedFor se resetea en el load del canvas).
  // Corre DESPUÉS del efecto que crea el overlay (declarado antes), por eso el borde
  // marching-ants termina reflejando la máscara YA limpia. silent=false → snapshot propio.
  useEffect(() => {
    if (!editable || mode !== 'seleccion') return
    const url = result?.url
    if (!url || cleanedFor.current === url) return
    cleanedFor.current = url
    cleanOutside(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, editable, result?.url])

  // Mantener el overlay alineado cuando el contenedor cambia de tamaño (resize de
  // ventana / paneles). Solo cuando Selección está activa.
  useEffect(() => {
    if (mode !== 'seleccion') return
    const wrap = wrapRef.current
    if (!wrap || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => syncLayout())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [mode, syncLayout])

  // Exponemos las acciones al padre (barra de opciones de herramienta) sin sacar la
  // lógica del canvas de acá: la barra de arriba solo dispara estos métodos.
  // Zoom por botón: centrado en el CENTRO del wrap (= transform-origin). Sincroniza refs
  // y resetea el pan al volver a 1:1, igual que el zoom con rueda.
  function zoomByButton(factor: number): void {
    const wrap = wrapRef.current
    if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    zoomAtCursor(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
  }

  useImperativeHandle(
    ref,
    () => ({
      undo,
      reset,
      featherEdge,
      cleanOutside: () => cleanOutside(false),
      zoomIn: () => zoomByButton(1.25),
      zoomOut: () => zoomByButton(0.8),
      samCycleShape,
      samApply: () => void samApply(),
      samDiscard,
      samAnalyzeAll: () => void samAnalyzeAll(),
      samEverythingApply: () => void samEverythingApply(),
      samEverythingClear,
      samEverythingRemoveCandidates: () => void samEverythingRemoveCandidates(),
      samEverythingDismissCandidates,
      levelsEnter,
      previewLevels,
      levelsLeave,
      currentDataURL: () => canvasRef.current?.toDataURL('image/png') ?? null,
      peloEnter,
      previewHair,
      peloApply,
      peloLeave
    }),
    // sourceFile: samAnalyzeAll lo lee (manda sus bytes); rebind al cambiar de imagen.
    // bgHistogram: samAnalyzeAll → samBuildBgModelFromSource lo lee; rebind al reprocesar
    // la MISMA imagen (cambia el histograma pero no sourceFile) para no leer uno viejo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feather, view, onEdited, selectOp, sourceFile, bgHistogram]
  )

  // ── Zoom / Pan / Pincel ──────────────────────────────────────────────────────
  const zoomable = ZOOMABLE.has(mode)
  const isBrushMode = BRUSH_MODES.has(mode)
  // En modos de pincel, el arrastre PINTA; el pan necesita Space. En 'mover'/'niveles' el
  // arrastre panea directo cuando hay zoom (no pintan). En 'sam' y en 'color' (Varita) el pan
  // TAMBIÉN va con Space: así un CLICK con zoom dispara la acción (borrar por color) en vez de
  // panear — antes, con zoom, el click de la Varita paneaba y NO BORRABA NADA.
  const panNeedsSpace = isBrushMode || mode === 'sam' || mode === 'color'
  // ¿El gesto de arrastre actual es PAN (no pincel)? Pan con Space (modos pincel) o
  // arrastre directo en mover/color con zoom. Con scale===1 no hace falta panear.
  const panActive = (spaceHeld || !panNeedsSpace) && scale > 1
  // String de transform compartida: se aplica al MISMO contenedor (canvas+overlays).
  const viewportTransform = zoomable ? `translate(${off.x}px, ${off.y}px) scale(${scale})` : 'none'

  // Zoom centrado en el CURSOR: el punto de imagen bajo el puntero queda fijo al hacer
  // zoom (sensación natural, como Photoshop). Compensamos el offset para que el píxel
  // del cursor no se mueva: off' = p − (p − off)·(n/s), con p relativo al centro del wrap
  // (porque transform-origin es el centro). Leemos scale/off de refs (no de closure) para
  // que ráfagas de rueda en un frame acumulen bien. Mantiene el clamp de escala existente.
  function zoomAtCursor(clientX: number, clientY: number, factor: number): void {
    const wrap = wrapRef.current
    if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const s = scaleRef.current
    const n = clampScale(s * factor)
    if (n === 1) {
      scaleRef.current = 1
      offRef.current = { x: 0, y: 0 }
      setScale(1)
      setOff({ x: 0, y: 0 })
      return
    }
    const k = n / s
    const o = offRef.current
    // Punto del cursor relativo al centro (origen del transform), en px de pantalla.
    const px = clientX - cx
    const py = clientY - cy
    const next = { x: px - (px - o.x) * k, y: py - (py - o.y) * k }
    scaleRef.current = n
    offRef.current = next
    setScale(n)
    setOff(next)
  }

  // Diámetro del cursor de pincel EN PANTALLA. El tamaño del pincel está en px de
  // PANTALLA (constante), así que el círculo mide `brushSize` px independientemente del
  // zoom: lo que cambia es cuántos píxeles de imagen abarca (más zoom = más fino).
  const showBrushCursor = isBrushMode && !spaceHeld && brushCursor !== null
  const brushDiameter = brushSize

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden"
      style={{ background: editable ? (view === 'white' ? '#ffffff' : view === 'black' ? '#111111' : view === 'mask' ? '#000000' : CHECKER) : 'hsl(var(--muted))' }}
    >
      {editable ? (
        <>
          {/* VIEWPORT: única superficie de eventos (puntero + rueda). Recibe el transform
              translate+scale y ENVUELVE canvas + máscara + overlay Konva, así los tres
              escalan/panean JUNTOS y el borde marching-ants sigue calzando exacto al
              hacer zoom. transform-origin: center (default) → zoomAtCursor compensa el off
              respecto del centro. Los hijos van con pointer-events:none para que TODO
              evento caiga acá (sin importar si el puntero está sobre el canvas, la máscara
              o el overlay). El mapeo a px de imagen lo hace toCanvasPx leyendo el rect del
              canvas (que ya refleja el transform), por eso el pincel cae en el pixel exacto. */}
          <div
            ref={viewportRef}
            className="absolute inset-0 h-full w-full"
            style={{
              cursor: showBrushCursor
                ? 'none'
                : spaceHeld
                  ? panActive
                    ? 'grabbing'
                    : 'grab'
                  : isBrushMode || mode === 'color' || mode === 'sam'
                    ? 'crosshair'
                    : scale > 1
                      ? 'grab'
                      : 'default',
              touchAction: 'none',
              transform: viewportTransform,
              transformOrigin: 'center'
            }}
            onWheel={(e) => {
              if (!zoomable) return
              zoomAtCursor(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 0.89)
            }}
            onPointerDown={(e) => {
              // 1) PAN: Space en modos de pincel, o arrastre directo en mover/color con zoom.
              if (panActive) {
                pan.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y }
                e.currentTarget.setPointerCapture(e.pointerId)
                return
              }
              // 2) PINCEL / herramienta.
              if (mode === 'color') {
                magicErase(e)
              } else if (mode === 'borrar') {
                pushHistory()
                drawing.current = true
                e.currentTarget.setPointerCapture(e.pointerId)
                eraseAt(e)
              } else if (mode === 'restaurar') {
                pushHistory()
                drawing.current = true
                e.currentTarget.setPointerCapture(e.pointerId)
                restoreAt(e)
              } else if (mode === 'seleccion') {
                // Pincel de selección: Sumar (+) restaura desde el original; Quitar (−)
                // borra. Edita el alfa directamente (la máscara ES la selección).
                pushHistory()
                drawing.current = true
                e.currentTarget.setPointerCapture(e.pointerId)
                if (selectOp === 'add') restoreAt(e)
                else eraseAt(e)
              } else if (mode === 'sam' && samMode === 'everything') {
                // "Analizar todo": el click ELIGE la región bajo el cursor (no hay box ni
                // arrastre). La acción ocurre en pointerUp (para distinguir Shift). No
                // capturamos el puntero ni abrimos box: el hover sigue actualizándose.
              } else if (mode === 'sam') {
                // Selección inteligente: empezá un posible arrastre de BOX. Guardamos el
                // inicio en px de CLIENTE (para mapear con toCanvasPx con precisión); si el
                // arrastre es ínfimo, en pointerUp lo tratamos como CLICK (point prompt); si
                // no, como BOX. El rect se dibuja fuera del viewport transformado (px del wrap).
                // Alt o click-DERECHO = punto EXCLUIR (−): siempre click (nunca box), para
                // sacar partes de la selección (ej. los cuerpos al lado del locker).
                const wrap = wrapRef.current
                if (wrap) {
                  samExclude.current = e.altKey || e.button === 2
                  const r = wrap.getBoundingClientRect()
                  samBox.current = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY }
                  setSamBoxRect({ x: e.clientX - r.left, y: e.clientY - r.top, w: 0, h: 0 })
                  e.currentTarget.setPointerCapture(e.pointerId)
                }
              } else if (scale > 1) {
                // mover sin Space: arrastre = pan.
                pan.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y }
                e.currentTarget.setPointerCapture(e.pointerId)
              }
            }}
            onPointerMove={(e) => {
              // Posición del cursor de pincel (px del wrap) para dibujar su círculo.
              if (isBrushMode) {
                const wrap = wrapRef.current
                if (wrap) {
                  const r = wrap.getBoundingClientRect()
                  setBrushCursor({ x: e.clientX - r.left, y: e.clientY - r.top })
                }
              }
              if (drawing.current) {
                if (mode === 'restaurar' || (mode === 'seleccion' && selectOp === 'add')) restoreAt(e)
                else eraseAt(e)
              } else if (mode === 'sam' && samMode === 'everything') {
                // "Analizar todo": resaltá la región bajo el cursor (instantáneo: lee el
                // labelMapCanvas cacheado; solo repinta si cambió la región). El pan con
                // Space ya cortó arriba (panActive), así que acá el puntero no está paneando.
                if (!pan.current) samEveryHover_(e.clientX, e.clientY)
              } else if (mode === 'sam' && samBox.current && !samExclude.current) {
                // Arrastrando el box-prompt: actualizá el rect (client px en el ref, wrap px
                // para el overlay de dibujo). En gesto EXCLUIR no se dibuja box (es click).
                const wrap = wrapRef.current
                if (wrap) {
                  const r = wrap.getBoundingClientRect()
                  samBox.current = { ...samBox.current, x1: e.clientX, y1: e.clientY }
                  const b = samBox.current
                  const x = Math.min(b.x0, b.x1) - r.left
                  const y = Math.min(b.y0, b.y1) - r.top
                  setSamBoxRect({ x, y, w: Math.abs(b.x1 - b.x0), h: Math.abs(b.y1 - b.y0) })
                }
              } else if (pan.current) {
                setOff({ x: pan.current.ox + (e.clientX - pan.current.x), y: pan.current.oy + (e.clientY - pan.current.y) })
              }
            }}
            onPointerUp={(e) => {
              if (drawing.current) {
                drawing.current = false
                commit()
                // CLAVE: tras la pincelada, regenerar el borde marching-ants desde el
                // alfa actualizado, para que muestre el límite EXACTO de la selección.
                if (mode === 'seleccion') refreshEdge()
              } else if (mode === 'sam' && samBox.current) {
                const b = samBox.current
                const exclude = samExclude.current
                samBox.current = null
                samExclude.current = false
                setSamBoxRect(null)
                const c = canvasRef.current
                if (c) {
                  const dragPx = Math.hypot(b.x1 - b.x0, b.y1 - b.y0)
                  // EXCLUIR (Alt/click-derecho) = siempre CLICK (−). Si no: drag ínfimo
                  // (< 6 px) = CLICK INCLUIR (+); drag mayor = BOX (abre sesión nueva).
                  if (exclude || dragPx < 6) {
                    const p = toCanvasPx(c, b.x1, b.y1)
                    void samPrompt({ point: { x: p.x, y: p.y }, include: !exclude })
                  } else {
                    const p0 = toCanvasPx(c, b.x0, b.y0)
                    const p1 = toCanvasPx(c, b.x1, b.y1)
                    void samPrompt({ box: { x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y } })
                  }
                }
              } else if (mode === 'sam' && samMode === 'everything' && !pan.current) {
                // "Analizar todo": click = elegir la región bajo el cursor. Shift = acumular
                // (no aplica todavía). Si fue un pan (Space+drag) no entra acá (pan.current).
                void samEveryClick(e.clientX, e.clientY, e.shiftKey)
              }
              pan.current = null
            }}
            onPointerLeave={() => {
              if (drawing.current) {
                drawing.current = false
                commit()
                if (mode === 'seleccion') refreshEdge()
              }
              // Si soltó fuera del lienzo durante un box-prompt, cancelalo (sin disparar).
              if (mode === 'sam' && samBox.current) {
                samBox.current = null
                samExclude.current = false
                setSamBoxRect(null)
              }
              // "Analizar todo": al salir del lienzo, apagá el resaltado del hover.
              if (mode === 'sam' && samMode === 'everything' && samEveryHover.current !== 0) {
                samEveryHover.current = 0
                renderSamEveryOverlay()
              }
              pan.current = null
              setBrushCursor(null)
            }}
            onContextMenu={(e) => {
              // En Selección inteligente, el click-DERECHO es un punto EXCLUIR (−): suprimí
              // el menú contextual del SO para que el gesto funcione sin interrupciones.
              if (mode === 'sam') e.preventDefault()
            }}
          >
            <canvas
              ref={canvasRef}
              className="pointer-events-none h-full w-full object-contain"
              // Al ampliar (≥3×) mostrá pixeles NÍTIDOS (no interpolados) para editar fino;
              // a bajo zoom queda suave (vista general de una imagen de alta resolución).
              style={{ imageRendering: scale >= 3 ? 'pixelated' : undefined }}
            />
            {/* Overlay de MÁSCARA: representación del alfa (B/N). No destructivo; el canvas real queda intacto debajo. */}
            <canvas
              ref={maskRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 h-full w-full object-contain"
              style={{ display: view === 'mask' ? 'block' : 'none' }}
            />
            {/* Overlay de PREVIEW de Selección inteligente (SAM): tinte azul de la candidata
                mostrada, en la MISMA caja object-contain que el canvas (escala/panea con el
                viewport). No destructivo: el alfa real solo cambia al "Aplicar". Solo visible
                en modo 'sam' con una sesión activa. */}
            <canvas
              ref={samPreviewRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 h-full w-full object-contain"
              style={{ display: mode === 'sam' && (samMode === 'everything' ? Boolean(samEveryUI?.ready) : Boolean(samUI)) ? 'block' : 'none' }}
            />
            {/* Overlay de SELECCIÓN (Konva): borde marching-ants en la MISMA caja que el
                canvas (absolute inset-0 = misma object-contain box). El Stage/Layer se
                alinean al object-contain BASE en `layout()` (la escala de zoom la pone el
                transform del viewport que envuelve a todos), así el anillo en px de imagen
                cae sobre el pixel correcto a cualquier zoom. Es solo un INDICADOR: nunca
                recibe eventos (pointer-events:none) para que el pincel +/− pinte abajo. */}
            <div
              ref={contourHostRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 h-full w-full"
              style={{ display: mode === 'seleccion' ? 'block' : 'none' }}
            />
            {/* A/B (#12): ORIGINAL superpuesto, DENTRO del viewport → sincronizado con
                zoom/pan. Mismo object-contain que el canvas → calza si no hubo auto-crop. */}
            {compareOriginal && sourceUrl && (
              <img
                src={sourceUrl}
                alt="Original"
                aria-hidden
                className="pointer-events-none absolute inset-0 h-full w-full object-contain"
              />
            )}
          </div>
          {/* Cursor de pincel: círculo del tamaño REAL del pincel en pantalla (px), fuera
              del viewport transformado para que su grosor no se deforme con el zoom. Su
              diámetro es constante en px de pantalla = brushSize (el pincel se define en px
              de pantalla); lo que cambia con el zoom es cuántos px de IMAGEN abarca. */}
          {showBrushCursor && brushCursor && (
            <div
              aria-hidden
              className="pointer-events-none absolute z-10 rounded-full border border-white mix-blend-difference"
              style={{
                left: brushCursor.x,
                top: brushCursor.y,
                width: brushDiameter,
                height: brushDiameter,
                transform: 'translate(-50%, -50%)'
              }}
            />
          )}
          {/* Box-prompt de la selección inteligente: rectángulo en px de PANTALLA (fuera del
              viewport transformado, igual que el cursor de pincel), para que el grosor no se
              deforme con el zoom. Sus esquinas se mapean a px de imagen con toCanvasPx al soltar. */}
          {mode === 'sam' && samBoxRect && samBoxRect.w > 1 && samBoxRect.h > 1 && (
            <div
              aria-hidden
              className="pointer-events-none absolute z-10 border border-white bg-white/10 mix-blend-difference"
              style={{
                left: samBoxRect.x,
                top: samBoxRect.y,
                width: samBoxRect.w,
                height: samBoxRect.h
              }}
            />
          )}
        </>
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <div className="flex flex-col items-center text-muted-foreground">
            {isTiff ? (
              <>
                <FileCheck2 className="mb-2 h-8 w-8" />
                <p className="text-sm">TIFF generado (sin vista previa)</p>
              </>
            ) : (
              <>
                <ImageOff className="mb-2 h-8 w-8" />
                <p className="text-sm">Resultado aquí</p>
              </>
            )}
          </div>
        </div>
      )}

      {/* A/B (#12): etiqueta fija (fuera del viewport → no se deforma con el zoom) */}
      {compareOriginal && sourceUrl && (
        <span className="pointer-events-none absolute left-2 top-2 z-20 rounded bg-black/70 px-2 py-0.5 text-xs font-medium text-white">
          Original
        </span>
      )}
    </div>
  )
})
