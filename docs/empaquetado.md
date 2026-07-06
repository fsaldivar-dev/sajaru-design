# Empaquetado para Omarchy Linux

Guía para compilar y distribuir **Sajaru Design** en Omarchy (Arch + Hyprland) y, en
general, en cualquier Arch/Arch-based. Genera un **AppImage** universal y un **paquete
pacman** nativo (`.pkg.tar.zst`).

## La vía recomendada: CI (GitHub Actions)

Como el equipo desarrolla en macOS y el motor necesita binarios de Linux, el instalador
se compila en la nube con [.github/workflows/build-linux.yml](../.github/workflows/build-linux.yml):

- **Build manual**: GitHub → pestaña **Actions** → *Build Linux (Omarchy)* → **Run
  workflow** → al terminar, bajá el artifact `sajaru-design-linux-*` (trae el AppImage y
  el .pacman).
- **Release**: taguear una versión publica los instaladores en GitHub Releases.
  **Primero subí la versión** en `ContainerApp/package.json` (el CI corta el build si el
  tag no coincide — el auto-update compara esas versiones):
  ```bash
  # 1) editá ContainerApp/package.json → "version": "0.2.0"
  git commit -am "v0.2.0"
  git tag v0.2.0 && git push && git push --tags
  ```
- El workflow compila el sidecar con `npm ci` EN Linux (binarios nativos correctos),
  corre el typecheck y empaqueta con electron-builder.

## Actualizaciones automáticas

Las apps instaladas **se enteran solas** de cada release (revisan al arrancar y cada 6 h):

- **AppImage**: auto-update completo — descarga en segundo plano y la barra superior
  muestra **"Reiniciar y actualizar"** (un clic instala y reabre). Para esto el release
  debe incluir `latest-linux.yml` y los `.blockmap` (el workflow ya los adjunta).
- **Instalación .pacman**: la app no puede auto-instalarse; la barra muestra
  **"vX.Y.Z disponible ↗"** con link a la página del release para bajar el .pacman nuevo
  (`sudo pacman -U ...`).

Lo que sigue abajo es la vía manual (una máquina Arch/Omarchy real).

## Importante: compilá en Linux

El “motor” de Sajaru Design es un **sidecar** (un CLI en `BackgroundRemove/sidecar/`) que usa
**binarios nativos**: `sharp` (procesamiento de imagen) y `onnxruntime-node` (IA). Esos
binarios son **por plataforma**: los de macOS no sirven en Linux.

Por eso **el empaquetado debe hacerse en Linux** (idealmente el mismo Omarchy). No se puede
cross-compilar de forma confiable desde macOS/Windows. Todo lo demás (config de
electron-builder, PKGBUILD, iconos, scripts) ya está en el repo listo para correr.

El sidecar viaja **dentro del paquete** como `resources/sidecar` (ver `extraResources` en
`ContainerApp/electron-builder.yml`). En producción, el proceso `main` lo resuelve ahí
(`app.isPackaged` → `process.resourcesPath/sidecar/dist/index.js`) y lo corre con el
`node` del sistema — por eso `nodejs` es dependencia del paquete.

## Dependencias del sistema

```bash
sudo pacman -S --needed base-devel git nodejs npm ffmpeg ghostscript
```

- **base-devel** — para `makepkg` (solo si usás el PKGBUILD).
- **nodejs / npm** — build + runtime del sidecar.
- **ffmpeg** — video 360° del Mockup 3D.
- **ghostscript** — exportar vector a PDF/EPS.

## Paso a paso

### 1) Compilar el motor (sidecar) — con binarios de Linux
```bash
cd BackgroundRemove/sidecar
npm ci          # instala sharp/onnxruntime nativos para ESTA máquina (Linux)
npm run build   # genera dist/
```

### 2) Compilar y empaquetar la app
```bash
cd ../../ContainerApp
npm ci
npm run dist:linux   # electron-vite build + electron-builder --linux
```

Salida en `ContainerApp/dist/`:
- `Sajaru Design-0.1.0-x86_64.AppImage`
- `Sajaru Design-0.1.0.pacman`  ← paquete Arch nativo

> Si `npm run dev`/build falla con `Error: Electron uninstall`, corré
> `node node_modules/electron/install.js` y reintentá.

### 3a) Instalar el paquete pacman (recomendado)
```bash
sudo pacman -U "dist/Sajaru Design-0.1.0.pacman"
sajaru-design    # queda en el PATH; también aparece en el menú de apps
```

### 3b) O correr el AppImage
```bash
chmod +x "dist/Sajaru Design-0.1.0-x86_64.AppImage"
./"dist/Sajaru Design-0.1.0-x86_64.AppImage"
```

## PKGBUILD (AUR)

Alternativa al target `pacman`: [`packaging/aur/PKGBUILD`](../packaging/aur/PKGBUILD)
empaqueta el AppImage ya generado (patrón `*-appimage`, sin recompilar).

```bash
cd packaging/aur
cp "../../ContainerApp/dist/Sajaru Design-0.1.0-x86_64.AppImage" \
   "sajaru-design-0.1.0.AppImage"
makepkg -si
```

Instala en `/opt/sajaru-design`, crea el lanzador `sajaru-design`, la entrada de menú y los
iconos del tema `hicolor`.

## Cómo está configurado (referencia)

- **`ContainerApp/electron-builder.yml`** — `appId: com.sajaru.design`,
  `productName: Sajaru Design`, targets `AppImage` + `pacman`, icono `build/icon.png`,
  `executableName: sajaru-design`, y `depends: [nodejs, ffmpeg, ghostscript]`.
- **`extraResources`** — copia `BackgroundRemove/sidecar/{dist,node_modules,package.json}`
  a `resources/sidecar` dentro del paquete.
- **Marca** — `ContainerApp/build/logo.svg` (logo completo: mascota + wordmark) es la fuente.
  El icono `build/icon.png` (1024²) + `build/icons/{64,128,256,512}.png` son la MASCOTA
  (sin wordmark) sobre un cuadrado redondeado claro. `build/logo.png` (transparente) lo usa
  el splash y el README.

## Problemas comunes

- **“The SUID sandbox helper binary…” / no arranca** — falta el bit setuid en
  `chrome-sandbox`. El paquete pacman lo maneja; con el AppImage, corré con
  `--no-sandbox` o instalá el paquete en su lugar.
- **El AppImage no abre** — instalá `fuse2` (`sudo pacman -S fuse2`) o usá el paquete pacman.
- **Funciones que “no hacen nada”** — falta una dependencia de sistema: revisá que estén
  `nodejs` (recortes/vectorizar/upscale), `ffmpeg` (video 360°) y `ghostscript` (PDF/EPS).
- **Regenerar la marca** — la fuente es `build/logo.svg`. Para el icono se extrae la mascota
  (paths sin el wordmark) y se compone sobre un cuadrado redondeado claro; para `logo.png` se
  rasteriza el logo completo transparente. Se usa `sharp` (ya está en el sidecar):
  ```bash
  # logo.png (completo, transparente)
  cd BackgroundRemove/sidecar
  node -e "const s=require('sharp');s('../../ContainerApp/build/logo.svg',{density:384}).trim().resize({width:560}).png().toFile('../../ContainerApp/build/logo.png')"
  ```
  El icono (mascota sobre cuadrado claro) + los tamaños hicolor se componen con el mismo
  `sharp` (ver el historial de build).
