import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, RefreshCw, Sparkles } from 'lucide-react'
import { USD_PER_UNIT, USD_TO_MXN, refreshBalance, useCredits } from '@renderer/lib/premium'

const mxn = (units: number, dec = 2): string =>
  (units * USD_PER_UNIT * USD_TO_MXN).toLocaleString('es-MX', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec
  })
const usd = (units: number, dec = 2): string => (units * USD_PER_UNIT).toFixed(dec)

/**
 * Indicador de créditos de IA Premium (Recraft), siempre visible en la barra
 * superior (home + cada mini app). Pastilla compacta con el saldo; al abrir
 * muestra el detalle: saldo en USD/MXN y el gasto de la sesión (imágenes +
 * dinero). El saldo se lee al montar y tras cada operación premium.
 */
export function CreditsBadge({ className = '' }: { className?: string }): React.JSX.Element | null {
  const c = useCredits()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void refreshBalance()
  }, [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Sin key configurada: no mostramos nada (el usuario usa solo lo local/gratis).
  if (c.noKey) return null

  const credits = c.credits ?? 0
  const low = c.credits != null && c.credits < 200

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Saldo de IA Premium"
        className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-sm transition ${
          low
            ? 'border-amber-500/50 text-amber-500 hover:bg-amber-500/10'
            : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
      >
        <Sparkles className="h-4 w-4" />
        <span className="font-medium tabular-nums">
          {c.credits == null ? (c.loading ? '…' : '—') : credits.toLocaleString('es-MX')}
        </span>
        <span className="text-xs opacity-60">u</span>
        {low && <AlertTriangle className="h-3.5 w-3.5" />}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-50 w-64 rounded-xl border border-border bg-card p-3 text-sm shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-semibold">
              <Sparkles className="h-4 w-4 text-foreground/70" /> IA Premium
            </span>
            <button
              type="button"
              onClick={() => void refreshBalance()}
              title="Actualizar saldo"
              className="text-muted-foreground transition hover:text-foreground"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${c.loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="rounded-lg bg-muted/50 p-2 tabular-nums">
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Saldo</span>
              <span className="text-base font-semibold">{credits.toLocaleString('es-MX')} u</span>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>≈ US${usd(credits)}</span>
              <span>${mxn(credits, 0)} MXN</span>
            </div>
          </div>

          <div className="mt-2 px-0.5 tabular-nums">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Esta sesión
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Imágenes tratadas</span>
              <span className="font-medium">{c.sessionCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Gastado</span>
              <span className="font-medium">${mxn(c.sessionUnits)} MXN</span>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>≈ US${usd(c.sessionUnits, 3)}</span>
              <span>{c.sessionUnits} u</span>
            </div>
          </div>

          {low && <p className="mt-2 text-xs text-amber-500">Saldo bajo — recargá en recraft.ai.</p>}
          {c.error && <p className="mt-2 text-xs text-red-500">{c.error}</p>}
        </div>
      )}
    </div>
  )
}
