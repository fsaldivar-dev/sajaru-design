// Does session.run block the event loop (sync native) or yield to it (threadpool)?
const ort = await import('onnxruntime-node')
const modelPath = process.env.HOME + '/.sajaru/models/sam-vitb-decoder.onnx'
const s = await ort.InferenceSession.create(modelPath,{executionProviders:['cpu'],intraOpNumThreads:8,graphOptimizationLevel:'all'})
const emb=new Float32Array(1*256*64*64), pos=new Float32Array(1*256*64*64)
const f=()=>({input_points:new ort.Tensor('float32',Float32Array.from([500,500]),[1,1,1,2]),input_labels:new ort.Tensor('int64',BigInt64Array.from([1n]),[1,1,1]),image_embeddings:new ort.Tensor('float32',emb,[1,256,64,64]),image_positional_embeddings:new ort.Tensor('float32',pos,[1,256,64,64])})
await s.run(f()) // warmup
let ticks=0
const timer=setInterval(()=>{ticks++},2) // should tick ~every 2ms if loop is free
const t=Date.now()
// fire 20 runs back-to-back via Promise.all; if threadpool, ticks keep flowing
await Promise.all(Array.from({length:20},()=>s.run(f())))
const dur=Date.now()-t
clearInterval(timer)
console.error(`20 runs took ${dur}ms; setInterval(2ms) fired ${ticks} times during it`)
console.error(ticks < 5 ? 'VERDICT: Run BLOCKS the JS event loop (synchronous native) => no libuv parallelism' : 'VERDICT: event loop stayed free => Run uses threadpool')
