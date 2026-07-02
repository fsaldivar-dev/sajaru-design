declare module 'potrace' {
  export interface PotraceOptions {
    turnPolicy?: string
    turdSize?: number
    alphaMax?: number
    optCurve?: boolean
    optTolerance?: number
    threshold?: number
    blackOnWhite?: boolean
    color?: string
    background?: string
  }
  export class Potrace {
    constructor(options?: PotraceOptions)
    loadImage(target: Buffer | string, cb: (err: Error | null) => void): void
    setParameters(params: PotraceOptions): void
    getPathTag(fillColor?: string): string
    getSVG(): string
  }
  export class Posterizer {
    constructor(options?: unknown)
  }
  export function trace(
    file: Buffer | string,
    options: PotraceOptions,
    cb: (err: Error | null, svg: string) => void
  ): void
  export function posterize(
    file: Buffer | string,
    options: unknown,
    cb: (err: Error | null, svg: string) => void
  ): void
}
