interface Props {
  title: string
  message: string
}

/** Estado vacío reutilizable (sin resultados, sin proyectos, etc.). */
export function EmptyState({ title, message }: Props): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{message}</p>
    </div>
  )
}
