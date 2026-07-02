declare module 'svg-to-pdfkit' {
  // La lib no trae tipos. Firma mínima: dibuja un SVG (string) en un doc de pdfkit.
  function SVGtoPDF(
    doc: unknown,
    svg: string,
    x?: number,
    y?: number,
    options?: Record<string, unknown>
  ): void
  export default SVGtoPDF
}
