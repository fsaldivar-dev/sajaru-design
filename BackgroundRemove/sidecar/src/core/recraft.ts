import sharp from 'sharp'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SidecarError } from './errors'

/**
 * Cliente de la API de Recraft (https://external.api.recraft.ai/v1).
 *
 * Es la opción PREMIUM opt-in del modelo híbrido: lo local sigue siendo el
 * default (gratis/privado) y Recraft se usa solo cuando el usuario lo pide.
 * Recraft cubre, con UNA sola key: generación text-to-image (con salida vectorial
 * nativa), vectorizar, quitar fondo y upscale.
 *
 * La key se lee de la env `RECRAFT_API_TOKEN` (o `RECRAFT_API_KEY`), o del
 * archivo `~/.sajaru/recraft.key`. Si falta, las funciones tiran E_NO_API_KEY
 * con un mensaje claro para que la UI ofrezca configurarla.
 */
const BASE = 'https://external.api.recraft.ai/v1'

function keyFile(): string {
  return process.env.SAJARU_RECRAFT_KEY_FILE || path.join(os.homedir(), '.sajaru', 'recraft.key')
}

/** Devuelve la API key o null (env primero, luego archivo). */
export function recraftKey(): string | null {
  const env = process.env.RECRAFT_API_TOKEN || process.env.RECRAFT_API_KEY
  if (env && env.trim()) return env.trim()
  const f = keyFile()
  if (existsSync(f)) {
    const k = readFileSync(f, 'utf8').trim()
    if (k) return k
  }
  return null
}

export function hasRecraftKey(): boolean {
  return recraftKey() !== null
}

function requireKey(): string {
  const k = recraftKey()
  if (!k) {
    throw new SidecarError(
      'E_NO_API_KEY',
      `Falta la API key de Recraft. Definí la env RECRAFT_API_TOKEN o pegá la key en ${keyFile()}.`
    )
  }
  return k
}

async function call(endpoint: string, body: string | FormData, json: boolean): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${requireKey()}` }
  if (json) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(`${BASE}${endpoint}`, { method: 'POST', headers, body })
  } catch (e) {
    throw new SidecarError('E_RECRAFT_NET', `Fallo de red llamando a Recraft ${endpoint}`, String(e))
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    const code = res.status === 401 ? 'E_NO_API_KEY' : 'E_RECRAFT'
    throw new SidecarError(code, `Recraft ${endpoint} → HTTP ${res.status}: ${txt.slice(0, 300)}`)
  }
  return res.json()
}

const b64 = (s: string): Buffer => Buffer.from(s, 'base64')

export interface GenerateOptions {
  /** recraftv3 | recraftv3_vector | recraftv2 | recraftv4_1 … (vector = SVG). */
  model?: string
  /** Estilo V2/V3: vector_illustration | digital_illustration | realistic_image. */
  style?: string
  /** "WxH", ej "1024x1024". */
  size?: string
  n?: number
  controls?: Record<string, unknown>
}

/** Genera N imágenes desde un prompt. Devuelve los buffers (PNG, o SVG si model *_vector). */
export async function generate(prompt: string, opts: GenerateOptions = {}): Promise<Buffer[]> {
  const body: Record<string, unknown> = {
    prompt,
    model: opts.model ?? 'recraftv3',
    size: opts.size ?? '1024x1024',
    n: Math.max(1, Math.min(6, opts.n ?? 1)),
    response_format: 'b64_json'
  }
  if (opts.style) body.style = opts.style
  if (opts.controls) body.controls = opts.controls
  const j = (await call('/images/generations', JSON.stringify(body), true)) as { data?: Array<{ b64_json?: string }> }
  return (j.data ?? []).filter((d) => d.b64_json).map((d) => b64(d.b64_json as string))
}

/**
 * Operación de imagen→imagen (multipart). Devuelve el buffer del resultado.
 *
 * `compress`: para fotos OPACAS pesadas, sube un JPEG (q92) en vez del PNG. Recraft
 * devuelve siempre su propio RGBA, así que el formato de SUBIDA no afecta la calidad
 * del resultado — pero el upload pesa ~10× menos (2.5MB→0.25MB), que es el cuello de
 * botella real. NO se usa en vectorizar (los artefactos JPEG ensucian el trazado), ni
 * en imágenes con alfa (un recorte previo) donde JPEG perdería la transparencia.
 */
async function imageOp(
  endpoint: string,
  input: Buffer,
  opts: { compress?: boolean } = {}
): Promise<Buffer> {
  let upload = input
  let filename = 'image.png'
  if (opts.compress) {
    try {
      const meta = await sharp(input).metadata()
      if (!meta.hasAlpha && input.length > 350_000) {
        upload = await sharp(input).jpeg({ quality: 92 }).toBuffer()
        filename = 'image.jpg'
      }
    } catch {
      /* si la compresión falla, subimos el original sin bloquear la operación */
    }
  }
  const fd = new FormData()
  fd.append('file', new Blob([new Uint8Array(upload)]), filename)
  fd.append('response_format', 'b64_json')
  const j = (await call(endpoint, fd, false)) as { image?: { b64_json?: string } }
  const out = j.image?.b64_json
  if (!out) throw new SidecarError('E_RECRAFT', `Recraft ${endpoint} no devolvió imagen`)
  return b64(out)
}

/** Vectoriza con Recraft → buffer SVG (image/svg+xml). Sin compresión (artefactos). */
export const vectorizeRecraft = (input: Buffer): Promise<Buffer> => imageOp('/images/vectorize', input)
/** Quita el fondo con Recraft → PNG con alfa. Sube JPEG si la fuente es opaca (más rápido). */
export const removeBackgroundRecraft = (input: Buffer): Promise<Buffer> =>
  imageOp('/images/removeBackground', input, { compress: true })
/** Upscale nítido (barato) con Recraft → PNG. */
export const crispUpscaleRecraft = (input: Buffer): Promise<Buffer> =>
  imageOp('/images/crispUpscale', input, { compress: true })
/** Upscale creativo (agrega detalle, más caro) con Recraft → PNG. */
export const creativeUpscaleRecraft = (input: Buffer): Promise<Buffer> =>
  imageOp('/images/creativeUpscale', input, { compress: true })

/**
 * Consulta el saldo de la cuenta (GET /users/me). Es una LECTURA: no consume
 * unidades. La usa el indicador de créditos del container para mostrar el saldo
 * disponible y el gasto en vivo.
 */
export async function recraftAccount(): Promise<{ credits: number; email?: string }> {
  const key = requireKey()
  let res: Response
  try {
    res = await fetch(`${BASE}/users/me`, { headers: { Authorization: `Bearer ${key}` } })
  } catch (e) {
    throw new SidecarError('E_RECRAFT_NET', 'Fallo de red consultando el saldo de Recraft', String(e))
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    const code = res.status === 401 ? 'E_NO_API_KEY' : 'E_RECRAFT'
    throw new SidecarError(code, `Recraft /users/me → HTTP ${res.status}: ${txt.slice(0, 200)}`)
  }
  const j = (await res.json()) as { credits?: number; email?: string }
  return { credits: Number(j.credits ?? 0), email: j.email }
}
