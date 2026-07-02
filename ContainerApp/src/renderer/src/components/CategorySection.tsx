import type { MiniAppEntry } from '@renderer/miniapps/types'
import { MiniAppCard } from './MiniAppCard'

interface Props {
  title: string
  entries: MiniAppEntry[]
  onOpen: (entry: MiniAppEntry) => void
}

/** Una sección de la grilla: título de categoría + sus herramientas. */
export function CategorySection({ title, entries, onOpen }: Props): React.JSX.Element {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{title}</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {entries.map((entry) => (
          <MiniAppCard key={entry.manifest.id} entry={entry} onOpen={onOpen} />
        ))}
      </div>
    </section>
  )
}
