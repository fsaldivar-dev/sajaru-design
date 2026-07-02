/** Config de la mini app Quitar Fondo (mapea 1:1 a las opciones del sidecar). */
export interface Config {
  imageType: 'auto' | 'logo' | 'persona' | 'ilustracion'
  edgeMode: 'duro' | 'suave'
  softness: number
  bgTolerance: number
  /** Encoge el borde hacia adentro N px (quita fringe/bordes raros). 0 = off. */
  contract: number
  /** Motor de quitar fondo: 'local' (rmbg/color) o 'recraft' (IA premium). */
  bgProvider: 'local' | 'recraft'
  /** Recorta los márgenes transparentes al bounding-box del recorte. */
  autoCrop: boolean
  cleanArtifacts: boolean
  expandEdge: boolean
  format: 'png' | 'tiff'
  model: string
}

export const DEFAULT_CONFIG: Config = {
  imageType: 'auto',
  edgeMode: 'suave',
  softness: 10,
  bgTolerance: 10,
  contract: 0,
  bgProvider: 'local',
  // Opt-in: no sorprender cambiando dimensiones en el preview reactivo.
  autoCrop: false,
  cleanArtifacts: true,
  expandEdge: true,
  format: 'png',
  // birefnet (lite, swin_tiny ~213MB): licencia MIT (apto comercial), mejor calidad
  // que rmbg-1.4 (que es CC BY-NC, NO comercial). u2netp es liviano pero peor.
  model: 'birefnet'
}

export interface SourceImage {
  url: string
  name: string
  file: File
}

/**
 * Herramienta activa del editor de máscara (lift de estado a QuitarFondo).
 * `seleccion` = Select & Mask estilo Photoshop: el borde marching-ants se DERIVA de
 * la máscara alfa a precisión de pixel (no editable por nodos) y se refina con
 * pincel +/− (Sumar/Quitar); tras cada pincelada el borde se regenera desde el alfa.
 * `sam` = Selección inteligente (MobileSAM): un click/box segmenta el objeto y lo
 * SUMA (revela de la fuente) o QUITA (borra) de la selección/recorte.
 */
export type EditorMode = 'mover' | 'borrar' | 'restaurar' | 'color' | 'seleccion' | 'sam' | 'niveles' | 'pelo'

/** Dirección del pincel de la herramienta Selección: Sumar (+) o Quitar (−). */
export type SelectBrushOp = 'add' | 'subtract'

/**
 * Niveles del recorte (herramienta "Pulir" #2): ajusta el canal ALFA como un Niveles de
 * Photoshop aplicado a la transparencia. Friendly 0/0/0 = identidad (no cambia nada).
 */
export interface Levels {
  /** 0-100: sube el punto negro del alfa → manda el fleco gris/halo a transparente (aprieta el borde). */
  limpiar: number
  /** 0-100: baja el punto blanco del alfa → solidifica semitransparencias (refuerza el borde). */
  reforzar: number
  /** -100..100: gamma de los medios del alfa (endurece/suaviza la transición). */
  medios: number
}

/** Niveles identidad (sin efecto). */
export const LEVELS_IDENTITY: Levels = { limpiar: 0, reforzar: 0, medios: 0 }

/**
 * Recuperar pelo por canales (herramienta "Pulir" #1): técnica clásica pre-IA. Se toma un CANAL
 * de la imagen ORIGINAL (donde el pelo separa más del fondo), se le sube el CONTRASTE hasta que el
 * pelo queda blanco y el fondo negro → esa máscara B/N se SUMA al alfa para recuperar las hebras
 * que el AI aplanó. El usuario afina con "Ver máscara" (el contraste/canal se tunea a ojo).
 */
export interface Hair {
  /** Canal fuente: 'auto' (el de más contraste) o R/G/B. */
  channel: 'auto' | 'r' | 'g' | 'b'
  /** 0-100: contraste aplicado al canal (sube → más blanco/negro puro). */
  contrast: number
  /** Invierte (pelo oscuro sobre fondo claro vs claro sobre oscuro). */
  invert: boolean
  /** Muestra la máscara B/N en el lienzo para afinarla (vs ver el pelo recuperado). */
  showMask: boolean
}

/** Recuperar-pelo por defecto. */
export const HAIR_DEFAULT: Hair = { channel: 'auto', contrast: 50, invert: false, showMask: false }

/**
 * Precisión de la "Selección inteligente" (SAM):
 *  - 'fast'  (MobileSAM): encode ~3s; ágil, ideal para objetos grandes/definidos.
 *  - 'precise' (SAM ViT-B): encode más lento (~8-15s en CPU) pero recorta targets
 *    finos sin sobre-recortar (ej. un locker fino entre dos cuerpos). Grado Affinity.
 */
export type SamPrecision = 'fast' | 'precise'

/** Mapea la precisión de la UI al id de encoder que entiende el plugin/sidecar. */
export function samPrecisionModel(p: SamPrecision): 'mobilesam' | 'sam-vitb' {
  return p === 'precise' ? 'sam-vitb' : 'mobilesam'
}

/**
 * Sub-modo de la "Selección inteligente" (SAM):
 *  - 'prompt'     : click/box → SAM decode (el modo Rápido/Preciso de siempre).
 *  - 'everything' : "Analizar todo" (sam-everything) segmenta TODA la imagen en
 *    regiones de una pasada; el hover resalta la región bajo el cursor y el click la
 *    aplica. Resuelve targets finos pre-segmentados (ej. la franja del locker).
 */
export type SamMode = 'prompt' | 'everything'

/**
 * Estado del "Analizar todo" (sam-everything) que ResultPanel reporta a la barra de
 * opciones: si está analizando (~1 min), si ya hay un labelmap cargado y cuántas
 * regiones se acumularon con Shift+click (a la espera de aplicar).
 */
export interface SamEverythingState {
  /** Análisis en curso (spinner + hint "Analizando…"). */
  analyzing: boolean
  /** Ya hay un labelmap decodeado para la imagen actual (se puede hover/click). */
  ready: boolean
  /** Cantidad de regiones detectadas. */
  count: number
  /** Regiones acumuladas (Shift+click) a la espera de Aplicar. */
  pinned: number
  /**
   * "Restos de fondo" DETECTADOS automáticamente tras el análisis (heurística
   * bg-color-match): objetos de fondo que el quitado dejó pegados entre/dentro de los
   * sujetos (ej. un locker entre dos personas). Se resaltan en ámbar y la barra ofrece
   * [Quitar]/[Descartar]. 0 = no se detectó nada (no se muestra el banner).
   */
  candidates: number
}

/**
 * Estado de la sesión INTERACTIVA de "Selección inteligente" (SAM), estilo Affinity:
 * un click/box muestra la selección en PREVIEW (sin aplicar), se refina con puntos
 * +/− y se puede ciclar entre las K formas candidatas; recién ahí se APLICA.
 * Lo emite ResultPanel (dueño de la lógica de canvas) para que la barra de opciones
 * pinte los controles de la sesión (puntos +/−, "Otra forma", "Aplicar", "Descartar").
 */
export interface SamSessionInfo {
  /** Cantidad de puntos INCLUIR (+, label 1) acumulados. */
  includes: number
  /** Cantidad de puntos EXCLUIR (−, label 0) acumulados. */
  excludes: number
  /** Cuántas formas candidatas devolvió SAM (para "Otra forma"). */
  candidates: number
  /** Índice de la candidata mostrada en el preview (0..candidates-1). */
  chosen: number
  /** IoU de la candidata mostrada (sanidad/UX). */
  iou: number
}

/** Fondo del lienzo para inspeccionar el borde (es una CAPA, no el resultado). */
export type EditorView = 'checker' | 'white' | 'black' | 'mask'

/** Parámetros de pincel/refinado del editor, compartidos por paleta y barra de opciones. */
export interface BrushParams {
  /** Tamaño del pincel (px de pantalla). */
  size: number
  /** Dureza del pincel: 0 = pluma suave, 100 = borde duro. */
  hardness: number
  /** Flujo: opacidad por pasada (0..100). */
  flow: number
  /** Tolerancia de color de la varita (flood-fill por similitud). */
  colorTol: number
  /** Varita: borrar TODO el color clickeado (global, no solo lo conectado) — pisos/fondos partidos. */
  colorGlobal: boolean
  /** Radio de suavizado de borde (feather) en px (0..3). */
  feather: number
}

export const DEFAULT_BRUSH: BrushParams = {
  size: 28,
  hardness: 70,
  flow: 100,
  colorTol: 45,
  colorGlobal: false,
  feather: 1
}
