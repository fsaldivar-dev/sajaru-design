import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { applyTheme, getTheme } from './lib/theme'

// DEV/navegador: si no está el puente de Electron (window.api), poné un stub no-op para poder
// abrir la app en un navegador normal (p.ej. probar el Mockup 3D, que no usa window.api). En la
// app real el preload define window.api, así que este stub NO se activa en producción.
{
  const w = window as unknown as { api?: unknown }
  if (!w.api) {
    const stub = (): unknown =>
      new Proxy(function () {}, {
        get: (_t, p) => (p === 'then' ? undefined : stub()),
        // Cada llamada devuelve algo que sirve como Promise (await/.then → undefined) Y como
        // función de limpieza no-op (return de useEffect, p.ej. onProgress). Así no crashea.
        apply: () => {
          const f = (): void => {}
          ;(f as unknown as { then: (on?: (v: unknown) => void) => Promise<unknown> }).then = (on) => {
            if (on) on(undefined)
            return Promise.resolve(undefined)
          }
          return f
        }
      })
    w.api = stub()
  }
}

// Aplica el tema antes del primer render (la ventana no se muestra hasta ready-to-show).
applyTheme(getTheme())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
