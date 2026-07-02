import { useEffect, useRef } from 'react'

/**
 * Revoca los object URLs "vivos" cuando el componente se desmonta — evita la fuga
 * de blobs al salir de una mini app. (El cambio de source/result ya revoca el
 * anterior; esto cubre el caso que faltaba: los que quedan en pantalla al salir.)
 */
export function useRevokeOnUnmount(...urls: Array<string | undefined | null>): void {
  const ref = useRef(urls)
  // Mantiene el ref con los URLs del último render…
  useEffect(() => {
    ref.current = urls
  })
  // …y los revoca solo al desmontar.
  useEffect(
    () => () => {
      for (const u of ref.current) if (u) URL.revokeObjectURL(u)
    },
    []
  )
}
