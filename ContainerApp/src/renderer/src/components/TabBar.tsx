import { cn } from '@renderer/lib/cn'

export type TabKey = 'app' | 'proyectos'

interface Props {
  value: TabKey
  onChange: (tab: TabKey) => void
}

const TABS: { key: TabKey; label: string }[] = [
  { key: 'app', label: 'App' },
  { key: 'proyectos', label: 'Proyectos' }
]

/** Tabs para alternar entre las herramientas (App) y los proyectos guardados. */
export function TabBar({ value, onChange }: Props): React.JSX.Element {
  return (
    <div className="border-b border-border px-6">
      <nav className="flex gap-1">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition',
              value === tab.key
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  )
}
