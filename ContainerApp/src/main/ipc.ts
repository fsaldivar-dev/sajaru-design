import type { IpcMain } from 'electron'
import { pluginRegistry } from './plugins/registry'

/**
 * Puente IPC entre el renderer (mini apps) y el main (plugins = "el CLI").
 * Por ahora solo lista los plugins registrados y ejecuta uno por id.
 * Cuando agregues plugins, esto ya queda listo para invocarlos desde la UI.
 */
export function registerPluginIpc(ipcMain: IpcMain): void {
  ipcMain.handle('plugins:list', () => pluginRegistry.list())

  ipcMain.handle('plugins:run', (_event, pluginId: string, input: unknown) =>
    pluginRegistry.run(pluginId, input)
  )
}
