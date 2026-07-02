/** Typed error so command handlers can attach a stable code + detail. */
export class SidecarError extends Error {
  readonly code: string
  readonly detail?: unknown

  constructor(code: string, message: string, detail?: unknown) {
    super(message)
    this.name = 'SidecarError'
    this.code = code
    this.detail = detail
  }
}
