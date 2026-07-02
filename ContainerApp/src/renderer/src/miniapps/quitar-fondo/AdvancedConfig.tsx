import { useState } from 'react'
import { Box, Brush, ChevronUp, Sparkles, User } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { FieldLabel, Segmented, Slider, Toggle } from './controls'
import type { Config } from './types'

export function AdvancedConfig({
  config,
  onChange
}: {
  config: Config
  onChange: <K extends keyof Config>(key: K, value: Config[K]) => void
}) {
  const [open, setOpen] = useState(true)
  const [advOpen, setAdvOpen] = useState(false)

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mb-4 flex w-full items-center justify-between"
      >
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Ajustes
        </h3>
        <ChevronUp className={cn('h-4 w-4 text-muted-foreground transition', !open && 'rotate-180')} />
      </button>

      {open && (
        <div className="space-y-5">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <FieldLabel>Tipo de imagen</FieldLabel>
              <span className="text-xs text-muted-foreground">{config.imageType.toUpperCase()}</span>
            </div>
            <Segmented
              value={config.imageType}
              onChange={(v) => onChange('imageType', v)}
              options={[
                { value: 'auto', label: 'Auto', icon: <Sparkles className="h-4 w-4" /> },
                { value: 'logo', label: 'Logo', icon: <Box className="h-4 w-4" /> },
                { value: 'persona', label: 'Persona', icon: <User className="h-4 w-4" /> },
                { value: 'ilustracion', label: 'Ilustración', icon: <Brush className="h-4 w-4" /> }
              ]}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {config.imageType === 'persona'
                ? 'Persona: recupera el cabello (matting de hebras finas).'
                : config.imageType === 'logo'
                  ? 'Logo: bordes nítidos; ideal vectorizar después.'
                  : config.imageType === 'ilustracion'
                    ? 'Ilustración: bordes definidos, colores planos.'
                    : 'Auto: detecta el tipo solo.'}
            </p>
          </div>

          <div>
            <FieldLabel>Calidad</FieldLabel>
            <div className="mt-2">
              <Segmented
                value={config.bgProvider}
                onChange={(v) => onChange('bgProvider', v)}
                options={[
                  { value: 'local', label: 'Estándar' },
                  { value: 'recraft', label: 'Premium (IA)' }
                ]}
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {config.bgProvider === 'recraft'
                ? 'IA premium en la nube (~$0.01/img, requiere API key). Tocá Reprocesar para aplicar.'
                : 'Local — gratis y privado, sin enviar tu imagen a ningún lado.'}
            </p>
          </div>

          <div>
            <FieldLabel>Detalle (fotos)</FieldLabel>
            <div className="mt-2">
              <Segmented
                value={config.model}
                onChange={(v) => onChange('model', v)}
                options={[
                  { value: 'birefnet', label: 'Máxima' },
                  { value: 'u2netp', label: 'Rápida' }
                ]}
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {config.model === 'u2netp'
                ? 'Rápida: liviana, menor precisión en bordes.'
                : 'Máxima: mejor calidad en sujetos y bordes (~213MB la 1ª vez).'}
            </p>
          </div>

          <div>
            <FieldLabel>Borde</FieldLabel>
            <div className="mt-2">
              <Segmented
                value={config.edgeMode}
                onChange={(v) => onChange('edgeMode', v)}
                options={[
                  { value: 'duro', label: 'Nítido' },
                  { value: 'suave', label: 'Suave' }
                ]}
              />
            </div>
            <button
              type="button"
              onClick={() => setAdvOpen((o) => !o)}
              className="mt-2 flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
            >
              <ChevronUp className={cn('h-3.5 w-3.5 transition', !advOpen && 'rotate-180')} />
              Avanzado
            </button>
            {advOpen && (
              <div className="mt-3 space-y-4 border-l border-border pl-3">
                <Slider label="Suavidad" value={config.softness} onChange={(v) => onChange('softness', v)} />
                <Slider
                  label="Reducir borde (px)"
                  value={config.contract}
                  min={0}
                  max={8}
                  onChange={(v) => onChange('contract', v)}
                />
                <Slider
                  label="Tolerancia fondo"
                  value={config.bgTolerance}
                  onChange={(v) => onChange('bgTolerance', v)}
                />
                <Toggle
                  label="Expandir borde +1px"
                  checked={config.expandEdge}
                  onChange={(v) => onChange('expandEdge', v)}
                />
              </div>
            )}
          </div>

          <div>
            <FieldLabel>Post-procesado</FieldLabel>
            <div className="mt-1">
              <Toggle label="Limpiar artefactos" checked={config.cleanArtifacts} onChange={(v) => onChange('cleanArtifacts', v)} />
              <Toggle label="Recortar a contenido" checked={config.autoCrop} onChange={(v) => onChange('autoCrop', v)} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {config.autoCrop
                ? 'Recorta los márgenes transparentes (el diseño llena el área). Cambia las dimensiones.'
                : '¿Subir resolución o tamaño físico para imprimir? Eso vive en '}
              {!config.autoCrop && (
                <>
                  <strong>Mejorar</strong> y <strong>Preparar Sublimación</strong>.
                </>
              )}
            </p>
          </div>

          <div>
            <FieldLabel>Formato</FieldLabel>
            <div className="mt-2">
              <Segmented
                value={config.format}
                onChange={(v) => onChange('format', v)}
                options={[
                  { value: 'png', label: 'PNG' },
                  { value: 'tiff', label: 'TIFF' }
                ]}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
