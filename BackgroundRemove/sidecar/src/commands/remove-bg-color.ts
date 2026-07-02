import type { Ctx } from '../core/context'
import { fromRgbaRaw, toRgbaRaw } from '../core/image'

/**
 * Remoción de fondo por COLOR (sin IA) para logos / diseños sobre fondo plano.
 *
 * Flood-fill desde los bordes (preserva regiones del mismo color encerradas por
 * el sujeto) y, en la banda de borde, calcula **alpha continuo** según la
 * distancia al color de fondo y hace **despill**: recupera el color real del
 * primer plano quitando el aporte del fondo. Así el borde no queda con halo y
 * el recorte "nace sin fondo".
 *
 * Tras el flood de borde corre un SEGUNDO pase que vacía el **fondo ENCERRADO**:
 * las contraformas de las letras (huecos de A, O, R, D, …) y motas residuales
 * que el flood de borde nunca alcanza porque sólo entra desde el perímetro de la
 * imagen. Sin este pase el logo queda inusable sobre fondo oscuro (las letras
 * "tapadas" por el fondo). Ver `clearEnclosedBackground`.
 */

/**
 * Distancia RGB máxima al color de fondo para que un píxel OPACO encerrado
 * cuente como "fondo atrapado" en el segundo pase. TIGHT a propósito: sólo se
 * vacía lo que es casi EXACTAMENTE el color de fondo (contraformas de letras +
 * motas), no contenido claro legítimo (vidrios de invernadero con plantas
 * detrás, highlights de tomate, gota azul) cuyo color se aleja del fondo.
 */
const ENCLOSED_BG_DIST = 42

/**
 * Tope de área (fracción de la imagen) de un hueco de fondo encerrado. Un hueco
 * de contraforma es chico; una región fotográfica clara (un panel de vidrio
 * brillante) es grande. Salvaguarda contra vaciar vidrios cuyo brillo cae dentro
 * de `ENCLOSED_BG_DIST` del blanco: son demasiado grandes para ser un hueco de
 * letra y se conservan. (~0.15% del lienzo.)
 */
const ENCLOSED_MAX_AREA_FRAC = 0.0015

/**
 * Fracción máxima del anillo (dilatación) de un hueco que puede ser OTRO píxel
 * casi-fondo antes de descartarlo. Un hueco de letra está amurallado por tinta
 * sólida (0 vecinos casi-fondo); un panel de vidrio es parte de un campo claro
 * fragmentado por travesaños finos → su anillo toca OTROS paneles casi-fondo.
 * Esa "vecindad clara" delata al vidrio y lo protege.
 */
const ENCLOSED_NEIGHBOR_FILL_FRAC = 0.02

/** Radio (px) del anillo que se inspecciona alrededor de cada hueco encerrado. */
const ENCLOSED_RING_RADIUS = 6

/**
 * Tope de área (fracción del lienzo) de una "isla de borde" que se puede borrar.
 *
 * Tras el flood de borde + el vaciado de fondo encerrado, el color-key todavía
 * conserva regiones OPACAS que NO son el fondo plano (su color se aleja lo
 * suficiente del blanco) pero TAMPOCO son el sujeto: bloques de un MARCO/borde
 * que tocan el borde de la imagen y quedan separados del emblema. Caso real:
 * el logo KIFA (un screenshot) trae dos bloques verde-oscuro en las esquinas
 * SUPERIORES que sobreviven el color-key. `clearBorderIslands` los quita.
 *
 * Esta guarda es CRÍTICA: un sujeto grande puede tocar legítimamente el borde
 * (un diseño a sangre). Sólo se borran componentes que tocan el borde Y son más
 * chicos que esta fracción → islas tipo esquina/marco, nunca el sujeto. 3% del
 * lienzo es holgado para un artefacto de marco y muy chico para un sujeto real.
 */
const BORDER_ISLAND_MAX_FRAC = 0.03

export interface RemoveBgColorOptions {
  /** 0..100 — qué tan parecido al fondo cuenta como fondo (umbral bajo). */
  tolerance: number
  /** 0..100 — ancho de la rampa anti-alias del borde. */
  softness: number
  /** 'duro' = corte casi binario; 'suave' = rampa + despill. */
  edgeMode: 'duro' | 'suave'
}

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

function dist(data: Buffer, i: number, r: number, g: number, b: number): number {
  const dr = data[i] - r
  const dg = data[i + 1] - g
  const db = data[i + 2] - b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

function median(values: number[]): number {
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)] ?? 0
}

function sampleBorderColor(data: Buffer, w: number, h: number): [number, number, number] {
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  const step = Math.max(1, Math.floor((2 * (w + h)) / 240))
  const at = (x: number, y: number): void => {
    const i = (y * w + x) * 4
    rs.push(data[i])
    gs.push(data[i + 1])
    bs.push(data[i + 2])
  }
  for (let x = 0; x < w; x += step) {
    at(x, 0)
    at(x, h - 1)
  }
  for (let y = 0; y < h; y += step) {
    at(0, y)
    at(w - 1, y)
  }
  return [median(rs), median(gs), median(bs)]
}

/** ¿El borde es de color uniforme? (heurística para el modo "auto"). */
export async function detectFlatBackground(buf: Buffer): Promise<boolean> {
  const { data, width, height } = await toRgbaRaw(buf)
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  const step = Math.max(1, Math.floor((2 * (width + height)) / 240))
  const at = (x: number, y: number): void => {
    const i = (y * width + x) * 4
    rs.push(data[i])
    gs.push(data[i + 1])
    bs.push(data[i + 2])
  }
  for (let x = 0; x < width; x += step) {
    at(x, 0)
    at(x, height - 1)
  }
  for (let y = 0; y < height; y += step) {
    at(0, y)
    at(width - 1, y)
  }
  const med: [number, number, number] = [median([...rs]), median([...gs]), median([...bs])]
  let close = 0
  for (let k = 0; k < rs.length; k++) {
    const dr = rs[k] - med[0]
    const dg = gs[k] - med[1]
    const db = bs[k] - med[2]
    if (Math.sqrt(dr * dr + dg * dg + db * db) < 40) close++
  }
  // Mayoría del borde cerca del color mediano ⇒ fondo plano (logo/ilustración).
  // Umbral laxo: tarjetas/sombras suaves no deben mandar a IA.
  return close / rs.length > 0.62
}

/**
 * Segundo pase: vacía el **fondo ENCERRADO** que el flood de borde no alcanza.
 *
 * El flood de borde sólo entra desde el perímetro, así que las contraformas de
 * las letras (huecos de A, O, R, D, …) y motas aisladas quedan rellenas del
 * color de fondo aunque ya no estén conectadas al borde. Acá:
 *
 *  1. Marcamos como candidato todo píxel OPACO cuyo color esté a menos de
 *     `ENCLOSED_BG_DIST` del fondo (TIGHT → casi exactamente el fondo).
 *  2. Etiquetamos componentes conexas (4-vecinos) de candidatos.
 *  3. Vaciamos una componente sólo si parece un **hueco de tinta**, no contenido
 *     fotográfico claro:
 *       - área ≤ `ENCLOSED_MAX_AREA_FRAC` del lienzo (un panel de vidrio es
 *         grande; un hueco de letra es chico), y
 *       - su anillo de dilatación casi no toca OTROS candidatos casi-fondo
 *         (`ENCLOSED_NEIGHBOR_FILL_FRAC`): los vidrios son un campo claro
 *         fragmentado por travesaños finos, así que sus paneles se "ven" entre
 *         sí; un hueco de letra está amurallado por tinta sólida y queda solo.
 *
 * Vaciar reusa `clearToBg` (misma rampa + despill que el borde) → corte interno
 * consistente. Devuelve cuántos píxeles se volvieron transparentes.
 *
 * Por qué la doble guarda: tras upscalear, los vidrios del invernadero traen
 * paneles planos casi BLANCO PURO (idénticos en color a un hueco de letra), así
 * que el umbral de color por sí solo NO los separa. El tamaño + la vecindad
 * clara sí: los paneles son grandes y/o están rodeados de más paneles.
 */
function clearEnclosedBackground(
  data: Buffer,
  width: number,
  height: number,
  br: number,
  bgc: number,
  bb: number,
  clearToBg: (i: number, d: number) => boolean
): number {
  const n = width * height
  const maxArea = ENCLOSED_MAX_AREA_FRAC * n
  const r = ENCLOSED_RING_RADIUS

  // Candidato = OPACO y casi exactamente el color de fondo.
  const isFill = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    const i = p * 4
    if (data[i + 3] >= 8 && dist(data, i, br, bgc, bb) < ENCLOSED_BG_DIST) isFill[p] = 1
  }

  const label = new Int32Array(n).fill(-1)
  const queue = new Int32Array(n) // pila reutilizable para el BFS/DFS
  let cleared = 0

  for (let start = 0; start < n; start++) {
    if (!isFill[start] || label[start] !== -1) continue

    // 1) Recoger la componente conexa (4-vecinos).
    let top = 0
    queue[top++] = start
    label[start] = start
    const comp: number[] = []
    while (top > 0) {
      const p = queue[--top]
      comp.push(p)
      const x = p % width
      const y = (p / width) | 0
      if (x > 0 && isFill[p - 1] && label[p - 1] === -1) { label[p - 1] = start; queue[top++] = p - 1 }
      if (x < width - 1 && isFill[p + 1] && label[p + 1] === -1) { label[p + 1] = start; queue[top++] = p + 1 }
      if (y > 0 && isFill[p - width] && label[p - width] === -1) { label[p - width] = start; queue[top++] = p - width }
      if (y < height - 1 && isFill[p + width] && label[p + width] === -1) { label[p + width] = start; queue[top++] = p + width }
    }

    // 2) Demasiado grande para ser un hueco de letra → región clara legítima.
    if (comp.length > maxArea) continue

    // 3) ¿El anillo toca OTROS candidatos casi-fondo? (campo de vidrio) → conservar.
    let ringTotal = 0
    let ringFill = 0
    const ringSeen = new Set<number>()
    for (const p of comp) {
      const x0 = p % width
      const y0 = (p / width) | 0
      for (let dy = -r; dy <= r; dy++) {
        const yy = y0 + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -r; dx <= r; dx++) {
          const xx = x0 + dx
          if (xx < 0 || xx >= width) continue
          const q = yy * width + xx
          if (label[q] === start || ringSeen.has(q)) continue // dentro del mismo hueco
          ringSeen.add(q)
          ringTotal++
          if (isFill[q]) ringFill++
        }
      }
    }
    if (ringTotal > 0 && ringFill / ringTotal > ENCLOSED_NEIGHBOR_FILL_FRAC) continue

    // 4) Es un hueco de fondo encerrado: vaciarlo con la misma rampa + despill.
    for (const p of comp) {
      const i = p * 4
      if (clearToBg(i, dist(data, i, br, bgc, bb))) cleared++
    }
  }

  return cleared
}

/**
 * Tercer pase: borra **islas de borde** = artefactos de MARCO/ESQUINA.
 *
 * El color-key conserva regiones OPACAS cuyo color se aleja del fondo plano
 * aunque NO sean parte del sujeto. Cuando esas regiones son bloques de un marco
 * que tocan el borde de la imagen y quedan SEPARADAS del emblema, ensucian el
 * recorte. Caso real: el screenshot del logo KIFA trae dos bloques verde-oscuro
 * en las esquinas superiores (parte de un marco, no del emblema) que el flood de
 * borde NO toca (no son blancos) y el pase de fondo encerrado tampoco (tocan el
 * borde, no están encerrados).
 *
 * Estrategia (mismo patrón de componentes conexas que `clearEnclosedBackground`):
 *  1. Etiquetar componentes conexas (4-vecinos) de píxeles OPACOS (alfa ≥ 8).
 *  2. El componente de mayor área es el PRINCIPAL = el emblema → nunca se borra.
 *  3. Borrar un componente sólo si cumple TODO:
 *       (a) toca el borde de la imagen (algún pixel en x=0, x=W-1, y=0, y=H-1),
 *       (b) NO es el principal, y
 *       (c) área < `BORDER_ISLAND_MAX_FRAC` del lienzo (guarda CRÍTICA: protege
 *           un sujeto grande aunque sangre al borde; sólo caen islas chicas).
 *
 * El contenido legítimo ENCERRADO por el sujeto (gota azul, hojas, tomates) NO
 * toca el borde → no es candidato → se conserva.
 *
 * Borrar reusa `clearToBg` (misma rampa + despill que el borde) para no dejar un
 * corte duro feo donde estaba la isla. Devuelve cuántos píxeles se vaciaron.
 */
function clearBorderIslands(
  data: Buffer,
  width: number,
  height: number,
  br: number,
  bgc: number,
  bb: number,
  clearToBg: (i: number, d: number) => boolean
): number {
  const n = width * height
  const maxArea = BORDER_ISLAND_MAX_FRAC * n

  // OPACO = parte de algún objeto recortado (sujeto o artefacto sobreviviente).
  const isOpaque = new Uint8Array(n)
  for (let p = 0; p < n; p++) if (data[p * 4 + 3] >= 8) isOpaque[p] = 1

  // Primera pasada: etiquetar componentes y, por componente, guardar su tamaño,
  // si toca el borde, y la lista de píxeles (para poder borrarlo después).
  const label = new Int32Array(n).fill(-1)
  const queue = new Int32Array(n) // pila reutilizable para el flood
  interface Comp {
    pixels: number[]
    touchesBorder: boolean
  }
  const comps: Comp[] = []
  let mainIdx = -1
  let mainArea = -1

  for (let start = 0; start < n; start++) {
    if (!isOpaque[start] || label[start] !== -1) continue
    const compIdx = comps.length
    let top = 0
    queue[top++] = start
    label[start] = compIdx
    const pixels: number[] = []
    let touchesBorder = false
    while (top > 0) {
      const p = queue[--top]
      pixels.push(p)
      const x = p % width
      const y = (p / width) | 0
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) touchesBorder = true
      if (x > 0 && isOpaque[p - 1] && label[p - 1] === -1) { label[p - 1] = compIdx; queue[top++] = p - 1 }
      if (x < width - 1 && isOpaque[p + 1] && label[p + 1] === -1) { label[p + 1] = compIdx; queue[top++] = p + 1 }
      if (y > 0 && isOpaque[p - width] && label[p - width] === -1) { label[p - width] = compIdx; queue[top++] = p - width }
      if (y < height - 1 && isOpaque[p + width] && label[p + width] === -1) { label[p + width] = compIdx; queue[top++] = p + width }
    }
    comps.push({ pixels, touchesBorder })
    if (pixels.length > mainArea) {
      mainArea = pixels.length
      mainIdx = compIdx
    }
  }

  // Segunda pasada: borrar las islas que tocan el borde, no son el principal y
  // son chicas. La guarda de tamaño protege a un sujeto que sangre al borde.
  let cleared = 0
  for (let ci = 0; ci < comps.length; ci++) {
    if (ci === mainIdx) continue
    const c = comps[ci]
    if (!c.touchesBorder) continue
    if (c.pixels.length >= maxArea) continue
    for (const p of c.pixels) {
      const i = p * 4
      // d=0 fuerza alfa→0 con la rampa/feather de `clearToBg` (sin corte duro).
      if (clearToBg(i, 0)) cleared++
    }
  }

  return cleared
}

export async function removeBgColorStep(
  buf: Buffer,
  opts: RemoveBgColorOptions,
  ctx: Ctx
): Promise<{ buffer: Buffer; method: 'color'; removedPixels: number }> {
  ctx.progress('remove-bg', 0.15, 'Detectando color de fondo')
  const { data, width, height } = await toRgbaRaw(buf)
  const [br, bgc, bb] = sampleBorderColor(data, width, height)

  // tCut: a partir de esta distancia al fondo es SUJETO y el flood frena. Debajo
  // se quita TODO lo conectado al borde (fondo + tarjeta + sombra suave), con una
  // banda anti-alias + despill justo contra el sujeto. Las regiones claras
  // ENCERRADAS por el sujeto no se tocan (el flood no las alcanza).
  const tCut = 90 + (opts.tolerance / 100) * 150 // default ~105
  // Banda anti-alias: punto medio entre NÍTIDO y curvas SUAVES. Muy estrecha dentaba
  // las curvas (arco/tomates) casi binarias; muy ancha da borde blando + fleco. Este
  // ancho moderado + el defringe (que limpia el color del borde) da nítido sin dentar.
  const ramp = opts.edgeMode === 'duro' ? 2 : 10 + (opts.softness / 100) * 22
  const tSolid = Math.max(6, tCut - ramp)

  ctx.progress('remove-bg', 0.4, 'Flood-fill desde los bordes')
  const visited = new Uint8Array(width * height)
  const stack: number[] = []
  const seed = (p: number): void => {
    if (!visited[p]) {
      visited[p] = 1
      stack.push(p)
    }
  }
  for (let x = 0; x < width; x++) {
    seed(x)
    seed((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    seed(y * width)
    seed(y * width + width - 1)
  }

  // Aplica la MISMA rampa anti-alias + despill que usa el borde a UN píxel cuya
  // distancia al fondo es `d`. Devuelve true si lo volvió (más) transparente.
  // Compartido por el flood de borde y el pase de fondo encerrado para que el
  // corte interno salga idéntico al externo (sin recorte duro feo).
  const clearToBg = (i: number, d: number): boolean => {
    const alpha = d <= tSolid ? 0 : (d - tSolid) / (tCut - tSolid) // 0..1
    const a8 = Math.round(alpha * 255)
    if (a8 >= data[i + 3]) return false
    // Despill: F = (C - (1-α)·B) / α  → color de primer plano sin el fondo.
    if (alpha > 0.02) {
      data[i] = clamp8((data[i] - (1 - alpha) * br) / alpha)
      data[i + 1] = clamp8((data[i + 1] - (1 - alpha) * bgc) / alpha)
      data[i + 2] = clamp8((data[i + 2] - (1 - alpha) * bb) / alpha)
    }
    data[i + 3] = a8
    return true
  }

  ctx.progress('remove-bg', 0.6, 'Quitando fondo + descontaminando bordes')
  let removed = 0
  while (stack.length > 0) {
    const p = stack.pop() as number
    const i = p * 4
    const d = dist(data, i, br, bgc, bb)
    if (d >= tCut) continue // sujeto: no tocar y frenar el flood acá

    if (clearToBg(i, d)) removed++

    const x = p % width
    const y = (p / width) | 0
    if (x > 0) seed(p - 1)
    if (x < width - 1) seed(p + 1)
    if (y > 0) seed(p - width)
    if (y < height - 1) seed(p + width)
  }

  ctx.progress('remove-bg', 0.85, 'Vaciando fondo encerrado (contraformas)')
  removed += clearEnclosedBackground(data, width, height, br, bgc, bb, clearToBg)

  ctx.progress('remove-bg', 0.9, 'Quitando islas de borde (marco/esquina)')
  removed += clearBorderIslands(data, width, height, br, bgc, bb, clearToBg)

  ctx.progress('remove-bg', 0.92, 'Reescribiendo PNG')
  const buffer = await fromRgbaRaw(data, width, height)
  ctx.progress('remove-bg', 1)
  return { buffer, method: 'color', removedPixels: removed }
}
