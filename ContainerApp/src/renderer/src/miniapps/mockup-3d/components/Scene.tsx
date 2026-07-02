import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Environment, ContactShadows, OrbitControls, Center, PerspectiveCamera } from '@react-three/drei'
import * as THREE from 'three'
import studioHdri from '@pmndrs/assets/hdri/studio.exr'
import { Garment, type DecalItem } from './Garment'

/** Opciones de captura del giro 360°. */
export interface TurntableOpts {
  /** Cuántos cuadros repartidos en la vuelta completa (más = más suave). */
  frames: number
  /** Color de fondo con el que se aplana cada cuadro (los videos no tienen alfa). */
  bg?: string
  /** Progreso 1..frames para pintar barra en la UI. */
  onProgress?: (done: number, total: number) => void
}

/** Función imperativa que devuelve los cuadros PNG (cuadrados) del giro 360°. */
export type CaptureApi = (opts: TurntableOpts) => Promise<ArrayBuffer[]>

/** Ajusta la exposición del render en vivo (control de "luz"/brillo). */
function Exposure({ value }: { value: number }): null {
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    gl.toneMappingExposure = value
  }, [gl, value])
  return null
}

/**
 * Mide el bbox del contenido (una vez cargado el modelo — vive dentro del mismo Suspense)
 * y reporta su piso (min.y). Así la sombra de contacto queda SIEMPRE pegada a la base del
 * producto, sin importar su escala de encuadre (viewScale) o proporciones.
 */
function GroundProbe({
  target,
  onGround,
  deps
}: {
  target: React.RefObject<THREE.Group | null>
  onGround: (y: number) => void
  deps: React.DependencyList
}): null {
  useLayoutEffect(() => {
    const g = target.current
    if (!g) return
    const box = new THREE.Box3().setFromObject(g)
    if (Number.isFinite(box.min.y)) onGround(box.min.y - 0.002)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return null
}

/**
 * Registra en `captureRef` una función que gira el modelo 360° y captura N cuadros PNG
 * cuadrados (recorte central del lienzo WebGL, aplanado sobre `bg`). Vive DENTRO del Canvas
 * para acceder a gl/scene/camera. Congela el auto-giro de la cámara durante la captura para
 * que la vuelta sea limpia (solo rota el modelo, con luz de estudio fija = turntable real).
 */
function CaptureController({
  spinRef,
  captureRef
}: {
  spinRef: React.RefObject<THREE.Group | null>
  captureRef?: React.MutableRefObject<CaptureApi | null>
}): null {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as { autoRotate?: boolean } | null
  useEffect(() => {
    if (!captureRef) return
    captureRef.current = async ({ frames, bg, onProgress }) => {
      const spin = spinRef.current
      const src = gl.domElement as HTMLCanvasElement
      if (!spin || !src.width) return []
      const prevAuto = controls?.autoRotate
      if (controls) controls.autoRotate = false
      const prevY = spin.rotation.y
      // Recorte central cuadrado del lienzo (lado par para códecs).
      const dim = Math.floor(Math.min(src.width, src.height) / 2) * 2
      const sx = Math.floor((src.width - dim) / 2)
      const sy = Math.floor((src.height - dim) / 2)
      const tmp = document.createElement('canvas')
      tmp.width = dim
      tmp.height = dim
      const ctx = tmp.getContext('2d')
      const out: ArrayBuffer[] = []
      for (let i = 0; i < frames; i++) {
        spin.rotation.y = prevY + (i / frames) * Math.PI * 2
        gl.render(scene, camera)
        if (ctx) {
          ctx.clearRect(0, 0, dim, dim)
          if (bg) {
            ctx.fillStyle = bg
            ctx.fillRect(0, 0, dim, dim)
          }
          ctx.drawImage(src, sx, sy, dim, dim, 0, 0, dim, dim)
          const blob = await new Promise<Blob | null>((r) => tmp.toBlob(r, 'image/png'))
          if (blob) out.push(await blob.arrayBuffer())
        }
        onProgress?.(i + 1, frames)
        await new Promise((r) => setTimeout(r, 0))
      }
      // Restaurar estado del visor.
      spin.rotation.y = prevY
      if (controls && prevAuto) controls.autoRotate = prevAuto
      gl.render(scene, camera)
      return out
    }
    return () => {
      if (captureRef) captureRef.current = null
    }
  }, [gl, scene, camera, controls, spinRef, captureRef])
  return null
}

export interface SceneProps {
  decals: DecalItem[]
  garmentColor: string
  modelUrl?: string | null
  autoRotate: boolean
  transparent: boolean
  brightness: number
  sizeScale: number
  frontZ?: number
  normalize?: boolean
  rotationY?: number
  allOverUrl?: string
  /** Ref donde el visor publica la función de captura del giro 360° (para exportar video). */
  captureRef?: React.MutableRefObject<CaptureApi | null>
}

/**
 * Escena 3D realista para el mockup de prenda. Iluminación por HDRI de estudio (offline,
 * @pmndrs/assets), sombra de contacto en el piso, tone mapping ACES y órbita/zoom/auto-giro.
 * `preserveDrawingBuffer` habilita la captura a PNG. El fondo puede ser estudio (gris claro)
 * o transparente (para exportar la prenda recortada).
 */
export function Scene({
  decals,
  garmentColor,
  modelUrl,
  autoRotate,
  transparent,
  brightness,
  sizeScale,
  frontZ,
  normalize,
  rotationY,
  allOverUrl,
  captureRef
}: SceneProps): React.JSX.Element {
  // Grupo que gira el modelo (centrado) para capturar el video 360° sin mover la cámara.
  const spinRef = useRef<THREE.Group>(null)
  // Piso real del producto (min.y del bbox): ancla la sombra de contacto a su base.
  const [groundY, setGroundY] = useState(-1)
  // Config del renderer MEMOIZADA: si fuera un objeto inline, React lo re-aplicaría en cada
  // render y reiniciaría la exposición (el brillo). La exposición la maneja <Exposure/>.
  const glConfig = useMemo(
    () => ({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      toneMapping: THREE.ACESFilmicToneMapping
    }),
    []
  )
  return (
    <Canvas shadows dpr={[1, 2]} gl={glConfig}>
      <PerspectiveCamera makeDefault position={[0, 0, 2.5]} fov={30} />
      <Exposure value={brightness} />
      {!transparent && <color attach="background" args={['#f3f4f6']} />}
      <ambientLight intensity={0.35} />
      <directionalLight
        position={[3, 5, 4]}
        intensity={1.3}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0002}
      />
      <Suspense fallback={null}>
        <group ref={spinRef}>
          <Center>
            <group scale={sizeScale}>
              <Garment
                decals={decals}
                color={garmentColor}
                modelUrl={modelUrl}
                frontZ={frontZ}
                normalize={normalize}
                rotationY={rotationY}
                allOverUrl={allOverUrl}
              />
            </group>
          </Center>
        </group>
        <GroundProbe target={spinRef} onGround={setGroundY} deps={[modelUrl, sizeScale, rotationY]} />
        <Environment files={studioHdri} />
      </Suspense>
      <CaptureController spinRef={spinRef} captureRef={captureRef} />
      <ContactShadows
        position={[0, groundY, 0]}
        opacity={0.45}
        scale={7}
        blur={2.6}
        far={2.2}
        resolution={1024}
      />
      <OrbitControls
        makeDefault
        autoRotate={autoRotate}
        autoRotateSpeed={5}
        enablePan={false}
        zoomSpeed={1.8}
        minDistance={0.5}
        maxDistance={10}
        minPolarAngle={0.25}
        maxPolarAngle={Math.PI - 0.35}
      />
    </Canvas>
  )
}
