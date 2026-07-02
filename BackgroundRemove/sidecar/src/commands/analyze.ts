import type { Ctx } from '../core/context'
import { imageInfo } from '../core/image'
import type { ImageInfo, Warning } from '../core/types'

export interface AnalyzeResult {
  info: ImageInfo
  warnings: Warning[]
}

/** Read metadata and surface print-readiness warnings. */
export async function analyzeStep(inputPath: string, ctx: Ctx): Promise<AnalyzeResult> {
  ctx.progress('analyze', 0.2, 'Leyendo metadatos')
  const info = await imageInfo(inputPath)

  const warnings: Warning[] = []
  if (info.dpi === null) {
    warnings.push({
      code: 'W_DPI_UNKNOWN',
      severity: 'warn',
      message: 'La imagen no declara DPI; se forzará al exportar.'
    })
  } else if (info.dpi < 300) {
    warnings.push({
      code: 'W_DPI_LOW',
      severity: 'warn',
      message: `DPI ${info.dpi} < 300; activá "Forzar 300 DPI" o upscale.`
    })
  }
  if (info.space === 'cmyk') {
    warnings.push({
      code: 'W_CMYK',
      severity: 'warn',
      message: 'Espacio CMYK; conviene convertir a RGB antes de imprimir.'
    })
  }
  if (!info.hasAlpha) {
    warnings.push({
      code: 'W_NO_ALPHA',
      severity: 'info',
      message: 'Sin canal alfa; el fondo se quitará al procesar.'
    })
  }
  if (info.width < 1000 || info.height < 1000) {
    warnings.push({
      code: 'W_SMALL',
      severity: 'info',
      message: `Resolución ${info.width}×${info.height}px: baja para impresión grande.`
    })
  }

  ctx.progress('analyze', 1, 'Análisis completo')
  return { info, warnings }
}

export function analyzeCommand(opts: { input: string }, ctx: Ctx): Promise<AnalyzeResult> {
  return analyzeStep(opts.input, ctx)
}
