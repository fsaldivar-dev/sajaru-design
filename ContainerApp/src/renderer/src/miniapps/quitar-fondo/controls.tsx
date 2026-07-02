import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'

interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  columns = 2
}: {
  value: T
  onChange: (v: T) => void
  options: SegmentedOption<T>[]
  columns?: number
}) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition',
            value === o.value
              ? 'border-foreground bg-foreground text-background'
              : 'border-border hover:border-foreground/30'
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-6 w-10 rounded-full transition-colors',
          checked ? 'bg-foreground' : 'bg-muted-foreground/30'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-5 w-5 rounded-full bg-background transition-all',
            checked ? 'left-[1.125rem]' : 'left-0.5'
          )}
        />
      </button>
    </div>
  )
}

export function Slider({
  value,
  onChange,
  label,
  min = 0,
  max = 100
}: {
  value: number
  onChange: (v: number) => void
  label: string
  min?: number
  max?: number
}) {
  return (
    <div className="py-1">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="text-sm tabular-nums">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
    </div>
  )
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</span>
  )
}
