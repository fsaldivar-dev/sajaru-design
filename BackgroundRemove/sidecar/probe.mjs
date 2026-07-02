process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '8'
const ort = await import('onnxruntime-node')
const os = await import('node:os')
const modelPath = process.env.HOME + '/.sajaru/models/sam-vitb-decoder.onnx'
const INTRA = Number(process.env.INTRA || '1')
const N = Number(process.env.N || '8')
function mkSess(){return ort.InferenceSession.create(modelPath,{executionProviders:['cpu'],intraOpNumThreads:INTRA,graphOptimizationLevel:'all'})}
const sessions = await Promise.all(Array.from({length:N},()=>mkSess()))
const s0 = sessions[0]
const emb = new Float32Array(1*256*64*64)
const pos = new Float32Array(1*256*64*64)
function feeds(){return {
  input_points:new ort.Tensor('float32',Float32Array.from([500,500]),[1,1,1,2]),
  input_labels:new ort.Tensor('int64',BigInt64Array.from([1n]),[1,1,1]),
  image_embeddings:new ort.Tensor('float32',emb,[1,256,64,64]),
  image_positional_embeddings:new ort.Tensor('float32',pos,[1,256,64,64]),
}}
await s0.run(feeds()) // warmup
let t=Date.now(); for(let i=0;i<5;i++) await s0.run(feeds()); const single=(Date.now()-t)/5
t=Date.now(); await Promise.all(sessions.map(s=>s.run(feeds()))); const conc=Date.now()-t
t=Date.now(); for(let i=0;i<N;i++) await s0.run(feeds()); const seqN=Date.now()-t
console.error(`INTRA=${INTRA} N=${N} cpus=${os.cpus().length} UV=${process.env.UV_THREADPOOL_SIZE}`)
console.error(`single-run avg: ${single.toFixed(1)}ms`)
console.error(`${N} concurrent (N sessions): ${conc}ms => per-run ${(conc/N).toFixed(1)}ms`)
console.error(`${N} sequential (1 session): ${seqN}ms => per-run ${(seqN/N).toFixed(1)}ms`)
console.error(`speedup concurrent vs sequential: ${(seqN/conc).toFixed(2)}x`)
