// Genera taza.glb y vaso.glb PROPIOS (sin licencias de terceros) como sólidos de revolución.
// Uso:  cd ContainerApp && node scripts/bake-drink-models.mjs <carpeta-salida>
// Shim mínimo de FileReader para Node (GLTFExporter lo usa al armar el .glb binario).
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((ab) => {
      this.result = ab
      this.onloadend?.()
    })
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((ab) => {
      this.result = 'data:application/octet-stream;base64,' + Buffer.from(ab).toString('base64')
      this.onloadend?.()
    })
  }
}
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { writeFileSync } from 'node:fs'

/** Perfil 2D (r, y) → LatheGeometry suave con costura UV limpia. */
function lathe(points, segments = 128) {
  const g = new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(r, y)),
    segments
  )
  g.computeVertexNormals()
  return g
}

/** Taza de café clásica: pared con grosor visible (labio + interior) + asa toroidal. */
function buildMug() {
  const group = new THREE.Group()
  group.name = 'taza'

  // Perfil exterior→labio→interior→fondo interno (con grosor 0.04 y radio 1).
  const R = 1.0 // radio exterior
  const H = 2.2 // alto
  const t = 0.05 // grosor pared
  const pts = []
  // base exterior (leve chaflán para que la sombra de contacto lea bien)
  pts.push([0.0, 0.0])
  pts.push([R - 0.12, 0.0])
  pts.push([R - 0.02, 0.06])
  // pared exterior (recta, apenas abombada al medio para que la luz module)
  pts.push([R, 0.16])
  pts.push([R + 0.015, H * 0.55])
  pts.push([R, H - 0.08])
  // labio redondeado
  pts.push([R - t * 0.35, H])
  pts.push([R - t, H - 0.02])
  // pared interior
  pts.push([R - t, 0.28])
  // fondo interior
  pts.push([0.0, 0.22])
  const body = new THREE.Mesh(lathe(pts, 144), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 }))
  body.name = 'cuerpo'
  group.add(body)

  // Asa: medio toro aplastado, pegado a la pared.
  const handleGeo = new THREE.TorusGeometry(0.52, 0.11, 24, 48, Math.PI)
  handleGeo.computeVertexNormals()
  const handle = new THREE.Mesh(handleGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 }))
  handle.name = 'asa'
  handle.position.set(-(R + 0.06), H * 0.52, 0)
  handle.rotation.z = Math.PI / 2 // arco vertical
  handle.scale.set(1, 1.25, 0.82)
  group.add(handle)

  return group
}

/** Vaso/termo de sublimación: cilindro levemente cónico, labio con grosor, interior visible. */
function buildTumbler() {
  const group = new THREE.Group()
  group.name = 'vaso'
  const Rb = 0.78 // radio base
  const Rt = 0.95 // radio boca
  const H = 2.6
  const t = 0.045
  const pts = []
  pts.push([0.0, 0.0])
  pts.push([Rb - 0.1, 0.0])
  pts.push([Rb, 0.05])
  // pared exterior cónica
  pts.push([Rb + (Rt - Rb) * 0.5, H * 0.5])
  pts.push([Rt, H - 0.06])
  // labio
  pts.push([Rt - t * 0.3, H])
  pts.push([Rt - t, H - 0.03])
  // pared interior
  pts.push([Rb - t + (Rt - Rb) * 0.15, 0.3])
  pts.push([0.0, 0.26])
  const body = new THREE.Mesh(lathe(pts, 144), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }))
  body.name = 'cuerpo'
  group.add(body)
  return group
}

/** Termo skinny 20oz con tapa: EL clásico de sublimación. Cuerpo recto + tapa a presión. */
function buildThermos() {
  const group = new THREE.Group()
  group.name = 'termo'
  const R = 0.62
  const H = 3.1
  // Cuerpo: cilindro casi recto con base levemente rebajada (skinny tumbler).
  const body = new THREE.Mesh(
    lathe(
      [
        [0.0, 0.0],
        [R - 0.08, 0.0],
        [R - 0.015, 0.05],
        [R, 0.4],
        [R, H - 0.05],
        [R - 0.02, H],
        [0.0, H]
      ],
      144
    ),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32 })
  )
  body.name = 'cuerpo'
  group.add(body)
  // Tapa a presión con botón/boquilla (pieza aparte, MENOS triángulos que el cuerpo).
  const lid = new THREE.Mesh(
    lathe(
      [
        [R + 0.02, H - 0.02],
        [R + 0.05, H + 0.06],
        [R + 0.03, H + 0.3],
        [0.34, H + 0.34],
        [0.3, H + 0.4],
        [0.16, H + 0.44],
        [0.0, H + 0.45]
      ],
      96
    ),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 })
  )
  lid.name = 'tapa'
  group.add(lid)
  return group
}

/** Botella deportiva con hombro curvo y tapa sport (sublimación de aluminio). */
function buildBottle() {
  const group = new THREE.Group()
  group.name = 'botella'
  const R = 0.58
  const H = 2.4 // alto del cuerpo hasta el hombro
  const neckR = 0.24
  const body = new THREE.Mesh(
    lathe(
      [
        [0.0, 0.0],
        [R - 0.08, 0.0],
        [R - 0.01, 0.06],
        [R, 0.5],
        [R, H * 0.72],
        // hombro curvo hacia el cuello
        [R * 0.92, H * 0.84],
        [R * 0.66, H * 0.94],
        [neckR + 0.05, H + 0.06],
        [neckR, H + 0.18],
        [neckR, H + 0.3]
      ],
      144
    ),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.15 })
  )
  body.name = 'cuerpo'
  group.add(body)
  const cap = new THREE.Mesh(
    lathe(
      [
        [neckR + 0.06, H + 0.28],
        [neckR + 0.08, H + 0.34],
        [neckR + 0.06, H + 0.6],
        [0.12, H + 0.66],
        [0.1, H + 0.78],
        [0.0, H + 0.8]
      ],
      96
    ),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 })
  )
  cap.name = 'tapa'
  group.add(cap)
  return group
}

/** Mousepad rectangular de bordes redondeados, cara imprimible mirando a +z (frente). */
function buildMousepad() {
  const group = new THREE.Group()
  group.name = 'mousepad'
  const shape = new THREE.Shape()
  const w = 2.3
  const h = 1.35
  const r = 0.12
  shape.moveTo(-w / 2 + r, -h / 2)
  shape.lineTo(w / 2 - r, -h / 2)
  shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r)
  shape.lineTo(w / 2, h / 2 - r)
  shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2)
  shape.lineTo(-w / 2 + r, h / 2)
  shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r)
  shape.lineTo(-w / 2, -h / 2 + r)
  shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2)
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.07, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 3, curveSegments: 24 })
  // Extrude va de z=0 a z=depth: centrarlo. Cara imprimible ya mira a +z.
  g.translate(0, 0, -0.035)
  // UVs planas 0..1 sobre la cara (para all-over): reproyectar del bbox XY.
  g.computeBoundingBox()
  const bb = g.boundingBox
  const pos = g.attributes.position
  const uv = g.attributes.uv
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x), (pos.getY(i) - bb.min.y) / (bb.max.y - bb.min.y))
  }
  g.computeVertexNormals()
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 }))
  mesh.name = 'pad'
  group.add(mesh)
  return group
}

/** Plato cerámico decorativo, de frente (cara imprimible a +z, como en exhibidor). */
function buildPlate() {
  const group = new THREE.Group()
  group.name = 'plato'
  const R = 1.15
  const g = lathe(
    [
      [0.0, 0.0],
      [R * 0.45, 0.02],
      [R * 0.55, 0.06],
      [R * 0.82, 0.12],
      [R * 0.97, 0.22],
      [R, 0.28],
      [R * 0.985, 0.3],
      // cara interior (la imprimible)
      [R * 0.8, 0.2],
      [R * 0.52, 0.12],
      [R * 0.4, 0.1],
      [0.0, 0.09]
    ],
    160
  )
  // El lathe queda "acostado" (cara arriba, +y): pararlo mirando a la cámara (+z).
  g.rotateX(-Math.PI / 2)
  g.computeVertexNormals()
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 }))
  mesh.name = 'plato'
  group.add(mesh)
  return group
}

function exportGlb(object, file) {
  return new Promise((resolve, reject) => {
    const scene = new THREE.Scene()
    scene.add(object)
    new GLTFExporter().parse(
      scene,
      (result) => {
        writeFileSync(file, Buffer.from(result))
        const tris = []
        object.traverse((o) => {
          if (o.isMesh) tris.push(`${o.name}:${o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3}`)
        })
        console.log(file, '→', tris.join(' · '))
        resolve()
      },
      (err) => reject(err),
      { binary: true }
    )
  })
}

await exportGlb(buildMug(), process.argv[2] + '/taza-propia.glb')
await exportGlb(buildTumbler(), process.argv[2] + '/vaso-propio.glb')
await exportGlb(buildThermos(), process.argv[2] + '/termo-propio.glb')
await exportGlb(buildBottle(), process.argv[2] + '/botella-propia.glb')
await exportGlb(buildMousepad(), process.argv[2] + '/mousepad-propio.glb')
await exportGlb(buildPlate(), process.argv[2] + '/plato-propio.glb')
console.log('OK')
