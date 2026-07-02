import type { IpcMain, WebContents } from 'electron'
import type { RecraftBalance } from '@shared/types'
import { runSidecar } from './sidecar'

/**
 * Adapter de IA Premium (Recraft). Por ahora expone solo el SALDO de la cuenta
 * (comando `account` → GET /users/me). Es una lectura: NO consume unidades. Lo
 * usa el indicador de créditos global del container para mostrar el saldo
 * disponible y el gasto en vivo en todas las mini apps premium.
 */
async function balance(sender: WebContents): Promise<RecraftBalance> {
  const r = await runSidecar(['account', '--events'], sender, 'recraft:progress')
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, credits: Number(r.data?.credits ?? 0), email: (r.data?.email as string) ?? undefined }
}

export function registerRecraftIpc(ipcMain: IpcMain): void {
  ipcMain.handle('recraft:balance', (e) => balance(e.sender))
}
