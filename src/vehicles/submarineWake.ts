import {
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  SphereGeometry,
  Vector3,
} from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import {
  abs,
  attribute,
  cos,
  cross,
  exp,
  float,
  hash,
  instanceIndex,
  mix,
  mx_noise_float,
  normalView,
  positionGeometry,
  positionViewDirection,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'
import { markMainDetail } from '../render/layers'
import type { SeaMediumSystem } from '../sea/medium'
import type { WaveSim } from '../sea/waveSim'

const BUBBLE_COUNT = 2304
const BUBBLE_LIFE_MAX = 3.4
const PLUME_COUNT = 512
const PLUME_LIFE_MAX = 2.4
const FOAM_COUNT = 512
const FOAM_LIFE_MAX = 5.5
const CAV_COUNT = 128
const CAV_LIFE_MAX = 0.18

interface Pool {
  mesh: InstancedMesh
  attributes: InstancedBufferAttribute[]
  cursor: number
  quietAt: number
  count: number
  lifeMax: number
}

/**
 * Propeller wake with two regimes (Scott's reference photos):
 *
 * UNDERWATER — a dense, bright, turbulent cloud: soft milky plume puffs
 * (fragment-noise eroded so they read billowy and irregular, never uniform
 * smoke) convected down a decaying swirl, with thousands of small entrained
 * bubbles glittering inside — tip bubbles clustered on the live blade
 * angles trace real helical filaments, hub bubbles seed the vortex rope,
 * and layered turbulence unravels everything downstream.
 *
 * SURFACED — a boat wake: white foam patches churned out at the stern,
 * spreading laterally into a persistent V trail. Foam is pinned to the TRUE
 * displaced ocean surface — its vertex stage samples the same displacement
 * cascades the ocean renders with — so the trail rides the waves the hull
 * rides. The piloting system cross-fades emission between the regimes by
 * how surfaced the hull is.
 *
 * Cavitation: short-lived vapour pockets off fast-moving blade tips that
 * collapse faster than they grew.
 *
 * Everything is vertex/fragment TSL against absolute time (the fountain
 * recycling rule); the CPU only writes spawn records into ring buffers.
 */
export class SubmarineWake {
  readonly meshes: InstancedMesh[]

  private readonly timeUniform = uniform(0)

  private readonly bubblePool: Pool
  private readonly bubbleOrigins: Float32Array
  private readonly bubbleAxes: Float32Array
  private readonly bubbleRadials: Float32Array
  private readonly bubbleParams: Float32Array // (spawnTime, axialSpeed)

  private readonly plumePool: Pool
  private readonly plumeOrigins: Float32Array
  private readonly plumeAxes: Float32Array
  private readonly plumeRadials: Float32Array
  private readonly plumeParams: Float32Array // (spawnTime, axialSpeed)

  private readonly foamPool: Pool
  private readonly foamOrigins: Float32Array
  private readonly foamDrives: Float32Array
  private readonly foamSpawns: Float32Array

  private readonly cavPool: Pool
  private readonly cavOrigins: Float32Array
  private readonly cavDrives: Float32Array
  private readonly cavSpawns: Float32Array

  constructor(medium: SeaMediumSystem, sim: WaveSim) {
    const rim = () =>
      float(1).sub(abs(normalView.dot(positionViewDirection)))

    // ── Entrained bubbles: helical filaments + hub vortex rope ────────────
    {
      const geometry = new SphereGeometry(1, 7, 5)
      this.bubbleOrigins = new Float32Array(BUBBLE_COUNT * 3)
      this.bubbleAxes = new Float32Array(BUBBLE_COUNT * 3)
      this.bubbleRadials = new Float32Array(BUBBLE_COUNT * 3)
      this.bubbleParams = new Float32Array(BUBBLE_COUNT * 2)
      for (let i = 0; i < BUBBLE_COUNT; i++) {
        this.bubbleOrigins[i * 3 + 1] = -900
        this.bubbleRadials[i * 3] = 0.05
        this.bubbleParams[i * 2] = -1000
        this.bubbleParams[i * 2 + 1] = 1
      }
      const attrs = [
        new InstancedBufferAttribute(this.bubbleOrigins, 3),
        new InstancedBufferAttribute(this.bubbleAxes, 3),
        new InstancedBufferAttribute(this.bubbleRadials, 3),
        new InstancedBufferAttribute(this.bubbleParams, 2),
      ]
      geometry.setAttribute('wakeOrigin', attrs[0])
      geometry.setAttribute('wakeAxis', attrs[1])
      geometry.setAttribute('wakeRadial', attrs[2])
      geometry.setAttribute('wakeParams', attrs[3])

      const material = new MeshStandardNodeMaterial()
      material.transparent = true
      material.depthWrite = false
      material.side = DoubleSide
      material.roughness = 0.07
      material.metalness = 0.16

      const origin = attribute('wakeOrigin', 'vec3') as unknown as Node<'vec3'>
      const axis = attribute('wakeAxis', 'vec3') as unknown as Node<'vec3'>
      const radial = attribute('wakeRadial', 'vec3') as unknown as Node<'vec3'>
      const params = attribute('wakeParams', 'vec2') as unknown as Node<'vec2'>
      const spawn = params.x
      const axialSpeed = params.y
      const seedA = hash(instanceIndex.add(61))
      const seedB = hash(instanceIndex.add(199))
      const seedC = hash(instanceIndex.add(977))

      const age = this.timeUniform.sub(spawn).max(0.0)
      const life = mix(1.8, BUBBLE_LIFE_MAX, seedA)
      const t01 = age.div(life)

      const axialDist = axialSpeed.mul(
        float(1).sub(exp(age.mul(-0.7))).div(0.7).mul(0.8).add(age.mul(0.2)),
      )
      const r0 = radial.length()
      const swirlDecay = float(1).sub(exp(age.mul(-1.1))).div(1.1)
      const angularTurbulence = sin(age.mul(2.3).add(seedA.mul(40)))
        .mul(0.5)
        .add(sin(age.mul(5.1).add(seedB.mul(40))).mul(0.25))
        .mul(smoothstep(0.1, 1.0, t01).mul(0.5))
      const swirl = axialSpeed
        .mul(1.05)
        .div(r0.add(0.4))
        .mul(swirlDecay)
        .negate()
        .add(angularTurbulence)
      const rotatedRadial = radial.mul(cos(swirl)).add(cross(axis, radial).mul(sin(swirl)))
      const radialGrow = float(1)
        .add(age.mul(0.22))
        .add(sin(age.mul(7.0).add(seedC.mul(50))).mul(age.pow(0.5)).mul(0.06))
      const rise = mix(0.05, 0.3, seedC).mul(age.sub(0.2).max(0.0))
      const wobble = vec3(
        sin(age.mul(6.4).add(seedA.mul(40))).add(sin(age.mul(15.7).add(seedC.mul(60))).mul(0.4)),
        sin(age.mul(8.9).add(seedB.mul(50))).mul(0.6),
        cos(age.mul(5.8).add(seedB.mul(40))).add(cos(age.mul(13.1).add(seedA.mul(60))).mul(0.4)),
      ).mul(age.mul(0.045).add(0.015))
      const center = origin
        .add(axis.mul(axialDist))
        .add(rotatedRadial.mul(radialGrow))
        .add(vec3(0, rise, 0))
        .add(wobble)

      const appear = smoothstep(0.0, 0.03, t01)
      const dissipate = float(1).sub(smoothstep(0.5, 1.0, t01))
      const surfaceFade = float(1).sub(smoothstep(-0.35, -0.05, center.y))
      const visible = appear.mul(dissipate).mul(surfaceFade)
      const size = mix(0.01, 0.036, seedC.pow(1.5))
        .mul(t01.mul(0.9).add(0.7))
        .mul(smoothstep(0.01, 0.08, visible))
      material.positionNode = center.add(positionGeometry.mul(size))

      const fresnel = rim().pow(2.25)
      material.colorNode = mix(vec3(0.05, 0.14, 0.18), vec3(0.55, 0.75, 0.8), fresnel)
      material.opacityNode = fresnel.mul(0.55).add(0.03).mul(visible)
      medium.applyCaustics(material, 0.18)

      this.bubblePool = this.finishPool('submarine:wake-bubbles', geometry, material, attrs, BUBBLE_COUNT, BUBBLE_LIFE_MAX)
    }

    // ── Underwater plume: the dense milky turbulent cloud ─────────────────
    {
      const geometry = new SphereGeometry(1, 8, 6)
      this.plumeOrigins = new Float32Array(PLUME_COUNT * 3)
      this.plumeAxes = new Float32Array(PLUME_COUNT * 3)
      this.plumeRadials = new Float32Array(PLUME_COUNT * 3)
      this.plumeParams = new Float32Array(PLUME_COUNT * 2)
      for (let i = 0; i < PLUME_COUNT; i++) {
        this.plumeOrigins[i * 3 + 1] = -900
        this.plumeRadials[i * 3] = 0.05
        this.plumeParams[i * 2] = -1000
        this.plumeParams[i * 2 + 1] = 1
      }
      const attrs = [
        new InstancedBufferAttribute(this.plumeOrigins, 3),
        new InstancedBufferAttribute(this.plumeAxes, 3),
        new InstancedBufferAttribute(this.plumeRadials, 3),
        new InstancedBufferAttribute(this.plumeParams, 2),
      ]
      geometry.setAttribute('plumeOrigin', attrs[0])
      geometry.setAttribute('plumeAxis', attrs[1])
      geometry.setAttribute('plumeRadial', attrs[2])
      geometry.setAttribute('plumeParams', attrs[3])

      const material = new MeshStandardNodeMaterial()
      material.transparent = true
      material.depthWrite = false
      material.side = DoubleSide
      material.roughness = 0.85
      material.metalness = 0

      const origin = attribute('plumeOrigin', 'vec3') as unknown as Node<'vec3'>
      const axis = attribute('plumeAxis', 'vec3') as unknown as Node<'vec3'>
      const radial = attribute('plumeRadial', 'vec3') as unknown as Node<'vec3'>
      const params = attribute('plumeParams', 'vec2') as unknown as Node<'vec2'>
      const spawn = params.x
      const axialSpeed = params.y
      const seedA = hash(instanceIndex.add(313))
      const seedB = hash(instanceIndex.add(709))
      const seedC = hash(instanceIndex.add(1201))

      const age = this.timeUniform.sub(spawn).max(0.0)
      const life = mix(1.3, PLUME_LIFE_MAX, seedA)
      const t01 = age.div(life)

      // Bulk convection + slower bulk swirl than the bubbles, spreading
      // hard and wobbling at cloud scale.
      const axialDist = axialSpeed
        .mul(0.85)
        .mul(float(1).sub(exp(age.mul(-0.7))).div(0.7).mul(0.8).add(age.mul(0.2)))
      const r0 = radial.length()
      const swirl = axialSpeed.mul(0.6).div(r0.add(0.45)).mul(float(1).sub(exp(age.mul(-1.0))))
        .negate()
      const rotatedRadial = radial.mul(cos(swirl)).add(cross(axis, radial).mul(sin(swirl)))
      const radialGrow = float(1).add(age.mul(0.35))
      const rise = age.mul(0.1)
      const wobble = vec3(
        sin(age.mul(3.1).add(seedA.mul(40))),
        sin(age.mul(4.3).add(seedB.mul(50))).mul(0.7),
        cos(age.mul(2.7).add(seedC.mul(40))),
      ).mul(age.mul(0.1))
      const center = origin
        .add(axis.mul(axialDist))
        .add(rotatedRadial.mul(radialGrow))
        .add(vec3(0, rise, 0))
        .add(wobble)

      const appear = smoothstep(0.0, 0.06, t01)
      const dissipate = float(1).sub(smoothstep(0.4, 1.0, t01))
      const surfaceFade = float(1).sub(smoothstep(-0.6, -0.15, center.y))
      const envelope = appear.mul(dissipate).mul(surfaceFade)

      // Puffs inflate as they shed — the cloud grows downstream.
      const size = mix(0.12, 0.24, seedB)
        .mul(t01.mul(2.6).add(1.0))
        .mul(smoothstep(0.01, 0.05, envelope))
      material.positionNode = center.add(positionGeometry.mul(size))

      // Billow erosion: evolving noise carves the sphere into an irregular
      // cloudlet and breaks it apart as it ages — never uniform smoke.
      const billow = mx_noise_float(
        positionGeometry.mul(2.3).add(vec3(seedA.mul(31), age.mul(0.55), seedB.mul(47))),
      )
      const erode = smoothstep(t01.mul(0.55).sub(0.55), 0.35, billow)
      const softBody = float(1).sub(rim()).mul(0.5).add(0.1)
      material.colorNode = vec3(0.55, 0.72, 0.75).mul(rim().mul(0.25).add(0.9))
      material.opacityNode = envelope.mul(erode).mul(softBody).mul(0.42)
      medium.applyCaustics(material, 0.25)

      this.plumePool = this.finishPool('submarine:wake-plume', geometry, material, attrs, PLUME_COUNT, PLUME_LIFE_MAX)
    }

    // ── Surface foam: the boat-wake V trail riding the real waves ─────────
    {
      const geometry = new SphereGeometry(1, 8, 6)
      this.foamOrigins = new Float32Array(FOAM_COUNT * 3)
      this.foamDrives = new Float32Array(FOAM_COUNT * 3)
      this.foamSpawns = new Float32Array(FOAM_COUNT)
      for (let i = 0; i < FOAM_COUNT; i++) {
        this.foamOrigins[i * 3] = 0
        this.foamOrigins[i * 3 + 2] = 0
        this.foamSpawns[i] = -1000
      }
      const attrs = [
        new InstancedBufferAttribute(this.foamOrigins, 3),
        new InstancedBufferAttribute(this.foamDrives, 3),
        new InstancedBufferAttribute(this.foamSpawns, 1),
      ]
      geometry.setAttribute('foamOrigin', attrs[0])
      geometry.setAttribute('foamDrive', attrs[1])
      geometry.setAttribute('foamSpawn', attrs[2])

      const material = new MeshStandardNodeMaterial()
      material.transparent = true
      material.depthWrite = false
      material.side = DoubleSide
      material.roughness = 0.75
      material.metalness = 0

      const origin = attribute('foamOrigin', 'vec3') as unknown as Node<'vec3'>
      const drive = attribute('foamDrive', 'vec3') as unknown as Node<'vec3'>
      const spawn = attribute('foamSpawn', 'float') as unknown as Node<'float'>
      const seedA = hash(instanceIndex.add(521))
      const seedB = hash(instanceIndex.add(1637))

      const age = this.timeUniform.sub(spawn).max(0.0)
      const life = mix(2.8, FOAM_LIFE_MAX, seedA)
      const t01 = age.div(life)

      // Churned foam spreads and slows; the V arms come from the lateral
      // drive the stern imparts, the trail from the hull's own advance.
      const drift = drive.mul(float(1).sub(exp(age.mul(-0.8))).div(0.8))
      const planar = origin.add(drift)
      // Pinned to the TRUE displaced surface: sample the same cascades the
      // ocean renders with at this patch's world XZ.
      const xz = vec2(planar.x, planar.z)
      let surfaceY = sim.displacementNodes[0]
        .sample(xz.div(sim.patchLengths[0]))
        .y as Node<'float'>
      for (let i = 1; i < sim.displacementNodes.length; i++) {
        surfaceY = surfaceY.add(
          sim.displacementNodes[i].sample(xz.div(sim.patchLengths[i])).y,
        ) as Node<'float'>
      }
      const center = vec3(planar.x, surfaceY.add(0.05), planar.z)

      const appear = smoothstep(0.0, 0.04, t01)
      const dissipate = float(1).sub(smoothstep(0.5, 1.0, t01))
      const envelope = appear.mul(dissipate)

      // Flattened pancake patches that grow as they disperse.
      const size = mix(0.25, 0.5, seedB)
        .mul(t01.mul(2.2).add(1.0))
        .mul(smoothstep(0.01, 0.05, envelope))
      material.positionNode = center.add(
        positionGeometry.mul(vec3(size, size.mul(0.22), size)),
      )

      // Lacing: noise erosion tightens with age so sheets break into the
      // lacy trailing edges of a real wake.
      const billow = mx_noise_float(
        positionGeometry.mul(2.6).add(vec3(seedA.mul(43), age.mul(0.35), seedB.mul(29))),
      )
      const erode = smoothstep(t01.mul(1.1).sub(0.65), 0.4, billow)
      material.colorNode = vec3(0.93, 0.96, 0.96)
      material.opacityNode = envelope
        .mul(erode)
        .mul(float(1).sub(rim()).mul(0.25).add(0.75))
        .mul(0.6)
      medium.applyCaustics(material, 0.1)

      this.foamPool = this.finishPool('submarine:wake-foam', geometry, material, attrs, FOAM_COUNT, FOAM_LIFE_MAX)
    }

    // ── Cavitation pockets ────────────────────────────────────────────────
    {
      const geometry = new SphereGeometry(1, 7, 5)
      this.cavOrigins = new Float32Array(CAV_COUNT * 3)
      this.cavDrives = new Float32Array(CAV_COUNT * 3)
      this.cavSpawns = new Float32Array(CAV_COUNT)
      for (let i = 0; i < CAV_COUNT; i++) {
        this.cavOrigins[i * 3 + 1] = -900
        this.cavSpawns[i] = -1000
      }
      const attrs = [
        new InstancedBufferAttribute(this.cavOrigins, 3),
        new InstancedBufferAttribute(this.cavDrives, 3),
        new InstancedBufferAttribute(this.cavSpawns, 1),
      ]
      geometry.setAttribute('cavOrigin', attrs[0])
      geometry.setAttribute('cavDrive', attrs[1])
      geometry.setAttribute('cavSpawn', attrs[2])

      const material = new MeshStandardNodeMaterial()
      material.transparent = true
      material.depthWrite = false
      material.side = DoubleSide
      material.roughness = 0.3
      material.metalness = 0

      const origin = attribute('cavOrigin', 'vec3') as unknown as Node<'vec3'>
      const drive = attribute('cavDrive', 'vec3') as unknown as Node<'vec3'>
      const spawn = attribute('cavSpawn', 'float') as unknown as Node<'float'>
      const seedA = hash(instanceIndex.add(389))
      const seedB = hash(instanceIndex.add(811))

      const age = this.timeUniform.sub(spawn).max(0.0)
      const life = mix(0.07, CAV_LIFE_MAX, seedA)
      const t01 = age.div(life)

      const envelope = smoothstep(0.0, 0.22, t01).mul(float(1).sub(smoothstep(0.55, 0.88, t01)))
      const jitter = vec3(
        sin(t01.mul(31).add(seedA.mul(50))),
        sin(t01.mul(27).add(seedB.mul(60))),
        cos(t01.mul(23).add(seedA.mul(70))),
      ).mul(t01.mul(0.02))
      const center = origin.add(drive.mul(age)).add(jitter)

      const size = mix(0.06, 0.13, seedB)
        .mul(smoothstep(0.0, 0.4, t01).mul(0.7).add(0.3))
        .mul(envelope.mul(0.5).add(0.5))
        .mul(smoothstep(0.01, 0.06, envelope))
      material.positionNode = center.add(positionGeometry.mul(size))

      const fresnel = rim().pow(1.6)
      material.colorNode = vec3(0.78, 0.88, 0.92).mul(fresnel.mul(0.2).add(0.85))
      material.opacityNode = float(1).sub(fresnel).mul(0.4).add(0.06).mul(envelope)
      medium.applyCaustics(material, 0.12)

      this.cavPool = this.finishPool('submarine:wake-cavitation', geometry, material, attrs, CAV_COUNT, CAV_LIFE_MAX)
    }

    this.meshes = [
      this.bubblePool.mesh,
      this.plumePool.mesh,
      this.foamPool.mesh,
      this.cavPool.mesh,
    ]
  }

  private finishPool(
    name: string,
    geometry: SphereGeometry,
    material: MeshStandardNodeMaterial,
    attributes: InstancedBufferAttribute[],
    count: number,
    lifeMax: number,
  ): Pool {
    for (const attr of attributes) attr.setUsage(DynamicDrawUsage)
    const mesh = new InstancedMesh(geometry, material, count)
    mesh.name = name
    mesh.frustumCulled = false // positions live in the vertex stage
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.visible = false
    markMainDetail(mesh)
    return { mesh, attributes, cursor: 0, quietAt: -Infinity, count, lifeMax }
  }

  private advance(pool: Pool, now: number): number {
    const i = pool.cursor
    pool.cursor = (i + 1) % pool.count
    pool.quietAt = now + pool.lifeMax
    for (const attr of pool.attributes) attr.needsUpdate = true
    return i
  }

  /** Entrain one bubble: hub centre, unit wake axis, initial radial ⊥ axis. */
  emitBubble(origin: Vector3, axis: Vector3, radial: Vector3, axialSpeed: number, now: number): void {
    const i = this.advance(this.bubblePool, now)
    writeVec3(this.bubbleOrigins, i, origin)
    writeVec3(this.bubbleAxes, i, axis)
    writeVec3(this.bubbleRadials, i, radial)
    this.bubbleParams[i * 2] = now
    this.bubbleParams[i * 2 + 1] = axialSpeed
  }

  /** Shed one milky plume puff into the underwater cloud. */
  emitPlume(origin: Vector3, axis: Vector3, radial: Vector3, axialSpeed: number, now: number): void {
    const i = this.advance(this.plumePool, now)
    writeVec3(this.plumeOrigins, i, origin)
    writeVec3(this.plumeAxes, i, axis)
    writeVec3(this.plumeRadials, i, radial)
    this.plumeParams[i * 2] = now
    this.plumeParams[i * 2 + 1] = axialSpeed
  }

  /** Churn one foam patch onto the surface trail (origin y is ignored —
   *  foam pins itself to the displaced surface). */
  emitFoam(origin: Vector3, drive: Vector3, now: number): void {
    const i = this.advance(this.foamPool, now)
    writeVec3(this.foamOrigins, i, origin)
    writeVec3(this.foamDrives, i, drive)
    this.foamSpawns[i] = now
  }

  /** Shed one cavitation pocket at a blade tip with its tangential drift. */
  emitCavitation(origin: Vector3, drive: Vector3, now: number): void {
    const i = this.advance(this.cavPool, now)
    writeVec3(this.cavOrigins, i, origin)
    writeVec3(this.cavDrives, i, drive)
    this.cavSpawns[i] = now
  }

  /** Absolute elapsed time — never a local clock (instances recycle on it).
   *  Pools hide entirely once their last spawn has fully dissipated. */
  update(now: number): void {
    this.timeUniform.value = now
    this.bubblePool.mesh.visible = now < this.bubblePool.quietAt
    this.plumePool.mesh.visible = now < this.plumePool.quietAt
    this.foamPool.mesh.visible = now < this.foamPool.quietAt
    this.cavPool.mesh.visible = now < this.cavPool.quietAt
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose()
      ;(mesh.material as MeshStandardNodeMaterial).dispose()
    }
  }
}

function writeVec3(target: Float32Array, index: number, value: Vector3): void {
  target[index * 3] = value.x
  target[index * 3 + 1] = value.y
  target[index * 3 + 2] = value.z
}
