import { Suspense, useLayoutEffect, useMemo } from 'react'
import { RoundedBox, Decal, useTexture, useGLTF } from '@react-three/drei'
import * as THREE from 'three'

export interface DecalXf {
  x: number
  y: number
  scale: number
  rotation: number
  side: 'front' | 'back' | 'left' | 'right'
}

/** Un diseño colocado sobre la prenda (imagen + su transform). */
export interface DecalItem {
  id: string
  url: string
  xf: DecalXf
}

/**
 * Prenda/producto 3D. Dos motores:
 *  - Playera (normalize=false): malla principal a escala nativa tuneada (frontZ fijo).
 *  - Bebibles/gorra (normalize=true): modelos con MÚLTIPLES mallas y escalas rotas → se hornean
 *    los transforms de cada malla, se normaliza TODO junto a ~2u centrado, y se pinta cada malla.
 * Sin modelo → placeholder.
 */
export function Garment(props: {
  decals: DecalItem[]
  color: string
  modelUrl?: string | null
  frontZ?: number
  normalize?: boolean
  /** Rotación Y (radianes) para orientar el frente hacia la cámara (ej. la gorra viene de costado). */
  rotationY?: number
  /** Si está seteado, el diseño cubre TODA la superficie (all-over/sublimado) en vez de ser un decal. */
  allOverUrl?: string
}): React.JSX.Element {
  if (!props.modelUrl) return <PlaceholderGarment {...props} />
  return props.normalize ? (
    <NormalizedModel
      modelUrl={props.modelUrl}
      decals={props.decals}
      color={props.color}
      rotationY={props.rotationY}
      allOverUrl={props.allOverUrl}
    />
  ) : (
    <TunedGarment
      modelUrl={props.modelUrl}
      decals={props.decals}
      color={props.color}
      frontZ={props.frontZ}
      allOverUrl={props.allOverUrl}
    />
  )
}

/** Decal de un diseño sobre la malla padre. Proyecta según el lado (frente/espalda/izq/der). */
function DesignDecal({
  url,
  decal,
  frontZ,
  sideX,
  center = [0, 0, 0]
}: {
  url: string
  decal: DecalXf
  frontZ: number
  sideX: number
  /** Centro (en espacio del modelo) de la malla destino: el decal se ubica RELATIVO a él, porque
   *  algunas mallas (la corona de la gorra) están desplazadas dentro del modelo. */
  center?: [number, number, number]
}): React.JSX.Element {
  const tex = useTexture(url)
  useLayoutEffect(() => {
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 8
    tex.center.set(0.5, 0.5)
    tex.repeat.set(1, 1)
    tex.needsUpdate = true
  }, [tex])

  const [cx, cy, cz] = center
  let position: [number, number, number]
  let rotation: [number, number, number]
  switch (decal.side) {
    case 'back':
      position = [cx + decal.x, cy + decal.y, cz - frontZ]
      rotation = [0, Math.PI, decal.rotation]
      break
    case 'left':
      position = [cx - sideX, cy + decal.y, cz + decal.x]
      rotation = [0, -Math.PI / 2, decal.rotation]
      break
    case 'right':
      position = [cx + sideX, cy + decal.y, cz + decal.x]
      rotation = [0, Math.PI / 2, decal.rotation]
      break
    default:
      position = [cx + decal.x, cy + decal.y, cz + frontZ]
      rotation = [0, 0, decal.rotation]
  }

  return (
    <Decal position={position} rotation={rotation} scale={[decal.scale, decal.scale, 0.3]}>
      <meshStandardMaterial
        map={tex}
        transparent
        polygonOffset
        polygonOffsetFactor={-10}
        roughness={0.8}
        depthTest
      />
    </Decal>
  )
}

/** Frente/lado del bounding box de una geometría (para posicionar el decal en la superficie). */
function surfaceExtents(geo: THREE.BufferGeometry): { sideX: number; frontZ: number } {
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  if (!bb) return { sideX: 0.34, frontZ: 0.3 }
  return {
    sideX: Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)) * 0.82,
    frontZ: Math.max(Math.abs(bb.min.z), Math.abs(bb.max.z)) * 0.82
  }
}

function tintMaterial(mat: THREE.MeshStandardMaterial, color: string, rough: number, metal: number): void {
  mat.color = new THREE.Color(color)
  // Quitar texturas horneadas (sombras/AO) que ensucian al teñir con colores claros.
  mat.map = null
  mat.aoMap = null
  if ('roughness' in mat) mat.roughness = rough
  if ('metalness' in mat) mat.metalness = metal
  if ('envMapIntensity' in mat) mat.envMapIntensity = 1
  mat.needsUpdate = true
}

/** Modo LOGO (color sólido; encima van los decals) o ALL-OVER (el diseño cubre TODA la superficie
 *  vía UV → sublimado full-print). En all-over la prenda va blanca y el diseño es la textura base. */
function applyMaterial(
  mat: THREE.MeshStandardMaterial,
  color: string,
  allOverUrl: string | undefined,
  rough: number,
  metal: number
): void {
  if (!allOverUrl) {
    tintMaterial(mat, color, rough, metal)
    return
  }
  mat.color = new THREE.Color('#ffffff')
  mat.aoMap = null
  if ('roughness' in mat) mat.roughness = rough
  if ('metalness' in mat) mat.metalness = metal
  if ('envMapIntensity' in mat) mat.envMapIntensity = 1
  new THREE.TextureLoader().load(allOverUrl, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace
    tex.flipY = false // convención de UV de glTF
    mat.map = tex
    mat.needsUpdate = true
  })
  mat.needsUpdate = true
}

/** Playera: una sola malla a escala nativa tuneada. `frontZ` fijo (0.15). NO se toca. */
function TunedGarment({
  modelUrl,
  decals,
  color,
  frontZ,
  allOverUrl
}: {
  modelUrl: string
  decals: DecalItem[]
  color: string
  frontZ?: number
  allOverUrl?: string
}): React.JSX.Element {
  const { scene } = useGLTF(modelUrl)
  const { geometry, material, sideX, bboxFrontZ } = useMemo(() => {
    let best: THREE.Mesh | null = null
    let bestSize = 0
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      m.geometry.computeBoundingSphere()
      const s = m.geometry.boundingSphere?.radius ?? 0
      if (s > bestSize) {
        bestSize = s
        best = m
      }
    })
    const chosen = best as THREE.Mesh | null
    const src = chosen?.material as THREE.MeshStandardMaterial | undefined
    const mat = src?.clone?.() ?? new THREE.MeshStandardMaterial()
    const ext = chosen?.geometry ? surfaceExtents(chosen.geometry) : { sideX: 0.34, frontZ: 0.15 }
    return { geometry: chosen?.geometry ?? null, material: mat, sideX: ext.sideX, bboxFrontZ: ext.frontZ }
  }, [scene])

  const effFrontZ = frontZ ?? bboxFrontZ
  useLayoutEffect(() => applyMaterial(material, color, allOverUrl, 0.85, 0), [material, color, allOverUrl])

  if (!geometry) return <primitive object={scene} />
  return (
    <mesh geometry={geometry} material={material} castShadow receiveShadow dispose={null}>
      {!allOverUrl &&
        decals.map((d) => (
          <Suspense key={d.id} fallback={null}>
            <DesignDecal url={d.url} decal={d.xf} frontZ={effFrontZ} sideX={sideX} />
          </Suspense>
        ))}
    </mesh>
  )
}

/** Bebibles/gorra: hornea transforms de TODAS las mallas, normaliza a ~2u centrado, pinta todo,
 *  y proyecta los decals sobre la malla más grande (cuerpo/corona). */
function NormalizedModel({
  modelUrl,
  decals,
  color,
  rotationY,
  allOverUrl
}: {
  modelUrl: string
  decals: DecalItem[]
  color: string
  rotationY?: number
  allOverUrl?: string
}): React.JSX.Element {
  const { scene } = useGLTF(modelUrl)

  const { parts, bigIndex, sideX, frontZ, center } = useMemo(() => {
    scene.updateMatrixWorld(true)
    const collected: THREE.Mesh[] = []
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) collected.push(m)
    })
    // Bounding box de TODO el modelo en mundo (con transforms) → centro + escala.
    const worldBox = new THREE.Box3()
    for (const m of collected) {
      m.geometry.computeBoundingBox()
      if (m.geometry.boundingBox) worldBox.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld))
    }
    const size = new THREE.Vector3()
    const wcenter = new THREE.Vector3()
    worldBox.getSize(size)
    worldBox.getCenter(wcenter)
    const norm = 2 / (Math.max(size.x, size.y, size.z) || 1)
    // Cada malla: clonar geo, hornear su matriz mundo, centrar y escalar a ~2u, y SUAVIZAR
    // (fusionar vértices + normales suaves) para que el low-poly se vea más redondo.
    const parts = collected.map((m) => {
      const g = m.geometry.clone()
      g.applyMatrix4(m.matrixWorld)
      g.translate(-wcenter.x, -wcenter.y, -wcenter.z)
      g.scale(norm, norm, norm)
      if (rotationY) g.rotateY(rotationY)
      g.computeBoundingBox()
      const tris = g.index ? g.index.count / 3 : g.attributes.position.count / 3
      const src = m.material as THREE.Material | THREE.Material[]
      const mat = (Array.isArray(src) ? src[0] : src)?.clone?.() ?? new THREE.MeshStandardMaterial()
      return { geometry: g, material: mat as THREE.MeshStandardMaterial, tris }
    })
    // Malla destino del decal = la de MAYOR VOLUMEN de bbox (el cuerpo/corona). El conteo de
    // triángulos engaña en modelos escaneados/detallados: una hebilla de plástico puede tener
    // más tris que toda la corona (caso real de la gorra de 93k tris).
    let bigIndex = 0
    let bigV = -1
    parts.forEach((p, i) => {
      const bb = p.geometry.boundingBox
      if (!bb) return
      const sz = new THREE.Vector3()
      bb.getSize(sz)
      const vol = Math.max(sz.x, 1e-4) * Math.max(sz.y, 1e-4) * Math.max(sz.z, 1e-4)
      if (vol > bigV) {
        bigV = vol
        bigIndex = i
      }
    })
    // Centro + medias-extensiones de la malla principal → el decal se ubica sobre SU superficie
    // (la corona de la gorra está desplazada respecto del origen del modelo).
    const bg = parts[bigIndex]?.geometry.boundingBox
    const bc = new THREE.Vector3()
    const bsz = new THREE.Vector3()
    if (bg) {
      bg.getCenter(bc)
      bg.getSize(bsz)
    }
    return {
      parts,
      bigIndex,
      sideX: (bsz.x / 2) * 0.9,
      frontZ: (bsz.z / 2) * 0.9,
      center: [bc.x, bc.y, bc.z] as [number, number, number]
    }
  }, [scene, rotationY])

  useLayoutEffect(() => {
    parts.forEach((p, i) =>
      applyMaterial(p.material, color, i === bigIndex ? allOverUrl : undefined, 0.6, 0.15)
    )
  }, [parts, color, allOverUrl, bigIndex])

  return (
    <group>
      {parts.map((p, i) => (
        <mesh key={i} geometry={p.geometry} material={p.material} castShadow receiveShadow dispose={null}>
          {!allOverUrl &&
            i === bigIndex &&
            decals.map((d) => (
              <Suspense key={d.id} fallback={null}>
                <DesignDecal url={d.url} decal={d.xf} frontZ={frontZ} sideX={sideX} center={center} />
              </Suspense>
            ))}
        </mesh>
      ))}
    </group>
  )
}

function PlaceholderGarment({
  decals,
  color
}: {
  decals: DecalItem[]
  color: string
  modelUrl?: string | null
  frontZ?: number
  normalize?: boolean
}): React.JSX.Element {
  return (
    <RoundedBox args={[1.35, 1.75, 0.5]} radius={0.24} smoothness={8} castShadow receiveShadow>
      <meshStandardMaterial color={color} roughness={0.88} metalness={0.02} envMapIntensity={0.8} />
      {decals.map((d) => (
        <Suspense key={d.id} fallback={null}>
          <DesignDecal url={d.url} decal={d.xf} frontZ={0.26} sideX={0.6} />
        </Suspense>
      ))}
    </RoundedBox>
  )
}
