import type { ComponentType } from 'react'
import { Grid2x2, Layers, Moon, Sun } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { CHECKER } from '@renderer/lib/image'
import type { ResultState } from './ResultPanel'
import type { EditorView } from './types'

interface ViewOpt {
  value: EditorView
  label: string
  icon: ComponentType<{ className?: string }>
}

const VIEWS: ViewOpt[] = [
  { value: 'checker', label: 'Cuadriculado', icon: Grid2x2 },
  { value: 'white', label: 'Blanco', icon: Sun },
  { value: 'black', label: 'Negro', icon: Moon },
  { value: 'mask', label: 'Máscara', icon: Layers }
]

/**
 * Panel "Capas" (derecha): control de la CAPA de fondo del lienzo (cuadriculado /
 * blanco / negro / máscara α) — antes vivía en la toolbar del canvas — + un thumbnail
 * del resultado. El fondo es una vista, no toca el RGBA real.
 */
export function LayersPanel({
  view,
  onView,
  result,
  disabled
}: {
  view: EditorView
  onView: (v: EditorView) => void
  result?: ResultState | null
  disabled?: boolean
}): React.JSX.Element {
  const showThumb = Boolean(result && result.format !== 'tiff')

  return (
    <section>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Vista</h3>

      {showThumb && (
        <div
          className="mb-3 flex h-28 items-center justify-center overflow-hidden rounded-xl border border-border"
          style={{ background: CHECKER }}
        >
          <img src={result!.url} alt="Resultado" className="h-full w-full object-contain" />
        </div>
      )}

      <p className="mb-2 text-xs text-muted-foreground">Fondo del lienzo</p>
      <div className={cn('grid grid-cols-2 gap-2', disabled && 'pointer-events-none opacity-40')}>
        {VIEWS.map((v) => (
          <button
            key={v.value}
            type="button"
            title={v.value === 'mask' ? 'Máscara (alfa B/N)' : v.label}
            onClick={() => onView(v.value)}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition',
              view === v.value
                ? 'border-foreground bg-foreground text-background'
                : 'border-border hover:border-foreground/30'
            )}
          >
            <v.icon className="h-4 w-4" />
            {v.label}
          </button>
        ))}
      </div>
    </section>
  )
}
