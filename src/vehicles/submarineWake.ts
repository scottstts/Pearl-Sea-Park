import {
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  SphereGeometry,
  Vector3,
} from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
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
  normalView,
  positionGeometry,
  positionViewDirection,
  sin,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl'
import { markMainDetail } from '../render/layers'

type WakeDebugMode = 'beauty' | 'layers' | 'age' | 'flow'

interface WakeOptions {
  qualityTier: number
  debugPass: string
}

/** Lower tiers shorten only the oldest trail residue. */
const BUBBLE_BUDGETS = [3_200, 5_200, 7_200] as const

const BUBBLE_LIFE_MAX = 3.6

/**
 * The UNDERWATER half of the wake: one high-count pool of small propeller
 * bubbles. There is no aeration cloud, cavitation layer, ribbon, spray, or
 * other secondary effect.
 *
 * The SURFACED half no longer lives here: surface wake foam is a property of
 * the ocean itself — the submarine splats into `sea/wakeFoamMap.ts` and the
 * detailed ocean sheet reads that field through its own whitecap pipeline.
 * The regime gate below only hides the bubble draw while surfaced.
 */
export class SubmarineWake {
  readonly meshes: InstancedMesh[]

  private readonly timeUniform = uniform(0)
  private readonly mesh: InstancedMesh
  private readonly attributes: InstancedBufferAttribute[]
  private readonly origins: Float32Array
  private readonly drives: Float32Array
  private readonly spawns: Float32Array
  private readonly count: number
  private cursor = 0
  private quietAt = -Infinity

  constructor(options: WakeOptions) {
    const tier = Math.max(0, Math.min(BUBBLE_BUDGETS.length - 1, options.qualityTier | 0))
    const count = BUBBLE_BUDGETS[tier]
    this.count = count
    const debugMode = wakeDebugMode(options.debugPass)

    const geometry = new SphereGeometry(1, 5, 3)
    this.origins = new Float32Array(count * 3)
    this.drives = new Float32Array(count * 3)
    this.spawns = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      this.origins[i * 3 + 1] = -900
      this.spawns[i] = -1000
    }
    this.attributes = [
      new InstancedBufferAttribute(this.origins, 3),
      new InstancedBufferAttribute(this.drives, 3),
      new InstancedBufferAttribute(this.spawns, 1),
    ]
    for (const attr of this.attributes) attr.setUsage(DynamicDrawUsage)
    geometry.setAttribute('bubbleOrigin', this.attributes[0])
    geometry.setAttribute('bubbleDrive', this.attributes[1])
    geometry.setAttribute('bubbleSpawn', this.attributes[2])

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

    const rim = float(1).sub(abs(normalView.dot(positionViewDirection)))
    const fresnel = rim.pow(2.35)
    const beautyColor = mix(vec3(0.08, 0.24, 0.3), vec3(0.66, 0.86, 0.9), fresnel)
    material.colorNode = debugColor(debugMode, t01, drive, beautyColor)
    material.opacityNode = fresnel.mul(0.42).add(0.02).mul(visible)

    const mesh = new InstancedMesh(geometry, material, count)
    mesh.name = 'submarine:wake-bubbles'
    mesh.frustumCulled = false
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.visible = false
    markMainDetail(mesh)
    this.mesh = mesh
    this.meshes = [mesh]
  }

  emitBubble(origin: Vector3, drive: Vector3, now: number): void {
    const i = this.cursor
    this.cursor = (i + 1) % this.count
    this.quietAt = now + BUBBLE_LIFE_MAX
    writeVec3(this.origins, i, origin)
    writeVec3(this.drives, i, drive)
    this.spawns[i] = now
    for (const attr of this.attributes) attr.needsUpdate = true
  }

  /** The regime gate: bubbles may only draw while genuinely submerged. */
  update(now: number, surfaced: boolean): void {
    this.timeUniform.value = now
    this.mesh.visible = !surfaced && now < this.quietAt
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as MeshBasicNodeMaterial).dispose()
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
  age01: Node<'float'>,
  flow: Node<'vec3'>,
  beauty: Node<'vec3'>,
): Node<'vec3'> {
  if (mode === 'age') return vec3(age01.clamp(0, 1), float(1).sub(age01.clamp(0, 1)), 0.08)
  if (mode === 'flow') {
    const direction = flow.div(flow.length().max(0.001))
    return direction.mul(0.5).add(0.5)
  }
  if (mode === 'layers') return vec3(0.05, 0.75, 1)
  return beauty
}

function writeVec3(target: Float32Array, index: number, value: Vector3): void {
  target[index * 3] = value.x
  target[index * 3 + 1] = value.y
  target[index * 3 + 2] = value.z
}
