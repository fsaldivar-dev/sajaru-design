import { useEffect, useRef, useState } from 'react'
import { Sparkles, Wand2 } from 'lucide-react'
import type { GenerateConfig } from '@shared/types'
import { cn } from '@renderer/lib/cn'
import { CHECKER } from '@renderer/lib/image'
import { ZoomableImage } from '@renderer/components/ZoomableImage'
import { useRevokeOnUnmount } from '@renderer/lib/useRevokeOnUnmount'

const PRESETS = [
  { id: 'vector', label: 'Vector / Logo', model: 'recraftv3_vector', style: 'vector_illustration', hint: 'SVG escalable — ideal para logos y sublimado' },
  { id: 'flat', label: 'Ilustración plana', model: 'recraftv3', style: 'digital_illustration', hint: 'Estilo plano/cartoon — PNG' },
  { id: 'real', label: 'Realista', model: 'recraftv3', style: 'realistic_image', hint: 'Foto-realista — PNG' }
] as const

const SIZES = [
  { v: '1024x1024', l: 'Cuadrado' },
  { v: '1024x1365', l: 'Vertical' },
  { v: '1365x1024', l: 'Horizontal' }
]

/** Mini app "Crear Diseño": genera arte/logos desde un prompt con Recraft (IA premium). */
export default function CrearDiseno(): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [presetId, setPresetId] = useState<(typeof PRESETS)[number]['id']>('vector')
  const [size, setSize] = useState('1024x1024')
  const [result, setResult] = useState<{ url: string; format: string } | null>(null)
  const [progress, setProgress] = useState<{ value: number; message?: string } | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)
  const tokenRef = useRef(0)
  const busy = progress !== null
  useRevokeOnUnmount(result?.url)

  useEffect(() => {
    void window.api.generate.hasApiKey().then(setHasKey)
    return window.api.generate.onProgress((ev) => setProgress({ value: ev.progress, message: ev.message }))
  }, [])

  async function onGenerate(): Promise<void> {
    if (!prompt.trim() || busy) return
    const preset = PRESETS.find((p) => p.id === presetId)!
    const cfg: GenerateConfig = { prompt: prompt.trim(), model: preset.model, style: preset.style, size }
    const token = ++tokenRef.current
    setError(null)
    setProgress({ value: 0, message: 'Generando…' })
    const r = await window.api.generate.process(cfg)
    if (token !== tokenRef.current) return
    setProgress(null)
    if (!r.ok) {
      setError(r.error ?? { code: 'E_GEN', message: 'Falló la generación' })
      return
    }
    if (r.bytes) {
      const type = r.format === 'svg' ? 'image/svg+xml' : 'image/png'
      const url = URL.createObjectURL(new Blob([r.bytes], { type }))
      setResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)
        return { url, format: r.format ?? 'png' }
      })
    }
  }

  async function onCopy(): Promise<void> {
    const r = await window.api.generate.copyResult()
    if (r.copied) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  async function onSave(): Promise<void> {
    if (!result) return
    const ext = result.format
    await window.api.generate.saveResult(`diseno.${ext}`)
  }

  const noKey = error?.code === 'E_NO_API_KEY' || hasKey === false

  return (
    <div className="flex h-full flex-col">
      {/* Barra de acción */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3">
        <p className="truncate text-sm text-muted-foreground">Generá un diseño desde texto (Recraft · IA premium)</p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={!result || busy || result.format === 'svg'}
            onClick={() => void onCopy()}
            title={result?.format === 'svg' ? 'El SVG no se copia como imagen; usá Guardar' : 'Copiar PNG'}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copied ? 'Copiado ✓' : 'Copiar'}
          </button>
          <button
            type="button"
            disabled={!result || busy}
            onClick={() => void onSave()}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            Guardar
          </button>
        </div>
      </div>

      {/* Aviso de API key faltante */}
      {noKey && (
        <div className="shrink-0 border-b border-border bg-muted px-6 py-2 text-xs text-muted-foreground">
          ⚠️ Falta la API key de Recraft. Definí la variable <code className="rounded bg-background px-1">RECRAFT_API_TOKEN</code> o pegá la key en <code className="rounded bg-background px-1">~/.sajaru/recraft.key</code> y reiniciá la app.
        </div>
      )}

      {/* Progreso */}
      {progress && (
        <div className="shrink-0 border-b border-border px-6 py-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="brand-gradient h-full transition-all" style={{ width: `${Math.round(progress.value * 100)}%` }} />
          </div>
          {progress.message && <p className="mt-1 text-xs text-muted-foreground">{progress.message}</p>}
        </div>
      )}

      {/* Error (no-key se muestra arriba) */}
      {error && !busy && !noKey && (
        <div className="shrink-0 border-b border-border bg-muted px-6 py-2 text-sm text-muted-foreground">{error.message}</div>
      )}

      {/* Fila principal: input (izq) + resultado (der) */}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-border p-6">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Describí tu diseño</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void onGenerate()
              }}
              rows={5}
              placeholder="Ej: logo minimalista de un lobo geométrico, dos colores, estilo flat para playera"
              className="w-full resize-none rounded-lg border border-border bg-transparent p-3 text-sm outline-none focus:border-foreground/40"
            />
            <p className="mt-1 text-xs text-muted-foreground">Tip: ⌘/Ctrl + Enter para generar.</p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Estilo</label>
            <div className="space-y-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={busy}
                  onClick={() => setPresetId(p.id)}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-left transition disabled:opacity-40',
                    presetId === p.id ? 'border-foreground bg-foreground text-background' : 'border-border hover:bg-muted'
                  )}
                >
                  <div className="text-sm font-medium">{p.label}</div>
                  <div className={cn('text-xs', presetId === p.id ? 'text-background/70' : 'text-muted-foreground')}>{p.hint}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Proporción</label>
            <div className="flex gap-2">
              {SIZES.map((s) => (
                <button
                  key={s.v}
                  type="button"
                  disabled={busy}
                  onClick={() => setSize(s.v)}
                  className={cn(
                    'flex-1 rounded-lg border px-2 py-2 text-xs font-medium transition disabled:opacity-40',
                    size === s.v ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {s.l}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            disabled={!prompt.trim() || busy}
            onClick={() => void onGenerate()}
            className="mt-1 flex items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Wand2 className="h-4 w-4" />
            {busy ? 'Generando…' : 'Generar'}
          </button>
        </div>

        {/* Resultado */}
        <div className="min-w-0 flex-1 p-6">
          {result ? (
            <ZoomableImage src={result.url} alt="Diseño generado" background={CHECKER} />
          ) : (
            <div className="flex h-full w-full items-center justify-center rounded-2xl border border-border bg-muted/40">
              <div className="flex max-w-xs flex-col items-center text-center text-muted-foreground">
                <Sparkles className="mb-3 h-9 w-9" />
                <p className="text-sm font-medium">Escribí un prompt y generá</p>
                <p className="mt-1 text-xs">Con estilo Vector obtenés un SVG escalable, ideal para sublimar.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
