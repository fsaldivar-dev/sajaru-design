import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  Redo2,
  ScanEye,
  Trash2,
  Undo2,
  Upload,
  X
} from 'lucide-react'
import type { PaletteEdit, RgbColor, VectorGroup, VectorizeConfig } from '@shared/types'
import { cn } from '@renderer/lib/cn'
import { CompareView, type CanvasPick } from '@renderer/components/CompareView'
import { useRevokeOnUnmount } from '@renderer/lib/useRevokeOnUnmount'
import { useShell } from '@renderer/lib/shell'
import { OP_COST, recordUsage } from '@renderer/lib/premium'
import {
  buildOverlayFromMask,
  effectiveMask,
  floodComponent,
  hitComponent,
  loadRaster,
  marqueeMask,
  maskToPngBytes,
  rectMask,
  type Component,
  type Raster
} from './flood'

import { CHECKER, IMAGE_ACCEPT as ACCEPT } from '@renderer/lib/image'

const DEFAULT_CONFIG: VectorizeConfig = {
  colors: 16,
  size: 2048,
  method: 'local',
  denoise: 30,
  keepBackground: false
}
const SIZES = [1024, 2048, 4096]

interface SourceImage {
  url: string
  name: string
  file: File
}

/** Paso del historial ÚNICO: una edición de paleta/capas, o una acción raster de `n`
 *  entradas (un rect = 1; recolorear un grupo de 8 objetos = 8, se deshace como UN paso). */
type UAction = { kind: 'palette' } | { kind: 'fill'; n: number }

/** Pieza de la SELECCIÓN: un componente conectado (clic) o una marquesina por color
 *  (arrastre — el color dominante DENTRO del marco, aunque no esté conectado). */
type SelComp = Component & {
  kind: 'comp' | 'marquee'
  /** Rect original de la marquesina (px de imagen) — lo usa "Emparejar". */
  rect?: { x: number; y: number; w: number; h: number }
}

/**
 * Mini app "Vectorizar": traza un logo/imagen a vector (Potrace + separación de capas de
 * color del sidecar) y permite exportarlo como SVG/PDF/EPS o PNG en alta resolución.
 * Reactiva: re-vectoriza al cambiar los controles.
 *
 * Gramática de edición (estilo Illustrator): CLIC selecciona un objeto y LO RESALTA,
 * shift+clic suma, Escape deselecciona; las acciones (recolorear/borrar/guardar como
 * grupo) operan sobre la selección visible desde la barra contextual. Las capas del panel
 * cambian TODOS los objetos de un color; los grupos con nombre agrupan objetos sueltos.
 */
export default function Vectorizar(): React.JSX.Element {
  const [config, setConfig] = useState<VectorizeConfig>(DEFAULT_CONFIG)
  const [palette, setPalette] = useState<RgbColor[]>([])
  // Historial de ediciones de paleta (sub-pila del historial único). cur = posición actual.
  const [hist, setHist] = useState<{ stack: Array<PaletteEdit[] | undefined>; cur: number }>({
    stack: [undefined],
    cur: 0
  })
  const coalesceRef = useRef<string | null>(null)
  // Historial ÚNICO (⌘Z): intercala pasos de paleta y de ediciones raster en orden real.
  const [uhist, setUhist] = useState<{ undo: UAction[]; redo: UAction[] }>({ undo: [], redo: [] })
  const [source, setSource] = useState<SourceImage | null>(null)
  const [result, setResult] = useState<{ url: string } | null>(null)
  const [progress, setProgress] = useState<{ value: number; message?: string } | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [over, setOver] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  // Contador de ediciones raster vigentes (para "Quitar ediciones (N)").
  const [zones, setZones] = useState(0)
  // SELECCIÓN — se calcula client-side (flood.ts) y se RESALTA en el lienzo. Se compone:
  // clic = componente conectado · arrastre = marquesina por color (el dominante DENTRO del
  // marco) · shift suma · ⌥+arrastre RESTA una zona (así separás la playera del gorro
  // aunque compartan color y se toquen). Las acciones de la barra operan sobre lo efectivo.
  const [selComps, setSelComps] = useState<SelComp[]>([])
  const [selSubs, setSelSubs] = useState<Uint8Array[]>([])
  const [actionColor, setActionColor] = useState('#c53916')
  // Grupos con nombre ("Letras", "Gorro"…). Persisten en el main (sobreviven cambiar de
  // mini app y re-trazados; se limpian al cargar otra imagen).
  const [groups, setGroups] = useState<VectorGroup[]>([])
  const [groupHover, setGroupHover] = useState<string | null>(null)
  const [hoverComps, setHoverComps] = useState<Component[]>([])
  const [layerNote, setLayerNote] = useState<string | null>(null)

  const tokenRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const resultUrlRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rasterRef = useRef<Raster | null>(null)
  const hoverCacheRef = useRef<Map<string, Component[]>>(new Map())
  const layerNoteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hasImage = Boolean(source)
  const busy = progress !== null
  // La edición raster (objetos/zonas) consolida re-trazando LOCAL: con IA Premium el SVG
  // pago no se pisa — esas herramientas quedan deshabilitadas con aviso (WYSIWYG honesto).
  const canEditRaster = config.method === 'local'
  const { consumeTransfer, openApp } = useShell()
  useRevokeOnUnmount(source?.url, result?.url)

  useEffect(() => {
    return window.api.vectorize.onProgress((ev) => {
      setProgress({ value: ev.progress, message: ev.message })
    })
  }, [])

  // Raster del resultado para el flood de selección. Al cambiar el resultado, el caché de
  // grupos queda obsoleto — pero la SELECCIÓN se REVIVE re-floodeando sus semillas sobre el
  // raster nuevo (normalizadas contra el viejo, por si cambió el Tamaño): recolorear no te
  // roba la selección ni el lugar, como en Illustrator. Semillas borradas mueren solas.
  useEffect(() => {
    const prev = rasterRef.current
    // Se reviven SOLO los componentes de clic (sus semillas re-floodean el objeto nuevo,
    // recolorado o no). Las marquesinas y las restas son máscaras del raster viejo: mueren.
    const seeds = prev
      ? selComps.filter((c) => c.kind === 'comp').map((c) => ({ px: c.seed.x / prev.w, py: c.seed.y / prev.h }))
      : []
    rasterRef.current = null
    hoverCacheRef.current.clear()
    setHoverComps([])
    setSelSubs([])
    if (!result?.url) {
      setSelComps([])
      return
    }
    let dead = false
    void loadRaster(result.url).then(
      (r) => {
        if (dead) return
        rasterRef.current = r
        if (seeds.length) {
          const revived = seeds
            .map((s) => floodComponent(r, s.px * r.w, s.py * r.h))
            .filter((c): c is Component => c !== null)
            .map((c) => ({ ...c, kind: 'comp' as const }))
          setSelComps(revived)
        } else {
          setSelComps([])
        }
      },
      () => undefined
    )
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.url])

  // Cambiar a IA Premium apaga las herramientas raster (ver `canEditRaster`).
  useEffect(() => {
    if (!canEditRaster) {
      setSelComps([])
      setSelSubs([])
    }
  }, [canEditRaster])

  // Grupos guardados en el main (si volvés a la mini app, siguen).
  useEffect(() => {
    void window.api.vectorize.groupsGet().then(
      (gs) => setGroups(Array.isArray(gs) ? gs : []),
      () => undefined
    )
  }, [])

  // Resaltado de grupo al pasar el mouse por su fila (flood cacheado por grupo/resultado).
  useEffect(() => {
    if (!groupHover) {
      setHoverComps([])
      return
    }
    const raster = rasterRef.current
    const g = groups.find((x) => x.id === groupHover)
    if (!raster || !g) {
      setHoverComps([])
      return
    }
    const cached = hoverCacheRef.current.get(g.id)
    if (cached) {
      setHoverComps(cached)
      return
    }
    const comps = g.seeds
      .map((s) => floodComponent(raster, s.px * raster.w, s.py * raster.h))
      .filter((c): c is Component => c !== null)
    hoverCacheRef.current.set(g.id, comps)
    setHoverComps(comps)
  }, [groupHover, groups])

  // Overlay de resaltado: (selección − restas) + grupo hovereado, compuesto por CompareView.
  const overlay = useMemo(() => {
    const raster = rasterRef.current
    if (!raster) return null
    const eff = effectiveMask(raster.w, raster.h, [...selComps, ...hoverComps], selSubs)
    if (!eff) return null
    return buildOverlayFromMask(raster.w, raster.h, eff.mask)
  }, [selComps, selSubs, hoverComps])

  // Handoff: si otra mini app nos mandó una imagen ("Enviar a → Vectorizar"), la
  // pre-cargamos al montar. consumeTransfer() es consume-once: no recarga en re-renders.
  useEffect(() => {
    const t = consumeTransfer()
    if (t) void onFile(new File([t.bytes], t.name, { type: 'image/png' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function run(cfg: VectorizeConfig): Promise<void> {
    // Sin guarda `if (!source) return`: en la 1ª carga el closure aún ve source=null
    // y abortaría el auto-procesado. Los callers (onFile/efecto reactivo) ya garantizan imagen.
    const token = ++tokenRef.current
    setError(null)
    setProgress({ value: 0, message: 'Vectorizando…' })

    const r = await window.api.vectorize.process(cfg)
    // Solo cuenta créditos cuando REALMENTE llama a la API: editar capas en Premium usa
    // svg-edit local (el main no toca Recraft) y no gasta.
    if (r.ok && cfg.method === 'recraft' && !(cfg.edit && cfg.edit.length)) recordUsage(OP_COST.vectorize)
    if (token !== tokenRef.current) return

    setProgress(null)
    if (!r.ok) {
      setError(r.error ?? { code: 'E_VECTOR', message: 'Falló la vectorización' })
      return
    }
    if (r.bytes) {
      const url = URL.createObjectURL(new Blob([r.bytes], { type: 'image/png' }))
      // Revocá el blob ANTERIOR FUERA del updater. Revocar dentro de setResult((prev)=>…) es un
      // efecto impuro: en StrictMode React corre el updater dos veces y revoca el blob NUEVO →
      // el <img> del "after" queda roto y se ve el "before" (original) debajo (preview sin cambiar).
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current)
      resultUrlRef.current = url
      setResult({ url })
    }
    // La paleta se refresca SOLO cuando re-detectamos (sin edición); al editar la conservamos.
    if (!cfg.edit) setPalette(r.palette ?? [])
  }

  async function onFile(file: File): Promise<void> {
    const ab = await file.arrayBuffer()
    setSource((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return { url: URL.createObjectURL(file), name: file.name, file }
    })
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current)
      resultUrlRef.current = null
    }
    setResult(null)
    setPalette([])
    setZones(0)
    setSelComps([])
    setSelSubs([])
    setGroups([])
    resetHistory(false)
    const fresh = { ...config, edit: undefined }
    setConfig(fresh)
    await window.api.vectorize.setImage(ab, file.name)
    void run(fresh)
  }

  // Re-vectoriza (debounced) con una config dada. ÚNICO disparador del re-trazado: la
  // llaman set() (controles) y applyEdit (paleta/capas). Un solo camino con debounce
  // compartido → nunca dos runs pisándose.
  function scheduleRun(cfg: VectorizeConfig): void {
    if (!source) return
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void run(cfg), 400)
  }

  // Limpia el debounce pendiente al desmontar.
  useEffect(() => () => clearTimeout(debounceRef.current), [])

  // Atajos globales: ⌘Z deshacer · ⌘⇧Z rehacer (historial ÚNICO: paleta + ediciones) ·
  // Escape deselecciona / cierra menús / sale de Editar zona · Supr borra la selección.
  useEffect(() => {
    const typing = (t: EventTarget | null): boolean =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    const onKey = (e: KeyboardEvent): void => {
      if (!source) return
      // Tipeando (renombrar un grupo, etc.): ⌘Z es del campo, no del diseño; Escape blurea.
      if (typing(e.target)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) void redoUnified()
        else void undoUnified()
        return
      }
      if (e.key === 'Escape') {
        // De a una capa por pulsación (estándar): menú → selección.
        if (exportOpen) setExportOpen(false)
        else if (selComps.length || selSubs.length) {
          setSelComps([])
          setSelSubs([])
        }
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selComps.length && !busy) {
        e.preventDefault()
        void applySelection('erase')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist, uhist, source, selComps, selSubs, busy, actionColor, exportOpen])

  function handleFiles(files: FileList | null): void {
    const f = files?.[0]
    if (f && ACCEPT.includes(f.type)) void onFile(f)
  }

  // Cambiar colores/ruido/motor RE-DETECTA la paleta (descarta ediciones de capas). El
  // TAMAÑO del PNG no toca la paleta: conserva ediciones e historial (era exasperante que
  // cambiar 2048→4096 borrara los recoloreos sin aviso).
  function set<K extends keyof VectorizeConfig>(key: K, value: VectorizeConfig[K]): void {
    if (key === 'size') {
      const next = { ...config, [key]: value }
      setConfig(next)
      scheduleRun(next)
      return
    }
    const next = { ...config, [key]: value, edit: undefined }
    setConfig(next)
    resetHistory(true)
    scheduleRun(next)
  }

  function applyEdit(edit: PaletteEdit[] | undefined): void {
    const next = { ...config, edit }
    setConfig(next)
    scheduleRun(next)
  }

  /** Resetea el historial de paleta. `keepFills` conserva los pasos de ediciones raster
   *  (que SÍ sobreviven a un re-trazado — persisten en el main). */
  function resetHistory(keepFills: boolean): void {
    setHist({ stack: [undefined], cur: 0 })
    coalesceRef.current = null
    setUhist((h) => (keepFills ? { undo: h.undo.filter((a) => a.kind === 'fill'), redo: [] } : { undo: [], redo: [] }))
  }

  /** Aplica una edición de paleta y la registra en AMBOS historiales. `coalesce` fusiona
   *  con el paso previo si la clave coincide (arrastrar el selector = un solo paso). */
  function commitEdit(next: PaletteEdit[] | undefined, coalesce: string | null): void {
    const merged = Boolean(coalesce && coalesce === coalesceRef.current)
    setHist((h) => {
      if (merged) {
        const stack = h.stack.slice(0, h.cur + 1)
        stack[h.cur] = next
        return { stack, cur: h.cur }
      }
      return { stack: [...h.stack.slice(0, h.cur + 1), next], cur: h.cur + 1 }
    })
    if (!merged) setUhist((h) => ({ undo: [...h.undo, { kind: 'palette' }], redo: [] }))
    coalesceRef.current = coalesce
    applyEdit(next)
  }

  function undoPalette(): void {
    if (hist.cur <= 0) return
    coalesceRef.current = null
    const i = hist.cur - 1
    setHist({ ...hist, cur: i })
    applyEdit(hist.stack[i])
  }

  function redoPalette(): void {
    if (hist.cur >= hist.stack.length - 1) return
    coalesceRef.current = null
    const i = hist.cur + 1
    setHist({ ...hist, cur: i })
    applyEdit(hist.stack[i])
  }

  /** ⌘Z: deshace LA última acción, sea de paleta o de ediciones raster (un solo historial). */
  async function undoUnified(): Promise<void> {
    if (busy) return
    const top = uhist.undo[uhist.undo.length - 1]
    if (!top) return
    if (top.kind === 'fill' && !canEditRaster) {
      setError({ code: 'E_ENGINE', message: 'Ese paso es una edición de objetos/zonas: volvé al motor Local para deshacerlo' })
      return
    }
    clearTimeout(debounceRef.current) // que no arranque un re-trazado en paralelo
    setUhist((h) => ({ undo: h.undo.slice(0, -1), redo: [...h.redo, top] }))
    if (top.kind === 'palette') {
      undoPalette()
      return
    }
    const token = ++tokenRef.current
    setError(null)
    setProgress({ value: 0, message: 'Deshaciendo la última edición…' })
    const r = await window.api.vectorize.undoLastFill(top.n)
    if (token !== tokenRef.current) return
    setProgress(null)
    if (!r.ok) {
      // El main no lo aplicó: devolvé el paso al historial (sin esto quedan desincronizados).
      setUhist((h) => ({ undo: [...h.undo, top], redo: h.redo.slice(0, -1) }))
      setError(r.error ?? { code: 'E_UNDO', message: 'No se pudo deshacer' })
      return
    }
    applyFillResult(r)
  }

  /** ⌘⇧Z: rehace la última acción deshecha. */
  async function redoUnified(): Promise<void> {
    if (busy) return
    const top = uhist.redo[uhist.redo.length - 1]
    if (!top) return
    if (top.kind === 'fill' && !canEditRaster) {
      setError({ code: 'E_ENGINE', message: 'Ese paso es una edición de objetos/zonas: volvé al motor Local para rehacerlo' })
      return
    }
    clearTimeout(debounceRef.current)
    setUhist((h) => ({ undo: [...h.undo, top], redo: h.redo.slice(0, -1) }))
    if (top.kind === 'palette') {
      redoPalette()
      return
    }
    const token = ++tokenRef.current
    setError(null)
    setProgress({ value: 0, message: 'Rehaciendo la edición…' })
    const r = await window.api.vectorize.redoLastFill()
    if (token !== tokenRef.current) return
    setProgress(null)
    if (!r.ok) {
      setUhist((h) => ({ undo: h.undo.slice(0, -1), redo: [...h.redo, top] }))
      setError(r.error ?? { code: 'E_REDO', message: 'No se pudo rehacer' })
      return
    }
    applyFillResult(r)
  }

  /** Toma el PNG devuelto por una operación raster y actualiza preview + contador. */
  function applyFillResult(r: { bytes?: ArrayBuffer; remaining?: number }): void {
    if (r.bytes) {
      const url = URL.createObjectURL(new Blob([r.bytes], { type: 'image/png' }))
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current)
      resultUrlRef.current = url
      setResult({ url })
    }
    if (typeof r.remaining === 'number') setZones(r.remaining)
  }

  const canUndoU = uhist.undo.length > 0
  const canRedoU = uhist.redo.length > 0

  /** Reemplaza (to) o quita (remove) el color i, conservando las demás ediciones. */
  function editColor(i: number, change: { to?: RgbColor | null; remove?: boolean }): void {
    const next: PaletteEdit[] = palette.map((c, k) => {
      const prev = config.edit?.[k]
      return { r: c.r, g: c.g, b: c.b, to: prev?.to, remove: prev?.remove }
    })
    if (!next[i]) return
    if (change.to !== undefined) next[i].to = change.to ?? undefined
    if (change.remove !== undefined) next[i].remove = change.remove
    // Reemplazar el mismo color se fusiona (un paso al arrastrar el selector); quitar = un paso.
    commitEdit(next, change.to !== undefined ? `r${i}` : null)
  }

  // --- Visibilidad de capas (ojo / aislar) ---
  // Reusa `remove` de PaletteEdit: ocultar = remove:true (pixeles transparentes), pero
  // reversible por el ojo y registrado en el historial (undo/redo lo revierte).
  /** Una capa está oculta si su edición actual la tiene con remove:true. */
  const isHidden = (i: number): boolean => Boolean(config.edit?.[i]?.remove)
  /** Hay al menos una capa oculta (para ofrecer "mostrar todas"). */
  const anyHidden = palette.some((_, i) => isHidden(i))
  /** Está aislada la capa i: es la única visible (todas las demás ocultas). */
  const isIsolated = (i: number): boolean =>
    palette.length > 1 && !isHidden(i) && palette.every((_, k) => k === i || isHidden(k))

  /** Construye el PaletteEdit[] base conservando `to`/`remove` actuales de cada color. */
  function baseEdits(): PaletteEdit[] {
    return palette.map((c, k) => {
      const prev = config.edit?.[k]
      return { r: c.r, g: c.g, b: c.b, to: prev?.to, remove: prev?.remove }
    })
  }

  /** Ojo: alterna oculto/visible de una capa (re-vectoriza con ese color dentro/fuera). */
  function toggleLayer(i: number): void {
    const next = baseEdits()
    if (!next[i]) return
    next[i].remove = !isHidden(i)
    commitEdit(next, null)
  }

  /** Aislar (ver sola): muestra únicamente la capa i. Si ya está aislada, muestra todas. */
  function isolateLayer(i: number): void {
    if (isIsolated(i)) {
      showAll()
      return
    }
    const next = baseEdits().map((e, k) => ({ ...e, remove: k !== i }))
    commitEdit(next, null)
  }

  /** Mostrar todas: revela todas las capas (limpia los remove; conserva recoloreos `to`). */
  function showAll(): void {
    const next = baseEdits().map((e) => ({ ...e, remove: false }))
    commitEdit(next, null)
  }

  /**
   * Exporta SOLO esta capa como su propio SVG (match por data-color en el main).
   * El sidecar emite `data-color` con el color YA recoloreado (`to`), así que matcheamos
   * sobre el color vigente (`cur`). Si la capa ya no existe en el vector (la borraste o
   * consolidaste distinto), avisamos en vez de fallar en silencio.
   */
  async function exportLayer(i: number): Promise<void> {
    const c = palette[i]
    if (!c) return
    const cur = config.edit?.[i]?.to ?? c
    const token = ++tokenRef.current
    setProgress({ value: 0, message: 'Exportando la capa…' })
    const r = await window.api.vectorize.saveLayerSvg(rgbToHex(cur), `${baseName()}-capa-${i + 1}.svg`)
    if (token === tokenRef.current) setProgress(null)
    if (!r.saved && !r.path) {
      clearTimeout(layerNoteTimer.current)
      setLayerNote('Esa capa ya no está en el vector actual (¿la ocultaste o recoloreaste?).')
      layerNoteTimer.current = setTimeout(() => setLayerNote(null), 5000)
    }
  }

  /** Export SVG: si hay ediciones sin trazar, el main consolida UNA vez (re-trazado con
   *  paleta protegida) — mostramos el progreso y lo limpiamos al volver. */
  async function onExportSvg(): Promise<void> {
    if (!result) return
    const token = ++tokenRef.current
    setProgress({ value: 0, message: 'Exportando SVG…' })
    await window.api.vectorize.saveSvg(`${baseName()}.svg`)
    if (token === tokenRef.current) setProgress(null)
  }

  /** Exporta el vector completo a PDF (vectorial) o EPS (Ghostscript). Surface del error
   *  si falta gs para EPS. */
  async function onSaveVector(format: 'pdf' | 'eps'): Promise<void> {
    if (!result) return
    const token = ++tokenRef.current
    setProgress({ value: 0, message: `Exportando ${format.toUpperCase()}…` })
    const r = await window.api.vectorize.saveVector(format, `${baseName()}.${format}`)
    if (token === tokenRef.current) setProgress(null)
    if (!r.saved && r.error) setError({ code: 'E_EXPORT', message: r.error })
  }

  const rgbToHex = (c: RgbColor): string =>
    '#' + [c.r, c.g, c.b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')
  const hexToRgb = (h: string): RgbColor => ({
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16)
  })

  const baseName = (): string => (source?.name ?? 'vector').replace(/\.[^.]+$/, '')

  async function onCopy(): Promise<void> {
    const r = await window.api.vectorize.copyResult()
    if (r.copied) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  /** "Enviar a Mockup 3D": manda el PNG vectorizado al Mockup 3D (lo pre-carga como diseño). */
  async function onSendToMockup(): Promise<void> {
    if (!result) return
    const bytes = await (await fetch(result.url)).blob().then((b) => b.arrayBuffer())
    openApp('playeras-mockup-3d', { bytes, name: `${baseName()}-vector.png` })
  }

  /** MARQUESINA (arrastre): suma la selección del color dominante dentro del marco;
   *  con ⌥ (alt) RESTA todo lo que caiga en el marco — separa la playera del gorro
   *  aunque compartan color y se toquen. Con shift suma sin reemplazar. */
  function onMarquee(
    rect: { x: number; y: number; w: number; h: number },
    opts: { additive: boolean; subtract: boolean }
  ): void {
    if (busy || !result || !canEditRaster) return
    const raster = rasterRef.current
    if (!raster) return
    if (opts.subtract) {
      const m = rectMask(raster, rect)
      if (m && selComps.length) setSelSubs((s) => [...s, m])
      return
    }
    const comp = marqueeMask(raster, rect)
    if (!comp) return
    const tagged: SelComp = { ...comp, kind: 'marquee', rect }
    if (opts.additive) {
      setSelComps((s) => [...s, tagged])
      return
    }
    setSelComps([tagged])
    setSelSubs([])
    setActionColor(comp.hex)
  }

  /** ¿La selección son SOLO componentes de clic, sin restas? (→ va por semillas y puede
   *  guardarse como grupo; si no, viaja como máscara exacta). */
  const pureComps = selSubs.length === 0 && selComps.every((c) => c.kind === 'comp')

  /** Aplica borrar/recolorear a TODA la selección en un solo paso del historial. Semillas
   *  cuando es pura (robusto a re-trazados); MÁSCARA exacta cuando hay marquesina o resta.
   *  La selección de clics NO se limpia: al llegar el resultado se re-floodean las mismas
   *  semillas ("probar dos colores en la misma letra" = recolorear dos veces). */
  async function applySelection(mode: 'erase' | 'recolor'): Promise<void> {
    if (!selComps.length || busy) return
    const to = mode === 'recolor' ? actionColor : undefined
    if (pureComps) {
      await runObjectEditPoints(selComps.map((c) => c.seed), mode, to)
      return
    }
    const raster = rasterRef.current
    if (!raster) return
    const eff = effectiveMask(raster.w, raster.h, selComps, selSubs)
    if (!eff) return
    clearTimeout(debounceRef.current)
    const bytes = await maskToPngBytes(raster.w, raster.h, eff.mask)
    const token = ++tokenRef.current
    setError(null)
    setProgress({ value: 0, message: mode === 'erase' ? 'Borrando la selección…' : 'Recoloreando la selección…' })
    const r = await window.api.vectorize.maskEdit(bytes, mode, to)
    if (token !== tokenRef.current) return
    setProgress(null)
    if (!r.ok) {
      setError(r.error ?? { code: 'E_AREA', message: 'No se pudo editar la selección' })
      return
    }
    if (r.bytes) {
      applyFillResult({ bytes: r.bytes })
      setZones((z) => z + 1)
      setUhist((h) => ({ undo: [...h.undo, { kind: 'fill', n: 1 }], redo: [] }))
    }
  }

  /** "Emparejar": la zona de la marquesina se funde a su color dominante (tapa suciedad).
   *  Disponible cuando la selección es UNA marquesina sin restas. */
  const canEmparejar = selComps.length === 1 && selComps[0].kind === 'marquee' && selSubs.length === 0

  async function onEmparejar(): Promise<void> {
    const rect = selComps[0]?.rect
    if (!rect || busy) return
    clearTimeout(debounceRef.current)
    const token = ++tokenRef.current
    setError(null)
    setProgress({ value: 0, message: 'Emparejando la zona…' })
    const r = await window.api.vectorize.areaFill(rect, 'fill')
    if (token !== tokenRef.current) return
    setProgress(null)
    if (!r.ok) {
      setError(r.error ?? { code: 'E_AREA', message: 'No se pudo emparejar la zona' })
      return
    }
    if (r.bytes) {
      applyFillResult({ bytes: r.bytes })
      setZones((z) => z + 1)
      setUhist((h) => ({ undo: [...h.undo, { kind: 'fill', n: 1 }], redo: [] }))
    }
  }

  /** Núcleo del modo OBJETO: N componentes conectados → sidecar → consolidar → historial. */
  async function runObjectEditPoints(
    points: Array<{ x: number; y: number }>,
    mode: 'erase' | 'recolor',
    to?: string
  ): Promise<boolean> {
    clearTimeout(debounceRef.current) // sin re-trazado en paralelo con la edición
    const token = ++tokenRef.current
    setError(null)
    const what = points.length === 1 ? 'el objeto' : `${points.length} objetos`
    setProgress({ value: 0, message: mode === 'erase' ? `Borrando ${what}…` : `Recoloreando ${what}…` })
    const r = await window.api.vectorize.objectEdit(points, mode, to)
    if (token !== tokenRef.current) return false
    setProgress(null)
    if (!r.ok) {
      setError(r.error ?? { code: 'E_AREA', message: 'No se pudo editar la selección' })
      return false
    }
    if (r.bytes) {
      applyFillResult({ bytes: r.bytes })
      setZones((z) => z + points.length)
      setUhist((h) => ({ undo: [...h.undo, { kind: 'fill', n: points.length }], redo: [] }))
    }
    return true
  }

  /** CLIC sobre el lienzo: SELECCIONA el objeto (componente conectado) y lo resalta.
   *  Shift+clic suma o quita; clic en vacío deselecciona. El clic nunca edita nada por sí
   *  solo (las acciones viven en la barra contextual). */
  function onPickPoint(p: CanvasPick): void {
    if (busy || !result || !canEditRaster) return
    const raster = rasterRef.current
    if (!raster) return
    if (!p.hex) {
      if (!p.additive) {
        setSelComps([])
        setSelSubs([])
      }
      return
    }
    const idx = hitComponent(selComps, raster.w, p.x, p.y)
    if (p.additive) {
      if (idx >= 0) {
        setSelComps((s) => s.filter((_, i) => i !== idx))
        return
      }
      const comp = floodComponent(raster, p.x, p.y)
      if (comp) setSelComps((s) => [...s, { ...comp, kind: 'comp' }])
      return
    }
    if (idx >= 0) return // ya estaba seleccionado: se mantiene
    const comp = floodComponent(raster, p.x, p.y)
    if (!comp) {
      setSelComps([])
      setSelSubs([])
      return
    }
    setSelComps([{ ...comp, kind: 'comp' }])
    setSelSubs([])
    // El recolor arranca del color real del objeto (después lo cambiás en el selector).
    setActionColor(comp.hex)
  }

  /** Guarda la selección actual como GRUPO con nombre (semillas normalizadas → main).
   *  Solo para selecciones de componentes puros: una marquesina o una resta no son
   *  reconstruibles por semillas tras un re-trazado. */
  function saveGroup(): void {
    const raster = rasterRef.current
    if (!raster || !selComps.length || !pureComps) return
    const g: VectorGroup = {
      id: `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
      name: `Grupo ${groups.length + 1}`,
      color: selComps[0].hex,
      seeds: selComps.map((c) => ({ px: c.seed.x / raster.w, py: c.seed.y / raster.h }))
    }
    const next = [...groups, g]
    setGroups(next)
    void window.api.vectorize.groupsSet(next)
    setSelComps([])
  }

  /** Recolorea TODO el grupo tocando su swatch (batch de N puntos, un paso del historial).
   *  Las semillas cuyos objetos ya no existen (los borraste) se saltean con aviso. */
  async function recolorGroup(g: VectorGroup, hex: string): Promise<void> {
    const raster = rasterRef.current
    if (!raster || busy) return
    const alive = g.seeds
      .map((s) => floodComponent(raster, s.px * raster.w, s.py * raster.h))
      .filter((c): c is Component => c !== null)
    if (!alive.length) {
      setError({ code: 'E_GROUP', message: `"${g.name}" ya no tiene objetos en el diseño (¿los borraste?)` })
      return
    }
    if (alive.length < g.seeds.length) {
      setLayerNote(`"${g.name}": ${alive.length} de ${g.seeds.length} objetos siguen en el diseño; recoloreo esos.`)
      clearTimeout(layerNoteTimer.current)
      layerNoteTimer.current = setTimeout(() => setLayerNote(null), 5000)
    }
    const ok = await runObjectEditPoints(alive.map((c) => c.seed), 'recolor', hex)
    if (!ok) return
    const next = groups.map((x) => (x.id === g.id ? { ...x, color: hex } : x))
    setGroups(next)
    void window.api.vectorize.groupsSet(next)
  }

  function renameGroup(id: string, name: string): void {
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, name } : g)))
  }

  function persistGroups(): void {
    void window.api.vectorize.groupsSet(groups)
  }

  function deleteGroup(id: string): void {
    const next = groups.filter((g) => g.id !== id)
    setGroups(next)
    hoverCacheRef.current.delete(id)
    if (groupHover === id) setGroupHover(null)
    void window.api.vectorize.groupsSet(next)
  }

  /** Quita TODAS las ediciones raster y re-vectoriza limpio (los grupos quedan: son
   *  selecciones guardadas, no ediciones). Es lo único sin vuelta atrás → confirma. */
  function clearZones(): void {
    if (!window.confirm(`¿Quitar las ${zones} ediciones de objetos/zonas? Esto no tiene deshacer.`)) return
    void window.api.vectorize.clearAreaFills()
    setZones(0)
    setUhist((h) => ({ undo: h.undo.filter((a) => a.kind !== 'fill'), redo: [] }))
    scheduleRun(config)
  }

  // ¿La selección incluye el FONDO (un componente gigante)? Aviso en la barra: clic+Supr
  // sobre el fondo es EL gesto del flujo sustractivo, pero que sea a sabiendas.
  const selHasBg = Boolean(
    rasterRef.current &&
      selComps.some((c) => c.area > 0.35 * (rasterRef.current as Raster).w * (rasterRef.current as Raster).h)
  )

  // La línea de ayuda contextual (UN solo lugar: la barra de estado del lienzo).
  const canvasHint = !result
    ? 'Vectoriza solo al cargar la imagen'
    : !canEditRaster
      ? 'Motor Premium: editá las capas en el panel · la edición de objetos/zonas es del motor Local'
      : selComps.length
        ? '⌥ + arrastrá RESTA una zona · shift suma · Supr borra · Escape deselecciona'
        : 'clic = objeto · arrastrá = zona por color · scroll/espacio = mover · pinch o ⌘ scroll = zoom'

  return (
    <div className="flex h-full flex-col">
      {/* Barra de acción: archivo · deshacer/rehacer GLOBAL · Mockup 3D · Exportar */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3">
        <p className="truncate text-sm text-muted-foreground">
          {source ? source.name : 'Arrastrá una imagen para vectorizar'}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            title="Deshacer la última acción (⌘Z)"
            disabled={!canUndoU || busy || !hasImage}
            onClick={() => void undoUnified()}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Undo2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Rehacer (⌘⇧Z)"
            disabled={!canRedoU || busy || !hasImage}
            onClick={() => void redoUnified()}
            className="mr-1 flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Redo2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={!result || busy}
            onClick={() => void onSendToMockup()}
            title="Ver el vector sobre un producto 3D"
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            Mockup 3D
          </button>
          <div className="relative">
            <button
              type="button"
              disabled={!result || busy}
              onClick={() => setExportOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Exportar
              <ChevronDown className="h-4 w-4" />
            </button>
            {exportOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-xl border border-border bg-background py-1 shadow-xl">
                  {(
                    [
                      { label: 'Guardar SVG', note: 'vector real', run: () => void onExportSvg() },
                      { label: 'PDF', note: 'imprenta / plotter', run: () => void onSaveVector('pdf') },
                      { label: 'EPS', note: 'imprenta / plotter', run: () => void onSaveVector('eps') },
                      { label: 'Guardar PNG', note: `${config.size}px`, run: () => void window.api.vectorize.savePng(`${baseName()}-vector.png`) },
                      { label: copied ? 'Copiado ✓' : 'Copiar PNG', note: 'al portapapeles', run: () => void onCopy() }
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => {
                        setExportOpen(false)
                        item.run()
                      }}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm transition hover:bg-muted"
                    >
                      <span className="font-medium">{item.label}</span>
                      <span className="text-xs text-muted-foreground">{item.note}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Progreso */}
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

      {/* Error (se ve como error, no como hint) */}
      {error && !busy && (
        <div className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-6 py-2 text-sm font-medium text-red-700 dark:text-red-300">
          {error.message}
        </div>
      )}

      {/* Fila principal: lienzo | panel */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 p-6">
          {source ? (
            <section
              className="relative flex min-w-0 flex-1 flex-col"
              onDragOver={(e) => {
                e.preventDefault()
                setOver(true)
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setOver(false)
                handleFiles(e.dataTransfer.files)
              }}
            >
              <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
                <h3 className="min-w-0 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Vector
                </h3>
                <div className="flex min-w-0 shrink items-center gap-3">
                  {!canEditRaster && (
                    <span className="text-[11px] text-muted-foreground">
                      {zones > 0 ? `${zones} ediciones en pausa · ` : ''}Objetos y zonas: motor Local
                    </span>
                  )}
                  {zones > 0 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={clearZones}
                      title="Quita TODAS las ediciones de objetos y zonas (⌘Z deshace de a una)"
                      className="text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
                    >
                      Quitar ediciones ({zones})
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    Cambiar imagen
                  </button>
                </div>
              </div>

              {/* Barra CONTEXTUAL de selección: aparece con objetos seleccionados; no tapa el arte. */}
              {selComps.length > 0 && !busy && (
                <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-sky-400/50 bg-sky-400/10 px-3 py-1.5">
                  <span className="flex items-center gap-1">
                    {selComps.slice(0, 4).map((c, i) => (
                      <span
                        key={i}
                        className="h-4 w-4 rounded border border-border"
                        style={{ backgroundColor: c.hex }}
                      />
                    ))}
                  </span>
                  <span className="text-xs font-medium">
                    {selComps.length === 1
                      ? selComps[0].kind === 'marquee'
                        ? 'zona (color dominante)'
                        : '1 objeto'
                      : `${selComps.length} piezas`}
                    {selSubs.length > 0 && (
                      <span className="ml-1 text-muted-foreground">− {selSubs.length} resta{selSubs.length > 1 ? 's' : ''}</span>
                    )}
                    {selHasBg && <span className="ml-1 font-semibold text-amber-600 dark:text-amber-400">· incluye el FONDO</span>}
                  </span>
                  <span className="mx-0.5 text-xs text-muted-foreground">→</span>
                  <label
                    className="relative h-6 w-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border"
                    title="Color nuevo"
                  >
                    <span className="absolute inset-0" style={{ backgroundColor: actionColor }} />
                    <input
                      type="color"
                      value={actionColor}
                      onChange={(e) => setActionColor(e.target.value)}
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void applySelection('recolor')}
                    className="rounded-md bg-foreground px-2.5 py-1 text-xs font-semibold text-background transition hover:opacity-90"
                  >
                    Recolorear
                  </button>
                  <button
                    type="button"
                    onClick={() => void applySelection('erase')}
                    title="También: tecla Supr"
                    className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
                  >
                    Borrar
                  </button>
                  {canEmparejar && (
                    <button
                      type="button"
                      onClick={() => void onEmparejar()}
                      title="Toda la zona del marco se funde a su color dominante (tapa suciedad y líneas de borde)"
                      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
                    >
                      Emparejar
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!pureComps}
                    onClick={saveGroup}
                    title={
                      pureComps
                        ? 'Guardá esta selección con nombre (Letras, Gorro…) para recolorearla toda junta cuando quieras'
                        : 'Los grupos se guardan desde selecciones de clics (las marquesinas y restas no sobreviven re-trazados)'
                    }
                    className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Guardar como grupo
                  </button>
                  <span className="ml-auto hidden text-[11px] text-muted-foreground lg:inline">
                    ⌥ + arrastrá = restar · shift suma · Escape deselecciona
                  </span>
                  <button
                    type="button"
                    title="Deseleccionar (Escape)"
                    onClick={() => {
                      setSelComps([])
                      setSelSubs([])
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              <div className="min-h-0 flex-1">
                <CompareView
                  before={source.url}
                  after={result?.url ?? null}
                  beforeLabel="Original"
                  afterLabel="Vector"
                  background={CHECKER}
                  busy={busy}
                  hint={canvasHint}
                  overlay={overlay}
                  onSelectRect={canEditRaster ? onMarquee : undefined}
                  onPickPoint={canEditRaster ? onPickPoint : undefined}
                />
              </div>
              {over && (
                <div className="pointer-events-none absolute inset-0 rounded-2xl border-2 border-dashed border-foreground/50 bg-background/40" />
              )}
            </section>
          ) : (
            <section className="flex min-w-0 flex-1 flex-col">
              <h3 className="mb-2 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Imagen original
              </h3>
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setOver(true)
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setOver(false)
                  handleFiles(e.dataTransfer.files)
                }}
                onClick={() => inputRef.current?.click()}
                className={cn(
                  'flex min-h-0 w-full flex-1 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed bg-muted/30 text-center transition',
                  over ? 'border-foreground/40 bg-muted' : 'border-border'
                )}
              >
                <Upload className="mb-3 h-9 w-9 text-muted-foreground" />
                <p className="text-base font-semibold">Arrastrá tu imagen aquí</p>
                <p className="mt-1 text-sm text-muted-foreground">JPG · PNG · WEBP</p>
              </div>
            </section>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT.join(',')}
            hidden
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        {/* Panel derecho */}
        <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-border p-6">
          <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Ajustes
          </h3>

          <label className="mb-1 block text-sm font-medium">Motor</label>
          <div className="mb-1 flex gap-2">
            {(['local', 'recraft'] as const).map((m) => (
              <button
                key={m}
                type="button"
                disabled={busy}
                onClick={() => set('method', m)}
                className={cn(
                  'flex-1 rounded-lg border px-2 py-2 text-sm font-medium transition disabled:opacity-40',
                  config.method === m
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {m === 'local' ? 'Local' : 'IA Premium'}
              </button>
            ))}
          </div>
          <p className="mb-5 text-xs text-muted-foreground">
            {config.method === 'recraft'
              ? 'Recraft (IA, ~$0.01/img). Requiere API key. Curvas muy limpias; la edición de objetos/zonas es del motor Local.'
              : 'Potrace por capas: gratis y privado. Bueno para la mayoría de los logos.'}
          </p>

          {config.method === 'local' && (
            <>
          {/* Flujo profesional: vectorizar el diseño COMPLETO (fondo incluido) y después
              quitar lo que sobre seleccionando objetos o con la herramienta de zona. El
              blanco queda como capa imprimible (DTF sobre prenda oscura). */}
          <label className="mb-1 flex items-center justify-between text-sm font-medium">
            <span>Conservar fondo</span>
            <input
              type="checkbox"
              disabled={busy}
              checked={Boolean(config.keepBackground)}
              onChange={(e) => set('keepBackground', e.target.checked)}
            />
          </label>
          <p className="mb-5 text-xs text-muted-foreground">
            {config.keepBackground
              ? 'Vectoriza TODO el diseño, fondo incluido (los blancos quedan como capa imprimible). Quitá lo que sobre clickeándolo y Borrar.'
              : 'El fondo liso del borde se quita solo. Activá esto si el fondo es parte del diseño.'}
          </p>

          <label className="mb-1 flex items-center justify-between text-sm font-medium">
            <span>Colores</span>
            <span className="text-muted-foreground">{config.colors}</span>
          </label>
          <input
            type="range"
            min={2}
            max={24}
            value={config.colors}
            disabled={busy}
            onChange={(e) => set('colors', Number(e.target.value))}
            className="w-full accent-primary"
          />
          <p className="mt-1 mb-5 text-xs text-muted-foreground">
            Más colores = más detalle. Logos planos suelen verse mejor con pocos.
          </p>

          <label className="mb-1 flex items-center justify-between text-sm font-medium">
            <span>Reducir ruido</span>
            <span className="text-muted-foreground">{config.denoise}</span>
          </label>
          <input
            type="range"
            min={0}
            max={100}
            value={config.denoise}
            disabled={busy}
            onChange={(e) => set('denoise', Number(e.target.value))}
            className="w-full accent-primary"
          />
          <p className="mt-1 mb-5 text-xs text-muted-foreground">
            Quita grano/textura del logo (lo suaviza antes de trazar). La paleta se re-detecta.
          </p>
            </>
          )}

          {/* Capas: local Y Premium (Recraft ahora también devuelve paleta agrupada). */}
          {palette.length > 0 && (
            <div className="mb-5">
              <div className="mb-2 flex items-center justify-between">
                <label className="text-sm font-medium">Capas · {palette.length}</label>
                <div className="flex items-center gap-1">
                  {anyHidden && (
                    <button
                      type="button"
                      title="Mostrar todas las capas"
                      disabled={busy}
                      onClick={showAll}
                      className="text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
                    >
                      Mostrar todas
                    </button>
                  )}
                  {config.edit && (
                    <button
                      type="button"
                      title="Vuelve la paleta al estado inicial"
                      disabled={busy}
                      onClick={() => commitEdit(undefined, null)}
                      className="ml-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
                    >
                      Restaurar
                    </button>
                  )}
                </div>
              </div>
              <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
                La capa cambia <span className="font-semibold">todos</span> los objetos de ese
                color — para uno solo, hacé <span className="font-semibold">clic sobre él</span> en el lienzo.
                Ojo = ocultar · ojo enmarcado = ver sola · flecha = exportar la capa (SVG).
              </p>
              <div className="space-y-1.5">
                {palette.map((c, i) => {
                  const e = config.edit?.[i]
                  const cur = e?.to ?? c
                  const hidden = Boolean(e?.remove)
                  const isolated = isIsolated(i)
                  return (
                    <div key={i} className={cn('flex items-center gap-1.5', hidden && 'opacity-45')}>
                      <button
                        type="button"
                        title={hidden ? 'Mostrar capa' : 'Ocultar capa'}
                        disabled={busy}
                        onClick={() => toggleLayer(i)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:text-foreground disabled:opacity-40"
                      >
                        {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                      <label
                        title="Recolorear TODOS los objetos de este color"
                        className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border"
                      >
                        <span className="block h-full w-full" style={{ backgroundColor: rgbToHex(cur) }} />
                        <input
                          type="color"
                          value={rgbToHex(cur)}
                          disabled={hidden || busy}
                          onChange={(ev) => editColor(i, { to: hexToRgb(ev.target.value) })}
                          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                        />
                      </label>
                      <span
                        className={cn(
                          'flex-1 truncate font-mono text-xs text-muted-foreground',
                          hidden && 'line-through'
                        )}
                      >
                        {rgbToHex(cur).toUpperCase()}
                      </span>
                      <button
                        type="button"
                        title={isolated ? 'Mostrar todas' : 'Ver sola esta capa'}
                        disabled={busy}
                        onClick={() => isolateLayer(i)}
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border transition hover:text-foreground disabled:opacity-40',
                          isolated ? 'border-foreground text-foreground' : 'text-muted-foreground'
                        )}
                      >
                        <ScanEye className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Exportar esta capa como SVG"
                        onClick={() => void exportLayer(i)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:text-foreground"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
              {layerNote && (
                <p className="mt-2 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
                  {layerNote}
                </p>
              )}
            </div>
          )}

          {/* Grupos con nombre: "Letras", "Gorro", "Barba"… (selecciones guardadas). */}
          {canEditRaster && groups.length > 0 && (
            <div className="mb-5" onMouseLeave={() => setGroupHover(null)}>
              <label className="mb-2 block text-sm font-medium">Grupos · {groups.length}</label>
              <div className="space-y-1.5">
                {groups.map((g) => (
                  <div
                    key={g.id}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md px-1 py-0.5 transition',
                      groupHover === g.id && 'bg-sky-400/10'
                    )}
                    onMouseEnter={() => setGroupHover(g.id)}
                  >
                    <label
                      title="Recolorear TODO el grupo"
                      className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border"
                    >
                      <span className="block h-full w-full" style={{ backgroundColor: g.color ?? '#888888' }} />
                      <input
                        type="color"
                        value={g.color ?? '#888888'}
                        disabled={busy}
                        onChange={(ev) => void recolorGroup(g, ev.target.value)}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      />
                    </label>
                    <input
                      type="text"
                      value={g.name}
                      onChange={(ev) => renameGroup(g.id, ev.target.value)}
                      onBlur={persistGroups}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur()
                      }}
                      className="w-0 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs font-medium outline-none transition focus:border-border"
                    />
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {g.seeds.length} obj
                    </span>
                    <button
                      type="button"
                      title="Eliminar el grupo (no toca el diseño)"
                      onClick={() => deleteGroup(g.id)}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:text-foreground"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                Tocá el swatch y se recolorea todo el grupo. Pasá el mouse para verlo en el
                lienzo. Para crear uno: seleccioná objetos (shift+clic) → «Guardar como grupo».
              </p>
            </div>
          )}

          <label className="mb-1 block text-sm font-medium">Tamaño de salida (PNG)</label>
          <div className="flex gap-2">
            {SIZES.map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() => set('size', s)}
                className={cn(
                  'flex-1 rounded-lg border px-2 py-2 text-sm font-medium transition disabled:opacity-40',
                  config.size === s
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {s}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            El SVG es vectorial: escala a cualquier tamaño sin perder nitidez.
          </p>

          {!hasImage && (
            <p className="mt-6 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              Subí una imagen y se vectoriza automáticamente. Ajustá los controles para reprocesar.
            </p>
          )}
        </aside>
      </div>
    </div>
  )
}
