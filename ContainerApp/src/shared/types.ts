/**
 * Contratos compartidos entre el proceso `main` (donde viven los plugins)
 * y el `renderer` (donde viven las mini apps). Es la semilla del "plugin SDK":
 * cuando crezca, esto se puede extraer a un paquete propio.
 */

/** Metadatos de un plugin = una capability reutilizable (el "comando" del CLI). */
export interface PluginManifest {
  id: string
  name: string
  version: string
  category?: string
  description?: string
}

/** Servicios que el host inyecta a cada plugin en tiempo de ejecución. */
export interface PluginContext {
  /** Reporta avance (0..1) para que la mini app muestre progreso. */
  onProgress: (value: number, message?: string) => void
  /** Permite cancelar el trabajo desde la UI. */
  signal: AbortSignal
  // Próximamente: http, fs, cache, log, ...
}

/**
 * Un plugin: input -> trabajo -> output. Sin UI, reutilizable por N mini apps.
 * Las validaciones de entrada/salida (p. ej. zod) se agregan junto al primer plugin.
 */
export interface Plugin<I = unknown, O = unknown> {
  manifest: PluginManifest
  run: (input: I, ctx: PluginContext) => Promise<O>
}

/** Estado de una mini app dentro del container. */
export type MiniAppStatus = 'ready' | 'coming-soon'

/** Metadatos de una mini app = lo que el container pinta como tile en la grilla. */
export interface MiniAppManifest {
  id: string
  name: string
  /** Categoría con la que se agrupa en la grilla (ej. "Sublimado Playeras"). */
  category: string
  description?: string
  /** ids de los plugins que usa (para reúso y composición). */
  uses?: string[]
  status?: MiniAppStatus
}

/** Config que el renderer manda al sidecar de quitar fondo (flags del pipeline). */
export interface BgConfig {
  imageType: string
  edgeMode: string
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

/** Config que la mini app Vectorizar manda al comando `vectorize` del sidecar. */
/** Un color RGB de la paleta del vector. */
export interface RgbColor {
  r: number
  g: number
  b: number
}

/** Edición de un color de la paleta del vector (reemplazar por `to`, o `remove` → transparente). */
export interface PaletteEdit extends RgbColor {
  to?: RgbColor
  remove?: boolean
}

export interface VectorizeConfig {
  /** Cantidad de colores de la paleta (2..12). Más = más detalle. */
  colors: number
  /** Tamaño del PNG rasterizado de salida (px, lado mayor). */
  size: number
  /** 'local' = Potrace por capas (gratis); 'recraft' = IA premium. */
  method: 'local' | 'recraft'
  /** Reducir ruido 0..100 (mediana antes de detectar la paleta; limpia grano/textura). */
  denoise: number
  /** Edición de paleta en vivo: fija la paleta detectada y reemplaza/quita colores. */
  edit?: PaletteEdit[]
}

/** Config que la mini app Mejorar manda al comando `enhance` del sidecar. */
export interface UpscaleConfig {
  /** Factor de upscale (1..4). */
  scale: number
  /** Aplicar nitidez (unsharp) tras el upscale (solo método clásico). */
  sharpen: boolean
  /** 'classic' = lanczos+nitidez; 'ai' = Real-ESRGAN local; 'recraft' = IA premium (API). */
  method: 'classic' | 'ai' | 'recraft'
}

/** Config que la mini app Crear Diseño manda al comando `generate` (Recraft). */
export interface GenerateConfig {
  prompt: string
  /** recraftv3 | recraftv3_vector | recraftv2 (vector = SVG). */
  model: string
  /** vector_illustration | digital_illustration | realistic_image. */
  style?: string
  /** "WxH", ej "1024x1024". */
  size: string
}

/** Config de "Preparar Sublimación" (comando `print-prep`). */
export interface PrintPrepConfig {
  /** Ancho físico en pulgadas. */
  widthIn: number
  /** Alto físico en pulgadas. */
  heightIn: number
  /** Espejo horizontal (para transfer de sublimación). */
  mirror: boolean
  format: 'png' | 'tiff'
}

/** Evento de progreso NDJSON reenviado del sidecar al renderer. */
export interface BgProgress {
  type: 'progress'
  stage: string
  progress: number
  message?: string
}

/**
 * Encoder de "Selección inteligente": 'mobilesam' (rápido ~3s) o 'sam-vitb' (preciso,
 * encode más lento pero ajusta mejor targets finos). Cada uno trae su propio decoder
 * compatible; el sidecar lo resuelve solo a partir del embedding.
 */
export type SamEncoderModel = 'mobilesam' | 'sam-vitb'

/** Punto de prompt de SAM en px de la imagen ORIGINAL (la que se encodeó). */
export interface SamPointInput {
  x: number
  y: number
  /** 1 = foreground (sumar), 0 = background (quitar). Default 1. */
  label?: number
}

/** Box de prompt de MobileSAM en px de la imagen ORIGINAL: [x0,y0,x1,y1]. */
export type SamBoxInput = [number, number, number, number]

/** Resultado de `sam:encode`: embedding cacheado en disco + dims de la imagen fuente. */
export interface SamEncodeResult {
  ok: boolean
  /** Ruta del embedding (temp del main) para reusar en cada `sam:decode`. */
  embeddingPath?: string
  /** Ancho de la imagen ORIGINAL que se encodeó (= espacio de las coords del prompt). */
  origW?: number
  /** Alto de la imagen ORIGINAL que se encodeó. */
  origH?: number
  error?: { code: string; message: string }
}

/** Una de las K máscaras candidatas del multimask de SAM: su PNG + IoU + cobertura. */
export interface SamCandidate {
  /** PNG de máscara (gris: 255 = objeto, 0 = fuera), tamaño de la imagen ORIGINAL. */
  bytes: ArrayBuffer
  /** IoU predicho por SAM para esta candidata. */
  iou: number
  /** Fracción de píxeles activos (0 = vacía). */
  coverage: number
}

/**
 * Resultado de `sam:decode`. Devuelve TODAS las K máscaras candidatas del multimask
 * (para ciclar formas en la UI) + el low-res (256x256) de la elegida para
 * refinamiento iterativo estilo Affinity. `bytes`/`iou`/`coverage` son de la elegida
 * (compat: primer-click directo). Las coords/box vienen en px de la imagen ORIGINAL.
 */
export interface SamDecodeResult {
  ok: boolean
  /** PNG de la candidata elegida (gris), tamaño ORIGINAL. = candidates[chosen].bytes. */
  bytes?: ArrayBuffer
  width?: number
  height?: number
  /** IoU de la candidata elegida (sanidad/UX). */
  iou?: number
  /** Fracción de píxeles activos de la elegida (0 = máscara vacía). */
  coverage?: number
  /** Índice de la candidata elegida entre las K. */
  chosen?: number
  /** Las K máscaras candidatas del multimask (para ciclar formas). */
  candidates?: SamCandidate[]
  /**
   * Ruta (en el temp del main) al PNG low-res (256x256) de la elegida, para
   * realimentar como `maskInputPath` en el próximo decode (refinamiento iterativo).
   * Es una ruta (no bytes): el renderer la reenvía tal cual; no necesita su contenido.
   */
  lowResPath?: string
  error?: { code: string; message: string }
}

/** Una región del "Analizar todo" (sam-everything): su índice 1-based en el labelmap + bbox + área. */
export interface SamEverythingMask {
  /**
   * Índice de la máscara en `summary.masks` (0-based). En el labelmap el pixel vale
   * `index + 1` (0 = sin región): al leer `labelMap[p]` la región es `labelMap[p] - 1`.
   */
  index: number
  /** Área en px de la región (a tamaño FUENTE). */
  area: number
  /** Bounding-box [x0, y0, x1, y1] en px de la imagen FUENTE. */
  bbox: [number, number, number, number]
}

/**
 * Resultado de `sam:everything` (Automatic Mask Generator): segmenta TODA la imagen
 * fuente en regiones. Devuelve el LABELMAP como PNG (8-bit gris: cada pixel = índice
 * 1-based de la región de menor área que lo cubre, 0 = ninguna), las dims de la fuente
 * y la lista de regiones (índice/bbox/área). El renderer decodea el labelmap a un typed
 * array HxW para el hover-lookup O(1) y compone la región elegida al alfa al clickear.
 */
export interface SamEverythingResult {
  ok: boolean
  /** PNG (8-bit gris) del labelmap, tamaño FUENTE. Pixel = índice 1-based de su región. */
  labelMapBytes?: ArrayBuffer
  /** Ancho de la imagen FUENTE (espacio del labelmap). */
  width?: number
  /** Alto de la imagen FUENTE (espacio del labelmap). */
  height?: number
  /** Regiones detectadas (índice 0-based / bbox / área) desde `summary.json`. */
  masks?: SamEverythingMask[]
  error?: { code: string; message: string }
}

/**
 * Modelo de color del FONDO VERDADERO que el sidecar computa durante el quita-fondo
 * (histograma 24³ del RGB de la FUENTE donde el matte está removido, alfa<26) y
 * reenvía al renderer. El renderer lo usa para detectar "restos de fondo" sin tener
 * que reconstruirlo del lienzo (que tiene el RGB del fondo en 0/negro) ni de la
 * fuente des-alineada por auto-crop/upscale. La Float32Array(bins³) viaja en base64
 * (little-endian) para no romper el stream NDJSON.
 */
export interface BgHistogram {
  /** Bins por canal del histograma (24). El renderer valida que coincida con su binning. */
  bins: number
  /** Frecuencia del bin más poblado (denominador del bg-match: freq/maxFreq*3). */
  maxFreq: number
  /** # de pixeles de fondo verdadero muestreados (alfa<26). Sanidad: >0. */
  bgPixels: number
  /** # de bins con frecuencia > 0. Sanidad: un histograma degenerado tiene poquísimos. */
  nonZeroBins: number
  /** Float32Array(bins³) en base64 (little-endian), normalizado por bgPixels. */
  histB64: string
}

/** Estado real de un paso del pipeline: si efectivamente hizo trabajo o no aplicó. */
export interface BgStepStatus {
  /** id del paso: 'remove-bg' | 'clean-halo' | 'fix-color' | 'auto-crop' | 'bg-fill' | 'fix-dpi' | 'flip' | 'export' | 'enhance'. */
  step: string
  /** true = hizo trabajo real; false = corrió pero no aplicó (ej. ya era RGB, sin espejo). */
  active: boolean
}

/** Resultado de una operación del sidecar (procesar / modelos). */
export interface BgProcessResult {
  ok: boolean
  bytes?: ArrayBuffer
  outputName?: string
  format?: string
  data?: unknown
  /** Estado por paso del pipeline (para mostrar ✓/– reales en la UI). */
  steps?: BgStepStatus[]
  /**
   * Modelo de color del FONDO VERDADERO (histograma 24³) que computó el sidecar
   * durante el recorte. El renderer lo guarda por imagen y lo usa para detectar
   * "restos de fondo" (objetos de fondo que el matte dejó pegados entre/dentro de
   * los sujetos). Ausente si el recorte no lo produjo (ej. provider recraft).
   */
  bgHistogram?: BgHistogram
  /** Perfil de contenido efectivo del recorte ('logo'|'ilustracion'|'producto'|'foto'); para sugerir acciones por tipo (ej. vectorizar logos). */
  detectedType?: string
  /** Paleta detectada del vector (en orden de capas), para mostrarla y editarla en la UI. */
  palette?: RgbColor[]
  error?: { code: string; message: string }
}

/** API segura que el preload expone al renderer como `window.api`. */
/** Saldo de IA Premium (Recraft). `credits` = unidades disponibles. */
export interface RecraftBalance {
  ok: boolean
  credits?: number
  email?: string
  error?: { code: string; message: string }
}

/** Config del contorno sticker/die-cut (borde de color + binarizado DTF). */
export interface ContourConfig {
  /** Grosor 0..100 (% relativo del lado mayor). */
  thickness: number
  /** Color del borde en #rrggbb. */
  color: string
}

/** Config de exportación de video 360° del Mockup 3D (encode con ffmpeg). */
export interface Video360Config {
  /** 'mp4' (H.264, para WhatsApp/redes), 'gif' (loop liviano) o 'both'. */
  format: 'mp4' | 'gif' | 'both'
  /** Cuadros por segundo del video de salida (12..60). */
  fps: number
  /** Nombre base sugerido para guardar (sin extensión). */
  name: string
}

/** Resultado de `mockup3d.renderVideo`: rutas guardadas (o error). */
export interface Video360Result {
  ok: boolean
  /** true si el usuario eligió una ruta y se guardó al menos un archivo. */
  saved?: boolean
  /** Rutas absolutas de los archivos escritos (mp4 y/o gif). */
  paths?: string[]
  error?: { code: string; message: string }
}

export interface SajaruApi {
  plugins: {
    list: () => Promise<PluginManifest[]>
    run: (pluginId: string, input: unknown) => Promise<unknown>
  }
  backgroundRemove: {
    setImage: (bytes: ArrayBuffer, name: string) => Promise<void>
    process: (config: BgConfig) => Promise<BgProcessResult>
    /** Inyecta un recorte ya procesado como resultado activo (multi-imagen: al cambiar de imagen). */
    loadResult: (bytes: ArrayBuffer, format: string) => Promise<void>
    /** Guarda varios recortes en una carpeta elegida (exportar todas). */
    saveAll: (
      items: Array<{ name: string; bytes: ArrayBuffer; format: string }>
    ) => Promise<{ saved: boolean; dir?: string; count?: number }>
    modelsList: () => Promise<BgProcessResult>
    modelsDownload: (id: string) => Promise<BgProcessResult>
    saveResult: (suggestedName: string) => Promise<{ saved: boolean; path?: string }>
    copyResult: () => Promise<{ copied: boolean }>
    updateResult: (bytes: ArrayBuffer) => Promise<void>
    vectorizeResult: () => Promise<BgProcessResult>
    contourResult: (config: ContourConfig) => Promise<BgProcessResult>
    onProgress: (cb: (ev: BgProgress) => void) => () => void
  }
  vectorize: {
    setImage: (bytes: ArrayBuffer, name: string) => Promise<void>
    process: (config: VectorizeConfig) => Promise<BgProcessResult>
    /** "Fundir al color predominante" en un rectángulo (px de la imagen resultado). Raster. */
    areaFill: (rect: { x: number; y: number; w: number; h: number }) => Promise<BgProcessResult>
    /** Borra todas las limpiezas de zona guardadas. */
    clearAreaFills: () => Promise<{ ok: boolean }>
    saveSvg: (suggestedName: string) => Promise<{ saved: boolean; path?: string }>
    savePng: (suggestedName: string) => Promise<{ saved: boolean; path?: string }>
    /**
     * Exporta SOLO una capa del vector como SVG propio: toma el `<g …data-color="{color}"…>`
     * del último resultado y lo guarda envuelto en el mismo `<svg …>`. `color` = '#rrggbb'.
     */
    saveLayerSvg: (color: string, suggestedName: string) => Promise<{ saved: boolean; path?: string }>
    /** Exporta el vector completo a PDF (vectorial) o EPS (vía Ghostscript). */
    saveVector: (
      format: 'pdf' | 'eps',
      suggestedName: string
    ) => Promise<{ saved: boolean; path?: string; error?: string }>
    copyResult: () => Promise<{ copied: boolean }>
    onProgress: (cb: (ev: BgProgress) => void) => () => void
  }
  upscale: {
    setImage: (bytes: ArrayBuffer, name: string) => Promise<void>
    process: (config: UpscaleConfig) => Promise<BgProcessResult>
    saveResult: (suggestedName: string) => Promise<{ saved: boolean; path?: string }>
    copyResult: () => Promise<{ copied: boolean }>
    onProgress: (cb: (ev: BgProgress) => void) => () => void
  }
  generate: {
    process: (config: GenerateConfig) => Promise<BgProcessResult>
    saveResult: (suggestedName: string) => Promise<{ saved: boolean; path?: string }>
    copyResult: () => Promise<{ copied: boolean }>
    hasApiKey: () => Promise<boolean>
    onProgress: (cb: (ev: BgProgress) => void) => () => void
  }
  /** IA Premium (Recraft): saldo de unidades disponibles. */
  recraft: {
    balance: () => Promise<RecraftBalance>
  }
  /** Mockup 3D: exporta un giro 360° (cuadros PNG capturados en el visor) a MP4/GIF. */
  mockup3d: {
    /**
     * Codifica los `frames` (PNG del giro 360°, ya cuadrados por el renderer) a MP4 y/o
     * GIF con ffmpeg y abre un diálogo para guardar. `frames` viajan como ArrayBuffer[].
     */
    renderVideo: (frames: ArrayBuffer[], config: Video360Config) => Promise<Video360Result>
    onProgress: (cb: (ev: BgProgress) => void) => () => void
  }
  printPrep: {
    setImage: (bytes: ArrayBuffer, name: string) => Promise<void>
    process: (config: PrintPrepConfig) => Promise<BgProcessResult>
    saveResult: (suggestedName: string) => Promise<{ saved: boolean; path?: string }>
    onProgress: (cb: (ev: BgProgress) => void) => () => void
  }
  editor: {
    save: (bytes: ArrayBuffer, suggestedName: string) => Promise<{ saved: boolean; path?: string }>
    copy: (bytes: ArrayBuffer) => Promise<{ copied: boolean }>
  }
  /** Selección inteligente (SAM): click/box → máscara del objeto. */
  samSelect: {
    /**
     * Encodea una imagen (caro, 1 vez por imagen+modelo) → embedding cacheado en el
     * main. `model`: 'mobilesam' (rápido, default) | 'sam-vitb' (preciso, encode más
     * lento pero recorta targets finos sin sobre-recortar). El decode lo elige solo
     * según qué encoder generó el embedding.
     */
    encode: (bytes: ArrayBuffer, name: string, model?: SamEncoderModel) => Promise<SamEncodeResult>
    /**
     * Decodifica un prompt (puntos/box en px ORIGINALES) → K máscaras candidatas +
     * low-res de la elegida. Para refinar: pasá `maskInputPath` (el `lowResPath` del
     * decode previo) + `hasMaskInput`. `maskIndex` fuerza cuál candidata es la elegida.
     */
    decode: (input: {
      embeddingPath: string
      points?: SamPointInput[]
      box?: SamBoxInput
      /** Low-res del decode previo (su `lowResPath`) para refinamiento iterativo. */
      maskInputPath?: string
      /** Realimentar el `maskInputPath` (si no, primer decode). */
      hasMaskInput?: boolean
      /** Cuál de las K candidatas usar como elegida (ciclar formas). */
      maskIndex?: number
    }) => Promise<SamDecodeResult>
    /**
     * "Analizar todo" (sam-everything, estilo Affinity): segmenta TODA la imagen en
     * regiones de una sola pasada (~50s con sam-vitb/40/crops0). Devuelve el labelmap
     * (PNG 8-bit: pixel = índice 1-based de la región a elegir ahí) + dims + regiones.
     * El renderer cachea el labelmap por imagen y resalta/aplica la región bajo el cursor.
     * Reporta progreso por `onEverythingProgress` (canal distinto al de encode/decode).
     */
    everything: (bytes: ArrayBuffer, name: string, model?: SamEncoderModel) => Promise<SamEverythingResult>
    onProgress: (cb: (ev: BgProgress) => void) => () => void
    /** Progreso del "Analizar todo" (sam-everything), separado del encode/decode. */
    onEverythingProgress: (cb: (ev: BgProgress) => void) => () => void
  }
}
