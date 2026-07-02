import { EmptyState } from './EmptyState'

/** Tab "Proyectos": por ahora vacío; se llena cuando una mini app guarde trabajo. */
export function ProjectsView(): React.JSX.Element {
  return (
    <EmptyState
      title="Aún no hay proyectos"
      message="Cuando guardes trabajo desde una herramienta, tus proyectos aparecerán acá."
    />
  )
}
