import { Layers, Maximize2, PenTool, Printer, Scissors, Shirt, SlidersHorizontal, Sparkles, Wand2, type LucideIcon } from 'lucide-react'
import type { MiniAppEntry } from '@renderer/miniapps/types'
import { cn } from '@renderer/lib/cn'

/** Icono por capacidad (uses[0]) → da identidad visual a cada herramienta. */
const ICONS: Record<string, LucideIcon> = {
  generate: Sparkles,
  batch: Layers,
  'remove-background': Scissors,
  vectorize: PenTool,
  upscale: Maximize2,
  mockup: Shirt,
  'print-prep': Printer,
  editor: SlidersHorizontal
}

interface Props {
  entry: MiniAppEntry
  onOpen: (entry: MiniAppEntry) => void
}

/** Tile de una herramienta dentro de una categoría. */
export function MiniAppCard({ entry, onOpen }: Props): React.JSX.Element {
  const { manifest } = entry
  const comingSoon = manifest.status === 'coming-soon'
  const Icon = ICONS[manifest.uses?.[0] ?? ''] ?? Wand2

  return (
    <button
      type="button"
      disabled={comingSoon}
      onClick={() => onOpen(entry)}
      title={manifest.description ?? manifest.name}
      className={cn(
        'group flex h-28 flex-col justify-between rounded-xl border border-border bg-card p-4 text-left transition duration-150',
        comingSoon
          ? 'cursor-not-allowed opacity-50'
          : 'hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30'
      )}
    >
      <span
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground transition duration-150',
          !comingSoon && 'group-hover:bg-foreground group-hover:text-background'
        )}
      >
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </span>

      <span>
        <span className="block text-sm font-medium leading-tight">{manifest.name}</span>
        {comingSoon && <span className="mt-0.5 block text-xs text-muted-foreground">Próximamente</span>}
      </span>
    </button>
  )
}
