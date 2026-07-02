import type { MiniAppEntry } from './types'

/**
 * Registro de mini apps que muestra el container.
 *
 * Cada entrada = una herramienta (tile) en la grilla, agrupada por categoría.
 * Las marcadas como 'coming-soon' son placeholders del mockup. Cuando termines
 * de diseñar una mini app real, reemplazá su entrada agregando `load` y
 * cambiando el status a 'ready', por ejemplo:
 *
 *   {
 *     manifest: {
 *       id: 'playeras-quitar-fondo',
 *       name: 'Quitar fondo',
 *       category: 'Sublimado Playeras',
 *       uses: ['remove-background'],
 *       status: 'ready'
 *     },
 *     load: () => import('./sublimado-playeras/QuitarFondo')
 *   }
 */
export const miniApps: MiniAppEntry[] = [
  // — Diseño y recursos (cross-producto) —
  {
    manifest: { id: 'crear-diseno', name: 'Crear diseño', category: 'Diseño y recursos', uses: ['generate'], status: 'ready' },
    load: () => import('./crear-diseno/CrearDiseno')
  },
  {
    manifest: { id: 'preparar-sublimacion', name: 'Preparar sublimación', category: 'Diseño y recursos', uses: ['print-prep'], status: 'ready' },
    load: () => import('./preparar-sublimacion/PrepararSublimacion')
  },
  {
    manifest: { id: 'editar', name: 'Editar imagen', category: 'Diseño y recursos', uses: ['editor'], status: 'ready' },
    load: () => import('./editor/Editor')
  },

  // — Sublimado Playeras —
  {
    manifest: { id: 'playeras-quitar-fondo', name: 'Quitar fondo', category: 'Sublimado Playeras', uses: ['remove-background'], status: 'ready' },
    load: () => import('./quitar-fondo/QuitarFondo')
  },
  {
    manifest: { id: 'playeras-upscale', name: 'Aumentar resolución', category: 'Sublimado Playeras', uses: ['upscale'], status: 'ready' },
    load: () => import('./mejorar/Mejorar')
  },
  {
    manifest: { id: 'playeras-vectorizar', name: 'Vectorizar', category: 'Sublimado Playeras', uses: ['vectorize'], status: 'ready' },
    load: () => import('./vectorizar/Vectorizar')
  },
  {
    manifest: { id: 'playeras-mockup-3d', name: 'Mockup 3D', category: 'Sublimado Playeras', uses: ['mockup-3d'], status: 'ready' },
    load: () => import('./mockup-3d/Mockup3D')
  },

  // — Sublimado Gorras —
  {
    manifest: { id: 'gorras-quitar-fondo', name: 'Quitar fondo', category: 'Sublimado Gorras', uses: ['remove-background'], status: 'ready' },
    load: () => import('./quitar-fondo/QuitarFondo')
  },
  {
    manifest: { id: 'gorras-vectorizar', name: 'Vectorizar', category: 'Sublimado Gorras', uses: ['vectorize'], status: 'ready' },
    load: () => import('./vectorizar/Vectorizar')
  },
  { manifest: { id: 'gorras-curvar', name: 'Curvar diseño', category: 'Sublimado Gorras', status: 'coming-soon' } },
  {
    manifest: { id: 'gorras-mockup-3d', name: 'Mockup 3D', category: 'Sublimado Gorras', uses: ['mockup-3d'], status: 'ready' },
    load: () => import('./mockup-3d/Mockup3D')
  },

  // — Sublimado Tazas y vasos —
  {
    manifest: { id: 'tazas-quitar-fondo', name: 'Quitar fondo', category: 'Sublimado Tazas y vasos', uses: ['remove-background'], status: 'ready' },
    load: () => import('./quitar-fondo/QuitarFondo')
  },
  {
    manifest: { id: 'tazas-upscale', name: 'Aumentar resolución', category: 'Sublimado Tazas y vasos', uses: ['upscale'], status: 'ready' },
    load: () => import('./mejorar/Mejorar')
  },
  { manifest: { id: 'tazas-ajustar', name: 'Ajustar al contorno', category: 'Sublimado Tazas y vasos', status: 'coming-soon' } },
  {
    manifest: { id: 'tazas-mockup-3d', name: 'Mockup 3D', category: 'Sublimado Tazas y vasos', uses: ['mockup-3d'], status: 'ready' },
    load: () => import('./mockup-3d/Mockup3D')
  }
]

/** Agrupa las mini apps por categoría preservando el orden de inserción. */
export function groupByCategory(apps: MiniAppEntry[]): Map<string, MiniAppEntry[]> {
  const groups = new Map<string, MiniAppEntry[]>()
  for (const app of apps) {
    const list = groups.get(app.manifest.category) ?? []
    list.push(app)
    groups.set(app.manifest.category, list)
  }
  return groups
}
