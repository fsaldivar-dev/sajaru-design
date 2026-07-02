import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Copy,
  Download,
  Eye,
  FolderDown,
  Loader2,
  Plus,
  RefreshCw,
  Wand2,
  X
} from 'lucide-react'
import type { BgConfig, BgHistogram, BgProcessResult, BgStepStatus } from '@shared/types'
import { cn } from '@renderer/lib/cn'
import { IMAGE_ACCEPT as ACCEPT } from '@renderer/lib/image'
import { useRevokeOnUnmount } from '@renderer/lib/useRevokeOnUnmount'
import { useShell } from '@renderer/lib/shell'
import { OP_COST, recordUsage } from '@renderer/lib/premium'
import { AdvancedConfig } from './AdvancedConfig'
import { FieldLabel, Slider, Toggle } from './controls'
import { DropZone } from './DropZone'
import { LayersPanel } from './LayersPanel'
import { PipelineSteps } from './PipelineSteps'
import { checkQuality, type QualityIssue } from './quality'
import { ResultPanel, type ResultHandle, type ResultState } from './ResultPanel'
import { SendToMenu, type SendTarget } from './SendToMenu'
import { ToolOptionsBar } from './ToolOptionsBar'
import { ToolPalette } from './ToolPalette'
import {
  DEFAULT_BRUSH,
  DEFAULT_CONFIG,
  HAIR_DEFAULT,
  LEVELS_IDENTITY,
  type BrushParams,
  type Config,
  type EditorMode,
  type EditorView,
  type Hair,
  type Levels,
  type SamEverythingState,
  type SamMode,
  type SamPrecision,
  type SamSessionInfo,
  type SelectBrushOp,
  type SourceImage
} from './types'

/** Destinos del "Enviar a": ids reales del registro de mini apps. */
const SEND_TARGETS: SendTarget[] = [
  { id: 'preparar-sublimacion', label: 'Preparar sublimación' },
  { id: 'playeras-mockup-3d', label: 'Mockup 3D' },
  { id: 'playeras-vectorizar', label: 'Vectorizar' }
]

function toBgConfig(c: Config): BgConfig {
  return { ...c }
}

/**
 * Una imagen de la galería (multi-imagen): su fuente + estado de procesado + recorte.
 * Cada imagen se trata de forma INDEPENDIENTE (su propio recorte y retoques). La imagen
 * ACTIVA se refleja en los estados de edición (`source`/`result`/…); las demás guardan
 * su recorte acá y se re-sincronizan con el backend al volverse activas.
 */
interface GalleryItem {
  id: string
  name: string
  file: File
  srcUrl: string
  /** Miniatura chica (dataURL) para el filmstrip — evita decodificar N imágenes full-res. */
  thumb: string
  status: 'pending' | 'processing' | 'done' | 'error'
  errorMsg?: string
  /** Recorte (object URL propio del item) — se preserva al cambiar de imagen. */
  result: { url: string; format: 'png' | 'tiff' } | null
  edited: boolean
  detectedType: string | null
  bgHistogram: BgHistogram | null
}

/**
 * Genera una miniatura pequeña (dataURL) para el filmstrip. Clave para el rendimiento con
 * MÚLTIPLES imágenes: sin esto, cada `<img>` del strip mantiene la imagen full-res
 * decodificada en memoria (N × decenas de MB) y la app se pone lenta.
 */
function makeThumb(file: File, max = 160): Promise<string> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = (): void => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      c.getContext('2d')?.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = (): void => {
      URL.revokeObjectURL(url)
      resolve('')
    }
    img.src = url
  })
}

/** Convierte los Niveles friendly (0-100 / -100..100) a punto negro/blanco/gamma del alfa. */
function levelsToBWG(l: Levels): { black: number; white: number; gamma: number } {
  return {
    black: Math.round((l.limpiar / 100) * 160),
    white: Math.round(255 - (l.reforzar / 100) * 160),
    gamma: Math.pow(2, l.medios / 100)
  }
}

export default function QuitarFondo() {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG)
  const [source, setSource] = useState<SourceImage | null>(null)
  const [result, setResult] = useState<ResultState | null>(null)
  // Modelo de color del fondo verdadero (histograma 24³) que computa el sidecar en el
  // recorte: lo usa ResultPanel para detectar "restos de fondo" tras "Analizar todo".
  // Se reemplaza en cada recorte (incl. reproceso); null cuando el provider no lo da.
  const [bgHistogram, setBgHistogram] = useState<BgHistogram | null>(null)
  const [report, setReport] = useState<BgStepStatus[] | null>(null)
  const [progress, setProgress] = useState<{ value: number; message?: string } | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [edited, setEdited] = useState(false)
  // Confirmación antes de Reprocesar cuando hay retoques manuales: evita perder
  // borrador/varita/Analizar todo de un clic accidental. Solo se abre si `edited`.
  const [confirmReprocess, setConfirmReprocess] = useState(false)
  // Verificador de calidad pre-export (no bloqueante): avisa si el recorte quedó
  // inservible (sujeto borrado / fondo no detectado). Solo señales sin falsos positivos.
  const [quality, setQuality] = useState<QualityIssue[]>([])
  // Perfil de contenido detectado ('logo'|'ilustracion'|'producto'|'foto') + si el
  // usuario descartó la sugerencia: para sugerir Vectorizar en logos/ilustraciones (#5/#9).
  const [detectedType, setDetectedType] = useState<string | null>(null)
  const [suggestDismissed, setSuggestDismissed] = useState(false)
  // A/B (#12): mostrar el original mientras se mantiene presionado "Comparar".
  const [compareOriginal, setCompareOriginal] = useState(false)
  // Niveles del recorte (#2 Pulir): valores friendly; el preview en vivo lo aplica ResultPanel.
  const [levels, setLevels] = useState<Levels>(LEVELS_IDENTITY)
  // Recuperar pelo (#1 Pulir): canal/contraste/invertir/ver-máscara; el preview lo aplica ResultPanel.
  const [hair, setHair] = useState<Hair>(HAIR_DEFAULT)
  // Contorno (sticker/die-cut): borde de color + alfa binarizado (DTF). Off por defecto
  // (no cambia nada para quien no lo use). Cuando está activo, un efecto debounced pide al
  // sidecar el recorte con contorno (siempre sobre la base, sin acumular) y guarda el PNG
  // en `contourPreview`, que se muestra/exporta en lugar del recorte plano.
  const [contour, setContour] = useState<{ enabled: boolean; thickness: number; color: string }>({
    enabled: false,
    thickness: 35,
    color: '#ffffff'
  })
  const [contourPreview, setContourPreview] = useState<ResultState | null>(null)
  // Snapshot del recorte EDITADO al momento de activar el contorno: se usa como base del
  // borde y para restaurar al apagar (así apagar el contorno NO vuelve al recorte original).
  const [editedSnapshot, setEditedSnapshot] = useState<ResultState | null>(null)
  const [contourBusy, setContourBusy] = useState(false)

  // Estado de SELECCIÓN de herramienta levantado del ResultPanel (la lógica de canvas
  // sigue en ResultPanel; acá solo vive QUÉ herramienta/vista/pincel está activa).
  const [mode, setMode] = useState<EditorMode>('mover')
  const [view, setView] = useState<EditorView>('checker')
  const [brush, setBrush] = useState<BrushParams>(DEFAULT_BRUSH)
  // Selección (Select & Mask): dirección del pincel de refinamiento (Sumar/Quitar).
  const [selectOp, setSelectOp] = useState<SelectBrushOp>('subtract')
  // Selección inteligente (SAM): estado de la operación (encode/decode) para la barra.
  const [samBusy, setSamBusy] = useState(false)
  const [samHint, setSamHint] = useState<string | null>(null)
  // Selección inteligente (SAM): sesión interactiva activa (preview) o null. La emite
  // ResultPanel; la barra de opciones pinta sus controles (puntos +/−, ciclar, aplicar).
  const [samSession, setSamSession] = useState<SamSessionInfo | null>(null)
  // Selección inteligente (SAM): precisión del encoder. 'fast' = MobileSAM (default,
  // ágil); 'precise' = SAM ViT-B (recorta targets finos sin sobre-recortar, encode
  // más lento). ResultPanel re-encodea con el modelo elegido al cambiar (cache por modelo).
  const [samPrecision, setSamPrecision] = useState<SamPrecision>('fast')
  // Selección inteligente (SAM): sub-modo. 'prompt' = click/box (lo de siempre);
  // 'everything' = "Analizar todo" (sam-everything): hover resalta la región pre-
  // segmentada bajo el cursor, click la aplica (resuelve la franja fina del locker).
  const [samMode, setSamMode] = useState<SamMode>('prompt')
  // Selección inteligente (SAM): estado del "Analizar todo" (analizando / labelmap
  // listo / regiones acumuladas con Shift+click). Lo emite ResultPanel; la barra lo pinta.
  const [samEverything, setSamEverything] = useState<SamEverythingState | null>(null)

  // Galería multi-imagen: varias imágenes independientes; la ACTIVA se edita en los
  // estados de arriba, las demás guardan su recorte en el item y se re-sincronizan al
  // backend cuando se vuelven activas.
  const [items, setItems] = useState<GalleryItem[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [savingAll, setSavingAll] = useState(false)
  const itemsRef = useRef<GalleryItem[]>([])
  itemsRef.current = items
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId
  const galleryIdRef = useRef(0)
  const processingAllRef = useRef(false)

  const tokenRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Contorno (sticker): debounce propio + token para descartar respuestas viejas cuando el
  // usuario mueve grosor/color rápido (evita que una respuesta lenta pise a una más nueva).
  const contourDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const contourTokenRef = useRef(0)
  const editedRef = useRef(false)
  const addInputRef = useRef<HTMLInputElement>(null)
  // Debounce del verificador de calidad: no escanear los píxeles en CADA pincelada.
  const qualityDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const resultRef = useRef<ResultHandle>(null)
  const hasImage = Boolean(source)
  const busy = progress !== null
  const { openApp } = useShell()
  // source.url/result.url pertenecen a los items de la galería (se revocan al quitar el
  // item o al desmontar); acá solo las capas transitorias del contorno.
  useRevokeOnUnmount(contourPreview?.url, editedSnapshot?.url)
  // Al desmontar, revocá TODAS las URLs de la galería (fuentes + recortes).
  useEffect(
    () => () =>
      itemsRef.current.forEach((it) => {
        URL.revokeObjectURL(it.srcUrl)
        if (it.result) URL.revokeObjectURL(it.result.url)
      }),
    []
  )

  function set<K extends keyof Config>(key: K, value: Config[K]): void {
    setConfig((c) => ({ ...c, [key]: value }))
  }

  function setBrushParam<K extends keyof BrushParams>(key: K, value: BrushParams[K]): void {
    setBrush((b) => ({ ...b, [key]: value }))
  }

  // Verificador de calidad: corre checkQuality sobre un PNG (resultado o dataURL
  // editado) en un canvas sub-muestreado (la fracción de área es invariante a escala).
  function inspectQuality(src: string): void {
    const img = new Image()
    img.onload = (): void => {
      const cap = 1400
      const scale = Math.min(1, cap / Math.max(img.width, img.height))
      const cw = Math.max(1, Math.round(img.width * scale))
      const ch = Math.max(1, Math.round(img.height * scale))
      const cv = document.createElement('canvas')
      cv.width = cw
      cv.height = ch
      const cx = cv.getContext('2d', { willReadFrequently: true })
      if (!cx) return
      cx.drawImage(img, 0, 0, cw, ch)
      setQuality(checkQuality(cx.getImageData(0, 0, cw, ch).data, cw, ch))
    }
    img.onerror = (): void => setQuality([])
    img.src = src
  }

  // #7: "Revisar restos" — entra a "Analizar todo" y dispara el análisis (que ya
  // auto-detecta y resalta los restos de fondo en ámbar). Reusa el flujo probado de SAM.
  function onReviewResidues(): void {
    setMode('sam')
    setSamMode('everything')
    resultRef.current?.samAnalyzeAll()
  }

  // Niveles (#2 Pulir): cada cambio de slider actualiza el estado y dispara el preview en
  // vivo sobre el lienzo (desde la base que tomó ResultPanel al entrar a la herramienta).
  function onLevels<K extends keyof Levels>(key: K, value: Levels[K]): void {
    const next: Levels = { ...levels, [key]: value }
    setLevels(next)
    const { black, white, gamma } = levelsToBWG(next)
    resultRef.current?.previewLevels(black, white, gamma)
  }
  function onLevelsReset(): void {
    setLevels(LEVELS_IDENTITY)
    resultRef.current?.previewLevels(0, 255, 1)
  }

  // Recuperar pelo (#1 Pulir): cada cambio actualiza el estado y dispara el preview (máscara B/N o
  // pelo recuperado) desde la base que tomó ResultPanel al entrar a la herramienta.
  function onHair<K extends keyof Hair>(key: K, value: Hair[K]): void {
    const next: Hair = { ...hair, [key]: value }
    setHair(next)
    resultRef.current?.previewHair(next.channel, next.contrast, next.invert, next.showMask)
  }
  function onHairApply(): void {
    resultRef.current?.peloApply(hair.channel, hair.contrast, hair.invert)
    setHair((h) => ({ ...h, showMask: false })) // tras sumar, mostrá el pelo recuperado (no la máscara)
  }

  // Recortar a contenido (post-retoque): toma el lienzo ACTUAL (con tus retoques), lo recorta al
  // bounding-box de lo opaco y lo RECARGA como nuevo resultado (reusa el camino de carga → re-inicia
  // el canvas a las nuevas dimensiones, sin romper otras herramientas). Preserva los retoques.
  function onTrim(): void {
    const dataUrl = resultRef.current?.currentDataURL()
    if (!dataUrl) return
    const img = new Image()
    img.onload = (): void => {
      const W = img.width
      const H = img.height
      const src = document.createElement('canvas')
      src.width = W
      src.height = H
      const sctx = src.getContext('2d', { willReadFrequently: true })
      if (!sctx) return
      sctx.drawImage(img, 0, 0)
      const d = sctx.getImageData(0, 0, W, H).data
      let minX = W
      let minY = H
      let maxX = -1
      let maxY = -1
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (d[(y * W + x) * 4 + 3] > 0) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      if (maxX < 0) return // todo transparente: nada que recortar
      const nw = maxX - minX + 1
      const nh = maxY - minY + 1
      if (nw === W && nh === H) return // ya está ajustado al contenido
      const out = document.createElement('canvas')
      out.width = nw
      out.height = nh
      out.getContext('2d')?.drawImage(src, minX, minY, nw, nh, 0, 0, nw, nh)
      out.toBlob((blob) => {
        if (!blob) return
        const url = URL.createObjectURL(blob)
        setActiveResult(url, 'png')
        setEdited(true)
        editedRef.current = true
        void blob.arrayBuffer().then((buf) => window.api.backgroundRemove.updateResult(buf))
      }, 'image/png')
    }
    img.onerror = (): void => undefined
    img.src = dataUrl
  }

  useEffect(() => {
    return window.api.backgroundRemove.onProgress((ev) => {
      setProgress({ value: ev.progress, message: ev.message })
    })
  }, [])

  // Cerrar el diálogo de confirmación con Escape (UX de modal estándar).
  useEffect(() => {
    if (!confirmReprocess) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setConfirmReprocess(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmReprocess])

  // Niveles (#2 Pulir): al ENTRAR a la herramienta, ResultPanel toma la base (snapshot) y
  // reseteamos los sliders; al SALIR (cleanup), commitea el ajuste o descarta el snapshot.
  useEffect(() => {
    if (mode !== 'niveles') return undefined
    setLevels(LEVELS_IDENTITY)
    resultRef.current?.levelsEnter()
    return () => resultRef.current?.levelsLeave()
  }, [mode])

  // Recuperar pelo (#1 Pulir): al entrar, ResultPanel toma la base + carga el original alineado;
  // reseteamos los controles. Al salir (cleanup), descarta el preview si no sumaste pelo.
  useEffect(() => {
    if (mode !== 'pelo') return undefined
    setHair(HAIR_DEFAULT)
    resultRef.current?.peloEnter()
    return () => resultRef.current?.peloLeave()
  }, [mode])

  async function runProcess(cfg: Config, targetId?: string): Promise<void> {
    // Procesa la imagen `targetId` (default = la activa). El caller garantiza que su
    // fuente ya está cargada en el backend (setImage); si no, el main responde E_NO_IMAGE.
    const id = targetId ?? activeIdRef.current
    editedRef.current = false
    setEdited(false)
    setQuality([])
    setSuggestDismissed(false)
    const token = ++tokenRef.current
    setError(null)
    setProgress({ value: 0, message: 'Procesando…' })

    const bgCfg = toBgConfig(cfg)
    // Timeout de seguridad: si el proceso se cuelga (el main muere, o cambiaste config a
    // mitad y el sidecar quedó raro), NO dejamos la barra girando para siempre — a los 90s
    // mostramos error y liberamos. El local tarda ~12s y Recraft ~7s, así que 90s nunca
    // corta un procesado legítimo.
    const r = await Promise.race<BgProcessResult>([
      window.api.backgroundRemove.process(bgCfg),
      new Promise<BgProcessResult>((resolve) =>
        setTimeout(
          () => resolve({ ok: false, error: { code: 'E_TIMEOUT', message: 'El procesado tardó demasiado. Reintentá con "Reprocesar".' } }),
          90000
        )
      )
    ])
    if (r.ok && bgCfg.bgProvider === 'recraft') recordUsage(OP_COST.removeBg)
    if (token !== tokenRef.current) return

    setProgress(null)
    if (!r.ok) {
      setError(r.error ?? { code: 'E_UNKNOWN', message: 'Error desconocido' })
      if (id) {
        setItems((its) =>
          its.map((it) => (it.id === id ? { ...it, status: 'error', errorMsg: r.error?.message } : it))
        )
      }
      return
    }
    const format: 'png' | 'tiff' = r.format === 'tiff' ? 'tiff' : 'png'
    const url = r.bytes
      ? URL.createObjectURL(new Blob([r.bytes], { type: format === 'tiff' ? 'image/tiff' : 'image/png' }))
      : null
    // Guardá el recorte en SU item (revocando el anterior si lo tenía) — cada imagen
    // conserva su recorte de forma independiente.
    if (id) {
      setItems((its) =>
        its.map((it) => {
          if (it.id !== id) return it
          if (url && it.result) URL.revokeObjectURL(it.result.url)
          return {
            ...it,
            status: 'done',
            errorMsg: undefined,
            result: url ? { url, format } : it.result,
            edited: false,
            detectedType: r.detectedType ?? null,
            bgHistogram: r.bgHistogram ?? null
          }
        })
      )
    }
    // Si es la imagen ACTIVA, reflejá en los estados de edición del editor.
    if (id === activeIdRef.current) {
      setReport(r.steps ?? [])
      setBgHistogram(r.bgHistogram ?? null)
      setDetectedType(r.detectedType ?? null)
      if (url) {
        setResult({ url, format })
        if (format !== 'tiff') inspectQuality(url)
      }
    }
  }

  /** Hace ACTIVA una imagen de la galería: carga su fuente al backend y sincroniza el
   *  editor con su recorte (o la procesa si aún está pendiente). */
  async function activate(id: string, opts?: { process?: boolean }): Promise<void> {
    const item = itemsRef.current.find((i) => i.id === id)
    if (!item) return
    // Preservá los retoques de la imagen que estabas editando antes de cambiar.
    if (activeIdRef.current && activeIdRef.current !== id) await bakeActiveIntoItem()

    activeIdRef.current = id
    setActiveId(id)
    setSource({ url: item.srcUrl, name: item.name, file: item.file })
    setError(null)
    setReport(null)
    // Imagen NUEVA → volver a 'cuadriculado' (la transparencia es obvia; el fondo de vista
    // es una CAPA, no el resultado).
    setView('checker')
    setMode('mover')
    setContour((c) => ({ ...c, enabled: false }))
    setContourPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
    setEditedSnapshot((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })

    const ab = await item.file.arrayBuffer()
    await window.api.backgroundRemove.setImage(ab, item.name)

    if (item.status === 'done' && item.result) {
      setResult({ url: item.result.url, format: item.result.format })
      setBgHistogram(item.bgHistogram)
      setDetectedType(item.detectedType)
      setEdited(item.edited)
      editedRef.current = item.edited
      setQuality([])
      // Re-sincronizá el recorte de ESTA imagen en el backend (para Guardar/Copiar/
      // Contorno/Vectorizar/retoques operen sobre ella, no sobre la anterior).
      const bytes = await (await fetch(item.result.url)).blob().then((b) => b.arrayBuffer())
      await window.api.backgroundRemove.loadResult(bytes, item.result.format)
      if (item.result.format !== 'tiff') inspectQuality(item.result.url)
    } else {
      setResult(null)
      setBgHistogram(null)
      setDetectedType(null)
      setEdited(false)
      editedRef.current = false
      setQuality([])
      if (opts?.process) {
        setItems((its) => its.map((it) => (it.id === id ? { ...it, status: 'processing' } : it)))
        await runProcess(config, id)
      }
    }
  }

  /** Captura el lienzo ACTUAL (con retoques) en el item activo, para no perderlo al cambiar. */
  async function bakeActiveIntoItem(): Promise<void> {
    const curId = activeIdRef.current
    if (!curId) return
    // Sin retoques, el item ya tiene el recorte exacto → no re-encodees (evita pérdida).
    if (!editedRef.current) return
    const item = itemsRef.current.find((i) => i.id === curId)
    if (!item || item.status !== 'done' || item.result?.format === 'tiff') return
    const dataUrl = resultRef.current?.currentDataURL()
    if (!dataUrl) return
    const blob = await (await fetch(dataUrl)).blob()
    const newUrl = URL.createObjectURL(blob)
    const wasEdited = editedRef.current
    setItems((its) =>
      its.map((it) => {
        if (it.id !== curId) return it
        if (it.result) URL.revokeObjectURL(it.result.url)
        return { ...it, result: { url: newUrl, format: 'png' }, edited: wasEdited }
      })
    )
  }

  /** Agrega una o varias imágenes a la galería. Si estaba vacía, procesa y activa la 1ª. */
  async function addFiles(files: File[]): Promise<void> {
    if (files.length === 0) return
    const wasEmpty = itemsRef.current.length === 0
    // Generá las miniaturas ANTES de montar los items → el filmstrip nunca decodifica
    // las imágenes full-res (clave para no ponerse lento con varias imágenes).
    const newItems: GalleryItem[] = await Promise.all(
      files.map(
        async (file): Promise<GalleryItem> => ({
          id: `img-${++galleryIdRef.current}`,
          name: file.name,
          file,
          srcUrl: URL.createObjectURL(file),
          thumb: await makeThumb(file),
          status: 'pending',
          result: null,
          edited: false,
          detectedType: null,
          bgHistogram: null
        })
      )
    )
    setItems((its) => [...its, ...newItems])
    // Disponible sincrónicamente para activate() antes del próximo render.
    itemsRef.current = [...itemsRef.current, ...newItems]
    if (wasEmpty) await activate(newItems[0].id, { process: true })
  }

  /** Procesa TODAS las pendientes, de a una (la activa sigue a la que procesa; sin conflicto). */
  async function onProcessAll(): Promise<void> {
    if (processingAllRef.current) return
    processingAllRef.current = true
    try {
      let next = itemsRef.current.find((i) => i.status === 'pending')
      while (next) {
        await activate(next.id, { process: true })
        next = itemsRef.current.find((i) => i.status === 'pending')
      }
    } finally {
      processingAllRef.current = false
    }
  }

  /** Quita una imagen (revoca sus URLs); si era la activa, salta a otra o vacía el editor. */
  function removeItem(id: string): void {
    const idx = itemsRef.current.findIndex((i) => i.id === id)
    const item = itemsRef.current[idx]
    if (!item) return
    const remaining = itemsRef.current.filter((i) => i.id !== id)
    if (activeIdRef.current === id) {
      const next = remaining[Math.min(idx, remaining.length - 1)]
      if (next) void activate(next.id)
      else clearActive()
    }
    setItems(remaining)
    URL.revokeObjectURL(item.srcUrl)
    if (item.result) URL.revokeObjectURL(item.result.url)
  }

  /** Deja el editor vacío (sin imagen activa). */
  function clearActive(): void {
    activeIdRef.current = null
    setActiveId(null)
    setSource(null)
    setResult(null)
    setBgHistogram(null)
    setDetectedType(null)
    setEdited(false)
    editedRef.current = false
    setReport(null)
    setQuality([])
    setError(null)
    setContour((c) => ({ ...c, enabled: false }))
    setContourPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
    setEditedSnapshot((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
  }

  /** Actualiza el recorte del item ACTIVO + el estado del editor (edits que generan un PNG nuevo). */
  function setActiveResult(url: string, format: 'png' | 'tiff'): void {
    const id = activeIdRef.current
    if (id) {
      setItems((its) =>
        its.map((it) => {
          if (it.id !== id) return it
          if (it.result && it.result.url !== url) URL.revokeObjectURL(it.result.url)
          return { ...it, status: 'done', result: { url, format } }
        })
      )
    }
    setResult({ url, format })
  }

  /** Guarda TODOS los recortes en una carpeta elegida (reemplaza a "Procesar en lote"). */
  async function onSaveAll(): Promise<void> {
    if (savingAll) return
    setSavingAll(true)
    try {
      await onProcessAll() // procesá lo pendiente
      await bakeActiveIntoItem() // conservá los retoques de la imagen activa
      const done = itemsRef.current.filter((it) => it.status === 'done' && it.result)
      if (done.length === 0) return
      const payload = await Promise.all(
        done.map(async (it) => ({
          name: `${it.name.replace(/\.[^.]+$/, '')}-sinfondo`,
          bytes: await (await fetch(it.result!.url)).blob().then((b) => b.arrayBuffer()),
          format: it.result!.format
        }))
      )
      await window.api.backgroundRemove.saveAll(payload)
    } finally {
      setSavingAll(false)
    }
  }

  // Reactivo: re-procesa (debounced) al cambiar settings, si hay imagen.
  // Si el usuario retocó a mano, NO auto-reprocesa (no le pisa los retoques).
  useEffect(() => {
    // Recraft es API de pago: no auto-reprocesar (se aplica con "Reprocesar").
    if (!source || editedRef.current || config.bgProvider === 'recraft') return
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void runProcess(config), 400)
    return () => clearTimeout(debounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  // Contorno (sticker): reactivo/debounced. Con el toggle ON y un recorte disponible, pide
  // al sidecar el PNG con borde de color + alfa binarizado (se aplica SIEMPRE sobre la base,
  // no acumula) y lo guarda en `contourPreview`. Con el toggle OFF (o sin recorte) limpia el
  // preview al instante → vuelve a verse el recorte plano. Se re-dispara al cambiar el recorte
  // base (result.url), grosor o color. Un token descarta respuestas viejas.
  useEffect(() => {
    if (!contour.enabled || !result) {
      contourTokenRef.current++ // invalida cualquier respuesta en vuelo
      setContourBusy(false)
      setContourPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)
        return null
      })
      return undefined
    }
    const token = ++contourTokenRef.current
    clearTimeout(contourDebounceRef.current)
    contourDebounceRef.current = setTimeout(() => {
      setContourBusy(true)
      void window.api.backgroundRemove
        .contourResult({ thickness: contour.thickness, color: contour.color })
        .then((r) => {
          if (token !== contourTokenRef.current) return
          setContourBusy(false)
          if (r.ok && r.bytes) {
            const url = URL.createObjectURL(new Blob([r.bytes], { type: 'image/png' }))
            setContourPreview((prev) => {
              if (prev) URL.revokeObjectURL(prev.url)
              return { url, format: 'png' }
            })
          }
        })
        .catch(() => {
          if (token !== contourTokenRef.current) return
          setContourBusy(false)
        })
    }, 300)
    return () => clearTimeout(contourDebounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contour.enabled, contour.thickness, contour.color, result?.url, editedSnapshot?.url])

  // Activar/desactivar contorno. Al ACTIVAR capturamos el recorte EDITADO actual
  // (currentDataURL): lo sincronizamos a lastOutput → el contorno se calcula sobre lo
  // editado (no el original), y lo guardamos como snapshot para restaurar al apagar sin
  // perder los retoques (varita/borrador). Si no hay canvas listo, cae al toggle simple.
  async function onContourToggle(v: boolean): Promise<void> {
    if (v) {
      const dataUrl = resultRef.current?.currentDataURL()
      if (dataUrl) {
        const bytes = await (await fetch(dataUrl)).blob().then((b) => b.arrayBuffer())
        await window.api.backgroundRemove.updateResult(bytes)
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
        setEditedSnapshot((prev) => {
          if (prev) URL.revokeObjectURL(prev.url)
          return { url, format: 'png' }
        })
      }
    }
    setContour((c) => ({ ...c, enabled: v }))
  }

  async function downloadModel(): Promise<void> {
    setDownloading(true)
    setError(null)
    setProgress({ value: 0, message: `Descargando ${config.model}…` })
    const r = await window.api.backgroundRemove.modelsDownload(config.model)
    setDownloading(false)
    setProgress(null)
    if (!r.ok) {
      setError(r.error ?? { code: 'E_DOWNLOAD', message: 'Falló la descarga' })
      return
    }
    void runProcess(config)
  }

  async function onSave(): Promise<void> {
    if (!result || !source) return
    const base = source.name.replace(/\.[^.]+$/, '')
    // Contorno activo: exportá los bytes CONTORNEADOS (borde + alfa DTF), no el recorte plano.
    // El PNG del contorno siempre es 'png'; lo guardamos vía editor.save con los bytes del blob.
    if (contour.enabled && contourPreview) {
      const bytes = await (await fetch(contourPreview.url)).blob().then((b) => b.arrayBuffer())
      await window.api.editor.save(bytes, `${base}-sticker.png`)
      return
    }
    const ext = result.format === 'tiff' ? 'tiff' : 'png'
    await window.api.backgroundRemove.saveResult(`${base}-sinfondo.${ext}`)
  }

  // "Enviar a → X": pasa el resultado actual a otra mini app, que lo pre-carga.
  // Tomamos los bytes del blob del resultado (no del main) para incluir retoques/vector.
  async function onSendTo(appId: string): Promise<void> {
    if (!result) return
    const base = (source?.name ?? 'imagen').replace(/\.[^.]+$/, '')
    // Con contorno activo, enviá el PNG contorneado (lo que se ve); si no, el recorte actual.
    const active = contour.enabled && contourPreview
    const src = active ? contourPreview.url : result.url
    const ext = active ? 'png' : result.format === 'tiff' ? 'tiff' : 'png'
    const suffix = active ? 'sticker' : 'sinfondo'
    const bytes = await (await fetch(src)).blob().then((b) => b.arrayBuffer())
    openApp(appId, { bytes, name: `${base}-${suffix}.${ext}` })
  }

  async function onCopy(): Promise<void> {
    if (!result) return
    // Contorno activo: copiá los bytes CONTORNEADOS vía editor.copy (el copyResult del main
    // copia el recorte plano). Si no, mantené el flujo existente intacto.
    if (contour.enabled && contourPreview) {
      const bytes = await (await fetch(contourPreview.url)).blob().then((b) => b.arrayBuffer())
      const r = await window.api.editor.copy(bytes)
      if (r.copied) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }
      return
    }
    const r = await window.api.backgroundRemove.copyResult()
    if (r.copied) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  // El borrador edita el canvas; persistimos los bytes para que Guardar/Copiar
  // usen la versión editada.
  async function onEdited(dataUrl: string): Promise<void> {
    const first = !editedRef.current
    editedRef.current = true
    setEdited(true)
    if (first && activeIdRef.current) {
      const id = activeIdRef.current
      setItems((its) => its.map((it) => (it.id === id ? { ...it, edited: true } : it)))
    }
    // Verificá calidad al SOLTAR (debounced), no en cada pincelada — evita el escaneo de
    // píxeles constante que traba el pincel.
    clearTimeout(qualityDebounceRef.current)
    qualityDebounceRef.current = setTimeout(() => inspectQuality(dataUrl), 400)
    const buf = await (await fetch(dataUrl)).blob().then((b) => b.arrayBuffer())
    await window.api.backgroundRemove.updateResult(buf)
  }

  // Vectoriza el resultado (Potrace por capas) → nítido a cualquier tamaño.
  async function onVectorize(): Promise<void> {
    if (!result) return
    const token = ++tokenRef.current
    editedRef.current = true
    setEdited(true)
    setError(null)
    setProgress({ value: 0, message: 'Vectorizando…' })
    try {
      const r = await window.api.backgroundRemove.vectorizeResult()
      if (token !== tokenRef.current) return
      setProgress(null)
      if (!r.ok) {
        setError(r.error ?? { code: 'E_VECTOR', message: 'Falló la vectorización' })
        return
      }
      if (r.bytes) {
        const url = URL.createObjectURL(new Blob([r.bytes], { type: 'image/png' }))
        setActiveResult(url, 'png')
      }
    } catch (e) {
      if (token !== tokenRef.current) return
      setProgress(null)
      setError({ code: 'E_VECTOR', message: e instanceof Error ? e.message : String(e) })
    }
  }

  // Galería: si hay pendientes por procesar y cuántas listas (para los botones de lote).
  const multi = items.length > 1
  const hasPending = items.some((i) => i.status === 'pending')
  const doneCount = items.filter((i) => i.status === 'done').length
  const modelMissing = error?.code === 'E_MODEL_MISSING'
  // Contorno activo = toggle ON y hay un preview listo. Mientras esté activo, el lienzo
  // muestra el sticker (preview) en vez del recorte plano.
  const contourActive = contour.enabled && Boolean(contourPreview)
  // Lo que ve el lienzo/ResultPanel: el preview del contorno cuando está activo, o el recorte.
  const effectiveResult = contourActive ? contourPreview : (editedSnapshot ?? result)
  // El editor de máscara solo opera sobre un resultado PNG visible. Con el contorno ACTIVO
  // el lienzo muestra el sticker binarizado (preview de salida): deshabilitamos edición para
  // que las herramientas no operen sobre —ni pisen— el recorte base (el borde se recalcula
  // desde la base en cada cambio). Apagá el contorno para volver a editar.
  const canEdit = Boolean(result && result.format !== 'tiff') && !contour.enabled
  // Sugerencia por tipo (#5/#9): vectorizar logos/ilustraciones para nitidez infinita.
  // Solo si hay resultado PNG sin retocar y el usuario no la descartó.
  const suggestVectorize =
    canEdit && !busy && !edited && !suggestDismissed && (detectedType === 'logo' || detectedType === 'ilustracion')

  return (
    <div className="flex h-full flex-col">
      {/* Barra de acción — fija */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3">
        <p className="truncate text-sm text-muted-foreground">
          {multi
            ? `${items.length} imágenes · editando: ${source?.name ?? '—'}`
            : source
              ? source.name
              : 'Arrastrá una o varias imágenes para empezar'}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {/* Lote: procesar todas las pendientes de una */}
          {hasPending && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void onProcessAll()}
              title="Quitar el fondo a todas las imágenes pendientes"
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Wand2 className="h-4 w-4" strokeWidth={1.75} />
              Procesar todas
            </button>
          )}

          {/* Re-ejecutar — acción de "ajustes", de-enfatizada (ghost) */}
          <button
            type="button"
            disabled={!hasImage || busy}
            onClick={() => {
              if (edited) setConfirmReprocess(true)
              else void runProcess(config)
            }}
            title="Volver a generar el recorte con los ajustes actuales"
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} strokeWidth={1.75} />
            {busy ? 'Procesando…' : 'Reprocesar'}
          </button>

          <div className="mx-1 h-6 w-px bg-border" />

          {/* A/B (#12): mantené presionado para ver el original a tamaño real */}
          <button
            type="button"
            disabled={!canEdit || busy}
            onPointerDown={() => setCompareOriginal(true)}
            onPointerUp={() => setCompareOriginal(false)}
            onPointerLeave={() => setCompareOriginal(false)}
            title="Mantené presionado para comparar con el original"
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Eye className="h-4 w-4" strokeWidth={1.75} />
            Comparar
          </button>

          {/* Salidas secundarias (outline) */}
          <button
            type="button"
            disabled={!result || busy}
            onClick={() => void onVectorize()}
            title="Trazar a vector (Potrace) → nítido a cualquier tamaño"
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Wand2 className="h-4 w-4" strokeWidth={1.75} />
            Vectorizar
          </button>
          <button
            type="button"
            disabled={!result || busy}
            onClick={() => void onCopy()}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Copy className="h-4 w-4" strokeWidth={1.75} />
            {copied ? 'Copiado ✓' : 'Copiar'}
          </button>
          <SendToMenu disabled={!result || busy} targets={SEND_TARGETS} onPick={(id) => void onSendTo(id)} />

          {/* Lote: guardar todos los recortes en una carpeta (reemplaza "Procesar en lote") */}
          {multi && (
            <button
              type="button"
              disabled={savingAll || busy || doneCount === 0}
              onClick={() => void onSaveAll()}
              title="Guardar todos los recortes en una carpeta"
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FolderDown className="h-4 w-4" strokeWidth={1.75} />
              {savingAll ? 'Guardando…' : `Guardar todas${doneCount ? ` (${doneCount})` : ''}`}
            </button>
          )}

          {/* Acción primaria — Guardar (filled) */}
          <button
            type="button"
            disabled={!result || busy}
            onClick={() => void onSave()}
            className="ml-1 flex items-center gap-1.5 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-4 w-4" strokeWidth={1.75} />
            Guardar
          </button>
        </div>
      </div>

      {/* Aviso de retoque manual — los settings no lo pisan */}
      {edited && !busy && (
        <div className="shrink-0 border-b border-border bg-muted px-6 py-1.5 text-xs text-muted-foreground">
          ✎ Resultado editado — cambiar ajustes no lo modifica. <strong>Reprocesar</strong> aplica los ajustes y descarta los retoques (te pide confirmar).
        </div>
      )}

      {/* Verificador de calidad pre-export — avisos no bloqueantes (solo casos graves) */}
      {quality.length > 0 && !busy && (
        <div className="shrink-0 border-b border-amber-500/50 bg-amber-500/10 px-6 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          {quality.map((q) => (
            <p key={q.kind}>⚠ {q.message}</p>
          ))}
        </div>
      )}

      {/* Sugerencia por tipo (#5/#7/#9): vectorizar + revisar restos en logos/ilustraciones */}
      {suggestVectorize && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/40 px-6 py-1.5 text-xs">
          <span className="text-muted-foreground">
            💡 {detectedType === 'logo' ? 'Parece un logo' : 'Parece una ilustración'} — vectorizá para
            nitidez infinita, o revisá si quedaron restos del fondo en huecos.
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void onVectorize()}
              className="flex items-center gap-1 rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background transition hover:opacity-90"
            >
              <Wand2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              Vectorizar
            </button>
            <button
              type="button"
              onClick={onReviewResidues}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium transition hover:bg-muted"
            >
              Revisar restos
            </button>
            <button
              type="button"
              onClick={() => setSuggestDismissed(true)}
              title="Descartar sugerencia"
              className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>
        </div>
      )}

      {/* Progreso — fijo */}
      {progress && (
        <div className="shrink-0 border-b border-border px-6 py-2">
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="brand-gradient h-full transition-all"
              style={{ width: `${Math.round(progress.value * 100)}%` }}
            />
            <div className="pointer-events-none absolute inset-y-0 left-0 w-1/3 animate-[sajaru-shimmer_1.2s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-foreground/30 to-transparent" />
          </div>
          {progress.message && <p className="mt-1 text-xs text-muted-foreground">{progress.message}</p>}
        </div>
      )}

      {/* Error — fijo */}
      {error && !busy && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted px-6 py-2 text-sm">
          <span className="text-muted-foreground">
            {modelMissing ? `Falta el modelo "${config.model}".` : error.message}
          </span>
          {modelMissing && (
            <button
              type="button"
              disabled={downloading}
              onClick={() => void downloadModel()}
              className="shrink-0 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
            >
              {downloading ? 'Descargando…' : 'Descargar modelo'}
            </button>
          )}
        </div>
      )}

      {/* Editor PRO: paleta izquierda · (opciones + canvas) centro · paneles derecha */}
      <div className="flex min-h-0 flex-1">
        <ToolPalette mode={mode} onMode={setMode} disabled={!canEdit} />

        {/* Columna central: barra de opciones de herramienta arriba + canvas focal */}
        <div className="flex min-w-0 flex-1 flex-col">
          {canEdit && (
            <ToolOptionsBar
              mode={mode}
              brush={brush}
              onBrush={setBrushParam}
              selectOp={selectOp}
              onSelectOp={setSelectOp}
              onUndo={() => resultRef.current?.undo()}
              onReset={() => resultRef.current?.reset()}
              onFeather={() => resultRef.current?.featherEdge()}
              onCleanOutside={() => resultRef.current?.cleanOutside()}
              levels={levels}
              onLevels={onLevels}
              onLevelsReset={onLevelsReset}
              hair={hair}
              onHair={onHair}
              onHairApply={onHairApply}
              onTrim={onTrim}
              onZoomIn={() => resultRef.current?.zoomIn()}
              onZoomOut={() => resultRef.current?.zoomOut()}
              samBusy={samBusy}
              samHint={samHint}
              samSession={samSession}
              samPrecision={samPrecision}
              onSamPrecision={setSamPrecision}
              onSamCycle={() => resultRef.current?.samCycleShape()}
              onSamApply={() => resultRef.current?.samApply()}
              onSamDiscard={() => resultRef.current?.samDiscard()}
              samMode={samMode}
              onSamMode={setSamMode}
              samEverything={samEverything}
              onSamAnalyzeAll={() => resultRef.current?.samAnalyzeAll()}
              onSamEverythingApply={() => resultRef.current?.samEverythingApply()}
              onSamEverythingClear={() => resultRef.current?.samEverythingClear()}
              onSamEverythingRemoveCandidates={() => resultRef.current?.samEverythingRemoveCandidates()}
              onSamEverythingDismissCandidates={() => resultRef.current?.samEverythingDismissCandidates()}
            />
          )}
          <div className="min-h-0 flex-1 p-4">
            <div className="h-full w-full overflow-hidden rounded-2xl border border-border">
              <ResultPanel
                ref={resultRef}
                result={effectiveResult}
                onEdited={onEdited}
                sourceKey={source?.name ?? null}
                mode={mode}
                view={view}
                brush={brush}
                selectOp={selectOp}
                sourceFile={source?.file ?? null}
                bgHistogram={bgHistogram}
                samPrecision={samPrecision}
                samMode={samMode}
                onSamBusy={setSamBusy}
                onSamHint={setSamHint}
                onSamSession={setSamSession}
                onSamEverything={setSamEverything}
                sourceUrl={source?.url ?? null}
                compareOriginal={compareOriginal}
              />
            </div>
          </div>

          {/* Filmstrip multi-imagen: cada imagen se trata independiente; click = editarla. */}
          {multi && (
            <div className="shrink-0 border-t border-border px-4 pb-3 pt-2">
              <div className="flex items-center gap-2 overflow-x-auto">
                {items.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void activate(it.id)}
                    title={it.name}
                    className={cn(
                      'group relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border transition disabled:cursor-not-allowed',
                      it.id === activeId
                        ? 'border-foreground ring-2 ring-foreground/30'
                        : 'border-border hover:border-foreground/40'
                    )}
                  >
                    <img
                      src={it.thumb || it.srcUrl}
                      alt={it.name}
                      className="h-full w-full object-cover"
                      style={{
                        background:
                          'repeating-conic-gradient(#e5e7eb 0% 25%, #f9fafb 0% 50%) 50% / 10px 10px'
                      }}
                    />
                    {/* estado del recorte */}
                    <span className="absolute left-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-background/85">
                      {it.status === 'processing' ? (
                        <Loader2 className="h-3 w-3 animate-spin text-foreground" />
                      ) : it.status === 'error' ? (
                        <AlertCircle className="h-3 w-3 text-red-500" />
                      ) : it.status === 'done' ? (
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      ) : (
                        <span className="h-2 w-2 rounded-full bg-muted-foreground/50" />
                      )}
                    </span>
                    {it.edited && it.status === 'done' && (
                      <span className="absolute bottom-0.5 left-1 rounded bg-foreground/85 px-1 text-[9px] font-medium leading-tight text-background">
                        ✎
                      </span>
                    )}
                    {/* quitar (span role=button: un <button> no puede anidar otro) */}
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label="Quitar imagen"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (!busy) removeItem(it.id)
                      }}
                      className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-background/85 text-muted-foreground opacity-0 transition hover:text-foreground group-hover:opacity-100"
                    >
                      <X className="h-3 w-3" strokeWidth={2} />
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => addInputRef.current?.click()}
                  title="Agregar imágenes"
                  className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
                >
                  <Plus className="h-5 w-5" strokeWidth={1.75} />
                  <span className="text-[10px]">Agregar</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Paneles derecha: Capas (vista + thumb + original) · Ajustes · Pipeline */}
        <aside className="w-[320px] shrink-0 space-y-6 overflow-y-auto border-l border-border p-6">
          <LayersPanel view={view} onView={setView} result={result} disabled={!canEdit} />

          {/* Original como REFERENCIA (thumbnail): conserva drag-drop + click para agregar más. */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Original</h3>
            <DropZone source={source} onFiles={addFiles} compact multiple />
          </section>

          <AdvancedConfig config={config} onChange={set} />

          {/* Contorno (sticker/die-cut): borde de color + alfa binarizado (DTF). Off por
              defecto. Requiere un recorte; se aplica sobre la base en cada cambio (no acumula). */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Contorno (sticker)
            </h3>
            <Toggle
              label="Agregar contorno"
              checked={contour.enabled}
              onChange={(v) => void onContourToggle(v)}
            />
            {contour.enabled && (
              <div className="mt-2 space-y-4 border-l border-border pl-3">
                <Slider
                  label="Grosor"
                  value={contour.thickness}
                  min={0}
                  max={100}
                  onChange={(v) => setContour((c) => ({ ...c, thickness: v }))}
                />
                <div className="flex items-center justify-between">
                  <FieldLabel>Color</FieldLabel>
                  <label
                    className="relative h-7 w-10 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border"
                    title="Elegir color del contorno"
                  >
                    <span className="absolute inset-0" style={{ backgroundColor: contour.color }} />
                    <input
                      type="color"
                      value={contour.color}
                      onChange={(e) => setContour((c) => ({ ...c, color: e.target.value }))}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  {contourBusy
                    ? 'Procesando…'
                    : 'El blanco no se ve sobre fondo blanco — poné el fondo del lienzo en oscuro para verlo.'}
                </p>
              </div>
            )}
          </section>

          <PipelineSteps config={config} steps={report} busy={busy} />
        </aside>
      </div>

      {/* Confirmación de Reprocesar — solo si hay retoques manuales (riesgo de pérdida) */}
      {confirmReprocess && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setConfirmReprocess(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border bg-background p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold">¿Reprocesar y descartar tus retoques?</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Hiciste retoques manuales (borrador, varita o Analizar todo). Reprocesar vuelve a
              generar el recorte desde cero con los ajustes actuales y{' '}
              <strong className="text-foreground">descarta esos retoques</strong>. No se puede
              deshacer.
            </p>
            <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              💡 ¿Solo querés conservar lo que tenés? Cerrá esto y usá{' '}
              <strong className="text-foreground">Guardar</strong> o{' '}
              <strong className="text-foreground">Copiar</strong>.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmReprocess(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmReprocess(false)
                  void runProcess(config)
                }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700"
              >
                Reprocesar y descartar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input oculto para "Agregar" imágenes desde el filmstrip (multi-imagen). */}
      <input
        ref={addInputRef}
        type="file"
        accept={ACCEPT.join(',')}
        multiple
        hidden
        onChange={(e) => {
          const fs = Array.from(e.target.files ?? []).filter((f) => ACCEPT.includes(f.type))
          if (fs.length) void addFiles(fs)
          e.target.value = ''
        }}
      />
    </div>
  )
}
