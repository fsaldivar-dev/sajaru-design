import os from 'node:os'

/**
 * Boot side-effects que DEBEN correr antes que cualquier otra cosa del proceso.
 *
 * `UV_THREADPOOL_SIZE` fija el tamaño del threadpool de libuv, donde
 * onnxruntime-node corre `session.run` (cada inferencia es trabajo async sobre
 * ese pool). El AMG ("sam-everything") dispara N decodes CONCURRENTES; si el pool
 * sigue en su default (4), nunca corren más de 4 a la vez por más workers que
 * tiremos. Lo subimos al nº de cores físicos para que la concurrencia rinda.
 *
 * Crítico: el pool de libuv se inicializa PEREZOSAMENTE la PRIMERA vez que se usa,
 * leyendo `UV_THREADPOOL_SIZE` en ese momento. Por eso esto vive en su propio
 * módulo importado PRIMERO en el entry (los `import` de ESM se evalúan en orden):
 * así corre antes de cargar onnxruntime/sharp y mucho antes del primer `run`.
 * (El `import os` de arriba es el único import de este módulo y no toca libuv.)
 *
 * Lo más confiable sigue siendo setearlo en el ENV con que el plugin spawnea el
 * sidecar (ContainerApp/.../segment-select.ts). Esto es el fallback para correr el
 * CLI directo (`node dist/index.js ...`) sin esa env preconfigurada: sólo lo
 * fijamos si nadie lo seteó antes (no pisamos una decisión explícita del host).
 */
if (!process.env.UV_THREADPOOL_SIZE) {
  // os.cpus().length = cores lógicos; en estas máquinas == físicos. Mínimo 4 (el
  // default de libuv) para no DEGRADAR otras cargas async si hubiera <4 cores.
  const cores = os.cpus().length
  process.env.UV_THREADPOOL_SIZE = String(Math.max(4, cores))
}
