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
import type { SeaMediumSystem } from '../sea/medium'

const COUNT = 240

/**
 * Propeller wash — a ring buffer of GPU bubbles behind the spinning screw.
 * The CPU only writes a spawn record (origin, wash velocity, launch time)
 * when the propeller sheds a bubble; everything else — decaying wash drift,
 * buoyant rise, wobble, growth, dissolve — is vertex TSL against absolute
 * time (the fountain recycling pattern). One draw, no per-frame matrices.
 */
export class SubmarineWake {
  readonly mesh: InstancedMesh

  private readonly timeUniform = uniform(0)
  private readonly origins: Float32Array
  private readonly drives: Float32Array
  private readonly spawns: Float32Array
  private readonly originAttribute: InstancedBufferAttribute
  private readonly driveAttribute: InstancedBufferAttribute
  private readonly spawnAttribute: InstancedBufferAttribute
  private cursor = 0

  constructor(medium: SeaMediumSystem) {
    const geometry = new SphereGeometry(1, 8, 6)
    this.origins = new Float32Array(COUNT * 3)
    this.drives = new Float32Array(COUNT * 3)
    this.spawns = new Float32Array(COUNT)
    // Everything starts long dead and far below the park.
    for (let i = 0; i < COUNT; i++) {
      this.origins[i * 3 + 1] = -900
      this.spawns[i] = -1000
    }
    this.originAttribute = new InstancedBufferAttribute(this.origins, 3)
    this.driveAttribute = new InstancedBufferAttribute(this.drives, 3)
    this.spawnAttribute = new InstancedBufferAttribute(this.spawns, 1)
    for (const attr of [this.originAttribute, this.driveAttribute, this.spawnAttribute]) {
      attr.setUsage(DynamicDrawUsage)
    }
    geometry.setAttribute('wakeOrigin', this.originAttribute)
    geometry.setAttribute('wakeDrive', this.driveAttribute)
    geometry.setAttribute('wakeSpawn', this.spawnAttribute)

    const material = new MeshStandardNodeMaterial()
    material.transparent = true
    material.depthWrite = false
    material.side = DoubleSide
    material.roughness = 0.07
    material.metalness = 0.16

    const origin = attribute('wakeOrigin', 'vec3') as unknown as Node<'vec3'>
    const drive = attribute('wakeDrive', 'vec3') as unknown as Node<'vec3'>
    const spawn = attribute('wakeSpawn', 'float') as unknown as Node<'float'>
    const seedA = hash(instanceIndex.add(61))
    const seedB = hash(instanceIndex.add(199))
    const seedC = hash(instanceIndex.add(977))

    const age = this.timeUniform.sub(spawn).max(0.0)
    const life = mix(1.1, 2.2, seedA)
    const t01 = age.div(life)

    // Wash drift decays as the slug of water loses momentum; buoyancy takes
    // over and the bubble rises, wobbling as it grows toward the light.
    const washDrift = drive.mul(float(1).sub(exp(age.mul(-2.4))).div(2.4))
    const rise = age.mul(mix(0.28, 0.62, seedB)).mul(smoothstep(0.0, 0.6, age))
    const wobble = vec3(
      sin(age.mul(7.0).add(seedA.mul(40.0))),
      float(0),
      cos(age.mul(6.3).add(seedB.mul(40.0))),
    ).mul(age.mul(0.05))
    const center = origin.add(washDrift).add(vec3(0, rise, 0)).add(wobble)

    const appear = smoothstep(0.0, 0.04, t01)
    const die = float(1).sub(smoothstep(0.72, 1.0, t01))
    // Bubbles rejoin the air at the displaced surface — never render above it.
    const surfaceFade = float(1).sub(smoothstep(-0.35, -0.05, center.y))
    const visible = appear.mul(die).mul(surfaceFade)

    // Decompression growth on the way up; dead instances collapse to points.
    const size = mix(0.016, 0.055, seedC)
      .mul(t01.mul(1.4).add(0.7))
      .mul(smoothstep(0.015, 0.1, visible))
    material.positionNode = center.add(positionGeometry.mul(size))

    const rim = float(1).sub(abs(normalView.dot(positionViewDirection))).pow(2.25)
    material.colorNode = mix(vec3(0.05, 0.14, 0.18), vec3(0.55, 0.75, 0.8), rim)
    material.opacityNode = rim.mul(0.6).add(0.04).mul(visible)
    medium.applyCaustics(material, 0.18)

    const mesh = new InstancedMesh(geometry, material, COUNT)
    mesh.name = 'submarine:wake'
    mesh.frustumCulled = false // positions live in the vertex stage
    mesh.castShadow = false
    mesh.receiveShadow = false
    markMainDetail(mesh)
    this.mesh = mesh
  }

  /** Shed one bubble at a world position with an initial wash velocity. */
  emit(origin: Vector3, drive: Vector3, now: number): void {
    const i = this.cursor
    this.cursor = (i + 1) % COUNT
    this.origins[i * 3] = origin.x
    this.origins[i * 3 + 1] = origin.y
    this.origins[i * 3 + 2] = origin.z
    this.drives[i * 3] = drive.x
    this.drives[i * 3 + 1] = drive.y
    this.drives[i * 3 + 2] = drive.z
    this.spawns[i] = now
    this.originAttribute.needsUpdate = true
    this.driveAttribute.needsUpdate = true
    this.spawnAttribute.needsUpdate = true
  }

  /** Absolute elapsed time — never a local clock (bubbles recycle on it). */
  update(now: number): void {
    this.timeUniform.value = now
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as MeshStandardNodeMaterial).dispose()
  }
}
