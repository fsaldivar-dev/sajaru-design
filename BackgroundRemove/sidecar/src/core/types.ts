/** Domain + protocol types shared across the sidecar. */

// — Domain (matches the mini app's advanced config) —
export type Product = 'playera' | 'taza' | 'gorra' | 'lona'
export type ImageType = 'auto' | 'logo' | 'persona' | 'ilustracion'
export type EdgeMode = 'duro' | 'suave'
export type OutputFormat = 'png' | 'tiff'

// — Perfil de contenido (ruteo consciente del perfil del quita-fondo) —
/** Tipo de contenido detectado/forzado que decide motor + matte. */
export type Profile = 'logo' | 'ilustracion' | 'foto' | 'producto'

/**
 * Modo del matte (consolidación del alfa) tras la inferencia IA:
 *  - 'soft'   foto: preserva el alfa crudo en la banda (pelo intacto).
 *  - 'medium' ilustración/producto: smoothstep de banda ancha.
 *  - 'crisp'  logo: smoothstep angosto (borde marcado).
 */
export type MatteMode = 'soft' | 'medium' | 'crisp'

/** Limpieza de halo por perfil (lo decide el preset, no la UI). */
export type CleanHaloMode = 'gentle' | 'normal' | 'off'

/** Motor de quita-fondo de un preset. 'autoflat' = flat ? color : ai. */
export type ProfileEngine = 'ai' | 'color' | 'autoflat'

/** Features baratas del contenido para decidir el perfil (analyzeContent). */
export interface ContentFeatures {
  /** # de colores distintos cuantizando a ~4 bits/canal (logos: pocos). */
  uniqueColors: number
  /** Fracción de píxeles con gradiente local alto (textura). 0..1. */
  edgeDensity: number
  /** Fracción del borde cerca del color mediano (fondo plano). 0..1. */
  borderUniformity: number
  /** ¿Hay alfa previa significativa? */
  hasAlpha: boolean
}

/** Preset por perfil: único lugar para tunear el comportamiento. */
export interface ProfilePreset {
  engine: ProfileEngine
  matte: MatteMode
  /** Pasadas de defringeEdge antes de clipear el alfa. */
  defringe: number
  /** Dilatar el borde +1px (en foto NO, para no tapar el pelo). */
  expandEdge: boolean
  cleanHalo: CleanHaloMode
}

export type PipelineStep =
  | 'analyze'
  | 'upscale-input'
  | 'remove-bg'
  | 'clean-halo'
  | 'fix-color'
  | 'auto-crop'
  | 'bg-fill'
  | 'enhance'
  | 'fix-dpi'
  | 'flip'
  | 'export'

/** Color de fondo para reemplazar la transparencia. 'transparent' = sin cambios. */
export type BgFill = 'transparent' | 'white' | 'black'

/** Full-pipeline options (used by batch and stream-events). */
export interface PipelineOptions {
  product: Product
  imageType: ImageType
  /**
   * Fuerza el perfil de contenido (override de la detección por imageType /
   * análisis). undefined = inferir: imageType si no es 'auto', sino analizar.
   */
  profile?: Profile
  model: string
  edgeMode: EdgeMode
  /** 0..100 — feather/smooth amount on the matte. */
  softness: number
  /** 0..100 — how aggressively to drop semi-transparent halo pixels. */
  bgTolerance: number
  cleanArtifacts: boolean
  /** Grow the opaque edge by 1px (avoids hairline gaps when printing). */
  expandEdge: boolean
  /** Encoge el borde hacia adentro N px (quita fringe/bordes raros). 0 = off. */
  contract: number
  /** Motor de quitar fondo: 'local' (rmbg/color) o 'recraft' (IA premium API). */
  removeBgProvider: 'local' | 'recraft'
  /** Recorta los márgenes transparentes al bounding-box del contenido. */
  autoCrop: boolean
  /** Reemplaza el fondo transparente por un color sólido (aplana el alfa). */
  bgFill: BgFill
  force300: boolean
  upscaleIfLow: boolean
  /**
   * Auto-upscale del INPUT antes de quitar el fondo cuando es de baja resolución
   * (logos chicos / screenshots). Un input chico da bordes dentados al keyear;
   * subiéndolo primero, el matte sale más limpio. NO-OP en imágenes que ya son
   * grandes (ver UPSCALE_BELOW en pipeline). default true.
   */
  autoUpscaleLowRes: boolean
  /** Mejorar imagen: upscale ×2 + nitidez después de quitar el fondo. */
  enhance: boolean
  format: OutputFormat
  /** Subset/order of steps to run; defaults to the full pipeline. */
  steps: PipelineStep[]
}

// — Protocol (NDJSON on stdout) —
export interface ProgressEvent {
  type: 'progress'
  stage: string
  /** 0..1 */
  progress: number
  message?: string
}

export interface ResultEnvelope<T = unknown> {
  type: 'result'
  ok: true
  command: string
  data: T
}

export interface ErrorEnvelope {
  type: 'error'
  ok: false
  command: string
  code: string
  message: string
  detail?: unknown
}

export type SidecarEvent = ProgressEvent | ResultEnvelope | ErrorEnvelope

// — Common result shapes —
export interface ImageInfo {
  path: string
  format: string
  width: number
  height: number
  channels: number
  hasAlpha: boolean
  /** sRGB, cmyk, etc. */
  space: string
  /** Dots per inch (horizontal), if known. */
  dpi: number | null
  sizeBytes: number
}

export interface Warning {
  code: string
  severity: 'info' | 'warn' | 'error'
  message: string
}
