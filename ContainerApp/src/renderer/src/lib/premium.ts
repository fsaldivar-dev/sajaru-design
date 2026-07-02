import { useSyncExternalStore } from 'react'

/**
 * Estado compartido de "IA Premium" (Recraft): saldo de unidades + gasto de la
 * sesión. Store mínimo (sin libs) que alimenta el indicador de créditos global.
 * El SALDO sale de la API (autoritativo); el contador de sesión es local e
 * instantáneo y se reconcilia con cada refresco del saldo.
 */

/** 1000 unidades = US$1 (medido y validado contra la API). */
export const USD_PER_UNIT = 0.001
/** Tipo de cambio aprox. (jun 2026). Editable acá si cambia. */
export const USD_TO_MXN = 17.5

/** Costo en unidades por operación (precios oficiales de Recraft). */
export const OP_COST = {
  removeBg: 10,
  vectorize: 10,
  upscaleCrisp: 4,
  upscaleCreative: 250,
  generateRaster: 40,
  generateVector: 80
} as const

export const toUsd = (units: number): number => units * USD_PER_UNIT
export const toMxn = (units: number): number => units * USD_PER_UNIT * USD_TO_MXN

export interface CreditsState {
  credits: number | null
  email: string | null
  noKey: boolean
  loading: boolean
  error: string | null
  /** Imágenes tratadas con IA Premium en esta sesión. */
  sessionCount: number
  /** Unidades gastadas en esta sesión. */
  sessionUnits: number
}

let state: CreditsState = {
  credits: null,
  email: null,
  noKey: false,
  loading: false,
  error: null,
  sessionCount: 0,
  sessionUnits: 0
}

const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((l) => l())
const set = (patch: Partial<CreditsState>): void => {
  state = { ...state, ...patch }
  emit()
}

let inflight: Promise<void> | null = null

/** Refresca el saldo real desde la API (lectura: no gasta). Dedupe concurrente. */
export function refreshBalance(): Promise<void> {
  if (inflight) return inflight
  set({ loading: true, error: null })
  inflight = (async () => {
    try {
      const r = await window.api.recraft.balance()
      if (r.ok) set({ credits: r.credits ?? 0, email: r.email ?? null, noKey: false, loading: false })
      else if (r.error?.code === 'E_NO_API_KEY') set({ noKey: true, loading: false })
      else set({ error: r.error?.message ?? 'No se pudo leer el saldo', loading: false })
    } catch (e) {
      set({ error: (e as Error).message, loading: false })
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Registra una operación premium: suma a la sesión y refresca el saldo real. */
export function recordUsage(units: number): void {
  set({ sessionCount: state.sessionCount + 1, sessionUnits: state.sessionUnits + units })
  void refreshBalance()
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
const snapshot = (): CreditsState => state

export function useCredits(): CreditsState {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
