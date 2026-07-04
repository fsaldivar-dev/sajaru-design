import { useEffect, useRef, useState } from 'react'
import { Download, Eraser, Eye, EyeOff, Redo2, ScanEye, Undo2, Upload, X } from 'lucide-react'
import type { PaletteEdit, RgbColor, VectorAreaMode, VectorizeConfig } from '@shared/types'
import { cn } from '@renderer/lib/cn'
import { CompareView } from '@renderer/components/CompareView'
import { useRevokeOnUnmount } from '@renderer/lib/useRevokeOnUnmount'
import { useShell } from '@renderer/lib/shell'
import { OP_COST, recordUsage } from '@renderer/lib/premium'

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

/**
 * Mini app "Vectorizar": traza un logo/imagen a vector (Potrace + separación
 * de capas de color del sidecar) y permite exportarlo como SVG (vector real) o PNG en
 * alta resolución. Reactiva: re-vectoriza al cambiar los settings.
 */
export default function Vectorizar(): React.JSX.Element {
  const [config, setConfig] = useState<VectorizeConfig>(DEFAULT_CONFIG)
  const [palette, setPalette] = useState<RgbColor[]>([])
  // Historial de ediciones de paleta (para deshacer/rehacer). cur = posición actual.
  const [hist, setHist] = useState<{ stack: Array<PaletteEdit[] | undefined>; cur: number }>({
    stack: [undefined],
    cur: 0
  })
  const coalesceRef = useRef<string | null>(null)
  const [source, setSource] = useState<SourceImage | null>(null)
  const [result, setResult] = useState<{ url: string } | null>(null)
  const [progress, setProgress] = useState<{ value: number; message?: string } | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [over, setOver] = useState(false)
  // Herramienta de ZONA: modo selección de rectángulo + contador de ediciones (para "Deshacer").
  // areaMode: qué hace el rect — fundir al predominante, borrar (→ transparente) o recolorear.
  const [selecting, setSelecting] = useState(false)
  const [zones, setZones] = useState(0)
  const [areaMode, setAreaMode] = useState<VectorAreaMode>('fill')
  const [areaColor, setAreaColor] = useState('#8b5a2b')
  // Popover de OBJETO: clic simple sobre el vector (modo normal) → recolorear/borrar SOLO ese
  // objeto (componente conectado), no todo el color. x/y en px de la imagen; vx/vy en px del
  // viewport (posición del popover); hex = color clickeado.
  const [objPick, setObjPick] = useState<{
    x: number
    y: number
    vx: number
    vy: number
    hex: string | null
  } | null>(null)

  const tokenRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const resultUrlRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const hasImage = Boolean(source)
  const busy = progress !== null
  const { consumeTransfer, openApp } = useShell()
  useRevokeOnUnmount(source?.url, result?.url)

  useEffect(() => {
    return window.api.vectorize.onProgress((ev) => {
      setProgress({ value: ev.progress, message: ev.message })
    })
  }, [])

  // El popover de objeto queda obsoleto si arranca un proceso, cambia el resultado (sus
  // coordenadas ya no corresponden) o se entra/sale del modo zona.
  useEffect(() => {
    if (busy) setObjPick(null)
  }, [busy])
  useEffect(() => {
    setObjPick(null)
  }, [result, selecting])

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
    if (r.ok && cfg.method === 'recraft') recordUsage(OP_COST.vectorize)
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
    setSelecting(false)
    resetHistory()
    const fresh = { ...config, edit: undefined }
    setConfig(fresh)
    await window.api.vectorize.setImage(ab, file.name)
    void run(fresh)
  }

  // Re-vectoriza (debounced) con una config dada. ÚNICO disparador del re-trazado: la
  // llaman set() (settings) y applyEdit (paleta/capas). Un solo camino con debounce
  // compartido → nunca dos runs pisándose. (El viejo efecto [config] duplicaba el disparo
  // junto a applyEdit → carrera de tokens que descartaba el setResult y dejaba el preview
  // sin actualizar al aislar/ocultar/recolorear.)
  function scheduleRun(cfg: VectorizeConfig): void {
    if (!source) return
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void run(cfg), 400)
  }

  // Limpia el debounce pendiente al desmontar.
  useEffect(() => () => clearTimeout(debounceRef.current), [])

  // Atajos: ⌘Z deshacer · ⌘⇧Z rehacer (edición de paleta).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!source) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hist, source])

  function handleFiles(files: FileList | null): void {
    const f = files?.[0]
    if (f && ACCEPT.includes(f.type)) void onFile(f)
  }

  // Cambiar colores/tamaño/método RE-DETECTA la paleta (descarta ediciones e historial).
  function set<K extends keyof VectorizeConfig>(key: K, value: VectorizeConfig[K]): void {
    const next = { ...config, [key]: value, edit: undefined }
    setConfig(next)
    resetHistory()
    scheduleRun(next)
  }

  function applyEdit(edit: PaletteEdit[] | undefined): void {
    const next = { ...config, edit }
    setConfig(next)
    scheduleRun(next)
  }

  function resetHistory(): void {
    setHist({ stack: [undefined], cur: 0 })
    coalesceRef.current = null
  }

  /** Aplica una edición y la registra en el historial. `coalesce` fusiona con el paso previo
   *  si la clave coincide (p.ej. arrastrar el selector del mismo color = un solo paso). */
  function commitEdit(next: PaletteEdit[] | undefined, coalesce: string | null): void {
    setHist((h) => {
      if (coalesce && coalesce === coalesceRef.current) {
        const stack = h.stack.slice(0, h.cur + 1)
        stack[h.cur] = next
        return { stack, cur: h.cur }
      }
      return { stack: [...h.stack.slice(0, h.cur + 1), next], cur: h.cur + 1 }
    })
    coalesceRef.current = coalesce
    applyEdit(next)
  }

  function undo(): void {
    if (hist.cur <= 0) return
    coalesceRef.current = null
    const i = hist.cur - 1
    setHist({ ...hist, cur: i })
    applyEdit(hist.stack[i])
  }

  function redo(): void {
    if (hist.cur >= hist.stack.length - 1) return
    coalesceRef.current = null
    const i = hist.cur + 1
    setHist({ ...hist, cur: i })
    applyEdit(hist.stack[i])
  }

  const canUndo = hist.cur > 0
  const canRedo = hist.cur < hist.stack.length - 1

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

  /** Aislar (solo): muestra únicamente la capa i. Si ya está aislada, muestra todas. */
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
   * sobre el color vigente (`cur`), no el original de la paleta.
   */
  function exportLayer(i: number): void {
    const c = palette[i]
    if (!c) return
    const cur = config.edit?.[i]?.to ?? c
    void window.api.vectorize.saveLayerSvg(rgbToHex(cur), `${baseName()}-capa-${i + 1}.svg`)
  }

  /** Exporta el vector completo a PDF (vectorial) o EPS (Ghostscript). Surface del error
   *  si falta gs para EPS. */
  async function onSaveVector(format: 'pdf' | 'eps'): Promise<void> {
    if (!result) return
    const r = await window.api.vectorize.saveVector(format, `${baseName()}.${format}`)
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

  /** Herramienta de ZONA: aplica el modo activo (fundir/borrar/recolorear) al rectángulo
   *  elegido (raster). La edición queda guardada en el main y se re-aplica si re-vectorizás
   *  (tocar capas/settings no la borra). */
  async function onSelectRect(rect: { x: number; y: number; w: number; h: number }): Promise<void> {
    const token = ++tokenRef.current
    setError(null)
    const msg =
      areaMode === 'fill' ? 'Fundiendo zona…' : areaMode === 'erase' ? 'Borrando zona…' : 'Recoloreando zona…'
    setProgress({ value: 0, message: msg })
    const r = await window.api.vectorize.areaFill(
      rect,
      areaMode,
      areaMode === 'recolor' ? areaColor : undefined
    )
    if (token !== tokenRef.current) return
    setProgress(null)
    if (!r.ok) {
      setError(r.error ?? { code: 'E_AREA', message: 'Falló la limpieza de zona' })
      return
    }
    if (r.bytes) {
      const url = URL.createObjectURL(new Blob([r.bytes], { type: 'image/png' }))
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current)
      resultUrlRef.current = url
      setResult({ url })
      setZones((z) => z + 1)
    }
  }

  /** Modo OBJETO: borra/recolorea el COMPONENTE CONECTADO del color clickeado — sin tocar
   *  otros objetos del mismo color (estilo varita de Illustrator). */
  async function runObjectEdit(
    point: { x: number; y: number },
    mode: 'erase' | 'recolor',
    to?: string
  ): Promise<void> {
    setObjPick(null)
    const token = ++tokenRef.current
    setError(null)
    setProgress({ value: 0, message: mode === 'erase' ? 'Borrando objeto…' : 'Recoloreando objeto…' })
    const r = await window.api.vectorize.objectEdit(point, mode, mode === 'recolor' ? to : undefined)
    if (token !== tokenRef.current) return
    setProgress(null)
    if (!r.ok) {
      setError(r.error ?? { code: 'E_AREA', message: 'Falló la edición del objeto' })
      return
    }
    if (r.bytes) {
      const url = URL.createObjectURL(new Blob([r.bytes], { type: 'image/png' }))
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current)
      resultUrlRef.current = url
      setResult({ url })
      setZones((z) => z + 1)
    }
  }

  /** CLICK sobre el resultado. En modo normal abre el popover de OBJETO (elegís recolorear o
   *  borrar ahí mismo); dentro de "Editar zona" aplica directo el modo activo. */
  function onPickPoint(p: { x: number; y: number; vx: number; vy: number; hex: string | null }): void {
    if (busy || !result) return
    if (selecting) {
      if (areaMode === 'fill') return // fundir necesita una zona; el click no aplica
      void runObjectEdit(p, areaMode, areaMode === 'recolor' ? areaColor : undefined)
      return
    }
    setObjPick(p)
  }

  /** Deshace TODAS las limpiezas de zona y re-vectoriza limpio. */
  function clearZones(): void {
    void window.api.vectorize.clearAreaFills()
    setZones(0)
    setSelecting(false)
    scheduleRun(config)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Barra de acción */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3">
        <p className="truncate text-sm text-muted-foreground">
          {source ? source.name : 'Arrastrá una imagen para vectorizar'}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={!result || busy}
            onClick={() => void onSendToMockup()}
            title="Ver el vector sobre un producto 3D"
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            Mockup 3D
          </button>
          <button
            type="button"
            disabled={!result || busy}
            onClick={() => void onCopy()}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copied ? 'Copiado ✓' : 'Copiar PNG'}
          </button>
          <button
            type="button"
            disabled={!result || busy}
            onClick={() => void (result && window.api.vectorize.savePng(`${baseName()}-vector.png`))}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            Guardar PNG
          </button>
          <button
            type="button"
            disabled={!result || busy}
            onClick={() => void (result && window.api.vectorize.saveSvg(`${baseName()}.svg`))}
            title="Vector real, escalable a cualquier tamaño"
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Guardar SVG
          </button>
          <button
            type="button"
            disabled={!result || busy}
            onClick={() => void onSaveVector('pdf')}
            title="PDF vectorial — imprenta / plotter"
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            PDF
          </button>
          <button
            type="button"
            disabled={!result || busy}
            onClick={() => void onSaveVector('eps')}
            title="EPS vectorial — imprenta / plotter"
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            EPS
          </button>
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

      {/* Error */}
      {error && !busy && (
        <div className="shrink-0 border-b border-border bg-muted px-6 py-2 text-sm text-muted-foreground">
          {error.message}
        </div>
      )}

      {/* Fila principal: original | resultado | config */}
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
                <h3 className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {selecting
                    ? areaMode === 'fill'
                      ? 'Arrastrá un rectángulo → se funde al color predominante'
                      : areaMode === 'erase'
                        ? 'CLIC en un objeto lo borra · arrastrá una zona → borra su color predominante'
                        : 'CLIC en un objeto lo recolorea · arrastrá una zona → recolorea su predominante'
                    : 'Vector · CLIC en un objeto = recolorear/borrar SOLO ese objeto · rueda = zoom'}
                </h3>
                <div className="flex shrink-0 items-center gap-3">
                  {selecting && (
                    <div className="flex items-center gap-1">
                      {(
                        [
                          { m: 'fill' as const, label: 'Fundir' },
                          { m: 'erase' as const, label: 'Borrar' },
                          { m: 'recolor' as const, label: 'Recolorear' }
                        ]
                      ).map(({ m, label }) => (
                        <button
                          key={m}
                          type="button"
                          disabled={busy}
                          onClick={() => setAreaMode(m)}
                          className={cn(
                            'rounded-md border px-2 py-0.5 text-[11px] font-medium transition disabled:opacity-40',
                            areaMode === m
                              ? 'border-foreground bg-foreground text-background'
                              : 'border-border text-muted-foreground hover:text-foreground'
                          )}
                        >
                          {label}
                        </button>
                      ))}
                      {areaMode === 'recolor' && (
                        <label
                          className="relative ml-1 h-5 w-7 shrink-0 cursor-pointer overflow-hidden rounded border border-border"
                          title="Color destino del recoloreado"
                        >
                          <span className="absolute inset-0" style={{ backgroundColor: areaColor }} />
                          <input
                            type="color"
                            value={areaColor}
                            onChange={(e) => setAreaColor(e.target.value)}
                            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                          />
                        </label>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    disabled={!result || busy}
                    onClick={() => setSelecting((s) => !s)}
                    title="Editá zonas del resultado: fundir al color predominante, borrarlo (transparente) o recolorearlo"
                    className={cn(
                      'flex items-center gap-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40',
                      selecting ? 'text-sky-500' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Eraser className="h-3.5 w-3.5" />
                    {selecting ? 'Listo' : 'Editar zona'}
                  </button>
                  {zones > 0 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={clearZones}
                      className="text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
                    >
                      Deshacer zonas ({zones})
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
              <div className="relative min-h-0 flex-1">
                <CompareView
                  before={source.url}
                  after={result?.url ?? null}
                  beforeLabel="Original"
                  afterLabel="Vector"
                  background={CHECKER}
                  selecting={selecting && !busy}
                  onSelectRect={(rect) => void onSelectRect(rect)}
                  onPickPoint={onPickPoint}
                />
                {/* Popover de OBJETO: aparece pegado al clic. Muestra el color detectado y
                    edita SOLO ese componente conectado (no todo el color, como las capas). */}
                {objPick && !busy && (
                  <div
                    className="absolute z-40 flex items-center gap-1.5 rounded-xl border border-border bg-background/95 p-1.5 shadow-xl backdrop-blur"
                    style={{
                      left: Math.max(150, objPick.vx),
                      top: objPick.vy > 64 ? objPick.vy - 54 : objPick.vy + 14,
                      transform: 'translateX(-50%)'
                    }}
                  >
                    <span className="flex items-center gap-1.5 pl-1 text-[11px] font-medium text-muted-foreground">
                      <span
                        className="h-4 w-4 shrink-0 rounded border border-border"
                        style={{ backgroundColor: objPick.hex ?? 'transparent' }}
                      />
                      Solo este objeto
                    </span>
                    <label
                      className="relative ml-0.5 h-6 w-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border"
                      title="Color nuevo del objeto"
                    >
                      <span className="absolute inset-0" style={{ backgroundColor: areaColor }} />
                      <input
                        type="color"
                        value={areaColor}
                        onChange={(e) => setAreaColor(e.target.value)}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void runObjectEdit(objPick, 'recolor', areaColor)}
                      className="rounded-md bg-foreground px-2 py-1 text-[11px] font-semibold text-background transition hover:opacity-90"
                    >
                      Recolorear
                    </button>
                    <button
                      type="button"
                      onClick={() => void runObjectEdit(objPick, 'erase')}
                      className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
                    >
                      Borrar
                    </button>
                    <button
                      type="button"
                      title="Cancelar"
                      onClick={() => setObjPick(null)}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
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
                <p className="text-base font-semibold">Arrastra tu imagen aquí</p>
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

        {/* Config */}
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
              ? 'Recraft (IA, ~$0.01/img). Requiere API key. Suele dar curvas muy limpias.'
              : 'Potrace por capas: gratis y privado. Bueno para la mayoría de los logos.'}
          </p>

          {config.method === 'local' && (
            <>
          {/* Flujo profesional: vectorizar el diseño COMPLETO (fondo incluido) y después
              quitar lo que sobre con "Editar zona → Borrar". El blanco queda como capa
              imprimible (DTF sobre prenda oscura). */}
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
              ? 'Vectoriza TODO el diseño, fondo incluido (los blancos quedan como capa imprimible). Quitá lo que sobre con “Editar zona → Borrar”.'
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
                  <button
                    type="button"
                    title="Deshacer (⌘Z)"
                    disabled={!canUndo}
                    onClick={undo}
                    className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Rehacer (⌘⇧Z)"
                    disabled={!canRedo}
                    onClick={redo}
                    className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <Redo2 className="h-3.5 w-3.5" />
                  </button>
                  {anyHidden && (
                    <button
                      type="button"
                      title="Mostrar todas las capas"
                      onClick={showAll}
                      className="ml-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      Mostrar todas
                    </button>
                  )}
                  {config.edit && (
                    <button
                      type="button"
                      onClick={() => commitEdit(undefined, null)}
                      className="ml-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      Restaurar
                    </button>
                  )}
                </div>
              </div>
              <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
                La capa cambia <span className="font-semibold">todos</span> los objetos de ese
                color. Para uno solo (una letra, el gorro…), hacé <span className="font-semibold">clic sobre él</span> en el lienzo.
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
                        onClick={() => toggleLayer(i)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:text-foreground"
                      >
                        {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                      <label
                        title="Recolorear capa"
                        className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border"
                      >
                        <span className="block h-full w-full" style={{ backgroundColor: rgbToHex(cur) }} />
                        <input
                          type="color"
                          value={rgbToHex(cur)}
                          disabled={hidden}
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
                        title={isolated ? 'Mostrar todas' : 'Aislar (ver solo esta)'}
                        onClick={() => isolateLayer(i)}
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border transition hover:text-foreground',
                          isolated ? 'border-foreground text-foreground' : 'text-muted-foreground'
                        )}
                      >
                        <ScanEye className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Exportar esta capa como SVG"
                        onClick={() => exportLayer(i)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:text-foreground"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Ojo = ver/ocultar · lupa = ver solo esa · tocá el color para recolorear ·
                descarga = exportar esa capa (SVG).
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
              Subí una imagen y se vectoriza automáticamente. Ajustá los settings para reprocesar.
            </p>
          )}
        </aside>
      </div>
    </div>
  )
}
