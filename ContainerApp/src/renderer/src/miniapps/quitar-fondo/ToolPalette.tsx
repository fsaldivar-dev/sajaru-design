import type { ComponentType } from 'react'
import { Eraser, Hand, Lasso, Paintbrush, SlidersHorizontal, Wand2, Wind } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { EditorMode } from './types'

/** Mismo look que el `toolBtn` original del ResultPanel (activo = invertido). */
function toolBtn(active: boolean): string {
  return cn(
    'flex h-9 w-9 items-center justify-center rounded-md border transition',
    active
      ? 'border-foreground bg-foreground text-background'
      : 'border-border text-muted-foreground hover:text-foreground'
  )
}

interface Tool {
  mode: EditorMode
  icon: ComponentType<{ className?: string }>
  title: string
}

// Mover y Refinar comparten el modo 'mover' (Refinar suaviza el borde con la acción de
// la barra de opciones; no es un modo de dibujo). Borrar/Restaurar/Varita pintan máscara.
const TOOLS: Tool[] = [
  { mode: 'mover', icon: Hand, title: 'Mover / Zoom' },
  { mode: 'borrar', icon: Eraser, title: 'Borrador' },
  { mode: 'restaurar', icon: Paintbrush, title: 'Restaurar (pintar de vuelta lo borrado)' },
  { mode: 'color', icon: Wand2, title: 'Varita (borrar color)' }
]

/**
 * Paleta de herramientas vertical (izquierda), estilo Affinity. Setea `mode` en el
 * estado levantado a QuitarFondo. Refinar comparte 'mover' (su acción vive arriba);
 * Selección (Select & Mask) muestra el borde exacto del alfa y lo refina con pincel +/−.
 */
export function ToolPalette({
  mode,
  onMode,
  disabled
}: {
  mode: EditorMode
  onMode: (m: EditorMode) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border py-3">
      {TOOLS.map((t) => (
        <button
          key={t.mode}
          type="button"
          title={t.title}
          disabled={disabled}
          className={cn(toolBtn(mode === t.mode), disabled && 'cursor-not-allowed opacity-40')}
          onClick={() => onMode(t.mode)}
        >
          <t.icon className="h-4 w-4" />
        </button>
      ))}

      <span className="my-1 h-px w-6 bg-border" />

      {/* Selección (Select & Mask): muestra el borde EXACTO del alfa con marching-ants
          y lo refina con pincel Sumar (+) / Quitar (−); el borde se actualiza al soltar. */}
      <button
        type="button"
        title="Selección — refiná el recorte con pincel +/− (el borde sigue la máscara)"
        disabled={disabled}
        className={cn(toolBtn(mode === 'seleccion'), disabled && 'cursor-not-allowed opacity-40')}
        onClick={() => onMode('seleccion')}
      >
        <Lasso className="h-4 w-4" />
      </button>

      <span className="my-1 h-px w-6 bg-border" />

      {/* Pulir → Niveles del recorte (#2): ajusta el ALFA como Niveles de Photoshop (limpiar
          halo / reforzar / medios) con preview en vivo. Sus controles viven en la barra de arriba. */}
      <button
        type="button"
        title="Niveles del recorte — limpiar halo / reforzar borde (Pulir)"
        disabled={disabled}
        className={cn(toolBtn(mode === 'niveles'), disabled && 'cursor-not-allowed opacity-40')}
        onClick={() => onMode('niveles')}
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>

      {/* Pulir → Recuperar pelo (#1): técnica de canales/contraste para recuperar hebras finas. */}
      <button
        type="button"
        title="Recuperar pelo — técnica de canales/contraste (Pulir)"
        disabled={disabled}
        className={cn(toolBtn(mode === 'pelo'), disabled && 'cursor-not-allowed opacity-40')}
        onClick={() => onMode('pelo')}
      >
        <Wind className="h-4 w-4" />
      </button>
    </div>
  )
}
