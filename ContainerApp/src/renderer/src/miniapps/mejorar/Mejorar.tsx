import { useEffect, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import type { UpscaleConfig } from '@shared/types'
import { cn } from '@renderer/lib/cn'
import { CompareView } from '@renderer/components/CompareView'
import { useRevokeOnUnmount } from '@renderer/lib/useRevokeOnUnmount'
import { OP_COST, recordUsage } from '@renderer/lib/premium'

import { CHECKER, IMAGE_ACCEPT as ACCEPT } from '@renderer/lib/image'

const DEFAULT_CONFIG: UpscaleConfig = { scale: 2, sharpen: true, method: 'classic' }
const SCALES = [2, 3, 4]

interface SourceImage {
  url: string
  name: string
  file: File
  w: number
  h: number
}

/**
 * Mini app "Mejorar / Aumentar resolución": agranda una imagen (upscale lanczos
 * + nitidez del sidecar, preserva alfa). Reactiva: re-procesa al cambiar factor
 * o nitidez. Útil para logos/diseños chicos antes de imprimir.
 */
export default function Mejorar(): React.JSX.Element {
  const [config, setConfig] = useState<UpscaleConfig>(DEFAULT_CONFIG)
  const [source, setSource] = useState<SourceImage | null>(null)
  const [result, setResult] = useState<{ url: string; w: number; h: number } | null>(null)
  const [progress, setProgress] = useState<{ value: number; message?: string } | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [over, setOver] = useState(false)

  const tokenRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = progress !== null
  useRevokeOnUnmount(source?.url, result?.url)

  useEffect(() => {
    return window.api.upscale.onProgress((ev) => {
      setProgress({ value: ev.progress, message: ev.message })
    })
  }, [])

  async function run(cfg: UpscaleConfig): Promise<void> {
    // Sin guarda `if (!source) return`: en la 1ª carga el closure aún ve source=null
    // y abortaría el auto-procesado. Los callers (onFile/efecto reactivo) ya garantizan imagen.
    const token = ++tokenRef.current
    setError(null)
    setProgress({ value: 0, message: `Mejorando ×${cfg.scale}…` })

    const r = await window.api.upscale.process(cfg)
    if (r.ok && cfg.method === 'recraft') recordUsage(OP_COST.upscaleCrisp)
    if (token !== tokenRef.current) return

    setProgress(null)
    if (!r.ok) {
      setError(r.error ?? { code: 'E_UPSCALE', message: 'Falló el procesamiento' })
      return
    }
    if (r.bytes) {
      const url = URL.createObjectURL(new Blob([r.bytes], { type: 'image/png' }))
      const d = (r.data ?? {}) as { width?: number; height?: number }
      setResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)
        return { url, w: d.width ?? 0, h: d.height ?? 0 }
      })
    }
  }

  async function onFile(file: File): Promise<void> {
    const ab = await file.arrayBuffer()
    const url = URL.createObjectURL(file)
    const dims = await new Promise<{ w: number; h: number }>((res) => {
      const img = new Image()
      img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight })
      img.onerror = () => res({ w: 0, h: 0 })
      img.src = url
    })
    setSource((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return { url, name: file.name, file, ...dims }
    })
    setResult(null)
    await window.api.upscale.setImage(ab, file.name)
    if (config.method === 'classic') void run(config)
  }

  // Reactivo SOLO para el método clásico (rápido). IA local (descarga+inferencia)
  // y Recraft (API de pago) se disparan con botón explícito — no en cada cambio.
  useEffect(() => {
    if (!source || config.method !== 'classic') return
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void run(config), 400)
    return () => clearTimeout(debounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  function handleFiles(files: FileList | null): void {
    const f = files?.[0]
    if (f && ACCEPT.includes(f.type)) void onFile(f)
  }

  function set<K extends keyof UpscaleConfig>(key: K, value: UpscaleConfig[K]): void {
    setConfig((c) => ({ ...c, [key]: value }))
  }

  const baseName = (): string => (source?.name ?? 'imagen').replace(/\.[^.]+$/, '')

  async function onCopy(): Promise<void> {
    const r = await window.api.upscale.copyResult()
    if (r.copied) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Barra de acción */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3">
        <p className="truncate text-sm text-muted-foreground">
          {source ? `${source.name} · ${source.w}×${source.h}` : 'Arrastrá una imagen para mejorar'}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={!result || busy}
            onClick={() => void onCopy()}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copied ? 'Copiado ✓' : 'Copiar'}
          </button>
          <button
            type="button"
            disabled={!result || busy}
            onClick={() => void (result && window.api.upscale.saveResult(`${baseName()}-x${config.scale}.png`))}
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Guardar PNG
          </button>
        </div>
      </div>

      {/* Progreso */}
      {progress && (
        <div className="shrink-0 border-b border-border px-6 py-2">
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="brand-gradient h-full transition-all" style={{ width: `${Math.round(progress.value * 100)}%` }} />
            <div className="pointer-events-none absolute inset-y-0 left-0 w-1/3 animate-[sajaru-shimmer_1.2s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-foreground/30 to-transparent" />
          </div>
          {progress.message && <p className="mt-1 text-xs text-muted-foreground">{progress.message}</p>}
        </div>
      )}

      {/* Error */}
      {error && !busy && (
        <div className="shrink-0 border-b border-border bg-muted px-6 py-2 text-sm text-muted-foreground">
          {error.message}
        </div>
      )}

      {/* Fila principal: original | resultado | config */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 p-6">
          {source ? (
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
              <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Mejorada · rueda = zoom · mantené “Ver original” para comparar
                </h3>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  Cambiar imagen
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <CompareView
                  before={source.url}
                  after={result?.url ?? null}
                  beforeLabel={`Original · ${source.w}×${source.h}`}
                  afterLabel={result?.w ? `Mejorada · ${result.w}×${result.h}` : 'Mejorada'}
                  background={CHECKER}
                />
              </div>
              {over && (
                <div className="pointer-events-none absolute inset-0 rounded-2xl border-2 border-dashed border-foreground/50 bg-background/40" />
              )}
            </section>
          ) : (
            <section className="flex min-w-0 flex-1 flex-col">
              <h3 className="mb-2 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Imagen original
              </h3>
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
                className={cn(
                  'flex min-h-0 w-full flex-1 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed bg-muted/30 text-center transition',
                  over ? 'border-foreground/40 bg-muted' : 'border-border'
                )}
              >
                <Upload className="mb-3 h-9 w-9 text-muted-foreground" />
                <p className="text-base font-semibold">Arrastra tu imagen aquí</p>
                <p className="mt-1 text-sm text-muted-foreground">JPG · PNG · WEBP</p>
              </div>
            </section>
          )}
          <input ref={inputRef} type="file" accept={ACCEPT.join(',')} hidden onChange={(e) => handleFiles(e.target.files)} />
        </div>

        {/* Config */}
        <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-border p-6">
          <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ajustes</h3>

          <label className="mb-1 block text-sm font-medium">Método</label>
          <div className="flex gap-1.5">
            {(['classic', 'ai', 'recraft'] as const).map((m) => (
              <button
                key={m}
                type="button"
                disabled={busy}
                onClick={() => set('method', m)}
                className={cn(
                  'flex-1 rounded-lg border px-1.5 py-2 text-xs font-medium transition disabled:opacity-40',
                  config.method === m
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {m === 'classic' ? 'Clásico' : m === 'ai' ? 'IA Local' : 'IA Premium'}
              </button>
            ))}
          </div>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">
            {config.method === 'recraft'
              ? 'Recraft (IA premium, ~$0.004/img). Requiere API key. Reconstruye detalle.'
              : config.method === 'ai'
                ? 'Real-ESRGAN local: bordes nítidos, gratis/privado. La 1ª vez descarga el modelo (~70 MB).'
                : 'Lanczos + nitidez: rápido, sin descargas. Para fotos/diseños generales.'}
          </p>

          {config.method !== 'classic' && (
            <button
              type="button"
              disabled={!source || busy}
              onClick={() => void run(config)}
              className="mb-5 w-full rounded-lg bg-foreground px-4 py-2.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Procesando…' : config.method === 'recraft' ? 'Aplicar IA Premium' : `Aplicar IA ×${config.scale}`}
            </button>
          )}

          <label className="mb-1 block text-sm font-medium">Factor de aumento</label>
          <div className="flex gap-2">
            {SCALES.map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() => set('scale', s)}
                className={cn(
                  'flex-1 rounded-lg border px-2 py-2 text-sm font-medium transition disabled:opacity-40',
                  config.scale === s
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                ×{s}
              </button>
            ))}
          </div>
          {source ? (
            <p className="mt-1 mb-5 text-xs text-muted-foreground">
              {source.w}×{source.h} → {source.w * config.scale}×{source.h * config.scale} px
            </p>
          ) : (
            <p className="mt-1 mb-5 text-xs text-muted-foreground">Cuánto agrandar la imagen.</p>
          )}

          {config.method === 'classic' && (
            <>
              <label className="flex cursor-pointer items-center justify-between gap-2 text-sm font-medium">
                <span>Nitidez</span>
                <input
                  type="checkbox"
                  checked={config.sharpen}
                  disabled={busy}
                  onChange={(e) => set('sharpen', e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
              </label>
              <p className="mt-1 text-xs text-muted-foreground">
                Realza los bordes tras agrandar. Desactivá si la imagen ya es nítida.
              </p>
            </>
          )}

          {!source && (
            <p className="mt-6 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              Para logos planos, <strong>Vectorizar</strong> da mejor resultado (nítido a cualquier
              tamaño). Mejorar es para fotos y diseños con textura.
            </p>
          )}
        </aside>
      </div>
    </div>
  )
}
