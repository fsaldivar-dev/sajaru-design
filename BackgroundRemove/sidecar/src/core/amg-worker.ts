import { parentPort, workerData } from 'node:worker_threads'
import { createCropEvaluator, type RawMask } from './amg'
import { openDecodeSessionPool, decodePointLowRes, type SamPointMasks } from './sam'

/**
 * Worker del AMG: decodea UNA porción de la grilla EN PARALELO con los demás workers.
 *
 * Por qué worker_threads y no `Promise.all` en un solo hilo: `onnxruntime-node`
 * (1.27) corre `session.run` SINCRÓNICO en el hilo de JS — bloquea el event loop, no
 * usa el threadpool de libuv. Verificado: 8 runs concurrentes en un hilo == 8 runs
 * secuenciales (0 ticks de setInterval durante la inferencia). Así que la ÚNICA forma
 * real de paralelizar el decode en CPU es tener N hilos OS, cada uno con su PROPIA
 * InferenceSession: el Run de cada worker bloquea SU hilo, y N hilos corren N decodes
 * de verdad en paralelo sobre N cores.
 *
 * Cada worker:
 *  1. Abre 1 sesión de decode (intraOp bajo) sobre el MISMO embedding en disco.
 *  2. Decodea sus puntos asignados, aplica los filtros (createCropEvaluator: la MISMA
 *     función pura que el camino in-proceso ⇒ calidad idéntica) y junta las RawMask.
 *  3. Postea progreso (ticks) y, al final, las RawMask (los `bits` se TRANSFIEREN sin copia).
 *
 * El sidecar sigue siendo un solo proceso hijo de Electron; el plugin y el protocolo
 * NDJSON no cambian. Los workers son detalle interno del sidecar.
 */

interface WorkerInput {
  embPath: string
  crop: [number, number, number, number]
  /** Puntos asignados a este worker, aplanados [x0,y0,x1,y1,...] en px del CROP. */
  points: Float64Array
  params: {
    predIouThresh: number
    stabilityScoreThresh: number
    stabilityScoreOffset: number
    minMaskRegionArea: number
  }
}

/** RawMask serializable hacia el main: `bits` viaja como ArrayBuffer transferible. */
interface RawMaskMsg {
  bits: ArrayBuffer
  area: number
  bbox: [number, number, number, number]
  predIou: number
  stabilityScore: number
  score: number
  point: [number, number]
}

async function main(): Promise<void> {
  if (!parentPort) throw new Error('amg-worker sin parentPort')
  const { embPath, crop, points, params } = workerData as WorkerInput

  // 1 sesión de decode dedicada a este worker (intraOp se lee del env del proceso).
  const [session] = await openDecodeSessionPool(embPath, 1)
  const evalPoint = createCropEvaluator(crop, params)

  const masks: RawMaskMsg[] = []
  const transfer: ArrayBuffer[] = []
  const total = points.length / 2
  let done = 0
  for (let i = 0; i < total; i++) {
    const px = points[i * 2]
    const py = points[i * 2 + 1]
    let res: SamPointMasks
    try {
      res = await decodePointLowRes(session, px, py)
    } catch {
      done++
      // Avisá igual el avance (un punto que falla no debe tumbar la grilla).
      if (done % 32 === 0) parentPort.postMessage({ type: 'tick', done })
      continue
    }
    const best: RawMask | null = evalPoint(res, px, py)
    if (best) {
      // Copiá `bits` a un ArrayBuffer propio para poder transferirlo al main sin copia
      // extra al cruzar el límite del worker. El resto son números.
      const bitsBuf = new ArrayBuffer(best.bits.byteLength)
      new Uint8Array(bitsBuf).set(best.bits)
      masks.push({
        bits: bitsBuf,
        area: best.area,
        bbox: best.bbox,
        predIou: best.predIou,
        stabilityScore: best.stabilityScore,
        score: best.score,
        point: best.point
      })
      transfer.push(bitsBuf)
    }
    done++
    // Tick de progreso cada 32 puntos (el main agrega los ticks de todos los workers).
    if (done % 32 === 0) parentPort.postMessage({ type: 'tick', done })
  }

  parentPort.postMessage({ type: 'done', masks, processed: total }, transfer)
}

main().catch((err) => {
  parentPort?.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
})
