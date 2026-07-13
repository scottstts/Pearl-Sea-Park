import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Euler,
  IcosahedronGeometry,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import { DoubleSide } from 'three'
import {
  attribute,
  float,
  mix,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl'
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
    this.buildShellsAndStones(rng.fork('shells-and-stones'))
    this.buildSeaTreasures(rng.fork('sea-treasures'))
    this.group.traverse((node) => {
      if ((node as Mesh).isMesh) {
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

      // Alternating lateral blades create the feathered kelp silhouette.
      // They share the same baked root and rooted sway weights, so the added
      // character costs no extra draw or animation pass.
      for (let leaf = 0; leaf < 4; leaf++) {
        const t = 0.3 + leaf * 0.16
        const side = leaf % 2 === 0 ? -1 : 1
        const leafYaw = yaw + side * (Math.PI * 0.42) + rng.range(-0.2, 0.2)
        const length = rng.range(0.85, 1.55) * (1 - t * 0.35)
        const leafWidth = width * 0.42
        const baseY = y + t * height
        const tipX = x + Math.cos(leafYaw) * length
        const tipZ = z + Math.sin(leafYaw) * length
        const px = -Math.sin(leafYaw) * leafWidth
        const pz = Math.cos(leafYaw) * leafWidth
        stalks.push(
          x - px, baseY, z - pz,
          x + px, baseY, z + pz,
          tipX + px * 0.15, baseY + length * 0.24, tipZ + pz * 0.15,
          tipX - px * 0.15, baseY + length * 0.24, tipZ - pz * 0.15,
        )
        const baseWeight = Math.pow(t, 1.4)
        sway.push(baseWeight, baseWeight, Math.min(1, baseWeight + 0.22), Math.min(1, baseWeight + 0.22))
        roots.push(x, z, x, z, x, z, x, z)
        indices.push(vertexBase, vertexBase + 1, vertexBase + 2, vertexBase, vertexBase + 2, vertexBase + 3)
        vertexBase += 4
      }
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
    // Per-stalk tonal identity from the baked root, olive deepening to a
    // translucent amber blade tip — the frond gradient real kelp carries.
    const stalkTone = fbm2(root.mul(0.04)).mul(0.45).add(0.75)
    material.colorNode = mix(vec3(0.075, 0.14, 0.06), vec3(0.24, 0.33, 0.11), weight)
      .mul(stalkTone)
      .add(weight.pow(3).mul(vec3(0.11, 0.075, 0.0)))
    material.roughnessNode = float(0.72).sub(weight.mul(0.18))
    this.medium.applyCaustics(material, 1.1)

    const mesh = new Mesh(geometry, material)
    mesh.name = 'flora-kelp'
    mesh.castShadow = false
    this.group.add(mesh)
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
    // Meadow-scale patch tone plus a warm sun-kissed tip so raking caustic
    // light picks individual blades out of the mass.
    material.colorNode = mix(vec3(0.09, 0.19, 0.11), vec3(0.3, 0.52, 0.27), weight)
      .mul(fbm2(root.mul(0.05)).mul(0.5).add(0.75))
      .add(weight.mul(weight).mul(vec3(0.07, 0.055, 0.0)))
    this.medium.applyCaustics(material, 1.2)

    for (const list of chunkLists) {
      if (list.positions.length === 0) continue
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(list.positions), 3))
      geometry.setAttribute('rootXZ', new BufferAttribute(new Float32Array(list.roots), 2))
      geometry.setAttribute('swayWeight', new BufferAttribute(new Float32Array(list.sway), 1))
      geometry.computeVertexNormals()
      const mesh = new Mesh(geometry, material)
      mesh.name = 'flora-seagrass'
      mesh.castShadow = false
      this.group.add(mesh)
    }
  }

  // ── Corals & rocks: static instanced archetypes ────────────────────────
  // Six families now: brain and staghorn corals, reef rock, tube-sponge
  // clusters, barrel sponges, and table corals. Every archetype's material
  // shares one recipe — a base identity color modulated by a worldspace
  // colony-patch field — so the reef reads as one ecosystem, and species
  // with growth direction (staghorn tips, sponge rims) grade their color
  // along the geometry's own local axis.
  private buildReef(rng: Rng): void {
    const brain = new SphereGeometry(1, 26, 18)
    displace(brain, 0.16, 3.1, rng.fork('brain-noise'))
    // Second octave: the meander-wrinkle that makes a brain coral a brain.
    displace(brain, 0.05, 10.0, rng.fork('brain-wrinkle'))
    brain.scale(1, 0.72, 1)

    const staghornPieces: BufferGeometry[] = []
    const stagRng = rng.fork('staghorn-shape')
    for (let i = 0; i < 8; i++) {
      const tilt = stagRng.range(0.3, 0.95)
      const yaw = stagRng.range(0, Math.PI * 2)
      const branch = new CylinderGeometry(0.045, 0.11, 1.15, 7)
      branch.translate(0, 0.55, 0)
      branch.rotateZ(tilt)
      branch.rotateY(yaw)
      staghornPieces.push(branch)
      // A forked twig off most branches — antler character over bare spikes.
      if (i % 3 !== 2) {
        const twig = new CylinderGeometry(0.028, 0.055, 0.62, 6)
        twig.translate(0, 0.31, 0)
        twig.rotateZ(tilt + stagRng.range(0.35, 0.7))
        twig.rotateY(yaw + stagRng.range(-0.4, 0.4))
        twig.translate(
          Math.sin(yaw) * 0.28 * Math.sin(tilt),
          0.62,
          Math.cos(yaw) * 0.28 * Math.sin(tilt),
        )
        staghornPieces.push(twig)
      }
    }
    const staghorn = mergeGeometries(staghornPieces)!

    const rock = new IcosahedronGeometry(1, 2)
    displace(rock, 0.24, 1.7, rng.fork('rock-noise'))

    const tubeSponge = createTubeSpongeGeometry(rng.fork('tube-sponge'))
    const barrelSponge = createBarrelSpongeGeometry(rng.fork('barrel-sponge'))
    const tableCoral = createTableCoralGeometry(rng.fork('table-coral'))

    const archetypes: {
      geometry: BufferGeometry
      color: number
      tip?: number
      tipStart?: number
      tipEnd?: number
      roughness: number
      count: number
      scale: [number, number]
      band: [number, number]
    }[] = [
      { geometry: brain, color: 0xa8756c, roughness: 0.85, count: 130, scale: [0.35, 1.1], band: [190, 430] },
      {
        geometry: staghorn, color: 0xd97e63, tip: 0xf7d9b4, tipStart: 0.55, tipEnd: 1.5,
        roughness: 0.7, count: 150, scale: [0.7, 1.6], band: [190, 440],
      },
      { geometry: rock, color: 0x69705f, roughness: 0.95, count: 220, scale: [0.5, 2.6], band: [60, 560] },
      {
        geometry: tubeSponge, color: 0x6e5f9e, tip: 0xb3a8d6, tipStart: 0.6, tipEnd: 1.35,
        roughness: 0.9, count: 90, scale: [0.55, 1.2], band: [140, 430],
      },
      {
        geometry: barrelSponge, color: 0xa06c3c, tip: 0xd6a86a, tipStart: 0.5, tipEnd: 1.0,
        roughness: 0.92, count: 55, scale: [0.5, 1.4], band: [150, 420],
      },
      {
        geometry: tableCoral, color: 0xb490b8, tip: 0xe8d3e0, tipStart: 0.35, tipEnd: 0.62,
        roughness: 0.78, count: 70, scale: [0.8, 2.0], band: [170, 430],
      },
    ]

    const matrix = new Matrix4()
    const position = new Vector3()
    const quaternion = new Quaternion()
    const scaleVector = new Vector3()
    const euler = new Euler()

    for (const type of archetypes) {
      const material = new MeshStandardNodeMaterial()
      material.roughness = type.roughness
      const base = new Color(type.color)
      const identity = vec3(base.r, base.g, base.b)
      // Colony-patch field: broad worldspace tone drift shared by the whole
      // reef, so neighbouring heads read as one growth, not random paint.
      const patch = fbm2(positionWorld.xz.mul(0.14)).mul(0.4).add(0.82)
      if (type.tip !== undefined) {
        const tip = new Color(type.tip)
        const rise = smoothstep(float(type.tipStart!), float(type.tipEnd!), positionLocal.y)
        material.colorNode = mix(identity, vec3(tip.r, tip.g, tip.b), rise).mul(patch)
      } else {
        material.colorNode = identity.mul(patch)
      }
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
        quaternion.setFromEuler(euler.set(
          placeRng.range(-0.18, 0.18),
          placeRng.range(0, Math.PI * 2),
          placeRng.range(-0.18, 0.18),
        ))
        scaleVector.set(
          s * placeRng.range(0.72, 1.35),
          s * placeRng.range(0.72, 1.18),
          s * placeRng.range(0.68, 1.28),
        )
        matrix.compose(position, quaternion, scaleVector)
        mesh.setMatrixAt(i, matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = true
      this.group.add(mesh)
    }
  }

  // ── Shells and garden stones: tiny instanced silhouettes ───────────────
  private buildShellsAndStones(rng: Rng): void {
    const clam = createClamShellGeometry()
    const spiral = mergeGeometries([
      new TorusGeometry(0.25, 0.105, 6, 18, Math.PI * 1.72),
      new LatheGeometry([
        new Vector2(0.03, 0), new Vector2(0.12, 0.04), new Vector2(0.16, 0.18),
        new Vector2(0.1, 0.36), new Vector2(0, 0.48),
      ], 9),
    ])!
    spiral.rotateX(Math.PI / 2)
    spiral.scale(1, 0.72, 1)

    const pebbleA = new IcosahedronGeometry(1, 1)
    const pebbleB = new IcosahedronGeometry(1, 1)
    displace(pebbleA, 0.2, 1.9, rng.fork('pebble-a'))
    displace(pebbleB, 0.27, 2.4, rng.fork('pebble-b'))

    const shellMaterial = new MeshStandardNodeMaterial()
    shellMaterial.color = new Color(0xd2b995)
    shellMaterial.roughness = 0.48
    shellMaterial.metalness = 0.04
    shellMaterial.side = DoubleSide
    this.medium.applyCaustics(shellMaterial, 1.35)
    const stoneMaterial = new MeshStandardNodeMaterial()
    stoneMaterial.color = new Color(0x6b7268)
    stoneMaterial.roughness = 0.96
    this.medium.applyCaustics(stoneMaterial, 1.1)

    const families = [
      { geometry: clam, material: shellMaterial, count: 150, min: 0.18, max: 0.48, y: 0.025 },
      { geometry: spiral, material: shellMaterial, count: 110, min: 0.22, max: 0.55, y: 0.04 },
      { geometry: pebbleA, material: stoneMaterial, count: 320, min: 0.12, max: 0.52, y: 0.05 },
      { geometry: pebbleB, material: stoneMaterial, count: 240, min: 0.2, max: 0.8, y: 0.06 },
    ] as const
    const matrix = new Matrix4()
    const position = new Vector3()
    const quaternion = new Quaternion()
    const scale = new Vector3()
    const euler = new Euler()

    for (let familyIndex = 0; familyIndex < families.length; familyIndex++) {
      const family = families[familyIndex]
      const mesh = new InstancedMesh(family.geometry, family.material, family.count)
      const place = rng.fork(`family-${familyIndex}`)
      for (let i = 0; i < family.count; i++) {
        let x = 0
        let z = 0
        let accepted = false
        for (let attempt = 0; attempt < 10; attempt++) {
          x = place.range(-360, 360)
          z = place.range(-205, 390)
          if (z > RIM_Z + 22 && !inParkFootprint(x, z, familyIndex < 2 ? 0.7 : 1.5)) {
            accepted = true
            break
          }
        }
        if (!accepted) {
          matrix.makeScale(0, 0, 0)
          mesh.setMatrixAt(i, matrix)
          continue
        }
        const size = place.range(family.min, family.max)
        position.set(x, terrainHeight(x, z) + family.y * size, z)
        quaternion.setFromEuler(euler.set(
          familyIndex < 2 ? place.range(-0.2, 0.2) : place.range(-0.45, 0.45),
          place.range(0, Math.PI * 2),
          familyIndex < 2 ? place.range(-0.18, 0.18) : place.range(-0.45, 0.45),
        ))
        scale.set(
          size * place.range(0.78, 1.3),
          size * (familyIndex < 2 ? place.range(0.8, 1.1) : place.range(0.45, 0.82)),
          size * place.range(0.78, 1.25),
        )
        matrix.compose(position, quaternion, scale)
        mesh.setMatrixAt(i, matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = false
      mesh.name = familyIndex < 2 ? 'flora-shells' : 'flora-garden-stones'
      this.group.add(mesh)
    }
  }

  // ── Sea treasures: giant clams and sunken amphorae ─────────────────────
  // New scene dressing (still procedural, still instanced): a handful of
  // metre-wide fluted clams gaping near the paths — mantle lips studded
  // with slowly pulsing electric spots, a pearl glowing in each throat —
  // and clusters of barnacled terracotta amphorae half-sunk in the sand,
  // as if the founder's supply barges spilled a little history.
  private buildSeaTreasures(rng: Rng): void {
    // Giant clams: one merged two-valve shell (DoubleSide — the open bowl
    // interior is the whole point), an iridescent mantle, a nacre pearl.
    const CLAMS = 8
    const shellGeometry = createGiantClamGeometry()
    const shellMaterial = new MeshStandardNodeMaterial()
    shellMaterial.side = DoubleSide
    shellMaterial.roughness = 0.62
    const shellTone = fbm2(positionWorld.xz.mul(2.2))
    shellMaterial.colorNode = mix(vec3(0.78, 0.72, 0.6), vec3(0.9, 0.87, 0.78), shellTone)
    this.medium.applyCaustics(shellMaterial, 1.3)

    const mantleGeometry = new TorusGeometry(0.78, 0.15, 9, 42)
    mantleGeometry.scale(1, 1, 0.38) // torus lies in XY before rotation
    mantleGeometry.rotateX(Math.PI / 2 - 0.16)
    mantleGeometry.translate(0, 0.1, 0)
    const mantleMaterial = new MeshStandardNodeMaterial()
    mantleMaterial.roughness = 0.35
    const mantleField = fbm2(positionWorld.xz.mul(7.0).add(positionWorld.y.mul(5.0)))
    mantleMaterial.colorNode = mix(vec3(0.05, 0.2, 0.24), vec3(0.16, 0.42, 0.4), mantleField)
    // Electric mantle spots, breathing on a slow park-time pulse.
    const spots = smoothstep(float(0.72), float(0.82), mantleField)
    const pulse = sin(this.timeUniform.mul(0.9).add(positionWorld.x.mul(0.7)).add(positionWorld.z))
      .mul(0.5)
      .add(0.5)
    mantleMaterial.emissiveNode = vec3(0.05, 0.5, 0.55).mul(spots).mul(pulse.mul(0.7).add(0.3))
    this.medium.applyCaustics(mantleMaterial, 0.8)

    const pearlGeometry = new SphereGeometry(0.24, 18, 14)
    pearlGeometry.translate(0, 0.2, 0.12)
    const pearlMaterial = new MeshStandardNodeMaterial()
    pearlMaterial.roughness = 0.18
    pearlMaterial.metalness = 0.15
    pearlMaterial.color = new Color(0xf0e8e4)
    pearlMaterial.emissiveNode = vec3(0.045, 0.04, 0.035)
    this.medium.applyCaustics(pearlMaterial, 0.9)

    const shells = new InstancedMesh(shellGeometry, shellMaterial, CLAMS)
    const mantles = new InstancedMesh(mantleGeometry, mantleMaterial, CLAMS)
    const pearls = new InstancedMesh(pearlGeometry, pearlMaterial, CLAMS)
    const matrix = new Matrix4()
    const quaternion = new Quaternion()
    const euler = new Euler()
    const clamRng = rng.fork('clams')
    let placedClams = 0
    for (let attempt = 0; attempt < 120 && placedClams < CLAMS; attempt++) {
      const angle = clamRng.range(0, Math.PI * 2)
      const radius = clamRng.range(60, 260)
      const x = Math.cos(angle) * radius
      const z = Math.sin(angle) * radius * 0.9
      if (z < RIM_Z + 25 || inParkFootprint(x, z, 1.6)) continue
      const y = terrainHeight(x, z)
      const s = clamRng.range(0.55, 1.05)
      quaternion.setFromEuler(euler.set(
        clamRng.range(-0.12, 0.12),
        clamRng.range(0, Math.PI * 2),
        clamRng.range(-0.12, 0.12),
      ))
      matrix.compose(new Vector3(x, y + 0.08 * s, z), quaternion, new Vector3(s, s, s))
      shells.setMatrixAt(placedClams, matrix)
      mantles.setMatrixAt(placedClams, matrix)
      pearls.setMatrixAt(placedClams, matrix)
      placedClams++
    }
    for (const mesh of [shells, mantles, pearls]) {
      mesh.count = placedClams
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = mesh === shells
      mesh.receiveShadow = true
      this.group.add(mesh)
    }
    shells.name = 'flora-clam-shells'
    mantles.name = 'flora-clam-mantles'
    pearls.name = 'flora-clam-pearls'

    // Amphorae: merged jar+handles prototype, slip-banded terracotta with
    // pale barnacle crusting; scattered in loose spills, several toppled.
    const amphora = createAmphoraGeometry()
    const clay = new MeshStandardNodeMaterial()
    clay.roughness = 0.88
    const slip = sin(positionLocal.y.mul(26.0)).mul(0.5).add(0.5)
    const crust = smoothstep(
      float(0.62),
      float(0.8),
      fbm2(positionWorld.xz.mul(3.4).add(positionWorld.y.mul(2.2))),
    )
    clay.colorNode = mix(
      mix(vec3(0.44, 0.24, 0.14), vec3(0.52, 0.31, 0.18), slip),
      vec3(0.74, 0.72, 0.64),
      crust.mul(0.75),
    )
    clay.roughnessNode = float(0.82).add(crust.mul(0.14))
    this.medium.applyCaustics(clay, 1.2)
    const AMPHORAE = 18
    const jars = new InstancedMesh(amphora, clay, AMPHORAE)
    const jarRng = rng.fork('amphorae')
    let placedJars = 0
    // Two spill clusters plus lone strays.
    const clusters: [number, number][] = []
    for (let c = 0; c < 2 && clusters.length < 2; c++) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const angle = jarRng.range(0, Math.PI * 2)
        const radius = jarRng.range(90, 300)
        const cx = Math.cos(angle) * radius
        const cz = Math.sin(angle) * radius * 0.88
        if (cz > RIM_Z + 30 && !inParkFootprint(cx, cz, 6)) {
          clusters.push([cx, cz])
          break
        }
      }
    }
    for (let attempt = 0; attempt < 200 && placedJars < AMPHORAE; attempt++) {
      let x: number
      let z: number
      if (placedJars < 12 && clusters.length > 0) {
        const [cx, cz] = clusters[placedJars % clusters.length]
        x = cx + jarRng.range(-4.5, 4.5)
        z = cz + jarRng.range(-4.5, 4.5)
      } else {
        x = jarRng.range(-340, 340)
        z = jarRng.range(-190, 380)
      }
      if (z < RIM_Z + 24 || inParkFootprint(x, z, 1.2)) continue
      const y = terrainHeight(x, z)
      const s = jarRng.range(0.7, 1.15)
      const toppled = jarRng.next() < 0.45
      if (toppled) {
        quaternion.setFromEuler(euler.set(
          jarRng.range(-0.2, 0.2),
          jarRng.range(0, Math.PI * 2),
          Math.PI / 2 + jarRng.range(-0.25, 0.25),
        ))
        matrix.compose(new Vector3(x, y + 0.3 * s, z), quaternion, new Vector3(s, s, s))
      } else {
        quaternion.setFromEuler(euler.set(
          jarRng.range(-0.14, 0.14),
          jarRng.range(0, Math.PI * 2),
          jarRng.range(-0.14, 0.14),
        ))
        matrix.compose(new Vector3(x, y - 0.06 * s, z), quaternion, new Vector3(s, s, s))
      }
      jars.setMatrixAt(placedJars, matrix)
      placedJars++
    }
    jars.count = placedJars
    jars.instanceMatrix.needsUpdate = true
    jars.castShadow = false
    jars.receiveShadow = true
    jars.name = 'flora-amphorae'
    this.group.add(jars)
  }
}

/**
 * A giant clam: two fluted valves hinged at the back, the upper one gaping
 * open ~35°. Flutes ripple both the radius and the rim line, strongest at
 * the lip — the signature scalloped silhouette. DoubleSide material shows
 * the bowl interior; both valves merge into one instanced geometry.
 */
function createGiantClamGeometry(): BufferGeometry {
  const flute = (geometry: BufferGeometry, lower: boolean) => {
    const position = geometry.getAttribute('position')
    const vertex = new Vector3()
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i)
      const radial = Math.hypot(vertex.x, vertex.z)
      if (radial < 1e-5) continue
      const angle = Math.atan2(vertex.x, vertex.z)
      // Rim weight: 1 at the open lip (y≈0), 0 at the pole.
      const rim = 1 - Math.min(1, Math.abs(vertex.y))
      const wave = Math.cos(angle * 9)
      const scale = 1 + 0.11 * wave * rim
      position.setX(i, vertex.x * scale)
      position.setZ(i, vertex.z * scale)
      position.setY(i, vertex.y + (lower ? -1 : 1) * 0.07 * wave * rim)
    }
    position.needsUpdate = true
    geometry.computeVertexNormals()
  }
  // Lower valve: bowl opening upward (equator → south pole).
  const lower = new SphereGeometry(1, 44, 9, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2)
  flute(lower, true)
  lower.scale(1, 0.48, 1)
  // Upper valve: dome opening downward, hinged open at the back (−z).
  const upper = new SphereGeometry(1, 44, 9, 0, Math.PI * 2, 0, Math.PI / 2)
  flute(upper, false)
  upper.scale(1, 0.48, 1)
  upper.translate(0, 0, 0.92) // hinge line to origin
  upper.rotateX(-0.62) // gape
  upper.translate(0, 0.04, -0.92)
  const merged = mergeGeometries([lower, upper])!
  lower.dispose()
  upper.dispose()
  return merged
}

/**
 * A shipping amphora: closed lathe from foot to rolled rim (with interior
 * lip so the mouth reads hollow), two shoulder handles. One merged geometry.
 */
function createAmphoraGeometry(): BufferGeometry {
  const body = new LatheGeometry(
    [
      new Vector2(0.09, 0),
      new Vector2(0.16, 0.02),
      new Vector2(0.13, 0.1),
      new Vector2(0.3, 0.32),
      new Vector2(0.4, 0.62),
      new Vector2(0.38, 0.88),
      new Vector2(0.28, 1.08),
      new Vector2(0.16, 1.22),
      new Vector2(0.14, 1.34),
      new Vector2(0.2, 1.4),
      new Vector2(0.21, 1.45),
      new Vector2(0.15, 1.46),
      new Vector2(0.11, 1.42),
      new Vector2(0.1, 1.3),
    ],
    18,
  )
  const parts: BufferGeometry[] = [body]
  for (const side of [-1, 1]) {
    const handle = new TorusGeometry(0.14, 0.035, 7, 14, Math.PI * 1.05)
    handle.rotateZ(Math.PI * 0.45 * side + (side < 0 ? Math.PI : 0))
    handle.translate(side * 0.3, 1.16, 0)
    parts.push(handle)
  }
  const merged = mergeGeometries(parts)!
  for (const part of parts) part.dispose()
  return merged
}

/** A cluster of 3–4 open-mouthed tube sponges leaning apart. Each tube is a
 *  closed clockwise lathe (outer wall up, rim inward, inner throat down) so
 *  the hollow interior is genuinely visible without DoubleSide. */
function createTubeSpongeGeometry(rng: Rng): BufferGeometry {
  const tubes: BufferGeometry[] = []
  const count = 4
  for (let i = 0; i < count; i++) {
    const h = rng.range(0.85, 1.5)
    const r = rng.range(0.14, 0.22)
    const tube = new LatheGeometry(
      [
        new Vector2(r * 1.3, 0),
        new Vector2(r * 1.15, h * 0.12),
        new Vector2(r * 0.92, h * 0.4),
        new Vector2(r * 1.0, h * 0.78),
        new Vector2(r * 1.14, h * 0.95),
        new Vector2(r * 1.18, h),
        new Vector2(r * 0.8, h),
        new Vector2(r * 0.66, h * 0.55),
        new Vector2(r * 0.52, h * 0.16),
      ],
      12,
    )
    displace(tube, 0.07, 4.5, rng.fork(`warts-${i}`))
    const lean = rng.range(0.06, 0.24)
    const yaw = (i / count) * Math.PI * 2 + rng.range(-0.4, 0.4)
    tube.rotateZ(lean)
    tube.rotateY(yaw)
    tube.translate(Math.sin(yaw) * rng.range(0.08, 0.22), 0, Math.cos(yaw) * rng.range(0.08, 0.22))
    tubes.push(tube)
  }
  const merged = mergeGeometries(tubes)!
  for (const tube of tubes) tube.dispose()
  return merged
}

/** One great barrel sponge: ridged flank, rolled rim, visible dark throat. */
function createBarrelSpongeGeometry(rng: Rng): BufferGeometry {
  const barrel = new LatheGeometry(
    [
      new Vector2(0.52, 0),
      new Vector2(0.66, 0.14),
      new Vector2(0.72, 0.45),
      new Vector2(0.66, 0.78),
      new Vector2(0.58, 0.96),
      new Vector2(0.6, 1.0),
      new Vector2(0.46, 0.98),
      new Vector2(0.38, 0.6),
      new Vector2(0.34, 0.24),
    ],
    18,
  )
  displace(barrel, 0.09, 2.6, rng)
  return barrel
}

/** Table coral: a stout trunk under a broad wavy-edged plate with real
 *  thickness — the reef's parasol silhouette. */
function createTableCoralGeometry(rng: Rng): BufferGeometry {
  const trunk = new CylinderGeometry(0.09, 0.16, 0.42, 9)
  trunk.translate(0, 0.21, 0)
  const plate = new CylinderGeometry(1, 0.9, 0.1, 26, 1)
  displace(plate, 0.14, 2.1, rng)
  plate.scale(1, 0.85, 1)
  plate.translate(0, 0.5, 0)
  const merged = mergeGeometries([trunk, plate])!
  trunk.dispose()
  plate.dispose()
  return merged
}

function createClamShellGeometry(): BufferGeometry {
  const positions: number[] = [0, 0.07, -0.08, 0, 0, -0.08]
  const indices: number[] = []
  const segments = 14
  for (let i = 0; i <= segments; i++) {
    const angle = -Math.PI / 2 + (i / segments) * Math.PI
    const scallop = Math.sin((i / segments) * Math.PI * segments * 0.5)
    const radial = 0.56 + scallop * 0.025
    const x = Math.sin(angle) * radial
    const z = Math.cos(angle) * radial
    const rib = 0.045 + Math.cos(i * Math.PI) * 0.012
    positions.push(x, rib, z, x, 0, z)
    if (i > 0) {
      const previousTop = 2 + (i - 1) * 2
      const previousBottom = previousTop + 1
      const top = 2 + i * 2
      const bottom = top + 1
      indices.push(
        0, previousTop, top,
        1, bottom, previousBottom,
        previousTop, previousBottom, bottom,
        previousTop, bottom, top,
      )
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
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
