/** Tema claro/oscuro, controlado in-app (clase `.dark` en <html>). Default: oscuro (look pro). */
export type Theme = 'light' | 'dark'

const KEY = 'sajaru-theme'

export function getTheme(): Theme {
  return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
}

export function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle('dark', t === 'dark')
  localStorage.setItem(KEY, t)
}
