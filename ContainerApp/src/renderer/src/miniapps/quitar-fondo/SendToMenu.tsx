import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Send } from 'lucide-react'
import { cn } from '@renderer/lib/cn'

/** Un destino del menú "Enviar a" (id de la mini app del registro + etiqueta). */
export interface SendTarget {
  id: string
  label: string
}

interface Props {
  disabled?: boolean
  targets: SendTarget[]
  /** Se llama con el id de la mini app destino elegida. */
  onPick: (appId: string) => void
}

/**
 * Botón "Enviar a" con menú desplegable: pasa el resultado actual a otra mini app.
 * Look consistente con los demás botones de la barra de acción (borde + hover muted).
 */
export function SendToMenu({ disabled, targets, onPick }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Cierra al click fuera o con Escape.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Si se deshabilita (ej. se pierde el resultado) cerramos el menú.
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Enviar el resultado a otra herramienta"
        className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Send className="h-4 w-4" strokeWidth={1.75} />
        Enviar a
        <ChevronDown className={cn('h-4 w-4 transition', open && 'rotate-180')} strokeWidth={1.75} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-[200px] overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg"
        >
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onPick(t.id)
              }}
              className="block w-full px-3 py-2 text-left text-sm transition hover:bg-muted"
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
