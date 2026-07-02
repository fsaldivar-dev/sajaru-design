/**
 * Agrupar un SVG "plano" (paths sueltos con fill) por color en capas nombradas, y editar
 * esas capas (recolorear / quitar) SIN re-trazar. Se usa para llevar el panel de capas al
 * vectorizado Premium (Recraft): Recraft devuelve un SVG plano; lo agrupamos igual que el
 * motor local (`<g data-color>`), y las ediciones se aplican sobre ESE SVG (localmente, sin
 * volver a llamar a la API → no gasta créditos por cada toque).
 */

export interface RgbColor {
  r: number
  g: number
  b: number
}

export interface PaletteEdit {
  r: number
  g: number
  b: number
  to?: RgbColor
  remove?: boolean
}

const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))

export const rgbToHex = (c: RgbColor): string =>
  '#' + [c.r, c.g, c.b].map((v) => clampByte(v).toString(16).padStart(2, '0')).join('')

/** Parsea un color CSS de SVG (#rrggbb, #rgb, rgb()/rgba()) a RGB. null si no aplica. */
export function parseColor(raw: string | null | undefined): RgbColor | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  if (!s || s === 'none' || s === 'transparent') return null
  let m = /^#([0-9a-f]{6})$/.exec(s)
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) }
  m = /^#([0-9a-f]{3})$/.exec(s)
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16) }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s)
  if (m) return { r: clampByte(+m[1]), g: clampByte(+m[2]), b: clampByte(+m[3]) }
  const named: Record<string, string> = {
    black: '#000000',
    white: '#ffffff',
    red: '#ff0000',
    lime: '#00ff00',
    green: '#008000',
    blue: '#0000ff',
    yellow: '#ffff00',
    gray: '#808080',
    grey: '#808080'
  }
  if (named[s]) return parseColor(named[s])
  return null
}

/** El fill de un elemento: atributo `fill="…"` o `style="…fill:…"`. */
function extractFill(el: string): string | null {
  let m = /\bfill\s*=\s*"([^"]*)"/i.exec(el)
  if (m) return m[1]
  m = /style\s*=\s*"[^"]*?\bfill\s*:\s*([^;"']+)/i.exec(el)
  if (m) return m[1]
  return null
}

/** Quita el fill (atributo y en style) para que el elemento herede el fill del `<g>`. */
function stripFill(el: string): string {
  return el.replace(/\s*\bfill\s*=\s*"[^"]*"/gi, '').replace(/\bfill\s*:\s*[^;"'}]+;?/gi, '')
}

const DRAW_RE = /<(path|polygon|polyline|circle|ellipse|rect)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/gi

/**
 * Reagrupa un SVG "plano" (paths sueltos con fill) para habilitar el panel de capas por color,
 * SIN romper el render. Clave: el z-order del SVG (típico de Recraft) es significativo — hay
 * shapes que se solapan — y los colores vienen INTERCALADOS, así que juntar todos los paths de
 * un color reordenaría y rompería el dibujo (negro tapando cosas, etc.). Por eso emitimos
 * "corridas" (runs) de color CONSECUTIVO en el ORDEN ORIGINAL: cada run sólido es un
 * `<g data-color fill>` (los hijos heredan el fill); los paths con gradiente (`fill="url(#…)"`)
 * u otros se preservan tal cual. La paleta son los colores sólidos únicos, ordenados por
 * prominencia (frecuencia) SOLO para mostrar — el orden de la paleta no afecta el render.
 */
export function groupSvgByColor(svg: string): { svg: string; palette: RgbColor[] } {
  const open = /<svg\b[^>]*>/i.exec(svg)
  const closeIdx = svg.lastIndexOf('</svg>')
  if (!open || closeIdx < 0) return { svg, palette: [] }
  const inner = svg.slice(open.index + open[0].length, closeIdx)
  const defs = /<defs\b[\s\S]*?<\/defs>/i.exec(inner)

  interface Run {
    color: string | null
    els: string[]
  }
  const runs: Run[] = []
  const counts = new Map<string, number>()
  const colorOf = new Map<string, RgbColor>()
  let cur: Run | null = null
  for (let m = DRAW_RE.exec(inner); m; m = DRAW_RE.exec(inner)) {
    const el = m[0]
    const c = parseColor(extractFill(el))
    const key = c ? rgbToHex(c) : null
    if (!cur || cur.color !== key) {
      cur = { color: key, els: [] }
      runs.push(cur)
    }
    if (key && c) {
      cur.els.push(stripFill(el))
      counts.set(key, (counts.get(key) ?? 0) + 1)
      if (!colorOf.has(key)) colorOf.set(key, c)
    } else {
      cur.els.push(el) // gradiente / sin color plano: preservar exactamente
    }
  }
  if (!runs.length) return { svg, palette: [] }

  let i = 0
  const body = runs
    .map((r) =>
      r.color
        ? `<g id="capa-${++i}" data-color="${r.color}" fill="${r.color}">${r.els.join('')}</g>`
        : `<g id="capa-${++i}">${r.els.join('')}</g>`
    )
    .join('')
  const outSvg = `${open[0]}${defs ? defs[0] : ''}${body}</svg>`
  const palette = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hex]) => colorOf.get(hex) as RgbColor)
  return { svg: outSvg, palette }
}

/**
 * Aplica una edición de paleta a un SVG YA agrupado por color (el de groupSvgByColor). Para
 * cada color: `remove` quita TODAS sus corridas `<g …data-color=…>`; `to` las recolorea (cambia
 * fill + data-color). Global: un color puede tener varias corridas (el SVG conserva el orden del
 * documento). Idempotente sobre el SVG BASE: aplicá SIEMPRE el array de edición completo sobre el
 * SVG original agrupado (no acumules).
 */
export function applyPaletteEditToSvg(svg: string, edit: PaletteEdit[]): string {
  let out = svg
  for (const e of edit) {
    const hex = rgbToHex(e)
    const groupRe = new RegExp(`<g id="capa-\\d+" data-color="${hex}"[^>]*>[\\s\\S]*?</g>`, 'gi')
    if (e.remove) {
      out = out.replace(groupRe, '')
    } else if (e.to) {
      const toHex = rgbToHex(e.to)
      out = out.replace(groupRe, (g) =>
        g.replace(`fill="${hex}"`, `fill="${toHex}"`).replace(`data-color="${hex}"`, `data-color="${toHex}"`)
      )
    }
  }
  return out
}
