import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { miniApps } from '@renderer/miniapps/registry'
import type { MiniAppEntry } from '@renderer/miniapps/types'

/** Imagen que una mini app le pasa a otra al hacer "Enviar a → X". */
export interface AppTransfer {
  /** Bytes del PNG resultante (ya decodificado del blob de origen). */
  bytes: ArrayBuffer
  /** Nombre sugerido del archivo, ej. "logo-sinfondo.png". */
  name: string
}

/** Servicios de navegación entre mini apps que el shell expone al renderer. */
export interface Shell {
  /** Mini app abierta actualmente (o null = grilla). */
  openEntry: MiniAppEntry | null
  /** Abre una mini app por id, opcionalmente pre-cargándole una imagen. */
  openApp: (appId: string, transfer?: AppTransfer) => void
  /** Abre una mini app por su entry del registro (sin transfer). */
  openMiniApp: (entry: MiniAppEntry) => void
  /** Vuelve a la grilla y limpia cualquier transfer pendiente. */
  closeApp: () => void
  /**
   * Devuelve el transfer pendiente UNA sola vez y lo limpia (consume-once):
   * el destino lo consume al montar y no se repite en re-renders/navegaciones.
   */
  consumeTransfer: () => AppTransfer | null
}

const ShellContext = createContext<Shell | null>(null)

/** Provider del shell: mantiene la mini app abierta + el transfer pendiente. */
export function ShellProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [openEntry, setOpenEntry] = useState<MiniAppEntry | null>(null)
  // El transfer vive en un ref (no en state): se consume imperativamente al montar
  // el destino y no debe disparar renders ni quedar "pegado" entre navegaciones.
  const transferRef = useRef<AppTransfer | null>(null)

  const openMiniApp = useCallback((entry: MiniAppEntry): void => {
    if (entry.load) setOpenEntry(entry)
  }, [])

  const openApp = useCallback((appId: string, transfer?: AppTransfer): void => {
    const entry = miniApps.find((a) => a.manifest.id === appId)
    if (!entry?.load) return // destino inexistente o sin UI: no navegamos
    transferRef.current = transfer ?? null
    setOpenEntry(entry)
  }, [])

  const closeApp = useCallback((): void => {
    transferRef.current = null
    setOpenEntry(null)
  }, [])

  const consumeTransfer = useCallback((): AppTransfer | null => {
    const t = transferRef.current
    transferRef.current = null
    return t
  }, [])

  const value = useMemo<Shell>(
    () => ({ openEntry, openApp, openMiniApp, closeApp, consumeTransfer }),
    [openEntry, openApp, openMiniApp, closeApp, consumeTransfer]
  )

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
}

/** Hook para usar el shell desde cualquier mini app (origen o destino). */
export function useShell(): Shell {
  const ctx = useContext(ShellContext)
  if (!ctx) throw new Error('useShell debe usarse dentro de <ShellProvider>')
  return ctx
}
