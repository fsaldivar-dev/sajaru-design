// Verificador de calidad PRE-EXPORT (no bloqueante).
//
// SOLO señales confiables — validadas con 0 falsos positivos en las muestras reales:
//   • subject-vanished : casi todo quedó transparente → el sujeto se borró.
//   • nothing-removed  : casi nada se quitó → el fondo no se detectó.
//
// NO detecta marca de agua/texto ni "restos sueltos". Todos esos heurísticos se
// probaron con números y FALLABAN:
//   - watermark por bordes tenues: disparaba MÁS en piel/tela lisa (foto limpia
//     trabajo=0.82) que en el watermark real (gemini=0.51).
//   - "restos sueltos" (fragmentos chicos): marcaba el palito de la "J" de un logo
//     y detalles del diseño como "resto del fondo".
// Ese terreno necesita un MODELO (detección de texto), no un truco de píxeles. Se
// difiere antes que shipear un detector que grita en falso (rompe la confianza).

export type QualityIssueKind = 'subject-vanished' | 'nothing-removed'

export interface QualityIssue {
  kind: QualityIssueKind
  severity: 'warn'
  message: string
}

const A = 128 // umbral de opacidad (alpha > A = sujeto)

/**
 * Analiza un recorte RGBA. La única métrica es la fracción de píxeles opacos, que es
 * invariante a escala → se puede correr sobre un canvas sub-muestreado (instantáneo).
 * Devuelve avisos solo en los extremos catastróficos (nunca dispara en un recorte ok).
 */
export function checkQuality(
  data: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number
): QualityIssue[] {
  const n = w * h
  if (n === 0) return []

  let kept = 0
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] > A) kept++
  const keptFrac = kept / n

  if (keptFrac < 0.015) {
    return [
      {
        kind: 'subject-vanished',
        severity: 'warn',
        message:
          'Casi todo quedó transparente — el sujeto pudo borrarse. Probá otro Tipo de imagen o la calidad Premium.'
      }
    ]
  }

  if (keptFrac > 0.985) {
    return [
      {
        kind: 'nothing-removed',
        severity: 'warn',
        message:
          'Casi no se quitó fondo — ¿la imagen ya venía sin fondo, o el fondo no se detectó? Revisá el Tipo de imagen.'
      }
    ]
  }

  return []
}
