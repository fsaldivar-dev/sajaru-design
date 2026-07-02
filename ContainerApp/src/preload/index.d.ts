import type { SajaruApi } from '@shared/types'

declare global {
  interface Window {
    api: SajaruApi
  }
}

export {}
