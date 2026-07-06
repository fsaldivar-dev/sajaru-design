import { Suspense, lazy, useMemo } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import type { MiniAppEntry } from '@renderer/miniapps/types'
import mascot from '@renderer/assets/mascot.png'
import { CreditsBadge } from './CreditsBadge'
import { ThemeToggle } from './ThemeToggle'
import { UpdatePill } from './UpdatePill'

/** Monta la UI de una mini app a pantalla completa, con botón Volver al grid. */
export function MiniAppHost({ entry, onBack }: { entry: MiniAppEntry; onBack: () => void }) {
  const Comp = useMemo(() => (entry.load ? lazy(entry.load) : null), [entry])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Volver
        </button>
        <img src={mascot} alt="" aria-hidden className="h-6 w-auto select-none" draggable={false} />
        <span className="text-sm font-medium">{entry.manifest.name}</span>
        <span className="ml-auto" />
        <UpdatePill />
        <CreditsBadge />
        <ThemeToggle />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          }
        >
          {Comp ? <Comp key={entry.manifest.id} /> : null}
        </Suspense>
      </div>
    </div>
  )
}
