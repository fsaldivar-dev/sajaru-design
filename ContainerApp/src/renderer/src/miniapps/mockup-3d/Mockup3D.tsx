import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import { Copy, ImagePlus, Rotate3d, Upload, Video, X } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { useShell } from '@renderer/lib/shell'
import { IMAGE_ACCEPT as ACCEPT } from '@renderer/lib/image'
import { Scene, type CaptureApi } from './components/Scene'
import type { DecalXf } from './components/Garment'
import tshirtModel from './assets/tshirt.glb?url'
import tazaModel from './assets/taza.glb?url'
import vasoModel from './assets/vaso.glb?url'
import gorraModel from './assets/gorra.glb?url'
import termoModel from './assets/termo.glb?url'
import botellaModel from './assets/botella.glb?url'
import mousepadModel from './assets/mousepad.glb?url'
import platoModel from './assets/plato.glb?url'

interface Layer {
  id: string
  url: string
  name: string
  xf: DecalXf
}

interface Placement {
  id: string
  label: string
  xf: DecalXf
}

interface Product {
  id: string
  label: string
  model: string
  /** Frente fijo (playera). Si se omite, Garment lo calcula del bounding box (bebibles cilíndricos). */
  frontZ?: number
  garment: boolean // true = usa tallas mexicanas; false = bebible
  placements: Placement[]
  defaultXf: DecalXf
  rotationY?: number // orienta el frente hacia la cámara (bebibles/gorra vienen rotados)
  /** Escala de ENCUADRE para no-prendas (la normalización deja todo en ~2u, que desborda
   *  la cámara fija; esto lo baja al tamaño de exhibición correcto). Default 1. */
  viewScale?: number
}

const GARMENT_PLACEMENTS: Placement[] = [
  { id: 'pecho-centro', label: 'Pecho centro', xf: { x: 0, y: 0.05, scale: 0.16, rotation: 0, side: 'front' } },
  { id: 'escudo-izq', label: 'Escudo izq.', xf: { x: -0.08, y: 0.12, scale: 0.06, rotation: 0, side: 'front' } },
  { id: 'escudo-der', label: 'Escudo der.', xf: { x: 0.08, y: 0.12, scale: 0.06, rotation: 0, side: 'front' } },
  { id: 'hombro-izq', label: 'Hombro izq.', xf: { x: 0, y: 0.15, scale: 0.05, rotation: 0, side: 'left' } },
  { id: 'hombro-der', label: 'Hombro der.', xf: { x: 0, y: 0.15, scale: 0.05, rotation: 0, side: 'right' } },
  { id: 'pecho-completo', label: 'Pecho completo', xf: { x: 0, y: 0, scale: 0.32, rotation: 0, side: 'front' } },
  { id: 'espalda', label: 'Espalda', xf: { x: 0, y: 0.03, scale: 0.32, rotation: 0, side: 'back' } },
  { id: 'espalda-cuello', label: 'Espalda cuello', xf: { x: 0, y: 0.2, scale: 0.08, rotation: 0, side: 'back' } }
]

// Bebibles cilíndricos: el diseño se proyecta sobre una de las 4 caras del cilindro.
const DRINK_PLACEMENTS: Placement[] = [
  { id: 'frente', label: 'Frente', xf: { x: 0, y: 0, scale: 0.4, rotation: 0, side: 'front' } },
  { id: 'atras', label: 'Atrás', xf: { x: 0, y: 0, scale: 0.4, rotation: 0, side: 'back' } },
  { id: 'izq', label: 'Izquierda', xf: { x: 0, y: 0, scale: 0.4, rotation: 0, side: 'left' } },
  { id: 'der', label: 'Derecha', xf: { x: 0, y: 0, scale: 0.4, rotation: 0, side: 'right' } }
]

const DRINK_DEFAULT: DecalXf = { x: 0, y: 0, scale: 0.4, rotation: 0, side: 'front' }

// Productos PLANOS (mousepad/plato): el diseño va al frente, centrado o cubriendo la cara.
const FLAT_PLACEMENTS: Placement[] = [
  { id: 'centro', label: 'Centro', xf: { x: 0, y: 0, scale: 0.35, rotation: 0, side: 'front' } },
  { id: 'completo', label: 'Completo', xf: { x: 0, y: 0, scale: 0.55, rotation: 0, side: 'front' } }
]
const FLAT_DEFAULT: DecalXf = { x: 0, y: 0, scale: 0.4, rotation: 0, side: 'front' }

// Gorra: el logo va en el panel delantero (crown), un poco arriba de la visera.
const GORRA_DEFAULT: DecalXf = { x: 0, y: 0.1, scale: 0.3, rotation: 0, side: 'front' }
const GORRA_PLACEMENTS: Placement[] = [
  { id: 'frente', label: 'Frente', xf: { x: 0, y: 0.1, scale: 0.3, rotation: 0, side: 'front' } },
  { id: 'lateral-izq', label: 'Lateral izq.', xf: { x: 0, y: 0.1, scale: 0.16, rotation: 0, side: 'left' } },
  { id: 'lateral-der', label: 'Lateral der.', xf: { x: 0, y: 0.1, scale: 0.16, rotation: 0, side: 'right' } },
  { id: 'atras', label: 'Atrás', xf: { x: 0, y: 0.1, scale: 0.2, rotation: 0, side: 'back' } }
]

const PRODUCTS: Product[] = [
  {
    id: 'playera',
    label: 'Playera',
    model: tshirtModel,
    frontZ: 0.15,
    garment: true,
    placements: GARMENT_PLACEMENTS,
    defaultXf: { x: 0, y: 0.05, scale: 0.16, rotation: 0, side: 'front' }
  },
  { id: 'taza', label: 'Taza', model: tazaModel, garment: false, placements: DRINK_PLACEMENTS, defaultXf: DRINK_DEFAULT, viewScale: 0.72 },
  { id: 'vaso', label: 'Vaso', model: vasoModel, garment: false, placements: DRINK_PLACEMENTS, defaultXf: DRINK_DEFAULT, viewScale: 0.62 },
  { id: 'termo', label: 'Termo', model: termoModel, garment: false, placements: DRINK_PLACEMENTS, defaultXf: DRINK_DEFAULT, viewScale: 0.6 },
  { id: 'botella', label: 'Botella', model: botellaModel, garment: false, placements: DRINK_PLACEMENTS, defaultXf: DRINK_DEFAULT, viewScale: 0.6 },
  { id: 'mousepad', label: 'Mousepad', model: mousepadModel, garment: false, placements: FLAT_PLACEMENTS, defaultXf: FLAT_DEFAULT, viewScale: 0.95 },
  { id: 'plato', label: 'Plato', model: platoModel, garment: false, placements: FLAT_PLACEMENTS, defaultXf: FLAT_DEFAULT, viewScale: 0.68 },
  {
    id: 'gorra',
    label: 'Gorra',
    model: gorraModel,
    garment: false,
    placements: GORRA_PLACEMENTS,
    defaultXf: GORRA_DEFAULT,
    viewScale: 0.8
  }
]

const GARMENT_COLORS = [
  { name: 'Blanco', hex: '#f5f5f5' },
  { name: 'Negro', hex: '#141414' },
  { name: 'Marino', hex: '#1e2a44' },
  { name: 'Gris', hex: '#9aa0a6' },
  { name: 'Rojo', hex: '#b21f28' },
  { name: 'Azul', hex: '#1d4ed8' },
  { name: 'Verde', hex: '#15803d' },
  { name: 'Arena', hex: '#d8c9a3' }
]

/**
 * Si el visor 3D no puede crear el contexto WebGL (GPU bloqueada/driver, típico en Linux),
 * R3F lanza al montar y sin esto la view queda en NEGRO sin explicación. Mostramos un aviso
 * accionable en su lugar.
 */
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm font-semibold">No se pudo iniciar el visor 3D (WebGL)</p>
        <p className="max-w-md text-xs text-muted-foreground">
          Tu equipo no pudo crear el contexto gráfico. Suele ser el driver de video: actualizá
          Mesa/los drivers de tu GPU y reabrí la app. Si persiste, lanzá desde la terminal con{' '}
          <code>sajaru-design --enable-unsafe-swiftshader</code> para forzar el modo por software.
        </p>
      </div>
    )
  }
}

/** Tallas mexicanas — factor = escala de la prenda (Niño más chica, XXL más grande). Solo playera. */
const SIZES = [
  { id: 'nino', label: 'Niño', factor: 0.82 },
  { id: 'ch', label: 'CH', factor: 0.92 },
  { id: 'm', label: 'M', factor: 1.0 },
  { id: 'g', label: 'G', factor: 1.08 },
  { id: 'xl', label: 'XL', factor: 1.16 },
  { id: 'xxl', label: 'XXL', factor: 1.24 }
]

/**
 * Mini app "Mockup 3D": muestra uno o varios diseños sobre un producto 3D real (playera, taza,
 * termo o vaso) con React Three Fiber. Giro/zoom, color, tallas (playera), ubicaciones estándar,
 * luz de estudio y exportación. Recibe diseños por drag&drop o "Enviar a Mockup 3D".
 */
export default function Mockup3D(): React.JSX.Element {
  const [productId, setProductId] = useState('playera')
  const [layers, setLayers] = useState<Layer[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [color, setColor] = useState(GARMENT_COLORS[1].hex)
  const [sizeId, setSizeId] = useState('m')
  const [autoRotate, setAutoRotate] = useState(false)
  const [transparent, setTransparent] = useState(false)
  const [symShoulders, setSymShoulders] = useState(true)
  const [brightness, setBrightness] = useState(0.5)
  const [allOver, setAllOver] = useState(false)
  const [over, setOver] = useState(false)
  const [saved, setSaved] = useState(false)
  const [videoFormat, setVideoFormat] = useState<'mp4' | 'gif' | 'both'>('mp4')
  const [videoProg, setVideoProg] = useState<{ stage: string; pct: number } | null>(null)

  const idRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const canvasWrapRef = useRef<HTMLDivElement>(null)
  const captureRef = useRef<CaptureApi | null>(null)
  const layersRef = useRef<Layer[]>([])
  layersRef.current = layers
  const { consumeTransfer } = useShell()

  const product = PRODUCTS.find((p) => p.id === productId) ?? PRODUCTS[0]

  useEffect(() => () => layersRef.current.forEach((l) => URL.revokeObjectURL(l.url)), [])

  useEffect(() => {
    const t = consumeTransfer()
    if (t) addImage(new File([t.bytes], t.name, { type: 'image/png' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Progreso de la codificación ffmpeg (fase "Codificando…") que reporta el main.
  useEffect(() => {
    const off = window.api?.mockup3d?.onProgress?.((ev) =>
      setVideoProg((cur) => (cur ? { stage: ev.message ?? cur.stage, pct: ev.progress } : cur))
    )
    return off
  }, [])

  function addImage(file: File): void {
    const id = `layer-${++idRef.current}`
    const url = URL.createObjectURL(file)
    setLayers((ls) => [...ls, { id, url, name: file.name, xf: { ...product.defaultXf } }])
    setSelectedId(id)
  }

  function removeLayer(id: string): void {
    setLayers((ls) => {
      const found = ls.find((l) => l.id === id)
      if (found) URL.revokeObjectURL(found.url)
      return ls.filter((l) => l.id !== id)
    })
    setSelectedId((cur) => (cur === id ? null : cur))
  }

  /** Duplica un diseño (mismo logo, copia independiente) para colocarlo en OTRO lugar. */
  async function duplicateLayer(id: string): Promise<void> {
    const src = layers.find((l) => l.id === id)
    if (!src) return
    const blob = await (await fetch(src.url)).blob()
    const nid = `layer-${++idRef.current}`
    const url = URL.createObjectURL(blob)
    setLayers((ls) => [...ls, { id: nid, url, name: src.name, xf: { ...src.xf } }])
    setSelectedId(nid)
  }

  function handleFiles(files: FileList | null): void {
    for (const f of Array.from(files ?? [])) if (ACCEPT.includes(f.type)) addImage(f)
  }

  /** Cambiar de producto reposiciona los diseños a la ubicación por defecto del nuevo producto
   *  (las ubicaciones de playera no aplican a un cilindro y viceversa). */
  function changeProduct(id: string): void {
    const next = PRODUCTS.find((p) => p.id === id)
    if (!next) return
    setProductId(id)
    setLayers((ls) => ls.map((l) => ({ ...l, xf: { ...next.defaultXf } })))
  }

  const selected = layers.find((l) => l.id === selectedId) ?? null

  function updateSelected(patch: Partial<DecalXf>): void {
    if (!selectedId) return
    setLayers((ls) => {
      const sel = ls.find((l) => l.id === selectedId)
      if (!sel) return ls
      const selIsShoulder = sel.xf.side === 'left' || sel.xf.side === 'right'
      const mirror: Partial<DecalXf> = { ...patch }
      delete mirror.side
      return ls.map((l) => {
        if (l.id === selectedId) return { ...l, xf: { ...l.xf, ...patch } }
        if (product.garment && symShoulders && selIsShoulder && (l.xf.side === 'left' || l.xf.side === 'right')) {
          return { ...l, xf: { ...l.xf, ...mirror } }
        }
        return l
      })
    })
  }

  function applyPlacement(id: string): void {
    const p = product.placements.find((x) => x.id === id)
    if (p && selectedId) setLayers((ls) => ls.map((l) => (l.id === selectedId ? { ...l, xf: { ...p.xf } } : l)))
  }

  const sizeScale = product.garment
    ? (SIZES.find((s) => s.id === sizeId)?.factor ?? 1)
    : (product.viewScale ?? 1)
  // All-over: el 1er diseño cubre toda la superficie (sublimado full-print) en vez de ser un decal.
  const allOverUrl = allOver && layers[0] ? layers[0].url : undefined

  function savePng(): void {
    const canvas = canvasWrapRef.current?.querySelector('canvas')
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const suffix = product.garment ? `-${SIZES.find((s) => s.id === sizeId)?.label ?? 'M'}` : ''
      a.href = url
      a.download = `mockup-${product.id}-${(layers[0]?.name ?? 'diseno').replace(/\.[^.]+$/, '')}${suffix}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    }, 'image/png')
  }

  /** Captura el giro 360° del visor y lo codifica a MP4/GIF (ffmpeg en el main). */
  async function exportVideo(): Promise<void> {
    const cap = captureRef.current
    if (!cap || videoProg) return
    try {
      setVideoProg({ stage: 'Capturando giro…', pct: 0 })
      const frames = await cap({
        frames: 60,
        bg: '#f3f4f6',
        onProgress: (d, t) => setVideoProg({ stage: 'Capturando giro…', pct: (d / t) * 0.35 })
      })
      if (frames.length === 0) {
        setVideoProg(null)
        return
      }
      setVideoProg({ stage: 'Codificando…', pct: 0.4 })
      const res = await window.api?.mockup3d?.renderVideo(frames, {
        format: videoFormat,
        fps: 30,
        name: `mockup-${product.id}-360`
      })
      setVideoProg(null)
      if (res?.ok && res.saved) {
        setSaved(true)
        setTimeout(() => setSaved(false), 1500)
      }
    } catch {
      setVideoProg(null)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3">
        <p className="truncate text-sm text-muted-foreground">
          {layers.length === 0
            ? `Arrastrá uno o más diseños para verlos en 3D (${product.label.toLowerCase()})`
            : `${layers.length} diseño${layers.length > 1 ? 's' : ''} en ${product.label.toLowerCase()}`}
        </p>
        <button
          type="button"
          disabled={layers.length === 0}
          onClick={savePng}
          className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saved ? 'Guardado ✓' : 'Guardar PNG'}
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 p-6">
          <section
            className="relative flex min-w-0 flex-1 flex-col"
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
          >
            <div
              ref={canvasWrapRef}
              className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-border"
              style={{
                background: transparent
                  ? 'repeating-conic-gradient(#e5e7eb 0% 25%, #f9fafb 0% 50%) 50% / 20px 20px'
                  : '#f3f4f6'
              }}
            >
              <SceneBoundary>
                <Scene
                  decals={layers}
                  garmentColor={color}
                  modelUrl={product.model}
                  frontZ={product.frontZ}
                  normalize={!product.garment}
                  rotationY={product.rotationY}
                  autoRotate={autoRotate}
                  transparent={transparent}
                  brightness={brightness}
                  sizeScale={sizeScale}
                  allOverUrl={allOverUrl}
                  captureRef={captureRef}
                />
              </SceneBoundary>
            </div>
            {layers.length === 0 && (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="absolute inset-6 flex flex-col items-center justify-center gap-2 rounded-2xl text-muted-foreground"
              >
                <Upload className="h-8 w-8" />
                <span className="text-sm font-medium">Arrastrá o hacé clic para cargar tu diseño</span>
              </button>
            )}
            {over && (
              <div className="pointer-events-none absolute inset-6 rounded-2xl border-2 border-dashed border-foreground/50 bg-background/40" />
            )}
          </section>
        </div>

        <aside className="flex w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l border-border p-5">
          {/* Producto */}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Producto
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {PRODUCTS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => changeProduct(p.id)}
                  className={cn(
                    'rounded-lg border px-2 py-1.5 text-xs font-medium transition',
                    productId === p.id
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border hover:bg-muted'
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {/* Atribución CC-BY del único modelo de terceros (requisito de la licencia). */}
            {productId === 'gorra' && (
              <p className="mt-1.5 text-[10px] leading-tight text-muted-foreground">
                Modelo 3D: “Baseball Cap” de Scott VanArsdale (CC-BY 4.0), con modificaciones.
              </p>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Color {product.garment ? 'de la prenda' : 'del producto'}
            </h3>
            <div className="grid grid-cols-4 gap-2">
              {GARMENT_COLORS.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  title={c.name}
                  onClick={() => setColor(c.hex)}
                  className={cn(
                    'aspect-square rounded-lg border transition',
                    color === c.hex ? 'border-foreground ring-2 ring-foreground/30' : 'border-border'
                  )}
                  style={{ background: c.hex }}
                />
              ))}
            </div>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="mt-2 h-8 w-full cursor-pointer rounded-lg border border-border bg-transparent"
            />
          </div>

          {product.garment && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Talla
              </h3>
              <div className="grid grid-cols-3 gap-2">
                {SIZES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSizeId(s.id)}
                    className={cn(
                      'rounded-lg border px-2 py-1.5 text-xs font-medium transition',
                      sizeId === s.id
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border hover:bg-muted'
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-tight text-muted-foreground">
                Cambia el tamaño de la prenda; el estampado escala con ella (M = referencia).
              </p>
            </div>
          )}

          {/* Diseños */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Diseños
              </h3>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <ImagePlus className="h-3.5 w-3.5" /> Agregar
              </button>
            </div>
            {layers.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">Sin diseños todavía.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {layers.map((l) => (
                  <div
                    key={l.id}
                    className={cn(
                      'flex items-center gap-2 rounded-lg border p-1.5 transition',
                      selectedId === l.id ? 'border-foreground bg-muted' : 'border-border'
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(l.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <img src={l.url} alt="" className="h-8 w-8 shrink-0 rounded bg-background object-contain" />
                      <span className="truncate text-xs">{l.name}</span>
                    </button>
                    <button
                      type="button"
                      aria-label="Duplicar diseño"
                      title="Duplicar (mismo logo en otro lugar)"
                      onClick={() => void duplicateLayer(l.id)}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label="Quitar diseño"
                      onClick={() => removeLayer(l.id)}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {selected && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Diseño (logo)
              </h3>
              <label className="text-xs text-muted-foreground">Ubicación</label>
              <div className="mb-3 mt-1 grid grid-cols-2 gap-1.5">
                {product.placements.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyPlacement(p.id)}
                    className="rounded-md border border-border px-2 py-1 text-[11px] font-medium transition hover:bg-muted"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <label className="text-xs text-muted-foreground">Tamaño</label>
              <input
                type="range"
                min={0.05}
                max={0.6}
                step={0.005}
                value={selected.xf.scale}
                onChange={(e) => updateSelected({ scale: Number(e.target.value) })}
                className="w-full"
              />
              <label className="text-xs text-muted-foreground">Altura</label>
              <input
                type="range"
                min={-0.4}
                max={0.4}
                step={0.005}
                value={selected.xf.y}
                onChange={(e) => updateSelected({ y: Number(e.target.value) })}
                className="w-full"
              />
              <label className="text-xs text-muted-foreground">Horizontal</label>
              <input
                type="range"
                min={-0.35}
                max={0.35}
                step={0.005}
                value={selected.xf.x}
                onChange={(e) => updateSelected({ x: Number(e.target.value) })}
                className="w-full"
              />
              <label className="text-xs text-muted-foreground">Rotación</label>
              <input
                type="range"
                min={-3.14}
                max={3.14}
                step={0.02}
                value={selected.xf.rotation}
                onChange={(e) => updateSelected({ rotation: Number(e.target.value) })}
                className="w-full"
              />
            </div>
          )}

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Iluminación
            </h3>
            <label className="text-xs text-muted-foreground">Brillo</label>
            <input
              type="range"
              min={0.3}
              max={2}
              step={0.02}
              value={brightness}
              onChange={(e) => setBrightness(Number(e.target.value))}
              className="w-full"
            />
          </div>

          {/* Video 360° para enviar al cliente (MP4/GIF) */}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Video 360°
            </h3>
            <div className="mb-2 grid grid-cols-3 gap-2">
              {(['mp4', 'gif', 'both'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setVideoFormat(f)}
                  className={cn(
                    'rounded-lg border px-2 py-1.5 text-xs font-medium transition',
                    videoFormat === f
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border hover:bg-muted'
                  )}
                >
                  {f === 'mp4' ? 'MP4' : f === 'gif' ? 'GIF' : 'Ambos'}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={!!videoProg}
              onClick={() => void exportVideo()}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Video className="h-4 w-4" />
              {videoProg ? 'Generando…' : 'Exportar giro 360°'}
            </button>
            {videoProg && (
              <div className="mt-2">
                <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                  <div
                    className="brand-gradient h-full transition-all"
                    style={{ width: `${Math.round(videoProg.pct * 100)}%` }}
                  />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {videoProg.stage} {Math.round(videoProg.pct * 100)}%
                </p>
              </div>
            )}
            <p className="mt-1.5 text-[11px] leading-tight text-muted-foreground">
              Gira el producto 360° y lo exporta como video para mandar al cliente.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label className="flex items-center justify-between text-sm">
              <span>
                Estampado all-over
                <span className="ml-1 text-[10px] text-muted-foreground">(sublimado full)</span>
              </span>
              <input type="checkbox" checked={allOver} onChange={(e) => setAllOver(e.target.checked)} />
            </label>
            {product.garment && (
              <label className="flex items-center justify-between text-sm">
                <span>Hombros simétricos</span>
                <input
                  type="checkbox"
                  checked={symShoulders}
                  onChange={(e) => setSymShoulders(e.target.checked)}
                />
              </label>
            )}
            <label className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <Rotate3d className="h-4 w-4" /> Giro automático
              </span>
              <input type="checkbox" checked={autoRotate} onChange={(e) => setAutoRotate(e.target.checked)} />
            </label>
            <label className="flex items-center justify-between text-sm">
              <span>Fondo transparente</span>
              <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} />
            </label>
          </div>
        </aside>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  )
}
