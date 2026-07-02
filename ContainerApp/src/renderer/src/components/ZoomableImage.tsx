import { useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'

const MIN = 1
const MAX = 8
const clamp = (n: number): number => Math.min(MAX, Math.max(MIN, n))

/** Imagen con zoom (rueda + botones) y pan (arrastrar cuando hay zoom). */
export function ZoomableImage({
  src,
  alt,
  background
}: {
  src: string
  alt: string
  background: string
}) {
  const [scale, setScale] = useState(1)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  const reset = (): void => {
    setScale(1)
    setOff({ x: 0, y: 0 })
  }
  const zoom = (factor: number): void =>
    setScale((s) => {
      const n = clamp(s * factor)
      if (n === 1) setOff({ x: 0, y: 0 })
      return n
    })

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-2xl border border-border"
      style={{ background }}
      onWheel={(e) => zoom(e.deltaY < 0 ? 1.15 : 0.87)}
      onPointerDown={(e) => {
        if (scale === 1) return
        drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        setOff({
          x: drag.current.ox + (e.clientX - drag.current.x),
          y: drag.current.oy + (e.clientY - drag.current.y)
        })
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerLeave={() => {
        drag.current = null
      }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="h-full w-full select-none object-contain"
        style={{
          transform: `translate(${off.x}px, ${off.y}px) scale(${scale})`,
          cursor: scale > 1 ? 'grab' : 'default'
        }}
      />
      <div className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded-lg border border-border bg-background/80 p-0.5 backdrop-blur">
        <button
          type="button"
          aria-label="Alejar"
          onClick={() => zoom(0.8)}
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={reset}
          className="w-12 text-center text-xs tabular-nums text-muted-foreground hover:text-foreground"
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          aria-label="Acercar"
          onClick={() => zoom(1.25)}
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
