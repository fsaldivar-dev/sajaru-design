import { AlertTriangle, BrushCleaning, Check, Crop, Droplet, Eraser, Feather, Grid2x2, Loader2, Minus, MousePointerClick, Plus, RotateCcw, Shapes, Sparkles, Undo2, Waves, X, Zap } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { BrushParams, EditorMode, Hair, Levels, SamEverythingState, SamMode, SamPrecision, SamSessionInfo, SelectBrushOp } from './types'

/** Mismo look que el `toolBtn` original del ResultPanel. */
function toolBtn(active: boolean): string {
  return cn(
    'flex h-7 w-7 items-center justify-center rounded-md border transition',
    active
      ? 'border-foreground bg-foreground text-background'
      : 'border-border text-muted-foreground hover:text-foreground'
  )
}

/** Slider de pincel reutilizable (tamaño / dureza / flujo). */
function BrushSlider({
  label,
  icon,
  min,
  max,
  value,
  onChange
}: {
  label: string
  icon?: React.ReactNode
  min: number
  max: number
  value: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1" title={label}>
      {icon ?? <span className="text-xs text-muted-foreground">{label}</span>}
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-20 accent-primary"
        aria-label={label}
      />
    </span>
  )
}

/**
 * Barra de opciones de herramienta (arriba del canvas). Muestra los controles del
 * modo activo (pincel / tolerancia / zoom / selección), el refinado de borde y
 * undo/reset. No tiene lógica de canvas: solo edita `brush` (levantado) y dispara
 * acciones.
 */
export function ToolOptionsBar({
  mode,
  brush,
  onBrush,
  selectOp,
  onSelectOp,
  onUndo,
  onReset,
  onFeather,
  onCleanOutside,
  levels,
  onLevels,
  onLevelsReset,
  hair,
  onHair,
  onHairApply,
  onTrim,
  onZoomIn,
  onZoomOut,
  samBusy,
  samHint,
  samSession,
  samPrecision,
  onSamPrecision,
  onSamCycle,
  onSamApply,
  onSamDiscard,
  samMode,
  onSamMode,
  samEverything,
  onSamAnalyzeAll,
  onSamEverythingApply,
  onSamEverythingClear,
  onSamEverythingRemoveCandidates,
  onSamEverythingDismissCandidates,
  disabled
}: {
  mode: EditorMode
  brush: BrushParams
  onBrush: <K extends keyof BrushParams>(key: K, value: BrushParams[K]) => void
  /** Selección: dirección del pincel (Sumar (+) / Quitar (−)). */
  selectOp: SelectBrushOp
  onSelectOp: (op: SelectBrushOp) => void
  onUndo: () => void
  onReset: () => void
  onFeather: () => void
  /** Selección: borra la basura semi-transparente que quedó FUERA del sujeto. */
  onCleanOutside: () => void
  /** Niveles (#2 Pulir): valores friendly del ajuste del alfa (limpiar/reforzar/medios). */
  levels: Levels
  /** Niveles (#2 Pulir): cambia un valor (el padre dispara el preview en vivo). */
  onLevels: <K extends keyof Levels>(key: K, value: Levels[K]) => void
  /** Niveles (#2 Pulir): restablece a identidad (revierte el preview). */
  onLevelsReset: () => void
  /** Recuperar pelo (#1 Pulir): valores de canal/contraste/invertir/ver-máscara. */
  hair: Hair
  /** Recuperar pelo (#1 Pulir): cambia un valor (el padre dispara el preview). */
  onHair: <K extends keyof Hair>(key: K, value: Hair[K]) => void
  /** Recuperar pelo (#1 Pulir): suma el pelo recuperado al recorte. */
  onHairApply: () => void
  /** Recorta el recorte a su contenido (saca el margen transparente alrededor del sujeto). */
  onTrim: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  /** Selección inteligente (SAM): hay un encode/decode en curso. */
  samBusy?: boolean
  /** Selección inteligente (SAM): estado/hint a mostrar (ej. "Preparando…"). */
  samHint?: string | null
  /** Selección inteligente (SAM): sesión interactiva activa (preview) o null. */
  samSession?: SamSessionInfo | null
  /** Selección inteligente (SAM): precisión del encoder (Rápido/Preciso). */
  samPrecision?: SamPrecision
  /** Selección inteligente (SAM): cambia la precisión (re-encodea con el modelo elegido). */
  onSamPrecision?: (p: SamPrecision) => void
  /** Selección inteligente (SAM): cicla a la siguiente forma candidata. */
  onSamCycle?: () => void
  /** Selección inteligente (SAM): hornea el preview al alfa (según Quitar/Sumar). */
  onSamApply?: () => void
  /** Selección inteligente (SAM): descarta la sesión (sin tocar el alfa). */
  onSamDiscard?: () => void
  /** Selección inteligente (SAM): sub-modo Click/box ('prompt') vs "Analizar todo" ('everything'). */
  samMode?: SamMode
  /** Selección inteligente (SAM): cambia el sub-modo. */
  onSamMode?: (m: SamMode) => void
  /** Selección inteligente (SAM): estado del "Analizar todo" (analizando / listo / acumuladas). */
  samEverything?: SamEverythingState | null
  /** Selección inteligente (SAM): dispara el análisis de toda la imagen (sam-everything). */
  onSamAnalyzeAll?: () => void
  /** Selección inteligente (SAM): aplica las regiones acumuladas (Shift+click) al alfa. */
  onSamEverythingApply?: () => void
  /** Selección inteligente (SAM): limpia las regiones acumuladas sin tocar el alfa. */
  onSamEverythingClear?: () => void
  /** "Analizar todo": QUITA del recorte los "restos de fondo" detectados (banner [Quitar]). */
  onSamEverythingRemoveCandidates?: () => void
  /** "Analizar todo": descarta los "restos de fondo" detectados (banner [Descartar]). */
  onSamEverythingDismissCandidates?: () => void
  disabled?: boolean
}): React.JSX.Element {
  const isBrush = mode === 'borrar' || mode === 'restaurar'

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-b border-border px-4 py-2',
        disabled && 'pointer-events-none opacity-40'
      )}
    >
      <span className="text-xs font-medium capitalize text-muted-foreground">
        {mode === 'mover'
          ? 'Mover / Zoom'
          : mode === 'borrar'
            ? 'Borrador'
            : mode === 'restaurar'
              ? 'Restaurar'
              : mode === 'seleccion'
                ? 'Selección'
                : mode === 'sam'
                  ? 'Selección inteligente'
                  : mode === 'niveles'
                    ? 'Niveles del recorte'
                    : mode === 'pelo'
                      ? 'Recuperar pelo'
                      : 'Varita'}
      </span>
      <span className="h-5 w-px bg-border" />

      {isBrush && (
        <>
          <BrushSlider label="Tamaño" min={8} max={90} value={brush.size} onChange={(v) => onBrush('size', v)} />
          <BrushSlider
            label="Dureza del pincel (borde duro ↔ pluma suave)"
            icon={<Droplet className="h-3.5 w-3.5 text-muted-foreground" />}
            min={0}
            max={100}
            value={brush.hardness}
            onChange={(v) => onBrush('hardness', v)}
          />
          <BrushSlider
            label="Flujo (opacidad por pasada)"
            icon={<Waves className="h-3.5 w-3.5 text-muted-foreground" />}
            min={0}
            max={100}
            value={brush.flow}
            onChange={(v) => onBrush('flow', v)}
          />
        </>
      )}

      {mode === 'color' && (
        <>
          <span className="flex items-center gap-1" title="Tolerancia de color (qué tan distinto puede ser el color y aún borrarse)">
            <span className="text-xs text-muted-foreground">Tolerancia</span>
            <input
              type="range"
              min={10}
              max={255}
              value={brush.colorTol}
              onChange={(e) => onBrush('colorTol', Number(e.target.value))}
              className="w-24 accent-primary"
              aria-label="Tolerancia de color"
            />
          </span>
          <button
            type="button"
            title="Contiguo = borra solo el color conectado al click. Todo el color = borra ese color en TODA la imagen (ideal para pisos/fondos partidos en parches)."
            className={cn(
              'rounded-md border px-2 py-1 text-xs transition',
              brush.colorGlobal
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground hover:text-foreground'
            )}
            onClick={() => onBrush('colorGlobal', !brush.colorGlobal)}
          >
            {brush.colorGlobal ? 'Todo el color' : 'Contiguo'}
          </button>
        </>
      )}

      {mode === 'niveles' && (
        <>
          <BrushSlider label="Limpiar halo" min={0} max={100} value={levels.limpiar} onChange={(v) => onLevels('limpiar', v)} />
          <BrushSlider label="Reforzar borde" min={0} max={100} value={levels.reforzar} onChange={(v) => onLevels('reforzar', v)} />
          <BrushSlider label="Medios (gamma)" min={-100} max={100} value={levels.medios} onChange={(v) => onLevels('medios', v)} />
          <button type="button" title="Restablecer niveles" className={toolBtn(false)} onClick={onLevelsReset}>
            <RotateCcw className="h-4 w-4" />
          </button>
        </>
      )}

      {mode === 'pelo' && (
        <>
          <span className="flex items-center gap-1" title="Canal del original (Auto = el de más contraste pelo↔fondo)">
            <span className="text-xs text-muted-foreground">Canal</span>
            <select
              value={hair.channel}
              onChange={(e) => onHair('channel', e.target.value as Hair['channel'])}
              className="h-7 rounded-md border border-border bg-transparent px-1 text-xs text-foreground"
              aria-label="Canal"
            >
              <option value="auto">Auto</option>
              <option value="r">R</option>
              <option value="g">G</option>
              <option value="b">B</option>
            </select>
          </span>
          <BrushSlider label="Contraste" min={0} max={100} value={hair.contrast} onChange={(v) => onHair('contrast', v)} />
          <button
            type="button"
            title="Invertir (pelo oscuro sobre fondo claro ↔ claro sobre oscuro)"
            className={cn(
              'rounded-md border px-2 py-1 text-xs transition',
              hair.invert ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'
            )}
            onClick={() => onHair('invert', !hair.invert)}
          >
            Invertir
          </button>
          <button
            type="button"
            title="Ver la máscara B/N para afinarla (pelo blanco / fondo negro)"
            className={cn(
              'rounded-md border px-2 py-1 text-xs transition',
              hair.showMask ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'
            )}
            onClick={() => onHair('showMask', !hair.showMask)}
          >
            Ver máscara
          </button>
          <button
            type="button"
            title="Sumar el pelo recuperado al recorte"
            className="rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background transition hover:opacity-90"
            onClick={onHairApply}
          >
            Sumar pelo
          </button>
        </>
      )}

      {mode === 'mover' && (
        <>
          <button type="button" title="Alejar" className={toolBtn(false)} onClick={onZoomOut}>
            <Minus className="h-4 w-4" />
          </button>
          <button type="button" title="Acercar" className={toolBtn(false)} onClick={onZoomIn}>
            <Plus className="h-4 w-4" />
          </button>
        </>
      )}

      {mode === 'seleccion' && (
        <>
          {/* Toggle Sumar (+) / Quitar (−): el pincel edita el alfa; el borde
              marching-ants se regenera al soltar para mostrar el límite exacto. */}
          <div className="flex items-center overflow-hidden rounded-md border border-border" role="group" aria-label="Dirección del pincel">
            <button
              type="button"
              title="Sumar a la selección (pintar de vuelta lo borrado)"
              aria-pressed={selectOp === 'add'}
              className={cn(
                'flex h-7 items-center gap-1 px-2 text-xs transition',
                selectOp === 'add'
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onSelectOp('add')}
            >
              <Plus className="h-3.5 w-3.5" />
              Sumar
            </button>
            <span className="h-7 w-px bg-border" />
            <button
              type="button"
              title="Quitar de la selección (borrar)"
              aria-pressed={selectOp === 'subtract'}
              className={cn(
                'flex h-7 items-center gap-1 px-2 text-xs transition',
                selectOp === 'subtract'
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onSelectOp('subtract')}
            >
              <Minus className="h-3.5 w-3.5" />
              Quitar
            </button>
          </div>
          <span className="h-5 w-px bg-border" />
          <BrushSlider label="Tamaño" min={8} max={90} value={brush.size} onChange={(v) => onBrush('size', v)} />
          <BrushSlider
            label="Dureza del pincel (borde duro ↔ pluma suave)"
            icon={<Droplet className="h-3.5 w-3.5 text-muted-foreground" />}
            min={0}
            max={100}
            value={brush.hardness}
            onChange={(v) => onBrush('hardness', v)}
          />
          <BrushSlider
            label="Flujo (opacidad por pasada)"
            icon={<Waves className="h-3.5 w-3.5 text-muted-foreground" />}
            min={0}
            max={100}
            value={brush.flow}
            onChange={(v) => onBrush('flow', v)}
          />
          <span className="h-5 w-px bg-border" />
          {/* Limpiar afuera: borra la basura semi-transparente (hebras de fondo tenues)
              que quedó FUERA del sujeto, conservando el borde suave. Undoable. Se corre
              solo al entrar a Selección; este botón la vuelve a disparar a mano. */}
          <button
            type="button"
            title="Limpiar afuera: borra los píxeles tenues de basura fuera del sujeto (conserva el borde suave)"
            className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition hover:text-foreground"
            onClick={onCleanOutside}
          >
            <BrushCleaning className="h-3.5 w-3.5" />
            Limpiar afuera
          </button>
        </>
      )}

      {mode === 'sam' && (
        <>
          {/* Sub-modo: Click/box (SAM decode de siempre) vs "Analizar todo" (sam-everything:
              segmenta TODA la imagen; hover resalta la región, click la aplica). */}
          <div className="flex items-center overflow-hidden rounded-md border border-border" role="group" aria-label="Modo de selección IA">
            <button
              type="button"
              title="Click / recuadro: SAM detecta el objeto bajo el click (Rápido/Preciso)."
              aria-pressed={samMode !== 'everything'}
              className={cn(
                'flex h-7 items-center gap-1 px-2 text-xs transition',
                samMode !== 'everything' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onSamMode?.('prompt')}
            >
              <MousePointerClick className="h-3.5 w-3.5" />
              Click / recuadro
            </button>
            <span className="h-7 w-px bg-border" />
            <button
              type="button"
              title="Analizar todo: segmenta toda la imagen en regiones; pasá el mouse para resaltar y clickeá para elegir (ideal para franjas finas)."
              aria-pressed={samMode === 'everything'}
              className={cn(
                'flex h-7 items-center gap-1 px-2 text-xs transition',
                samMode === 'everything' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onSamMode?.('everything')}
            >
              <Grid2x2 className="h-3.5 w-3.5" />
              Analizar todo
            </button>
          </div>
          <span className="h-5 w-px bg-border" />

          {/* Toggle Rápido / Preciso: solo en Click/recuadro (elige el encoder de SAM).
              Rápido = MobileSAM (ágil); Preciso = SAM ViT-B (recorta targets finos). */}
          {samMode !== 'everything' && (
            <>
              <div className="flex items-center overflow-hidden rounded-md border border-border" role="group" aria-label="Precisión de la selección IA">
                <button
                  type="button"
                  title="Rápido (MobileSAM): selección IA ágil (~3s). Ideal para objetos grandes/definidos."
                  aria-pressed={samPrecision !== 'precise'}
                  className={cn(
                    'flex h-7 items-center gap-1 px-2 text-xs transition',
                    samPrecision !== 'precise' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => onSamPrecision?.('fast')}
                >
                  <Zap className="h-3.5 w-3.5" />
                  Rápido
                </button>
                <span className="h-7 w-px bg-border" />
                <button
                  type="button"
                  title="Preciso (SAM ViT-B): recorta targets finos sin sobre-recortar. El encode es más lento (~8-15s en CPU)."
                  aria-pressed={samPrecision === 'precise'}
                  className={cn(
                    'flex h-7 items-center gap-1 px-2 text-xs transition',
                    samPrecision === 'precise' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => onSamPrecision?.('precise')}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Preciso
                </button>
              </div>
              <span className="h-5 w-px bg-border" />
            </>
          )}

          {/* Toggle Sumar (+) / Quitar (−): define qué hace APLICAR sobre la selección
              (preview de SAM o región de "Analizar todo"). Quitar la borra (alfa=0) del
              recorte; Sumar la revela desde la imagen original. Compartido por ambos sub-modos. */}
          <div className="flex items-center overflow-hidden rounded-md border border-border" role="group" aria-label="Qué hace Aplicar">
            <button
              type="button"
              title="Al Aplicar: revelar la selección (pinta desde la imagen original)"
              aria-pressed={selectOp === 'add'}
              className={cn(
                'flex h-7 items-center gap-1 px-2 text-xs transition',
                selectOp === 'add' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onSelectOp('add')}
            >
              <Plus className="h-3.5 w-3.5" />
              Sumar
            </button>
            <span className="h-7 w-px bg-border" />
            <button
              type="button"
              title="Al Aplicar: borrar la selección del recorte (alfa = 0)"
              aria-pressed={selectOp === 'subtract'}
              className={cn(
                'flex h-7 items-center gap-1 px-2 text-xs transition',
                selectOp === 'subtract' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onSelectOp('subtract')}
            >
              <Minus className="h-3.5 w-3.5" />
              Quitar
            </button>
          </div>
          <span className="h-5 w-px bg-border" />

          {/* ── "Analizar todo" (sam-everything) ─────────────────────────────────── */}
          {samMode === 'everything' ? (
            samBusy || samEverything?.analyzing ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {samHint ?? 'Analizando toda la imagen… (~1 min)'}
              </span>
            ) : samEverything?.ready ? (
              <>
                {/* DETECCIÓN AUTOMÁTICA: banner de "restos de fondo" (objetos de fondo que el
                    quitado dejó pegados, resaltados en ÁMBAR sobre el lienzo). Sugerencia, el
                    usuario confirma: [Quitar] borra los candidatos del recorte; [Descartar]
                    solo limpia el resaltado. No rompe el hover/click manual. */}
                {(samEverything.candidates ?? 0) > 0 && (
                  <div className="flex items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-xs font-medium" title="Objetos de fondo que el quitado dejó pegados entre/dentro de los sujetos, resaltados en ámbar.">
                      {`Detecté ${samEverything.candidates} resto${samEverything.candidates === 1 ? '' : 's'} de fondo`}
                    </span>
                    <button
                      type="button"
                      title="Quitar del recorte los restos de fondo detectados (alfa = 0)"
                      className="flex h-6 items-center gap-1 rounded bg-amber-600 px-2 text-xs font-medium text-white transition hover:bg-amber-700"
                      onClick={onSamEverythingRemoveCandidates}
                    >
                      <Eraser className="h-3.5 w-3.5" />
                      Quitar
                    </button>
                    <button
                      type="button"
                      title="Descartar la sugerencia (no toca la imagen)"
                      className="flex h-6 items-center gap-1 rounded border border-amber-500/50 px-2 text-xs transition hover:bg-amber-500/15"
                      onClick={onSamEverythingDismissCandidates}
                    >
                      <X className="h-3.5 w-3.5" />
                      Descartar
                    </button>
                  </div>
                )}
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Pasá el mouse para resaltar una región · Click la aplica · Shift+click suma varias">
                  <Sparkles className="h-3.5 w-3.5" />
                  {samEverything.pinned > 0
                    ? `${samEverything.pinned} región${samEverything.pinned === 1 ? '' : 'es'} lista${samEverything.pinned === 1 ? '' : 's'} — Aplicá`
                    : `${samEverything.count} regiones — pasá el mouse y clickeá`}
                </span>
                {samEverything.pinned > 0 && (
                  <>
                    <button
                      type="button"
                      title={selectOp === 'subtract' ? 'Aplicar: borrar las regiones del recorte (alfa = 0)' : 'Aplicar: revelar las regiones desde la imagen original'}
                      className="flex h-7 items-center gap-1 rounded-md bg-foreground px-2.5 text-xs font-medium text-background transition hover:opacity-90"
                      onClick={onSamEverythingApply}
                    >
                      <Check className="h-3.5 w-3.5" />
                      Aplicar
                    </button>
                    <button
                      type="button"
                      title="Limpiar las regiones acumuladas (no toca la imagen)"
                      className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition hover:text-foreground"
                      onClick={onSamEverythingClear}
                    >
                      <X className="h-3.5 w-3.5" />
                      Limpiar
                    </button>
                  </>
                )}
                <button
                  type="button"
                  title="Volver a analizar toda la imagen"
                  className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition hover:text-foreground"
                  onClick={onSamAnalyzeAll}
                >
                  <Grid2x2 className="h-3.5 w-3.5" />
                  Re-analizar
                </button>
              </>
            ) : (
              <button
                type="button"
                title="Analizar toda la imagen (~1 min): la segmenta en regiones para elegir con el mouse"
                className="flex h-7 items-center gap-1 rounded-md bg-foreground px-2.5 text-xs font-medium text-background transition hover:opacity-90"
                onClick={onSamAnalyzeAll}
              >
                <Grid2x2 className="h-3.5 w-3.5" />
                Analizar todo
              </button>
            )
          ) : /* ── Click / recuadro: sesión interactiva de SAM (preview) ───────────── */
          samSession ? (
            <>
              {samBusy ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {samHint ?? 'Refinando…'}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Click = incluir (+) · Alt o click-derecho = excluir (−)">
                  <Sparkles className="h-3.5 w-3.5" />
                  {`Vista previa · +${samSession.includes} −${samSession.excludes} · IoU ${samSession.iou.toFixed(2)}`}
                </span>
              )}
              {samSession.candidates > 1 && (
                <button
                  type="button"
                  title="Probar otra forma candidata de SAM (para clicks ambiguos)"
                  className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition hover:text-foreground"
                  onClick={onSamCycle}
                >
                  <Shapes className="h-3.5 w-3.5" />
                  {`Otra forma ${samSession.chosen + 1}/${samSession.candidates}`}
                </button>
              )}
              <button
                type="button"
                title={selectOp === 'subtract' ? 'Aplicar: borrar la selección del recorte (alfa = 0)' : 'Aplicar: revelar la selección desde la imagen original'}
                className="flex h-7 items-center gap-1 rounded-md bg-foreground px-2.5 text-xs font-medium text-background transition hover:opacity-90"
                onClick={onSamApply}
              >
                <Check className="h-3.5 w-3.5" />
                Aplicar
              </button>
              <button
                type="button"
                title="Descartar la selección (no toca la imagen)"
                className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition hover:text-foreground"
                onClick={onSamDiscard}
              >
                <X className="h-3.5 w-3.5" />
                Descartar
              </button>
            </>
          ) : samBusy ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {samHint ?? 'Procesando…'}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" />
              {samHint ?? 'Clickeá un objeto (o arrastrá un recuadro)'}
            </span>
          )}
        </>
      )}

      <span className="ml-auto flex items-center gap-2">
        <button
          type="button"
          title="Recortar a contenido: saca el margen transparente alrededor del sujeto (ajusta la imagen al recorte)"
          className={toolBtn(false)}
          onClick={onTrim}
        >
          <Crop className="h-4 w-4" />
        </button>
        <span className="h-5 w-px bg-border" />
        <span className="flex items-center gap-1" title="Suavizar borde: desenfoca solo el alfa (radio en px)">
          <Feather className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="range"
            min={0}
            max={3}
            value={brush.feather}
            onChange={(e) => onBrush('feather', Number(e.target.value))}
            className="w-16 accent-primary"
            aria-label="Radio de suavizado de borde"
          />
          <button type="button" title="Suavizar borde (aplicar)" className={toolBtn(false)} onClick={onFeather}>
            <Feather className="h-4 w-4" />
          </button>
        </span>
        <span className="h-5 w-px bg-border" />
        <button type="button" title="Deshacer (Ctrl/Cmd+Z)" className={toolBtn(false)} onClick={onUndo}>
          <Undo2 className="h-4 w-4" />
        </button>
        <button type="button" title="Restaurar todo" className={toolBtn(false)} onClick={onReset}>
          <RotateCcw className="h-4 w-4" />
        </button>
      </span>
    </div>
  )
}
