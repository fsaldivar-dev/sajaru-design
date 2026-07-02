import type { Plugin, PluginContext, PluginManifest } from '@shared/types'

/**
 * Registro de plugins (las "capabilities" reutilizables).
 *
 * Viven en el proceso `main` = el "CLI". Las mini apps los invocan por id vía IPC,
 * sin saber si por dentro llaman a una API cloud, un modelo local o un binario.
 *
 * Aún no hay ninguno registrado: agregá el primero cuando exista el plugin, p. ej.
 *
 *   import removeBackground from '../../plugins/remove-background'
 *   pluginRegistry.register(removeBackground)
 */
class PluginRegistry {
  private plugins = new Map<string, Plugin>()

  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.manifest.id)) {
      throw new Error(`Plugin duplicado: ${plugin.manifest.id}`)
    }
    this.plugins.set(plugin.manifest.id, plugin)
  }

  list(): PluginManifest[] {
    return [...this.plugins.values()].map((p) => p.manifest)
  }

  async run(id: string, input: unknown): Promise<unknown> {
    const plugin = this.plugins.get(id)
    if (!plugin) throw new Error(`Plugin no encontrado: ${id}`)

    // Contexto mínimo por ahora. Acá se inyectarán http, fs, cache, etc.
    const ctx: PluginContext = {
      onProgress: () => {},
      signal: new AbortController().signal
    }
    return plugin.run(input, ctx)
  }
}

export const pluginRegistry = new PluginRegistry()
