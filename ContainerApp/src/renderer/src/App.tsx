import { useState } from 'react'
import { Header } from './components/Header'
import { TabBar, type TabKey } from './components/TabBar'
import { AppView } from './components/AppView'
import { ProjectsView } from './components/ProjectsView'
import { MiniAppHost } from './components/MiniAppHost'
import { ShellProvider, useShell } from './lib/shell'

/**
 * Shell del container. Solo se ocupa de mostrar y enrutar mini apps:
 * nombre + búsqueda + tabs + grilla. Las mini apps llegan después y se
 * registran en `miniapps/registry.ts`. La navegación (qué app está abierta y
 * el "Enviar a → X" entre apps) la maneja `ShellProvider`/`useShell`.
 */
function Shell(): React.JSX.Element {
  const [tab, setTab] = useState<TabKey>('app')
  const [query, setQuery] = useState('')
  const { openEntry, openMiniApp, closeApp } = useShell()

  if (openEntry) {
    return (
      <div className="flex h-full flex-col bg-background text-foreground">
        {/* Línea de acento de marca (teal→rosa), la firma del splash. */}
        <div className="brand-gradient h-[3px] shrink-0" aria-hidden />
        <MiniAppHost entry={openEntry} onBack={closeApp} />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Línea de acento de marca (teal→rosa), la firma del splash. */}
      <div className="brand-gradient h-[3px] shrink-0" aria-hidden />
      <Header query={query} onQuery={setQuery} />
      <TabBar value={tab} onChange={setTab} />
      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {tab === 'app' ? <AppView query={query} onOpen={openMiniApp} /> : <ProjectsView />}
      </main>
    </div>
  )
}

export default function App(): React.JSX.Element {
  return (
    <ShellProvider>
      <Shell />
    </ShellProvider>
  )
}
