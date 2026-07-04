import { useEffect, useRef, useState } from 'react'
import { Eye, Minus, Plus } from 'lucide-react'

const MIN = 1
const MAX = 12
const clamp = (n: number): number => Math.min(MAX, Math.max(MIN, n))

/**
 * Vista de resultado con zoom/pan y "mantené para ver el original". Un SOLO <canvas> que
 * dibuja UNA imagen (el resultado por defecto, o el original mientras mantenés el botón).
 * Se dibuja con un único drawImage: dibujar dos imágenes (o usar ctx.clip/clipPath) dejaba
 * el resultado sin componer en este entorno y el vector no aparecía.
 */
export function CompareView({
  before,
  after,
  beforeLabel = 'Original',
  afterLabel = 'Resultado',
  background,
  selecting = false,
  onSelectRect,
  onPickPoint
}: {
  before: string
  after?: string | null
  beforeLabel?: string
  afterLabel?: string
  background: string
  /** Modo "seleccionar zona": el arrastre dibuja un rectángulo en vez de hacer pan. */
  selecting?: boolean
  /** Rectángulo elegido, en píxeles de la imagen `after` (no del canvas). */
  onSelectRect?: (rect: { x: number; y: number; w: number; h: number }) => void
  /** CLICK (sin arrastre) sobre un píxel OPACO del resultado — en modo selección Y en modo
   *  normal. `x/y` en píxeles de la imagen `after` (para el modo OBJETO del sidecar),
   *  `vx/vy` en px del viewport (para posicionar un popover) y `hex` el color clickeado. */
  onPickPoint?: (point: { x: number; y: number; vx: number; vy: number; hex: string | null }) => void
}) {
  const [scale, setScale] = useState(1)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [showBefore, setShowBefore] = useState(false)
  const [sel, setSel] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [ver, setVer] = useState(0)
  const viewRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const beforeImg = useRef<HTMLImageElement | null>(null)
  const afterImg = useRef<HTMLImageElement | null>(null)
  const panning = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  // Dónde empezó el pointerdown en modo normal: si el pointerup queda a <4px es un CLICK
  // (selección de objeto), no un pan.
  const downPt = useRef<{ x: number; y: number } | null>(null)

  /** Invierte el transform de dibujo (translate/scale/object-contain): px CSS del viewport →
   *  píxeles de la imagen `after`. Devuelve null fuera de la imagen o sin resultado. */
  const viewToImg = (cx: number, cy: number): { x: number; y: number } | null => {
    const img = afterImg.current
    if (!img || !img.naturalWidth) return null
    const W = size.w
    const H = size.h
    const s = Math.min(W / img.naturalWidth, H / img.naturalHeight)
    const dw = img.naturalWidth * s
    const dh = img.naturalHeight * s
    const x = ((cx - W / 2 - off.x) / scale + dw / 2) / s
    const y = ((cy - H / 2 - off.y) / scale + dh / 2) / s
    if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return null
    return { x, y }
  }

  /** Color del píxel clickeado en el resultado (o null si es transparente). */
  const sampleHex = (px: number, py: number): string | null => {
    const img = afterImg.current
    if (!img) return null
    const c = document.createElement('canvas')
    c.width = 1
    c.height = 1
    const g = c.getContext('2d', { willReadFrequently: true })
    if (!g) return null
    g.drawImage(img, -Math.floor(px), -Math.floor(py))
    const d = g.getImageData(0, 0, 1, 1).data
    if (d[3] < 128) return null
    return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')
  }

  useEffect(() => {
    if (!before) {
      beforeImg.current = null
      setVer((v) => v + 1)
      return
    }
    const img = new Image()
    img.onload = () => {
      beforeImg.current = img
      setVer((v) => v + 1)
    }
    img.src = before
    return () => {
      img.onload = null
    }
  }, [before])

  useEffect(() => {
    if (!after) {
      afterImg.current = null
      setVer((v) => v + 1)
      return
    }
    const img = new Image()
    img.onload = () => {
      afterImg.current = img
      setVer((v) => v + 1)
    }
    img.src = after
    return () => {
      img.onload = null
    }
  }, [after])

  useEffect(() => {
    setScale(1)
    setOff({ x: 0, y: 0 })
  }, [before, after])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const update = (): void => {
      const r = view.getBoundingClientRect()
      setSize({ w: r.width, h: r.height })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(view)
    return () => ro.disconnect()
  }, [])

  // Un solo drawImage de la imagen activa (resultado, o el original si se mantiene).
  useEffect(() => {
    const canvas = canvasRef.current
    const W = size.w
    const H = size.h
    if (!canvas || !W || !H) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const img = showBefore ? beforeImg.current : after ? afterImg.current : beforeImg.current
    if (!img || !img.naturalWidth || !img.naturalHeight) return
    const s = Math.min(W / img.naturalWidth, H / img.naturalHeight)
    const dw = img.naturalWidth * s
    const dh = img.naturalHeight * s
    ctx.translate(W / 2 + off.x, H / 2 + off.y)
    ctx.scale(scale, scale)
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh)
  }, [scale, off, ver, after, size, showBefore])

  // Invierte el transform de dibujo (translate/scale/object-contain) para pasar del canvas
  // (px CSS) a píxeles de la imagen `after`. Respeta el zoom/pan actual.
  const finishSelection = (): void => {
    const img = afterImg.current
    const cur = sel
    setSel(null)
    if (!img || !cur || (!onSelectRect && !onPickPoint)) return
    const W = size.w
    const H = size.h
    const s = Math.min(W / img.naturalWidth, H / img.naturalHeight)
    const dw = img.naturalWidth * s
    const dh = img.naturalHeight * s
    const toImg = (cx: number, cy: number): { x: number; y: number } => ({
      x: ((cx - W / 2 - off.x) / scale + dw / 2) / s,
      y: ((cy - H / 2 - off.y) / scale + dh / 2) / s
    })
    const a = toImg(cur.x0, cur.y0)
    const b = toImg(cur.x1, cur.y1)
    const x = Math.max(0, Math.min(a.x, b.x))
    const y = Math.max(0, Math.min(a.y, b.y))
    const w = Math.min(img.naturalWidth, Math.max(a.x, b.x)) - x
    const h = Math.min(img.naturalHeight, Math.max(a.y, b.y)) - y
    if (w > 3 && h > 3) {
      onSelectRect?.({ x, y, w, h })
    } else if (onPickPoint) {
      // CLICK (sin arrastre) = seleccionar OBJETO: el punto en px de la imagen.
      const px = Math.max(0, Math.min(img.naturalWidth - 1, a.x))
      const py = Math.max(0, Math.min(img.naturalHeight - 1, a.y))
      onPickPoint({ x: px, y: py, vx: cur.x0, vy: cur.y0, hex: sampleHex(px, py) })
    }
  }

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
      ref={viewRef}
      className={`relative h-full w-full overflow-hidden rounded-2xl border border-border ${
        selecting ? 'cursor-crosshair select-none' : ''
      }`}
      style={{ background }}
      onWheel={(e) => zoom(e.deltaY < 0 ? 1.15 : 0.87)}
      onPointerMove={(e) => {
        if (selecting) {
          if (!sel) return
          const r = viewRef.current?.getBoundingClientRect()
          if (!r) return
          const cx = e.clientX - r.left
          const cy = e.clientY - r.top
          setSel((s) => (s ? { ...s, x1: cx, y1: cy } : s))
          return
        }
        if (!panning.current) return
        setOff({
          x: panning.current.ox + (e.clientX - panning.current.x),
          y: panning.current.oy + (e.clientY - panning.current.y)
        })
      }}
      onPointerDown={(e) => {
        if (selecting) {
          const r = viewRef.current?.getBoundingClientRect()
          if (!r) return
          const cx = e.clientX - r.left
          const cy = e.clientY - r.top
          setSel({ x0: cx, y0: cy, x1: cx, y1: cy })
          e.currentTarget.setPointerCapture(e.pointerId)
          return
        }
        downPt.current = { x: e.clientX, y: e.clientY }
        if (scale === 1) return
        panning.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerUp={(e) => {
        if (selecting) {
          finishSelection()
          return
        }
        panning.current = null
        const d = downPt.current
        downPt.current = null
        if (!d || !onPickPoint) return
        // CLICK simple en modo NORMAL (sin arrastre, sobre el canvas y no sobre un botón):
        // seleccionar el OBJETO bajo el cursor — el flujo natural estilo Illustrator.
        if ((e.clientX - d.x) ** 2 + (e.clientY - d.y) ** 2 > 16) return // fue un pan
        if (e.target !== canvasRef.current) return
        const r = viewRef.current?.getBoundingClientRect()
        if (!r) return
        const vx = e.clientX - r.left
        const vy = e.clientY - r.top
        const p = viewToImg(vx, vy)
        if (!p) return
        const hex = sampleHex(p.x, p.y)
        if (!hex) return // píxel transparente: nada que editar
        onPickPoint({ x: p.x, y: p.y, vx, vy, hex })
      }}
      onPointerLeave={() => {
        downPt.current = null
        if (selecting) return
        panning.current = null
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* Rectángulo de selección (modo "limpiar zona") */}
      {selecting && sel && (
        <div
          className="pointer-events-none absolute z-30 border-2 border-sky-400 bg-sky-400/20"
          style={{
            left: Math.min(sel.x0, sel.x1),
            top: Math.min(sel.y0, sel.y1),
            width: Math.abs(sel.x1 - sel.x0),
            height: Math.abs(sel.y1 - sel.y0)
          }}
        />
      )}

      {/* Etiqueta de lo que se ve */}
      {after && (
        <span className="pointer-events-none absolute left-2 top-2 z-20 rounded-md bg-background/80 px-2 py-0.5 text-xs font-medium text-muted-foreground backdrop-blur">
          {showBefore ? beforeLabel : afterLabel}
        </span>
      )}

      {/* Mantené para ver el original */}
      {after && (
        <button
          type="button"
          aria-label={`Mantené para ver ${beforeLabel.toLowerCase()}`}
          className={`absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium backdrop-blur transition ${
            showBefore ? 'bg-foreground text-background' : 'bg-background/80 text-muted-foreground hover:text-foreground'
          }`}
          onPointerDown={(e) => {
            e.stopPropagation()
            setShowBefore(true)
          }}
          onPointerUp={() => setShowBefore(false)}
          onPointerLeave={() => setShowBefore(false)}
        >
          <Eye className="h-3.5 w-3.5" />
          Ver {beforeLabel.toLowerCase()}
        </button>
      )}

      {/* Zoom */}
      {after && (
        <div className="absolute bottom-2 right-2 z-20 flex items-center gap-0.5 rounded-lg border border-border bg-background/80 p-0.5 backdrop-blur">
          <button type="button" aria-label="Alejar" onClick={() => zoom(0.8)} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted">
            <Minus className="h-4 w-4" />
          </button>
          <button type="button" onClick={reset} className="w-12 text-center text-xs tabular-nums text-muted-foreground hover:text-foreground">
            {Math.round(scale * 100)}%
          </button>
          <button type="button" aria-label="Acercar" onClick={() => zoom(1.25)} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted">
            <Plus className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  )
}
