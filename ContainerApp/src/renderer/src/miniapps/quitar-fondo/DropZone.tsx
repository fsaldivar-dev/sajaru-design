import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { SourceImage } from './types'

import { IMAGE_ACCEPT as ACCEPT } from '@renderer/lib/image'

export function DropZone({
  source,
  onFiles,
  compact,
  multiple
}: {
  source: SourceImage | null
  onFiles: (files: File[]) => void
  /** Variante chica para usar como tarjeta de REFERENCIA del original en un panel. */
  compact?: boolean
  /** Permite seleccionar/soltar varias imágenes a la vez (multi-imagen). */
  multiple?: boolean
}) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function handleFiles(files: FileList | null): void {
    const valid = Array.from(files ?? []).filter((f) => ACCEPT.includes(f.type))
    if (valid.length > 0) onFiles(valid)
  }

  return (
    <section className={cn('flex flex-col', compact ? 'shrink-0' : 'h-full')}>
      {!compact && (
        <h3 className="mb-2 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Imagen original
        </h3>
      )}
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
          'group relative flex w-full cursor-pointer flex-col items-center justify-center overflow-hidden border-dashed bg-muted/30 text-center transition',
          compact ? 'aspect-square rounded-xl border' : 'min-h-0 flex-1 rounded-2xl border-2',
          over ? 'border-foreground/40 bg-muted' : 'border-border',
          source && 'border-solid bg-transparent'
        )}
      >
        {source ? (
          <>
            <img src={source.url} alt={source.name} className="h-full w-full object-contain" />
            <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-lg bg-foreground/90 px-3 py-1 text-xs font-medium text-background opacity-0 transition group-hover:opacity-100">
              {multiple ? 'Click para agregar imágenes' : 'Click para cambiar imagen'}
            </span>
          </>
        ) : compact ? (
          <>
            <Upload className="mb-1.5 h-6 w-6 text-muted-foreground" />
            <p className="px-2 text-xs text-muted-foreground">Arrastrá o hacé click</p>
          </>
        ) : (
          <>
            <Upload className="mb-3 h-9 w-9 text-muted-foreground" />
            <p className="text-base font-semibold">Arrastra tu imagen aquí</p>
            <p className="mt-1 text-sm text-muted-foreground">JPG · PNG · WEBP</p>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT.join(',')}
        multiple={multiple}
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
    </section>
  )
}
