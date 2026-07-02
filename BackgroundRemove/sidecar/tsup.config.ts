import { defineConfig } from 'tsup'

// Bundle our own source into a single ESM file. Native deps (sharp,
// onnxruntime-node) stay external and are resolved from node_modules at runtime.
export default defineConfig({
  // `amg-worker` es un entry aparte: el AMG lo lanza como worker_thread para
  // paralelizar el decode (onnxruntime-node corre Run sincrónico, así que la única
  // paralelización real es por hilos OS, cada uno con su sesión). Se bundlea a
  // dist/core/amg-worker.js y `amg.ts` lo resuelve relativo a su propia ubicación.
  entry: ['src/index.ts', 'src/core/amg-worker.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  external: ['sharp', 'onnxruntime-node', '@neplex/vectorizer', 'pdfkit', 'svg-to-pdfkit'],
  banner: { js: '#!/usr/bin/env node' }
})
