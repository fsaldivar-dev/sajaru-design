import { useEffect, useState } from 'react'
import { ArrowDownToLine, ExternalLink, RefreshCw } from 'lucide-react'
import type { UpdateState } from '@shared/types'

/**
 * Pastilla de ACTUALIZACIONES (vive junto al saldo/tema en las barras superiores).
 * Invisible cuando no hay nada que decir; aparece sola cuando el main detecta versión nueva:
 *  - "Actualizando · N%"        → AppImage descargando en segundo plano (informativo).
 *  - "Reiniciar y actualizar"   → descarga lista: un clic instala y reabre.
 *  - "vX.Y.Z disponible ↗"      → instalación .pacman (o dev): abre la página del release.
 */
export function UpdatePill(): React.JSX.Element | null {
  const [st, setSt] = useState<UpdateState | null>(null)

  useEffect(() => {
    let dead = false
    void window.api.updates.get().then(
      (s) => {
        if (!dead) setSt(s)
      },
      () => undefined
    )
    const off = window.api.updates.onStatus((s) => setSt(s))
    return () => {
      dead = true
      off()
    }
  }, [])

  if (!st) return null

  if (st.state === 'downloading') {
    return (
      <span
        title={`Descargando la versión ${st.latest ?? ''} en segundo plano`}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-muted-foreground"
      >
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        Actualizando · {st.percent ?? 0}%
      </span>
    )
  }

  if (st.state === 'ready') {
    return (
      <button
        type="button"
        onClick={() => void window.api.updates.install()}
        title={`La versión ${st.latest ?? ''} ya se descargó — un clic para instalarla y reabrir`}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-foreground px-3 text-sm font-medium text-background transition hover:opacity-90"
      >
        <ArrowDownToLine className="h-3.5 w-3.5" />
        Reiniciar y actualizar
      </button>
    )
  }

  if (st.state === 'available-manual') {
    return (
      <button
        type="button"
        onClick={() => void window.api.updates.open()}
        title="Hay una versión nueva — abre la página de descarga en GitHub"
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-primary/50 px-3 text-sm font-medium text-primary transition hover:bg-primary/10"
      >
        v{st.latest} disponible
        <ExternalLink className="h-3.5 w-3.5" />
      </button>
    )
  }

  return null
}
