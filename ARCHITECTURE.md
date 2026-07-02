# Sajaru Design — Arquitectura

Apps de escritorio (Electron, cross-platform) para una agencia de sublimado.
Objetivo: agregar herramientas como unidades aisladas, sin monolito ni spaghetti.
Mental model: **un CLI con interfaz gráfica**.

## Capas

1. **Container** (`ContainerApp/`) — shell de Electron. Solo hospeda mini apps:
   nombre, tabs (App / Proyectos), búsqueda y grilla por categoría. No conoce la
   lógica de ninguna herramienta. La grilla es data-driven desde el registro.

2. **Mini app** — UI de React (renderer) para un flujo concreto (ej. "Quitar fondo").
   Se registra en `ContainerApp/src/renderer/src/miniapps/registry.ts` y declara qué
   plugins usa (`uses: [pluginId]`).

3. **Plugin** — capability reutilizable (el "comando"). Contrato en
   `ContainerApp/src/shared/types.ts`. Vive en el proceso `main` del container y se
   reusa entre mini apps. Para trabajo liviano, el plugin hace el trabajo ahí mismo.

4. **Sidecar** — cuando el plugin necesita trabajo **pesado** (IA, `sharp`, binarios
   nativos), NO corre en el `main` de Electron: corre como **proceso hijo** (un CLI).
   El plugin en `main` es un *adapter delgado* que spawnea el sidecar y traduce sus
   eventos a `ctx.onProgress`.

```
Container (renderer)  ->  Plugin adapter (main)  ->  Sidecar CLI (proceso hijo)
   mini app UI              spawnea + traduce          motor real (sharp / onnx)
```

## Por qué sidecar

- El `main` de Electron no debe bloquearse ni cargar deps nativas pesadas
  (`onnxruntime-node`, `sharp`).
- Un CLI se testea solo, se reusa fuera de Electron y se empaqueta aparte.
- Es literalmente el "CLI con GUI".

## Protocolo sidecar <-> Electron

- Electron lo invoca: `node dist/index.js <command> [opts]` (o binario empaquetado).
- **stdout = SOLO JSON.** NDJSON: una línea por evento.
  - `{ "type": "progress", "stage": "remove-bg", "progress": 0.0..1.0, "message": "..." }`
  - `{ "type": "result", "ok": true, "command": "...", "data": { ... } }`  ← línea final
- **stderr = logs humanos + errores.** Ante error: `{ "type": "error", "code": "...",
  "message": "..." }` a stderr **y** exit code != 0.
- El adapter en `main` parsea línea por línea: `progress` → `ctx.onProgress`, y resuelve
  con el `data` del `result`.

## Contratos (ya en código)

- `Plugin<I, O> { manifest, run(input, ctx) }` — `ContainerApp/src/shared/types.ts`
- `MiniAppManifest` / `MiniAppEntry { manifest, load() }` — `miniapps/registry.ts`
- `PluginContext { onProgress, signal }` — el host inyecta servicios

## Estructura por mini app (carpetas hermanas bajo `DesingAgent/`)

```
BackgroundRemove/
  sidecar/      # el CLI (motor)            <- se construye primero
  ui/           # la UI React de la mini app  (se monta en el container)  [pendiente]
  plugin.ts     # adapter que registra en el container                     [pendiente]
```

## Cómo agregar una mini app

1. **Sidecar** (si hay trabajo pesado): CLI con comandos, eventos NDJSON a stdout.
2. **Plugin adapter** en `ContainerApp/src/main/plugins/`: spawnea el sidecar e
   implementa `Plugin.run` mapeando eventos → `ctx.onProgress`.
3. **UI** en el renderer; registrar en `miniapps/registry.ts` con `uses:[pluginId]` y `load`.

## Pins del stack (no romper)

- `electron-vite@5` topa en `vite@^7` → usar `vite@^7` y `@vitejs/plugin-react@^5`.
- Tras instalar `electron`, si `npm run dev` falla con `Error: Electron uninstall`,
  correr `node node_modules/electron/install.js`.
- Tailwind v4: `@import 'tailwindcss'` + `@theme inline` (sin `tailwind.config.js`).
