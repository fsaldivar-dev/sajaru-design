# bg-sidecar — Sajaru Design

Sidecar CLI for the **Quitar fondo** mini app. It's the heavy-lifting engine for the
sublimation pipeline (background removal + cleanup + print-prep), driven by Electron as
a child process. See `../../ARCHITECTURE.md` for how it fits the container/plugin model.

> **Why a sidecar?** AI (`onnxruntime`) and image work (`sharp`) shouldn't run inside
> Electron's main process. The CLI is independently testable, reusable, and packaged apart.

## Setup

Requires Node 20+.

```bash
cd BackgroundRemove/sidecar
npm install            # pulls sharp + onnxruntime-node native binaries

npm run dev -- analyze -i some.png   # run from TS (tsx), no build needed
npm run build                        # bundle to dist/index.js (what Electron spawns)
npm run typecheck                    # tsc --noEmit
```

Download at least one model before using `remove-bg`:

```bash
npm run dev -- models list
npm run dev -- models download rmbg-1.4   # ~176 MB -> ~/.sajaru/models
```

Models cache in `~/.sajaru/models` (override with `SAJARU_MODELS_DIR`, e.g. Electron's
`userData` folder).

## Output contract

- **stdout = JSON only.** Errors never touch it.
- **stderr = human logs + errors.** On failure: a JSON `error` line to stderr **and** a
  non-zero exit code.
- Add `--events` to stream **NDJSON** progress (one event per line) ending in a `result`
  line. Without it, a single pretty JSON object is printed.

```jsonc
// with --events
{"type":"progress","stage":"remove-bg","progress":0.5,"message":"Inferencia"}
{"type":"result","ok":true,"command":"remove-bg","data":{"output":"a.nobg.png","model":"rmbg-1.4"}}
// error (stderr)
{"type":"error","ok":false,"command":"remove-bg","code":"E_MODEL_MISSING","message":"..."}
```

## Commands

```bash
# 1. analyze — metadata + print-readiness warnings
bg-sidecar analyze -i art.png

# 2. remove-bg — AI background removal
bg-sidecar remove-bg -i art.png -o art.nobg.png --model rmbg-1.4

# 3. clean-halo — drop semi-transparent residual pixels
bg-sidecar clean-halo -i art.nobg.png -o art.clean.png --tolerance 12 --softness 10 --expand-edge

# 4. fix-color — CMYK -> sRGB
bg-sidecar fix-color -i art.clean.png -o art.rgb.png

# 5. fix-dpi — stamp 300 DPI, optionally upscale for a print width
bg-sidecar fix-dpi -i art.rgb.png -o art.dpi.png --target 300 --upscale --print-width 11

# 6. flip — mirror based on product type (taza mirrors by default)
bg-sidecar flip -i art.dpi.png -o art.flip.png --product taza

# 7. export — PNG or TIFF with DPI metadata
bg-sidecar export -i art.flip.png -o final.tiff --format tiff --dpi 300

# 8. batch — whole folder through the full pipeline
bg-sidecar batch -i ./in -o ./out --product playera --format png --concurrency 3

# 9. models — list / download / remove / path
bg-sidecar models list
bg-sidecar models download rmbg-1.4
bg-sidecar models remove u2netp

# 10. stream-events — full pipeline on one image, always streaming NDJSON
bg-sidecar stream-events -i art.png --events --product taza --format png \
  --steps analyze,remove-bg,clean-halo,fix-color,fix-dpi,flip,export
```

### Pipeline flags (batch & stream-events)

`--product playera|taza|gorra|lona` · `--image-type auto|logo|persona|ilustracion` ·
`--model <id>` · `--edge-mode duro|suave` · `--softness 0..100` · `--bg-tolerance 0..100` ·
`--no-clean-artifacts` · `--no-expand-edge` · `--no-force-300` · `--no-upscale` ·
`--format png|tiff` · `--steps a,b,c`

These map 1:1 to the mini app's **Configuraciones avanzadas** panel.

## Electron integration

The plugin adapter in the container spawns the built sidecar and parses stdout line by line:

```ts
import { spawn } from 'node:child_process'

function runSidecar(args: string[], onProgress: (p: number, msg?: string) => void) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [sidecarEntry, ...args, '--events'], {
      env: { ...process.env, SAJARU_MODELS_DIR: app.getPath('userData') + '/models' }
    })
    let result: unknown
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      for (const line of buf.split('\n').slice(0, -1)) {
        if (!line.trim()) continue
        const ev = JSON.parse(line)
        if (ev.type === 'progress') onProgress(ev.progress, ev.message)
        else if (ev.type === 'result') result = ev.data
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1)
    })
    child.stderr.on('data', (d) => console.error('[sidecar]', String(d)))
    child.on('close', (code) => (code === 0 ? resolve(result) : reject(new Error(`exit ${code}`))))
  })
}
```

Cancellation: `child.kill('SIGTERM')` — the sidecar aborts in-flight work.

## Packaging

For production, ship `dist/index.js` plus `node_modules` (sharp + onnxruntime-node are
native) via electron-builder `extraResources`, and spawn with the bundled Node. A single
binary (Node SEA / `pkg`) is possible later but the native addons need care.

## Notes

- `rmbg-1.4` works out of the box. `birefnet-general` is registered but confirm its ONNX
  URL in `src/core/models/registry.ts` before production.
- `fix-color` is a straight colourspace conversion; for proofing-grade color, add ICC
  profiles.
- `fix-dpi` upscales with lanczos; swap in an AI upscaler later without changing the CLI.
