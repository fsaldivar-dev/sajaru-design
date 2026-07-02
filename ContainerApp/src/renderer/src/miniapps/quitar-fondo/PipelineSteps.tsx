import type { ComponentType } from 'react'
import {
  Check,
  Circle,
  Crop,
  Eraser,
  FileDown,
  Loader2,
  Minus,
  Palette,
  ScanSearch,
  SlidersHorizontal
} from 'lucide-react'
import type { BgStepStatus } from '@shared/types'
import { cn } from '@renderer/lib/cn'
import type { Config } from './types'

interface Step {
  /** id del paso del pipeline (debe coincidir con el reporte del sidecar). */
  key: string
  icon: ComponentType<{ className?: string }>
  title: string
  sub: (c: Config) => string
  /** Texto cuando el paso corrió pero NO aplicó (no-op). */
  subOff?: (c: Config) => string
  /** Mostrar el paso solo si esta condición se cumple (ej. enhance opcional). */
  when?: (c: Config) => boolean
}

// En orden REAL de ejecución del pipeline (analyze es interno y no se muestra).
const STEPS: Step[] = [
  {
    key: 'remove-bg',
    icon: Eraser,
    title: 'Quitar fondo',
    sub: (c) =>
      c.bgProvider === 'recraft'
        ? 'Recraft IA Premium'
        : c.imageType === 'logo'
          ? 'por color (fondo plano)'
          : c.imageType === 'auto'
            ? 'auto: IA o color'
            : `IA · ${c.model}`
  },
  { key: 'clean-halo', icon: SlidersHorizontal, title: 'Limpiar halo', sub: () => 'umbral de alfa', subOff: () => 'sin halo que limpiar' },
  { key: 'fix-color', icon: Palette, title: 'Modo color', sub: () => 'CMYK → RGB', subOff: () => 'ya era RGB' },
  {
    key: 'auto-crop',
    icon: Crop,
    title: 'Recortar a contenido',
    sub: () => 'bbox del recorte',
    subOff: () => 'sin márgenes que recortar',
    when: (c) => c.autoCrop
  },
  { key: 'fix-dpi', icon: ScanSearch, title: 'Verificar DPI', sub: () => 'mínimo 300' },
  { key: 'export', icon: FileDown, title: 'Exportar', sub: (c) => `${c.format.toUpperCase()} 300 DPI` }
]

/**
 * Resumen del pipeline con estado REAL (no decorativo): pendiente (○) sin
 * resultado, procesando (spinner), hecho (✓) si el paso hizo trabajo, y no-aplicó
 * (–) si corrió sin cambios (ej. la imagen ya era RGB).
 */
export function PipelineSteps({
  config,
  steps,
  busy
}: {
  config: Config
  steps: BgStepStatus[] | null
  busy: boolean
}) {
  const visible = STEPS.filter((s) => !s.when || s.when(config))
  return (
    <section className="mb-6">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Pipeline de procesado
      </h3>
      <div className="grid grid-cols-1 gap-2">
        {visible.map((s) => {
          const st = steps?.find((x) => x.step === s.key)
          const ranNoop = Boolean(st) && !st!.active
          const pending = !steps && !busy
          return (
            <div
              key={s.key}
              className={cn(
                'flex items-center gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3 transition',
                (pending || ranNoop) && 'opacity-55'
              )}
            >
              <s.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{s.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {ranNoop ? (s.subOff?.(config) ?? 'sin cambios') : s.sub(config)}
                </p>
              </div>
              {busy ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground/70" />
              ) : !steps ? (
                <Circle className="h-4 w-4 shrink-0 text-muted-foreground/30" />
              ) : ranNoop ? (
                <Minus className="h-4 w-4 shrink-0 text-muted-foreground/40" />
              ) : (
                <Check className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
