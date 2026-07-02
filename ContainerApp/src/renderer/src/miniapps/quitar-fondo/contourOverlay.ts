import Konva from 'konva'

import { buildEdgeRing, type EdgeRing } from './contour'

/**
 * Overlay de la SELECCIÓN (Select & Mask). Muestra el borde EXACTO del recorte
 * como "marching ants" animados. NO es editable por nodos: es un indicador del
 * límite real del alfa, que se regenera tras cada pincelada (+/−).
 *
 * ── POR QUÉ ANILLO-IMAGEN (no Konva.Line densa) ───────────────────────────────
 * El borde se deriva del alfa con `buildEdgeRing` = `mask − erode(mask)` (1px). Eso
 * da la frontera EXACTA pixel-a-pixel. Renderizarlo como una `Konva.Line` con
 * miles de vértices y `dashOffset` animado obliga a Konva a recalcular geometría de
 * guiones cada frame (stuttery a ~1800px) y los guiones sobre curvas de alta
 * frecuencia se ven sucios. En cambio mostramos el anillo como `Konva.Image` y la
 * animación de hormigas es un patrón de rayas que se desplaza, recortado al anillo
 * por composición (`destination-in`). Es exacto por construcción y barato de animar
 * (solo se recompone el bbox del anillo, a fps moderado).
 *
 * ── COORDENADAS (igual que la versión vieja, sin nodos) ───────────────────────
 * El canvas principal se muestra con `object-contain`: escala uniforme
 * `s = min(boxW/imgW, boxH/imgH)` + padding `(padX, padY)`. Aplicamos la MISMA
 * transformación a la CAPA (`layer.scale(s)`, `layer.position(padX,padY)`) y
 * dibujamos el anillo en px de IMAGEN → calza 1:1 con los pixeles del canvas.
 * Konva maneja el devicePixelRatio internamente (no lo tocamos a mano).
 */

/** Rayas marching-ants: dos colores RGB que alternan (gris-azulado / blanco clásico). */
const ANT_DARK: [number, number, number] = [0x11, 0x18, 0x27]
const ANT_LIGHT: [number, number, number] = [0xff, 0xff, 0xff]
/** Período del patrón de rayas en px de PANTALLA (largo de cada guion + hueco). */
const ANT_PERIOD_SCREEN = 8
/** Velocidad de avance de las hormigas (px de pantalla por segundo). */
const ANT_SPEED = 36
/** Refresco de la animación (fps). 20 alcanza para hormigas fluidas y es barato. */
const ANT_FPS = 20
/**
 * Grosor visible del trazo en px de PANTALLA. El anillo crudo es de 1px de IMAGEN;
 * como la capa se escala por `s` (object-contain, normalmente <1 con imágenes
 * grandes), un anillo de 1px se minifica y se "lava". Dilatamos el anillo a este
 * grosor en px de pantalla (centrado sobre la frontera exacta de 1px → sigue
 * calzando) para que las hormigas se vean sólidas con cualquier zoom.
 */
const ANT_STROKE_SCREEN = 1.75

export interface ContourOverlay {
  /**
   * Regenera el borde marching-ants DESDE el alfa (fuente de verdad). Se llama al
   * entrar al modo y tras cada pincelada (+/−).
   */
  refresh: (data: Uint8ClampedArray, imgW: number, imgH: number) => void
  /** ¿Hay borde visible (la máscara tiene frontera)? */
  hasEdge: () => boolean
  /** Realinea Stage/Layer al object-contain del canvas (al cambiar tamaño/zoom). */
  layout: (box: { width: number; height: number }, imgW: number, imgH: number) => void
  /** Limpia el borde mostrado. */
  clear: () => void
  /** Libera el Stage de Konva. */
  destroy: () => void
}

export function createContourOverlay(container: HTMLDivElement): ContourOverlay {
  const stage = new Konva.Stage({
    container,
    width: container.clientWidth || 1,
    height: container.clientHeight || 1
  })
  // El overlay es puramente informativo (las hormigas no reciben eventos): el
  // pincel lo maneja el canvas de abajo. listening:false = más liviano.
  const layer = new Konva.Layer({ listening: false })
  stage.add(layer)

  // Escala actual del object-contain (px imagen → px CSS). Para que el grosor del
  // trazo y el período de las rayas se vean constantes en pantalla con cualquier zoom.
  let viewScale = 1

  // Anillo de borde vigente (canvas alfa 1px en px de imagen, recortado a su bbox).
  let ring: EdgeRing | null = null
  // Máscara de recorte = anillo DILATADO al grosor de trazo (centrado en la frontera
  // exacta). Es el alfa contra el que recortamos las rayas; el padding extra es `pad`.
  let clip: HTMLCanvasElement | null = null
  let pad = 0
  // Konva.Image que pinta las hormigas (su `image` es `antCanvas`, recompuesto por frame).
  let antImage: Konva.Image | null = null
  // Canvas donde componemos las rayas recortadas al anillo (tamaño del bbox + pad).
  let antCanvas: HTMLCanvasElement | null = null
  let antCtx: CanvasRenderingContext2D | null = null

  // Patrón de rayas diagonales (tile pequeño y reutilizable) para las hormigas.
  let stripePattern: CanvasPattern | null = null
  // Período del patrón en px de IMAGEN (lado del tile). El offset de animación se
  // envuelve EXACTO en este múltiplo para que el bucle no "salte" (sin costura).
  let stripePeriod = 2

  /**
   * (Re)construye el tile de rayas DIAGONALES según la escala (período constante en
   * pantalla). Se pinta pixel a pixel con la regla `floor((x+y)/seg) % 2` → franjas
   * a 45° que TESELAN sin costuras (el lado del tile es múltiplo de `2*seg`), por eso
   * el patrón repetido se ve continuo. Diagonal = al desplazar en X las hormigas
   * "marchan" en todas las orientaciones del borde (no solo en tramos horizontales).
   */
  function buildStripeTile(): void {
    const period = Math.max(2, ANT_PERIOD_SCREEN / viewScale) // px de imagen (par claro+oscuro)
    const seg = Math.max(1, Math.round(period / 2)) // ancho de cada franja
    const tilePx = seg * 2 // múltiplo de 2*seg ⇒ teselado diagonal sin costura
    stripePeriod = tilePx
    const tile = document.createElement('canvas')
    tile.width = tilePx
    tile.height = tilePx
    const tctx = tile.getContext('2d')
    if (!tctx) return
    const img = tctx.createImageData(tilePx, tilePx)
    const d = img.data
    for (let y = 0; y < tilePx; y++) {
      for (let x = 0; x < tilePx; x++) {
        const onDark = Math.floor((x + y) / seg) % 2 === 0
        const c = onDark ? ANT_DARK : ANT_LIGHT
        const i = (y * tilePx + x) * 4
        d[i] = c[0]
        d[i + 1] = c[1]
        d[i + 2] = c[2]
        d[i + 3] = 255
      }
    }
    tctx.putImageData(img, 0, 0)
    stripePattern = tctx.createPattern(tile, 'repeat')
  }

  /**
   * Padding/dilatación (px de imagen) para que el trazo se vea ~ANT_STROKE_SCREEN
   * en pantalla con cualquier escala. La dilatación se centra en la frontera exacta
   * de 1px, así el borde sigue calzando perfecto (solo se engrosa simétricamente).
   */
  function dilateRadius(): number {
    const thick = ANT_STROKE_SCREEN / viewScale // grosor en px de imagen
    return Math.max(0, Math.round(thick / 2))
  }

  /** (Re)construye la máscara de recorte = anillo de 1px DILATADO `pad` px. */
  function buildClip(): void {
    if (!ring || ring.empty) {
      clip = null
      pad = 0
      return
    }
    pad = dilateRadius()
    const cw = ring.width + pad * 2
    const ch = ring.height + pad * 2
    const c = document.createElement('canvas')
    c.width = cw
    c.height = ch
    const cctx = c.getContext('2d')
    if (!cctx) {
      clip = null
      return
    }
    if (pad === 0) {
      cctx.drawImage(ring.canvas, 0, 0)
    } else {
      // Dilatación por estampado del anillo en un disco de offsets (radio `pad`).
      // Barato: el anillo es fino y `pad` pequeño (1–3 px típicos).
      for (let dy = -pad; dy <= pad; dy++) {
        for (let dx = -pad; dx <= pad; dx++) {
          if (dx * dx + dy * dy > pad * pad) continue
          cctx.drawImage(ring.canvas, pad + dx, pad + dy)
        }
      }
    }
    clip = c
  }

  /** Recompone `antCanvas`: rayas desplazadas (offset) recortadas al anillo dilatado. */
  function composeAnts(offset: number): void {
    if (!antCanvas || !antCtx || !stripePattern || !clip) return
    const w = antCanvas.width
    const h = antCanvas.height
    antCtx.setTransform(1, 0, 0, 1, 0, 0)
    antCtx.clearRect(0, 0, w, h)
    // 1) Rayas en movimiento (el patrón se desplaza con el offset = "hormigas").
    antCtx.save()
    antCtx.translate(offset, 0)
    antCtx.fillStyle = stripePattern
    antCtx.fillRect(-offset, 0, w, h)
    antCtx.restore()
    // 2) Recorte EXACTO al anillo (dilatado): solo quedan rayas sobre la frontera.
    antCtx.globalCompositeOperation = 'destination-in'
    antCtx.drawImage(clip, 0, 0)
    antCtx.globalCompositeOperation = 'source-over'
  }

  function rebuildImage(): void {
    if (antImage) {
      antImage.destroy()
      antImage = null
    }
    if (!ring || ring.empty) {
      layer.batchDraw()
      return
    }
    buildStripeTile()
    buildClip()
    antCanvas = document.createElement('canvas')
    antCanvas.width = ring.width + pad * 2
    antCanvas.height = ring.height + pad * 2
    antCtx = antCanvas.getContext('2d')
    composeAnts(0)
    antImage = new Konva.Image({
      image: antCanvas,
      // El canvas incluye `pad` de margen: posicionamos restando pad para que la
      // frontera exacta caiga sobre su pixel real (el centro del trazo dilatado).
      x: ring.x - pad,
      y: ring.y - pad,
      width: ring.width + pad * 2,
      height: ring.height + pad * 2,
      listening: false,
      // El trazo es nítido; sin suavizado para que no se "lave" al escalar la capa.
      imageSmoothingEnabled: false
    })
    layer.add(antImage)
    layer.batchDraw()
  }

  // ── Animación de las hormigas ───────────────────────────────────────────────
  let lastTick = 0
  const frameInterval = 1000 / ANT_FPS
  const anim = new Konva.Animation((frame) => {
    if (!frame || !antImage || !antCanvas) return
    if (frame.time - lastTick < frameInterval) return
    lastTick = frame.time
    // Avance del patrón en px de imagen (velocidad constante en pantalla). Se envuelve
    // en el PERÍODO del tile (no en el ancho del canvas) para que el bucle sea continuo.
    const offsetImg = ((frame.time / 1000) * (ANT_SPEED / viewScale)) % stripePeriod
    composeAnts(offsetImg)
    // Notifica a Konva que la fuente de la imagen cambió.
    antImage.getLayer()?.batchDraw()
  }, layer)

  function refresh(data: Uint8ClampedArray, imgW: number, imgH: number): void {
    ring = buildEdgeRing(data, imgW, imgH)
    rebuildImage()
  }

  function layout(box: { width: number; height: number }, imgW: number, imgH: number): void {
    const w = Math.max(1, box.width)
    const h = Math.max(1, box.height)
    stage.width(w)
    stage.height(h)
    // Misma cuenta que `toCanvasPx`: object-contain → escala uniforme + padding.
    const s = Math.min(w / imgW, h / imgH)
    const padX = (w - imgW * s) / 2
    const padY = (h - imgH * s) / 2
    const scaleChanged = Math.abs(s - viewScale) > 1e-6
    viewScale = s
    layer.scale({ x: s, y: s })
    layer.position({ x: padX, y: padY })
    // El período de rayas, el grosor (dilatación) y el padding dependen de la escala:
    // si cambió, reconstruimos la imagen para que las hormigas se vean del mismo
    // tamaño en pantalla y sigan calzando exacto. Si no cambió, solo re-posicionamos.
    if (ring && !ring.empty && scaleChanged) rebuildImage()
    layer.batchDraw()
  }

  anim.start()

  return {
    refresh,
    hasEdge: () => Boolean(ring && !ring.empty),
    layout,
    clear: () => {
      ring = null
      clip = null
      pad = 0
      if (antImage) {
        antImage.destroy()
        antImage = null
      }
      antCanvas = null
      antCtx = null
      layer.batchDraw()
    },
    destroy: () => {
      try {
        anim.stop()
        if (antImage) antImage.destroy()
        stage.destroy()
      } catch {
        // El stage puede haberse desmontado junto al contenedor; ignorar.
      }
      ring = null
      clip = null
      pad = 0
      antImage = null
      antCanvas = null
      antCtx = null
      stripePattern = null
    }
  }
}
