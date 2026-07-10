import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import { DoubleSide } from 'three'
import { attribute, float, mix, positionLocal, sin, uniform, vec3 } from 'three/tsl'
import { registerBookmark } from '../core/debug'
import { fbm2 as fbmCpu } from '../core/noise2'
import type { Rng } from '../core/prng'
import { fbm2 } from '../render/tslNoise'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { currentFlow } from '../sea/current'
import type { SeaMediumSystem } from '../sea/medium'
import { inParkFootprint } from './parkPlan'
import { terrainHeight, RIM_Z } from './terrain'

/**
 * Flora & reef dressing (plan §6): kelp curtain on the south/east/west
 * boundary, seagrass meadows where the sand tint says so (same field, same
 * cause), coral colonies and rocks. Kelp and seagrass sway on the shared
 * current field via baked root attributes — one draw each, world-coherent.
 */
export class FloraSystem implements GameSystem {
  readonly id = 'flora'
  private readonly group = new Object3D()
  private readonly timeUniform = uniform(0)
  private readonly medium: SeaMediumSystem

  constructor(medium: SeaMediumSystem) {
    this.medium = medium
  }

  init(ctx: GameContext): void {
    const rng = ctx.rng.fork('flora')
    this.buildKelp(rng.fork('kelp'))
    this.buildSeagrass(rng.fork('seagrass'), ctx.quality.params.seagrassDensity)
    this.buildReef(rng.fork('reef'))
    this.group.traverse((node) => {
      if ((node as Mesh).isMesh) {
        node.castShadow = true
        node.receiveShadow = true
      }
    })
    ctx.scene.add(this.group)

    registerBookmark({
      name: 'gardens',
      position: [150, terrainHeight(150, 150) + 2, 150],
      look: [190, terrainHeight(190, 120) - 1, 120],
      note: 'Coral gardens + seagrass on the plateau',
    })
  }

  update(ctx: GameContext): void {
    this.timeUniform.value = ctx.time.elapsed
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
  }

  // ── Kelp: baked ribbon stalks with root-coherent sway ──────────────────
  private buildKelp(rng: Rng): void {
    const SEGMENTS = 9
    const stalks: number[] = []
    const roots: number[] = []
    const sway: number[] = []
    const indices: number[] = []
    let vertexBase = 0

    const COUNT = 300
    for (let s = 0; s < COUNT; s++) {
      // Boundary arc: radius 320–450, southern 250° (kelp never blocks the rim).
      const angle = Math.PI * 0.5 + rng.range(-1.1, 1.1) * Math.PI * 0.72
      const radius = rng.range(320, 450)
      const x = Math.cos(angle) * radius
      const z = Math.sin(angle) * radius
      if (z < RIM_Z + 40) continue
      if (inParkFootprint(x, z, 3)) continue
      const y = terrainHeight(x, z)
      const height = rng.range(7, 14)
      const width = rng.range(0.22, 0.4)
      const yaw = rng.range(0, Math.PI * 2)
      const dx = Math.cos(yaw) * width
      const dz = Math.sin(yaw) * width

      for (let i = 0; i <= SEGMENTS; i++) {
        const t = i / SEGMENTS
        const wy = y + t * height
        const taper = 1 - t * 0.75
        stalks.push(x - dx * taper, wy, z - dz * taper, x + dx * taper, wy, z + dz * taper)
        const w = Math.pow(t, 1.4)
        sway.push(w, w)
        roots.push(x, z, x, z)
      }
      for (let i = 0; i < SEGMENTS; i++) {
        const a = vertexBase + i * 2
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
      vertexBase += (SEGMENTS + 1) * 2
    }

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(stalks), 3))
    geometry.setAttribute('rootXZ', new BufferAttribute(new Float32Array(roots), 2))
    geometry.setAttribute('swayWeight', new BufferAttribute(new Float32Array(sway), 1))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()

    const material = new MeshStandardNodeMaterial()
    material.side = DoubleSide
    material.roughness = 0.65
    const root = attribute('rootXZ', 'vec2') as unknown as Node<'vec2'>
    const weight = attribute('swayWeight', 'float') as unknown as Node<'float'>
    const rootWorld = vec3(root.x, float(-20), root.y)
    const flow = currentFlow(rootWorld, this.timeUniform)
    const flutter = sin(this.timeUniform.mul(1.7).add(root.x.mul(0.7)).add(root.y.mul(0.9)))
    material.positionNode = positionLocal
      .add(flow.mul(weight).mul(vec3(2.2, 0.35, 2.2)))
      .add(vec3(flutter.mul(weight).mul(0.35), 0, flutter.mul(weight).mul(-0.22)))
    material.colorNode = mix(vec3(0.1, 0.16, 0.08), vec3(0.23, 0.32, 0.12), weight)
    this.medium.applyCaustics(material, 1.1)

    this.group.add(new Mesh(geometry, material))
  }

  // ── Seagrass: chunked baked blades in the meadow field ─────────────────
  private buildSeagrass(rng: Rng, density: number): void {
    const TARGET = Math.floor(120_000 * density)
    const CHUNK = 5
    const chunkLists: { positions: number[]; roots: number[]; sway: number[] }[] = []
    for (let i = 0; i < CHUNK * CHUNK; i++) {
      chunkLists.push({ positions: [], roots: [], sway: [] })
    }

    let placed = 0
    let attempts = 0
    while (placed < TARGET && attempts < TARGET * 6) {
      attempts++
      const x = rng.range(-420, 420)
      const z = rng.range(-240, 420)
      // Meadow mask = the same field that tints the sand green.
      const mask = fbmCpu(x * 0.0045, z * 0.0045, 5, 23)
      if (mask < 0.62) continue
      if (inParkFootprint(x, z, 0.5)) continue
      const y = terrainHeight(x, z)
      if (y < -32) continue
      const height = rng.range(0.5, 1.15)
      const lean = rng.range(-0.12, 0.12)
      const yaw = rng.range(0, Math.PI * 2)
      const w = 0.045
      const dx = Math.cos(yaw) * w
      const dz = Math.sin(yaw) * w

      const ci =
        Math.min(CHUNK - 1, Math.floor(((x + 420) / 840) * CHUNK)) +
        Math.min(CHUNK - 1, Math.floor(((z + 240) / 660) * CHUNK)) * CHUNK
      const list = chunkLists[ci]
      // Blade: 4 verts (two tapering quads as a strip via 2 triangles here).
      list.positions.push(
        x - dx, y, z - dz,
        x + dx, y, z + dz,
        x + lean, y + height, z + lean * 0.6,
      )
      list.roots.push(x, z, x, z, x, z)
      list.sway.push(0, 0, 1)
      placed++
    }

    const material = new MeshStandardNodeMaterial()
    material.side = DoubleSide
    material.roughness = 0.8
    const root = attribute('rootXZ', 'vec2') as unknown as Node<'vec2'>
    const weight = attribute('swayWeight', 'float') as unknown as Node<'float'>
    const rootWorld = vec3(root.x, float(-24), root.y)
    const flow = currentFlow(rootWorld, this.timeUniform)
    const flutter = sin(
      this.timeUniform.mul(2.3).add(root.x.mul(3.1)).add(root.y.mul(2.7)),
    ).mul(0.09)
    material.positionNode = positionLocal
      .add(flow.mul(weight).mul(vec3(0.45, 0.05, 0.45)))
      .add(vec3(flutter.mul(weight), 0, flutter.mul(weight).mul(0.7)))
    material.colorNode = mix(vec3(0.1, 0.2, 0.12), vec3(0.3, 0.5, 0.28), weight).mul(
      fbm2(root.mul(0.05)).mul(0.5).add(0.75),
    )
    this.medium.applyCaustics(material, 1.2)

    for (const list of chunkLists) {
      if (list.positions.length === 0) continue
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(list.positions), 3))
      geometry.setAttribute('rootXZ', new BufferAttribute(new Float32Array(list.roots), 2))
      geometry.setAttribute('swayWeight', new BufferAttribute(new Float32Array(list.sway), 1))
      geometry.computeVertexNormals()
      const mesh = new Mesh(geometry, material)
      mesh.castShadow = false
      this.group.add(mesh)
    }
  }

  // ── Corals & rocks: static instanced archetypes ────────────────────────
  private buildReef(rng: Rng): void {
    const brain = new SphereGeometry(1, 24, 16)
    displace(brain, 0.16, 3.1, rng.fork('brain-noise'))
    brain.scale(1, 0.72, 1)

    const staghornPieces: BufferGeometry[] = []
    const stagRng = rng.fork('staghorn-shape')
    for (let i = 0; i < 8; i++) {
      const branch = new CylinderGeometry(0.045, 0.11, 1.15, 7)
      const tilt = stagRng.range(0.3, 0.95)
      const yaw = stagRng.range(0, Math.PI * 2)
      branch.translate(0, 0.55, 0)
      branch.rotateZ(tilt)
      branch.rotateY(yaw)
      staghornPieces.push(branch)
    }
    const staghorn = mergeGeometries(staghornPieces)!

    const fan = new SphereGeometry(1, 28, 12)
    displace(fan, 0.3, 6.0, rng.fork('fan-noise'))
    fan.scale(1, 0.95, 0.1)

    const rock = new IcosahedronGeometry(1, 2)
    displace(rock, 0.24, 1.7, rng.fork('rock-noise'))

    const archetypes: {
      geometry: BufferGeometry
      color: number
      roughness: number
      count: number
      scale: [number, number]
      band: [number, number]
    }[] = [
      { geometry: brain, color: 0xa8756c, roughness: 0.85, count: 130, scale: [0.35, 1.1], band: [190, 430] },
      { geometry: staghorn, color: 0xe08a70, roughness: 0.7, count: 150, scale: [0.7, 1.6], band: [190, 440] },
      { geometry: fan, color: 0x9a6fb0, roughness: 0.6, count: 120, scale: [0.35, 0.9], band: [200, 450] },
      { geometry: rock, color: 0x69705f, roughness: 0.95, count: 220, scale: [0.5, 2.6], band: [60, 560] },
    ]

    const matrix = new Matrix4()
    const position = new Vector3()
    const quaternion = new Quaternion()
    const up = new Vector3(0, 1, 0)
    const scaleVector = new Vector3()

    for (const type of archetypes) {
      const material = new MeshStandardNodeMaterial()
      material.color = new Color(type.color)
      material.roughness = type.roughness
      this.medium.applyCaustics(material, 1.3)
      const mesh = new InstancedMesh(type.geometry, material, type.count)
      mesh.instanceMatrix.setUsage(DynamicDrawUsage)
      const placeRng = rng.fork(`place-${type.color}`)
      for (let i = 0; i < type.count; i++) {
        const angle = placeRng.range(0, Math.PI * 2)
        const radius = placeRng.range(type.band[0], type.band[1])
        const x = Math.cos(angle) * radius
        const z = Math.sin(angle) * radius * 0.92
        if (z < RIM_Z + 18 || inParkFootprint(x, z, 2.5)) {
          matrix.makeScale(0, 0, 0)
          mesh.setMatrixAt(i, matrix)
          continue
        }
        const y = terrainHeight(x, z)
        const s = placeRng.range(type.scale[0], type.scale[1])
        position.set(x, y + s * 0.12, z)
        quaternion.setFromAxisAngle(up, placeRng.range(0, Math.PI * 2))
        scaleVector.set(s, s * placeRng.range(0.85, 1.15), s)
        matrix.compose(position, quaternion, scaleVector)
        mesh.setMatrixAt(i, matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
      this.group.add(mesh)
    }
  }
}

function displace(geometry: BufferGeometry, amount: number, frequency: number, rng: Rng): void {
  const seedX = rng.range(0, 100)
  const seedY = rng.range(0, 100)
  const positions = geometry.getAttribute('position')
  const v = new Vector3()
  for (let i = 0; i < positions.count; i++) {
    v.fromBufferAttribute(positions, i)
    const n =
      fbmCpu(v.x * frequency + seedX, (v.y + v.z) * frequency + seedY, 4, 5) - 0.5
    v.multiplyScalar(1 + n * 2 * amount)
    positions.setXYZ(i, v.x, v.y, v.z)
  }
  positions.needsUpdate = true
  geometry.computeVertexNormals()
}
