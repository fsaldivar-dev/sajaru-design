import { useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { applyTheme, getTheme, type Theme } from '@renderer/lib/theme'

/** Botón claro/oscuro compartido por el grid y las mini apps (misma experiencia en toda la suite). */
export function ThemeToggle(): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(getTheme)
  const toggle = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    setTheme(next)
  }
  return (
    <button
      type="button"
      onClick={toggle}
      title={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}
      aria-label="Cambiar tema"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  )
}
