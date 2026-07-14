import {
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
} from 'three'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import {
  abs,
  attribute,
  cos,
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
  vec3,
} from 'three/tsl'
import { markMainDetail } from '../render/layers'
import type { WaveSim } from '../sea/waveSim'

type WakeMaterial = MeshBasicNodeMaterial | MeshStandardNodeMaterial
type WakeDebugMode = 'beauty' | 'layers' | 'age' | 'flow'

interface WakeOptions {
  qualityTier: number
  debugPass: string
}

interface Pool {
  mesh: InstancedMesh
  attributes: InstancedBufferAttribute[]
  cursor: number
  quietAt: number
  count: number
  lifeMax: number
}

/** Lower tiers shorten only the oldest trail residue. */
const WAKE_BUDGETS = [
  { bubbles: 3_200, foam: 640 },
  { bubbles: 5_200, foam: 960 },
  { bubbles: 7_200, foam: 1_280 },
] as const

const BUBBLE_LIFE_MAX = 3.6
const FOAM_LIFE_MAX = 10

/** Kelvin cusp half-angle: asin(1/3) = 19.47 degrees. */
const KELVIN_SIN = 1 / 3
const KELVIN_COS = Math.sqrt(1 - KELVIN_SIN * KELVIN_SIN)

/**
 * Two deliberately exclusive wake regimes:
 *
 * UNDERWATER — one high-count pool of small bubbles. There is no aeration
 * cloud, cavitation layer, ribbon, spray, or other secondary effect.
 *
 * SURFACED — only the accepted wave-conforming foam. The bubble draw is hidden
 * as soon as the surfaced regime owns the wake, and the foam draw is hidden
 * whenever the craft returns underwater.
 */
export class SubmarineWake {
  readonly meshes: InstancedMesh[]

  private readonly timeUniform = uniform(0)

  private readonly bubblePool: Pool
  private readonly bubbleOrigins: Float32Array
  private readonly bubbleDrives: Float32Array
  private readonly bubbleSpawns: Float32Array

  private readonly foamPool: Pool
  private readonly foamOrigins: Float32Array
  private readonly foamAxes: Float32Array
  private readonly foamParams: Float32Array

  constructor(sim: WaveSim, options: WakeOptions) {
    const tier = Math.max(0, Math.min(WAKE_BUDGETS.length - 1, options.qualityTier | 0))
    const budget = WAKE_BUDGETS[tier]
    const debugMode = wakeDebugMode(options.debugPass)
    const rim = () => float(1).sub(abs(normalView.dot(positionViewDirection)))

    // ── Underwater: small, numerous, simply advected bubbles ─────────────
    {
      const count = budget.bubbles
      const geometry = new SphereGeometry(1, 5, 3)
      this.bubbleOrigins = new Float32Array(count * 3)
      this.bubbleDrives = new Float32Array(count * 3)
      this.bubbleSpawns = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        this.bubbleOrigins[i * 3 + 1] = -900
        this.bubbleSpawns[i] = -1000
      }
      const attrs = [
        new InstancedBufferAttribute(this.bubbleOrigins, 3),
        new InstancedBufferAttribute(this.bubbleDrives, 3),
        new InstancedBufferAttribute(this.bubbleSpawns, 1),
      ]
      geometry.setAttribute('bubbleOrigin', attrs[0])
      geometry.setAttribute('bubbleDrive', attrs[1])
      geometry.setAttribute('bubbleSpawn', attrs[2])

      const material = new MeshBasicNodeMaterial()
      material.transparent = true
      material.depthWrite = false
      material.side = DoubleSide

      const origin = attribute('bubbleOrigin', 'vec3') as unknown as Node<'vec3'>
      const drive = attribute('bubbleDrive', 'vec3') as unknown as Node<'vec3'>
      const spawn = attribute('bubbleSpawn', 'float') as unknown as Node<'float'>
      const seedA = hash(instanceIndex.add(61))
      const seedB = hash(instanceIndex.add(199))
      const seedC = hash(instanceIndex.add(977))
      const age = this.timeUniform.sub(spawn).max(0).min(BUBBLE_LIFE_MAX + 1)
      const life = mix(1.8, BUBBLE_LIFE_MAX, seedA)
      const t01 = age.div(life)

      const washDrift = drive.mul(float(1).sub(exp(age.mul(-1.15))).div(1.15))
      const rise = mix(0.08, 0.28, seedB)
        .mul(age)
        .mul(smoothstep(0.08, 0.5, age))
      const wobble = vec3(
        sin(age.mul(6.7).add(seedA.mul(43))),
        sin(age.mul(8.3).add(seedC.mul(51))).mul(0.25),
        cos(age.mul(6.1).add(seedB.mul(47))),
      ).mul(age.mul(0.025))
      const center = origin.add(washDrift).add(vec3(0, rise, 0)).add(wobble)

      const appear = smoothstep(0, 0.025, t01)
      const dissipate = float(1).sub(smoothstep(0.64, 1, t01))
      const surfaceFade = float(1).sub(smoothstep(-0.24, 0.02, center.y))
      const visible = appear.mul(dissipate).mul(surfaceFade)
      const size = mix(0.006, 0.022, seedC.pow(2))
        .mul(t01.mul(0.45).add(0.78))
        .mul(smoothstep(0.01, 0.08, visible))
      material.positionNode = center.add(positionGeometry.mul(size))

      const fresnel = rim().pow(2.35)
      const beautyColor = mix(vec3(0.08, 0.24, 0.3), vec3(0.66, 0.86, 0.9), fresnel)
      material.colorNode = debugColor(debugMode, 'bubbles', t01, drive, beautyColor)
      material.opacityNode = fresnel.mul(0.42).add(0.02).mul(visible)

      this.bubblePool = this.finishPool(
        'submarine:wake-bubbles', geometry, material, attrs, count, BUBBLE_LIFE_MAX,
      )
    }

    // ── Surface: wave-conforming center churn + Kelvin foam arms ─────────
    {
      const count = budget.foam
      const geometry = new PlaneGeometry(2, 2, 4, 2)
      geometry.rotateX(-Math.PI / 2)
      this.foamOrigins = new Float32Array(count * 3)
      this.foamAxes = new Float32Array(count * 3)
      this.foamParams = new Float32Array(count * 3)
      for (let i = 0; i < count; i++) {
        this.foamOrigins[i * 3 + 1] = -900
        this.foamAxes[i * 3 + 2] = 1
        this.foamParams[i * 3] = -1000
        this.foamParams[i * 3 + 2] = 0.5
      }
      const attrs = [
        new InstancedBufferAttribute(this.foamOrigins, 3),
        new InstancedBufferAttribute(this.foamAxes, 3),
        new InstancedBufferAttribute(this.foamParams, 3),
      ]
      geometry.setAttribute('foamOrigin', attrs[0])
      geometry.setAttribute('foamAxis', attrs[1])
      geometry.setAttribute('foamParams', attrs[2])

      const material = new MeshStandardNodeMaterial()
      material.transparent = true
      material.depthWrite = false
      material.side = DoubleSide
      material.roughness = 0.92
      material.metalness = 0

      const origin = attribute('foamOrigin', 'vec3') as unknown as Node<'vec3'>
      const storedAxis = attribute('foamAxis', 'vec3') as unknown as Node<'vec3'>
      const params = attribute('foamParams', 'vec3') as unknown as Node<'vec3'>
      const seedA = hash(instanceIndex.add(521))
      const seedB = hash(instanceIndex.add(1637))
      const age = this.timeUniform.sub(params.x).max(0).min(FOAM_LIFE_MAX + 1)
      const lane = params.y
      const strength = params.z.clamp(0, 1)
      const arm = smoothstep(0.25, 0.75, abs(lane))
      const life = mix(6.5, FOAM_LIFE_MAX, seedA).mul(mix(0.82, 1.04, strength))
      const t01 = age.div(life)

      const wakeAxis = storedAxis.div(storedAxis.length().max(0.001))
      const wakeRight = vec3(wakeAxis.z, 0, wakeAxis.x.negate())
      const rawFlow = wakeAxis.mul(KELVIN_COS).add(wakeRight.mul(lane).mul(KELVIN_SIN))
      const flowDirection = rawFlow.div(rawFlow.length().max(0.001))
      const patchRight = vec3(flowDirection.z, 0, flowDirection.x.negate())
      const driftSpeed = mix(0.24, 0.82, arm).mul(mix(0.55, 1.18, strength))
      const driftDistance = float(1).sub(exp(age.mul(-0.28))).div(0.28).mul(driftSpeed)
      const lateralWander = wakeRight.mul(seedB.sub(0.5)).mul(age).mul(0.07).mul(float(1).sub(arm))
      const center = origin.add(flowDirection.mul(driftDistance)).add(lateralWander)

      const local = positionGeometry.xz
      const appear = smoothstep(0, 0.025, t01)
      // Foam loses opacity continuously from its first settled moment. The
      // old 58%-life plateau made the later smoothstep read like a TTL pop.
      const remaining = float(1).sub(t01.clamp(0, 1))
      const envelope = appear.mul(remaining.pow(1.35))
      const geometryKeep = smoothstep(0.001, 0.04, envelope)
      const halfLength = mix(0.46, 0.7, seedB)
        .mul(mix(0.9, 1.45, arm))
        .mul(t01.mul(0.82).add(1))
        .mul(geometryKeep)
      const halfWidth = mix(0.28, 0.42, seedA)
        .mul(mix(1, 0.52, arm))
        .mul(t01.mul(1.35).add(1))
        .mul(geometryKeep)
      const sampleXZ = center.xz
        .add(patchRight.xz.mul(local.x).mul(halfWidth))
        .add(flowDirection.xz.mul(local.y).mul(halfLength))

      let displacement = sim.displacementNodes[0]
        .sample(sampleXZ.div(sim.patchLengths[0])).xyz as Node<'vec3'>
      for (let i = 1; i < sim.displacementNodes.length; i++) {
        displacement = displacement.add(
          sim.displacementNodes[i].sample(sampleXZ.div(sim.patchLengths[i])).xyz,
        ) as Node<'vec3'>
      }
      material.positionNode = vec3(
        sampleXZ.x.add(displacement.x),
        displacement.y.add(0.045),
        sampleXZ.y.add(displacement.z),
      )

      const ellipse = local.x.mul(local.x).add(local.y.mul(local.y))
      const edge = float(1).sub(smoothstep(0.42, 1, ellipse))
      const laceA = mx_noise_float(vec3(
        local.x.mul(2.5),
        local.y.mul(3.8),
        seedA.mul(37).add(age.mul(0.1)),
      ))
      const laceB = mx_noise_float(vec3(
        local.y.mul(5.1).add(seedB.mul(11)),
        local.x.mul(4.2),
        seedB.mul(29).sub(age.mul(0.07)),
      ))
      const lace = smoothstep(
        mix(-0.42, -0.02, t01),
        0.48,
        laceA.mul(0.7).add(laceB.mul(0.3)),
      )
      const beautyColor = mix(vec3(0.67, 0.79, 0.8), vec3(0.96, 0.98, 0.97), edge)
      material.colorNode = debugColor(debugMode, 'foam', t01, flowDirection, beautyColor)
      material.opacityNode = envelope.mul(edge).mul(lace).mul(mix(0.52, 0.42, arm))

      this.foamPool = this.finishPool(
        'submarine:wake-foam', geometry, material, attrs, count, FOAM_LIFE_MAX,
      )
      this.foamPool.mesh.renderOrder = -50
    }

    this.meshes = [this.bubblePool.mesh, this.foamPool.mesh]
  }

  private finishPool(
    name: string,
    geometry: BufferGeometry,
    material: WakeMaterial,
    attributes: InstancedBufferAttribute[],
    count: number,
    lifeMax: number,
  ): Pool {
    for (const attr of attributes) attr.setUsage(DynamicDrawUsage)
    const mesh = new InstancedMesh(geometry, material, count)
    mesh.name = name
    mesh.frustumCulled = false
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

  emitBubble(origin: Vector3, drive: Vector3, now: number): void {
    const i = this.advance(this.bubblePool, now)
    writeVec3(this.bubbleOrigins, i, origin)
    writeVec3(this.bubbleDrives, i, drive)
    this.bubbleSpawns[i] = now
  }

  /** lane: -1/+1 = Kelvin arms, 0 = center churn. */
  emitFoam(origin: Vector3, axis: Vector3, lane: number, strength: number, now: number): void {
    const i = this.advance(this.foamPool, now)
    writeVec3(this.foamOrigins, i, origin)
    writeVec3(this.foamAxes, i, axis)
    this.foamParams[i * 3] = now
    this.foamParams[i * 3 + 1] = lane
    this.foamParams[i * 3 + 2] = strength
  }

  /** A regime gate guarantees that only one wake representation can draw. */
  update(now: number, surfaced: boolean): void {
    this.timeUniform.value = now
    this.bubblePool.mesh.visible = !surfaced && now < this.bubblePool.quietAt
    this.foamPool.mesh.visible = surfaced && now < this.foamPool.quietAt
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose()
      ;(mesh.material as WakeMaterial).dispose()
    }
  }
}

function wakeDebugMode(pass: string): WakeDebugMode {
  if (pass === 'wake-layers') return 'layers'
  if (pass === 'wake-age') return 'age'
  if (pass === 'wake-flow') return 'flow'
  return 'beauty'
}

function debugColor(
  mode: WakeDebugMode,
  layer: 'bubbles' | 'foam',
  age01: Node<'float'>,
  flow: Node<'vec3'>,
  beauty: Node<'vec3'>,
): Node<'vec3'> {
  if (mode === 'age') return vec3(age01.clamp(0, 1), float(1).sub(age01.clamp(0, 1)), 0.08)
  if (mode === 'flow') {
    const direction = flow.div(flow.length().max(0.001))
    return direction.mul(0.5).add(0.5)
  }
  if (mode === 'layers') {
    return layer === 'bubbles' ? vec3(0.05, 0.75, 1) : vec3(1, 0.8, 0.08)
  }
  return beauty
}

function writeVec3(target: Float32Array, index: number, value: Vector3): void {
  target[index * 3] = value.x
  target[index * 3 + 1] = value.y
  target[index * 3 + 2] = value.z
}
