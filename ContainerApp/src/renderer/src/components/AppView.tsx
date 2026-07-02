import { useMemo } from 'react'
import { groupByCategory, miniApps } from '@renderer/miniapps/registry'
import type { MiniAppEntry } from '@renderer/miniapps/types'
import { CategorySection } from './CategorySection'
import { EmptyState } from './EmptyState'

interface Props {
  query: string
  onOpen: (entry: MiniAppEntry) => void
}

/** Tab "App": grilla de herramientas agrupadas por categoría, filtrable por búsqueda. */
export function AppView({ query, onOpen }: Props): React.JSX.Element {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return miniApps
    return miniApps.filter((app) =>
      `${app.manifest.name} ${app.manifest.category}`.toLowerCase().includes(q)
    )
  }, [query])

  if (filtered.length === 0) {
    return (
      <EmptyState
        title="Sin resultados"
        message={`No encontramos herramientas para “${query}”.`}
      />
    )
  }

  const groups = [...groupByCategory(filtered).entries()]

  return (
    <div>
      {groups.map(([category, entries]) => (
        <CategorySection key={category} title={category} entries={entries} onOpen={onOpen} />
      ))}
    </div>
  )
}
