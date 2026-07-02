import { useEffect, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import type { PrintPrepConfig } from '@shared/types'
import { cn } from '@renderer/lib/cn'
import { useRevokeOnUnmount } from '@renderer/lib/useRevokeOnUnmount'
import { useShell } from '@renderer/lib/shell'
import { CHECKER, IMAGE_ACCEPT as ACCEPT } from '@renderer/lib/image'

const PRESETS = [
  { label: 'Playera frente', w: 11, h: 14 },
  { label: 'Playera bolsillo', w: 4, h: 4 },
  { label: 'Taza 11oz', w: 8.5, h: 3.5 },
  { label: 'Gorra', w: 5, h: 2.5 },
  { label: 'Mousepad', w: 9.5, h: 8 }
]

interface SourceImage {
  url: string
  name: string
}

/** Mini app "Preparar Sublimación": tamaño físico + 300 DPI + espejo para transfer. */
export default function PrepararSublimacion(): React.JSX.Element {
  const [config, setConfig] = useState<PrintPrepConfig>({ widthIn: 11, heightIn: 14, mirror: true, format: 'png' })
  const [source, setSource] = useState<SourceImage | null>(null)
  const [result, setResult] = useState<{ url: string; w: number; h: number; dpi: number; mirror: boolean } | null>(null)
  const [progress, setProgress] = useState<{ value: number; message?: string } | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [over, setOver] = useState(false)
  const tokenRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = progress !== null
  const { consumeTransfer } = useShell()
  useRevokeOnUnmount(source?.url, result?.url)

  useEffect(() => {
    return window.api.printPrep.onProgress((ev) => setProgress({ value: ev.progress, message: ev.message }))
  }, [])

  // Handoff: si otra mini app nos mandó una imagen ("Enviar a → Preparar"), la
  // pre-cargamos al montar. consumeTransfer() es consume-once: no recarga en re-renders.
  useEffect(() => {
    const t = consumeTransfer()
    if (t) void onFile(new File([t.bytes], t.name, { type: 'image/png' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function run(cfg: PrintPrepConfig): Promise<void> {
    // Sin guarda `if (!source) return`: en la 1ª carga el closure aún ve source=null
    // y abortaría el auto-procesado. Los callers (onFile/efecto reactivo) ya garantizan imagen.
    const token = ++tokenRef.current
    setError(null)
    setProgress({ value: 0, message: 'Preparando…' })
    const r = await window.api.printPrep.process(cfg)
    if (token !== tokenRef.current) return
    setProgress(null)
    if (!r.ok) {
      setError(r.error ?? { code: 'E_PREP', message: 'Falló la preparación' })
      return
    }
    if (r.bytes) {
      const type = cfg.format === 'tiff' ? 'image/tiff' : 'image/png'
      const url = URL.createObjectURL(new Blob([r.bytes], { type }))
      const d = (r.data ?? {}) as { width?: number; height?: number; dpi?: number; mirror?: boolean }
      setResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)
        return { url, w: d.width ?? 0, h: d.height ?? 0, dpi: d.dpi ?? 300, mirror: Boolean(d.mirror) }
      })
    }
  }

  async function onFile(file: File): Promise<void> {
    const ab = await file.arrayBuffer()
    setSource((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return { url: URL.createObjectURL(file), name: file.name }
    })
    setResult(null)
    await window.api.printPrep.setImage(ab, file.name)
    void run(config)
  }

  useEffect(() => {
    if (!source) return
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void run(config), 300)
    return () => clearTimeout(debounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  function handleFiles(files: FileList | null): void {
    const f = files?.[0]
    if (f && ACCEPT.includes(f.type)) void onFile(f)
  }
  function set<K extends keyof PrintPrepConfig>(key: K, value: PrintPrepConfig[K]): void {
    setConfig((c) => ({ ...c, [key]: value }))
  }
  const isTiff = result && config.format === 'tiff'

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3">
        <p className="truncate text-sm text-muted-foreground">
          {result ? `${result.w}×${result.h}px · ${config.widthIn}×${config.heightIn}in @ ${result.dpi} DPI${result.mirror ? ' · espejo ✓' : ''}` : 'Prepará tu diseño para imprimir en transfer'}
        </p>
        <button type="button" disabled={!result || busy} onClick={() => void (result && window.api.printPrep.saveResult(`transfer.${config.format}`))} className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
          Guardar
        </button>
      </div>

      {progress && (
        <div className="shrink-0 border-b border-border px-6 py-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="brand-gradient h-full transition-all" style={{ width: `${Math.round(progress.value * 100)}%` }} />
          </div>
        </div>
      )}
      {error && !busy && <div className="shrink-0 border-b border-border bg-muted px-6 py-2 text-sm text-muted-foreground">{error.message}</div>}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 p-6">
          {source ? (
            <section
              className="relative flex h-full min-w-0 flex-col"
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
                <h3 className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">Listo para transfer</h3>
                <button type="button" onClick={() => inputRef.current?.click()} className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground">
                  Cambiar imagen
                </button>
              </div>
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-border" style={{ background: CHECKER }}>
                {isTiff ? (
                  <p className="text-sm text-muted-foreground">TIFF generado a {result?.dpi} DPI (sin vista previa)</p>
                ) : result ? (
                  <img src={result.url} alt="Listo para transfer" className="h-full w-full object-contain p-4" />
                ) : null}
              </div>
              {over && (
                <div className="pointer-events-none absolute inset-0 rounded-2xl border-2 border-dashed border-foreground/50 bg-background/40" />
              )}
            </section>
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
              <p className="text-base font-semibold">Arrastra tu diseño aquí</p>
              <p className="mt-1 text-sm text-muted-foreground">Ideal: PNG sin fondo, ya vectorizado o en alta resolución</p>
            </div>
          )}
          <input ref={inputRef} type="file" accept={ACCEPT.join(',')} hidden onChange={(e) => handleFiles(e.target.files)} />
        </div>

        <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-border p-6">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tamaño físico</h3>
          <div className="mb-4 space-y-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                disabled={busy}
                onClick={() => setConfig((c) => ({ ...c, widthIn: p.w, heightIn: p.h }))}
                className={cn('flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition disabled:opacity-40', config.widthIn === p.w && config.heightIn === p.h ? 'border-foreground bg-foreground text-background' : 'border-border hover:bg-muted')}
              >
                <span className="font-medium">{p.label}</span>
                <span className={cn('text-xs', config.widthIn === p.w && config.heightIn === p.h ? 'text-background/70' : 'text-muted-foreground')}>{p.w}×{p.h}″</span>
              </button>
            ))}
          </div>

          <div className="mb-4 flex gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-xs text-muted-foreground">Ancho (in)</label>
              <input type="number" min={1} max={60} step={0.5} value={config.widthIn} disabled={busy} onChange={(e) => set('widthIn', Number(e.target.value))} className="w-full rounded-lg border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-foreground/40" />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs text-muted-foreground">Alto (in)</label>
              <input type="number" min={1} max={60} step={0.5} value={config.heightIn} disabled={busy} onChange={(e) => set('heightIn', Number(e.target.value))} className="w-full rounded-lg border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-foreground/40" />
            </div>
          </div>

          <label className="mb-3 flex cursor-pointer items-center justify-between gap-2 text-sm font-medium">
            <span>Espejo (para transfer)</span>
            <input type="checkbox" checked={config.mirror} disabled={busy} onChange={(e) => set('mirror', e.target.checked)} className="h-4 w-4 accent-primary" />
          </label>
          <p className="mb-4 text-xs text-muted-foreground">En sublimación el diseño se imprime invertido para que quede bien al transferirlo.</p>

          <label className="mb-1 block text-sm font-medium">Formato</label>
          <div className="flex gap-2">
            {(['png', 'tiff'] as const).map((f) => (
              <button key={f} type="button" disabled={busy} onClick={() => set('format', f)} className={cn('flex-1 rounded-lg border px-2 py-2 text-sm font-medium uppercase transition disabled:opacity-40', config.format === f ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground')}>
                {f}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Salida a 300 DPI. TIFF para máxima calidad de impresión.</p>
        </aside>
      </div>
    </div>
  )
}
