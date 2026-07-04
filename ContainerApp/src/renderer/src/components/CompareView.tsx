import { useEffect, useRef, useState } from 'react'
import { Eye, Minus, Plus } from 'lucide-react'

// Zoom hasta 64×: a 2048px de lado, 64× = ver píxeles individuales de a bloques — el
// nivel "precisión de mota" que pide el retoque fino (12× se quedaba corto para letras).
const MIN = 1
const MAX = 64
const clamp = (n: number): number => Math.min(MAX, Math.max(MIN, n))

/** Clic (sin arrastre) sobre un píxel del resultado, en cualquier modo. */
export type CanvasPick = {
  /** Punto en píxeles de la imagen `after`. */
  x: number
  y: number
  /** Punto en píxeles del viewport (para anclar UI cerca del clic). */
  vx: number
  vy: number
  /** Color muestreado del píxel (null = transparente). */
  hex: string | null
  /** true si venía con Shift (sumar a la selección). */
  additive: boolean
}

/**
 * Lienzo de resultado con la gramática de navegación estándar de las herramientas de diseño
 * (Figma/Illustrator/Photoshop):
 *  - scroll de dos dedos / rueda  = DESPLAZAR (pan)
 *  - pinch del trackpad o ⌘+scroll = ZOOM anclado al cursor
 *  - espacio + arrastrar           = mano (en cualquier modo, incluso seleccionando)
 *  - doble clic                    = ajustar a la ventana
 *  - Escape                        = cancela el rectángulo a medio dibujar
 * Cursores: crosshair al seleccionar, grab/grabbing al panear.
 *
 * Un SOLO <canvas> dibuja UNA imagen (el resultado, o el original mientras mantenés el botón).
 * `overlay` (canvas a resolución nativa de `after`) se dibuja encima con el mismo transform —
 * lo usa Vectorizar para RESALTAR la selección de objetos.
 */
export function CompareView({
  before,
  after,
  beforeLabel = 'Original',
  afterLabel = 'Resultado',
  background,
  selecting = false,
  busy = false,
  hint,
  overlay,
  onSelectRect,
  onPickPoint
}: {
  before: string
  after?: string | null
  beforeLabel?: string
  afterLabel?: string
  background: string
  /** Modo "zona" heredado: fuerza arrastre = rectángulo. Con `onSelectRect` presente, el
   *  arrastre en modo normal YA es marquesina (gramática única) — el pan vive en scroll,
   *  espacio y botón del medio, como en Figma/Illustrator. */
  selecting?: boolean
  /** Procesando: se puede navegar pero NO editar (no dispara rect ni pick, sin perder el modo). */
  busy?: boolean
  /** Ayuda contextual que se muestra en la barra de estado (un solo lugar, sin truncar). */
  hint?: string
  /** Canvas de resaltado a resolución nativa de `after`; se compone sobre el resultado. */
  overlay?: HTMLCanvasElement | null
  /** Marquesina, en píxeles de la imagen `after` (ya intersectada con la imagen).
   *  `additive` = shift (sumar) · `subtract` = ⌥/alt (restar de la selección). */
  onSelectRect?: (
    rect: { x: number; y: number; w: number; h: number },
    opts: { additive: boolean; subtract: boolean }
  ) => void
  /** Clic sin arrastre sobre un píxel OPACO — en cualquier modo. */
  onPickPoint?: (pick: CanvasPick) => void
}) {
  const [scale, setScale] = useState(1)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [showBefore, setShowBefore] = useState(false)
  const [sel, setSel] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [spaceDown, setSpaceDown] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [ver, setVer] = useState(0)
  const viewRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const beforeImg = useRef<HTMLImageElement | null>(null)
  const afterImg = useRef<HTMLImageElement | null>(null)
  const panning = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const downPt = useRef<{ x: number; y: number } | null>(null)
  const hovering = useRef(false)
  // Los handlers nativos (wheel) y de teclado leen SIEMPRE el último estado vía refs.
  const scaleRef = useRef(scale)
  const offRef = useRef(off)
  scaleRef.current = scale
  offRef.current = off

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

  // La vista se resetea SOLO con imagen nueva. Cada edición produce un blob URL nuevo en
  // `after` — si esto dependiera de `after`, cada recolor/⌘Z te devolvería a 100% centrado
  // y el loop profesional "zoom → editar → verificar" moriría en cada vuelta.
  useEffect(() => {
    setScale(1)
    setOff({ x: 0, y: 0 })
  }, [before])

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

  // Un solo drawImage de la imagen activa + el overlay de selección con el mismo transform.
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
    if (overlay && !showBefore && img === afterImg.current) {
      ctx.drawImage(overlay, -dw / 2, -dh / 2, dw, dh)
    }
  }, [scale, off, ver, after, size, showBefore, overlay])

  /** px CSS del viewport → píxeles de la imagen `after` (null fuera de la imagen). */
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

  const reset = (): void => {
    setScale(1)
    setOff({ x: 0, y: 0 })
  }

  /** Zoom anclado a un punto del viewport: lo que está bajo el cursor queda bajo el cursor. */
  const zoomAt = (cx: number, cy: number, factor: number): void => {
    const s0 = scaleRef.current
    const s1 = clamp(s0 * factor)
    if (s1 === s0) return
    if (s1 === 1) {
      reset()
      return
    }
    const k = s1 / s0
    const o = offRef.current
    const W = size.w
    const H = size.h
    setOff({
      x: cx - W / 2 - k * (cx - W / 2 - o.x),
      y: cy - H / 2 - k * (cy - H / 2 - o.y)
    })
    setScale(s1)
  }

  /** Zoom desde los botones − / + (ancla al centro). */
  const zoom = (factor: number): void => zoomAt(size.w / 2, size.h / 2, factor)

  // Rueda/trackpad nativo (passive:false para poder frenar el scroll/zoom de la página):
  // pinch (ctrlKey) o ⌘+scroll = zoom al cursor · scroll solo = desplazar.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = view.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0035))
        zoomAt(e.clientX - r.left, e.clientY - r.top, factor)
      } else if (scaleRef.current > 1) {
        setOff((o) => ({ x: o.x - e.deltaX, y: o.y - e.deltaY }))
      }
    }
    view.addEventListener('wheel', onWheel, { passive: false })
    return () => view.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h])

  // Espacio = mano (solo con el puntero sobre el lienzo, nunca al tipear) · Escape = cancelar rect.
  useEffect(() => {
    const typing = (t: EventTarget | null): boolean =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    const down = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !e.repeat && hovering.current && !typing(e.target)) {
        e.preventDefault()
        setSpaceDown(true)
      }
      if (e.key === 'Escape') setSel(null)
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') setSpaceDown(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  const startPan = (e: React.PointerEvent<HTMLDivElement>): void => {
    panning.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y }
    setIsPanning(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const endPan = (): void => {
    panning.current = null
    setIsPanning(false)
  }

  /** Cierra el rectángulo: clic (por distancia EN PANTALLA) o rect intersectado con la imagen. */
  const finishSelection = (e: React.PointerEvent<HTMLDivElement>): void => {
    const img = afterImg.current
    const cur = sel
    setSel(null)
    if (!img || !cur || busy) return
    const dx = cur.x1 - cur.x0
    const dy = cur.y1 - cur.y0
    if (dx * dx + dy * dy < 16) {
      // CLIC: mismo camino que el modo normal (seleccionar objeto).
      firePick(cur.x0, cur.y0, e.shiftKey)
      return
    }
    if (!onSelectRect) return
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
    // Intersección real con la imagen: un rect totalmente afuera se DESCARTA (nunca se
    // convierte en un punto clampeado que edite un objeto del borde por accidente).
    const x = Math.max(0, Math.min(a.x, b.x))
    const y = Math.max(0, Math.min(a.y, b.y))
    const w = Math.min(img.naturalWidth, Math.max(a.x, b.x)) - x
    const h = Math.min(img.naturalHeight, Math.max(a.y, b.y)) - y
    if (w <= 0 || h <= 0) return
    // Cualquier franja vale (una marquesina de 200×2 px es un caso REAL: líneas de borde).
    onSelectRect({ x, y, w: Math.max(1, w), h: Math.max(1, h) }, { additive: e.shiftKey, subtract: e.altKey })
  }

  /** Dispara el pick (clic sin arrastre). Fuera de la imagen (checkerboard) también dispara,
   *  con hex null — el "clic en el vacío" más natural para deseleccionar. */
  const firePick = (vx: number, vy: number, additive: boolean): void => {
    if (!onPickPoint || busy) return
    const p = viewToImg(vx, vy)
    if (!p) {
      onPickPoint({ x: 0, y: 0, vx, vy, hex: null, additive })
      return
    }
    const hex = sampleHex(p.x, p.y)
    onPickPoint({ x: p.x, y: p.y, vx, vy, hex, additive })
  }

  const cursor = spaceDown || isPanning
    ? isPanning
      ? 'cursor-grabbing'
      : 'cursor-grab'
    : selecting || sel
      ? busy
        ? 'cursor-progress'
        : 'cursor-crosshair select-none'
      : scale > 1 && !onSelectRect
        ? 'cursor-grab'
        : ''

  return (
    <div
      ref={viewRef}
      className={`relative h-full w-full overflow-hidden rounded-2xl border border-border ${cursor}`}
      style={{ background }}
      onPointerEnter={() => {
        hovering.current = true
      }}
      onPointerLeave={() => {
        hovering.current = false
        downPt.current = null
        if (!selecting) endPan()
      }}
      onDoubleClick={(e) => {
        // Doble clic AJUSTA a la ventana — pero solo sobre vacío: doble clic sobre un objeto
        // no te roba el zoom (el clic simple ya lo seleccionó).
        const r = viewRef.current?.getBoundingClientRect()
        if (!r) return
        const p = viewToImg(e.clientX - r.left, e.clientY - r.top)
        if (!p || !sampleHex(p.x, p.y)) reset()
      }}
      onPointerMove={(e) => {
        if (panning.current) {
          setOff({
            x: panning.current.ox + (e.clientX - panning.current.x),
            y: panning.current.oy + (e.clientY - panning.current.y)
          })
          return
        }
        if (sel) {
          const r = viewRef.current?.getBoundingClientRect()
          if (!r) return
          setSel((s) => (s ? { ...s, x1: e.clientX - r.left, y1: e.clientY - r.top } : s))
        }
      }}
      onPointerDown={(e) => {
        // Espacio o botón del medio = mano, en CUALQUIER modo.
        if (spaceDown || e.button === 1) {
          startPan(e)
          return
        }
        if (e.button !== 0) return
        // Con onSelectRect, el arrastre es MARQUESINA (gramática única de selección) — el
        // pan vive en scroll/espacio/botón del medio. Sin ella (p.ej. Mejorar), el arrastre
        // sigue paneando con zoom.
        if (selecting || onSelectRect) {
          if (busy) return
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
        startPan(e)
      }}
      onPointerUp={(e) => {
        if (panning.current) {
          const wasClick =
            downPt.current &&
            (e.clientX - downPt.current.x) ** 2 + (e.clientY - downPt.current.y) ** 2 < 16
          endPan()
          if (wasClick && !spaceDown && e.target === canvasRef.current) {
            const r = viewRef.current?.getBoundingClientRect()
            if (r) firePick(e.clientX - r.left, e.clientY - r.top, e.shiftKey)
          }
          downPt.current = null
          return
        }
        if (sel) {
          finishSelection(e)
          return
        }
        const d = downPt.current
        downPt.current = null
        if (!d) return
        if ((e.clientX - d.x) ** 2 + (e.clientY - d.y) ** 2 > 16) return
        if (e.target !== canvasRef.current) return
        const r = viewRef.current?.getBoundingClientRect()
        if (!r) return
        firePick(e.clientX - r.left, e.clientY - r.top, e.shiftKey)
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* Rectángulo de la marquesina */}
      {sel && (
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

      {/* Barra de estado: zoom + LA línea de ayuda contextual (un solo lugar, sin truncar).
          stopPropagation: sin esto, el pointerdown burbujea al lienzo, que captura el puntero
          (pan/rect) y el click de los botones −/%/＋ muere justo cuando estás zoomeado. */}
      <div
        className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 border-t border-border bg-background/85 px-2 py-1 backdrop-blur"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" aria-label="Alejar" onClick={() => zoom(0.8)} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted">
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Ajustar a la ventana (o doble clic en el lienzo)"
            onClick={reset}
            className="w-12 text-center text-xs tabular-nums text-muted-foreground hover:text-foreground"
          >
            {Math.round(scale * 100)}%
          </button>
          <button type="button" aria-label="Acercar" onClick={() => zoom(1.25)} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="min-w-0 truncate text-right text-[11px] text-muted-foreground">
          {hint ?? 'scroll = mover · pinch o ⌘ scroll = zoom · espacio = mano · doble clic = ajustar'}
        </p>
      </div>
    </div>
  )
}
