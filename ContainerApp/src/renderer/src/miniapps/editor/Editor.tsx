import { useEffect, useRef, useState } from 'react'
import { FlipHorizontal2, FlipVertical2, RotateCw, Upload } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { useRevokeOnUnmount } from '@renderer/lib/useRevokeOnUnmount'
import { CHECKER, IMAGE_ACCEPT as ACCEPT } from '@renderer/lib/image'

interface Adj {
  brightness: number
  contrast: number
  saturate: number
  hue: number
  blur: number
}
interface Fx {
  grayscale: boolean
  sepia: boolean
  invert: boolean
}
interface Tf {
  rotate: number
  flipH: boolean
  flipV: boolean
}
interface Levels {
  black: number
  white: number
  gamma: number
}
const DEF_ADJ: Adj = { brightness: 100, contrast: 100, saturate: 100, hue: 0, blur: 0 }
const DEF_FX: Fx = { grayscale: false, sepia: false, invert: false }
const DEF_TF: Tf = { rotate: 0, flipH: false, flipV: false }
const DEF_LEVELS: Levels = { black: 0, white: 255, gamma: 1 }

/** Mini app "Editar": ajustes/filtros/transformaciones en vivo sobre canvas. */
export default function Editor(): React.JSX.Element {
  const [source, setSource] = useState<{ url: string; name: string } | null>(null)
  const [adj, setAdj] = useState<Adj>(DEF_ADJ)
  const [fx, setFx] = useState<Fx>(DEF_FX)
  const [tf, setTf] = useState<Tf>(DEF_TF)
  const [over, setOver] = useState(false)
  const [copied, setCopied] = useState(false)
  const [aspect, setAspect] = useState<number | null>(null)
  const [vignette, setVignette] = useState(0)
  const [temp, setTemp] = useState(0)
  const [sharpen, setSharpen] = useState(0)
  const [levels, setLevels] = useState<Levels>(DEF_LEVELS)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgElRef = useRef<HTMLImageElement | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useRevokeOnUnmount(source?.url)

  const filterString = `brightness(${adj.brightness}%) contrast(${adj.contrast}%) saturate(${adj.saturate}%) hue-rotate(${adj.hue}deg) blur(${adj.blur}px) grayscale(${fx.grayscale ? 100 : 0}%) sepia(${fx.sepia ? 100 : 0}%) invert(${fx.invert ? 100 : 0}%)`

  function redraw(): void {
    const img = imgElRef.current
    const canvas = canvasRef.current
    if (!img || !canvas) return
    const iW = img.naturalWidth
    const iH = img.naturalHeight
    // Recorte por aspect ratio: rectángulo centrado de área máxima.
    let cW = iW
    let cH = iH
    let cX = 0
    let cY = 0
    if (aspect && iW > 0 && iH > 0) {
      if (iW / iH > aspect) {
        cH = iH
        cW = Math.round(iH * aspect)
        cX = Math.round((iW - cW) / 2)
      } else {
        cW = iW
        cH = Math.round(iW / aspect)
        cY = Math.round((iH - cH) / 2)
      }
    }
    const swap = tf.rotate === 90 || tf.rotate === 270
    canvas.width = swap ? cH : cW
    canvas.height = swap ? cW : cH
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.filter = filterString
    ctx.save()
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((tf.rotate * Math.PI) / 180)
    ctx.scale(tf.flipH ? -1 : 1, tf.flipV ? -1 : 1)
    ctx.drawImage(img, cX, cY, cW, cH, -cW / 2, -cH / 2, cW, cH)
    ctx.restore()

    // Niveles: remapea negros/blancos/gamma con una LUT de 256 entradas. Sólo si ≠ default.
    if (levels.black > 0 || levels.white < 255 || levels.gamma !== 1) {
      const lo = levels.black
      const range = Math.max(1, levels.white - lo)
      const invGamma = 1 / levels.gamma
      const lut = new Uint8ClampedArray(256)
      for (let v = 0; v < 256; v++) {
        let t = (v - lo) / range
        t = t < 0 ? 0 : t > 1 ? 1 : t
        lut[v] = Math.pow(t, invGamma) * 255
      }
      const id = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const d = id.data
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue // respeta píxeles transparentes
        d[i] = lut[d[i]]
        d[i + 1] = lut[d[i + 1]]
        d[i + 2] = lut[d[i + 2]]
      }
      ctx.putImageData(id, 0, 0)
    }

    // Temperatura: pase por píxel, cálido (R+/B-) o frío (R-/B+). Sólo si ≠ 0.
    if (temp !== 0) {
      const k = (temp / 100) * 45
      const id = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const d = id.data
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue // respeta píxeles transparentes
        const r = d[i] + k
        const b = d[i + 2] - k
        d[i] = r < 0 ? 0 : r > 255 ? 255 : r
        d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b
      }
      ctx.putImageData(id, 0, 0)
    }

    // Nitidez: convolución 3×3 (unsharp). Lee de una copia, escribe al destino. Sólo si > 0.
    if (sharpen > 0) {
      const a = (sharpen / 100) * 1.2
      const center = 1 + 4 * a
      const w = canvas.width
      const h = canvas.height
      const id = ctx.getImageData(0, 0, w, h)
      const d = id.data
      const src = new Uint8ClampedArray(d) // buffer original (clamp automático)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4
          if (src[o + 3] === 0) continue // respeta píxeles transparentes
          const up = ((y > 0 ? y - 1 : 0) * w + x) * 4
          const dn = ((y < h - 1 ? y + 1 : h - 1) * w + x) * 4
          const lf = (y * w + (x > 0 ? x - 1 : 0)) * 4
          const rt = (y * w + (x < w - 1 ? x + 1 : w - 1)) * 4
          for (let c = 0; c < 3; c++) {
            d[o + c] = center * src[o + c] - a * (src[up + c] + src[dn + c] + src[lf + c] + src[rt + c])
          }
        }
      }
      ctx.putImageData(id, 0, 0)
    }

    // Viñeta: degradado radial oscuro en los bordes (en espacio de canvas).
    if (vignette > 0) {
      const cx = canvas.width / 2
      const cy = canvas.height / 2
      const inner = Math.min(canvas.width, canvas.height) * 0.32
      const outer = Math.max(canvas.width, canvas.height) * 0.72
      const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer)
      g.addColorStop(0, 'rgba(0,0,0,0)')
      g.addColorStop(1, `rgba(0,0,0,${(vignette / 100) * 0.75})`)
      ctx.filter = 'none'
      ctx.fillStyle = g
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
  }

  // Carga la imagen en un Image element y dibuja.
  useEffect(() => {
    if (!source) return
    const el = new Image()
    el.onload = () => {
      imgElRef.current = el
      redraw()
    }
    el.src = source.url
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  // Redibuja en cada cambio de ajuste/filtro/transformación/recorte.
  useEffect(() => {
    redraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adj, fx, tf, aspect, vignette, temp, sharpen, levels])

  async function onFile(file: File): Promise<void> {
    setSource((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return { url: URL.createObjectURL(file), name: file.name }
    })
    setAdj(DEF_ADJ)
    setFx(DEF_FX)
    setTf(DEF_TF)
    setAspect(null)
    setVignette(0)
    setTemp(0)
    setSharpen(0)
    setLevels(DEF_LEVELS)
  }
  function handleFiles(files: FileList | null): void {
    const f = files?.[0]
    if (f && ACCEPT.includes(f.type)) void onFile(f)
  }

  function bake(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const canvas = canvasRef.current
      if (!canvas) return resolve(null)
      canvas.toBlob((b) => resolve(b), 'image/png')
    })
  }
  async function onSave(): Promise<void> {
    const blob = await bake()
    if (!blob) return
    const ab = await blob.arrayBuffer()
    const base = (source?.name ?? 'imagen').replace(/\.[^.]+$/, '')
    await window.api.editor.save(ab, `${base}-editado.png`)
  }
  async function onCopy(): Promise<void> {
    const blob = await bake()
    if (!blob) return
    const ab = await blob.arrayBuffer()
    const r = await window.api.editor.copy(ab)
    if (r.copied) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  function reset(): void {
    setAdj(DEF_ADJ)
    setFx(DEF_FX)
    setTf(DEF_TF)
    setAspect(null)
    setVignette(0)
    setTemp(0)
    setSharpen(0)
    setLevels(DEF_LEVELS)
  }

  const slider = (label: string, value: number, min: number, max: number, onChange: (v: number) => void, suffix = '%', step = 1): React.JSX.Element => (
    <div className="mb-3">
      <label className="mb-1 flex items-center justify-between text-sm font-medium">
        <span>{label}</span>
        <span className="text-muted-foreground">{Number.isInteger(value) ? value : value.toFixed(2)}{suffix}</span>
      </label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-primary" />
    </div>
  )
  const fxBtn = (label: string, on: boolean, toggle: () => void): React.JSX.Element => (
    <button type="button" onClick={toggle} className={cn('flex-1 rounded-lg border px-2 py-2 text-xs font-medium transition', on ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground')}>
      {label}
    </button>
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3">
        <p className="truncate text-sm text-muted-foreground">{source ? source.name : 'Arrastrá una imagen para editar'}</p>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" disabled={!source} onClick={() => void onCopy()} className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40">
            {copied ? 'Copiado ✓' : 'Copiar'}
          </button>
          <button type="button" disabled={!source} onClick={() => void onSave()} className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40">
            Guardar
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 p-6">
          {source ? (
            <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-2xl border border-border" style={{ background: CHECKER }}>
              <canvas ref={canvasRef} className="max-h-full max-w-full object-contain p-2" />
            </div>
          ) : (
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setOver(true)
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setOver(false)
                handleFiles(e.dataTransfer.files)
              }}
              onClick={() => inputRef.current?.click()}
              className={cn('flex h-full w-full cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed text-center transition', over ? 'border-foreground/40 bg-muted' : 'border-border bg-muted/30')}
            >
              <Upload className="mb-3 h-9 w-9 text-muted-foreground" />
              <p className="text-base font-semibold">Arrastra tu imagen aquí</p>
              <p className="mt-1 text-sm text-muted-foreground">JPG · PNG · WEBP</p>
            </div>
          )}
          <input ref={inputRef} type="file" accept={ACCEPT.join(',')} hidden onChange={(e) => handleFiles(e.target.files)} />
        </div>

        <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-border p-6">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ajustes</h3>
          {slider('Brillo', adj.brightness, 0, 200, (v) => setAdj((a) => ({ ...a, brightness: v })))}
          {slider('Contraste', adj.contrast, 0, 200, (v) => setAdj((a) => ({ ...a, contrast: v })))}
          {slider('Saturación', adj.saturate, 0, 300, (v) => setAdj((a) => ({ ...a, saturate: v })))}
          {slider('Tono', adj.hue, 0, 360, (v) => setAdj((a) => ({ ...a, hue: v })), '°')}
          {slider('Temperatura', temp, -100, 100, (v) => setTemp(v), '')}
          {slider('Desenfoque', adj.blur, 0, 20, (v) => setAdj((a) => ({ ...a, blur: v })), 'px')}
          {slider('Nitidez', sharpen, 0, 100, (v) => setSharpen(v))}
          {slider('Viñeta', vignette, 0, 100, (v) => setVignette(v))}

          <h3 className="mb-3 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Niveles</h3>
          {slider('Negros', levels.black, 0, 254, (v) => setLevels((l) => ({ ...l, black: Math.min(v, l.white - 1) })), '')}
          {slider('Blancos', levels.white, 1, 255, (v) => setLevels((l) => ({ ...l, white: Math.max(v, l.black + 1) })), '')}
          {slider('Gamma', levels.gamma, 0.1, 3, (v) => setLevels((l) => ({ ...l, gamma: v })), '', 0.05)}

          <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filtros</h3>
          <div className="mb-4 flex gap-2">
            {fxBtn('B/N', fx.grayscale, () => setFx((f) => ({ ...f, grayscale: !f.grayscale })))}
            {fxBtn('Sepia', fx.sepia, () => setFx((f) => ({ ...f, sepia: !f.sepia })))}
            {fxBtn('Invertir', fx.invert, () => setFx((f) => ({ ...f, invert: !f.invert })))}
          </div>

          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Transformar</h3>
          <div className="mb-4 flex gap-2">
            <button type="button" onClick={() => setTf((t) => ({ ...t, rotate: (t.rotate + 90) % 360 }))} className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-border px-2 py-2 text-xs font-medium hover:bg-muted">
              <RotateCw className="h-4 w-4" /> 90°
            </button>
            <button type="button" onClick={() => setTf((t) => ({ ...t, flipH: !t.flipH }))} className={cn('flex flex-1 items-center justify-center rounded-lg border px-2 py-2 transition', tf.flipH ? 'border-foreground bg-foreground text-background' : 'border-border hover:bg-muted')}>
              <FlipHorizontal2 className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => setTf((t) => ({ ...t, flipV: !t.flipV }))} className={cn('flex flex-1 items-center justify-center rounded-lg border px-2 py-2 transition', tf.flipV ? 'border-foreground bg-foreground text-background' : 'border-border hover:bg-muted')}>
              <FlipVertical2 className="h-4 w-4" />
            </button>
          </div>

          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recortar</h3>
          <div className="mb-4 grid grid-cols-3 gap-2">
            {([['Libre', null], ['1:1', 1], ['4:5', 0.8], ['3:4', 0.75], ['16:9', 16 / 9], ['9:16', 9 / 16]] as const).map(([label, a]) => (
              <button
                key={label}
                type="button"
                onClick={() => setAspect(a)}
                className={cn('rounded-lg border px-2 py-2 text-xs font-medium transition', aspect === a ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground')}
              >
                {label}
              </button>
            ))}
          </div>

          <button type="button" onClick={reset} className="w-full rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground">
            Restablecer
          </button>
        </aside>
      </div>
    </div>
  )
}
