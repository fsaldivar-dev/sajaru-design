import { Search } from 'lucide-react'
import { APP } from '@renderer/config/app'
import mascot from '@renderer/assets/mascot.png'
import { CreditsBadge } from './CreditsBadge'
import { ThemeToggle } from './ThemeToggle'

interface Props {
  query: string
  onQuery: (value: string) => void
}

/** Barra superior: marca (mascota + nombre) + buscador + saldo + toggle de tema. */
export function Header({ query, onQuery }: Props): React.JSX.Element {
  return (
    <header className="flex items-center justify-between gap-4 px-6 pt-5">
      <div className="flex items-center gap-2.5">
        <img src={mascot} alt="" aria-hidden className="h-8 w-auto select-none" draggable={false} />
        <h1 className="text-lg font-semibold tracking-tight">{APP.name}</h1>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Buscar app, proyecto…"
            aria-label="Buscar app o proyecto"
            className="h-9 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/60"
          />
        </div>
        <CreditsBadge />
        <ThemeToggle />
      </div>
    </header>
  )
}
