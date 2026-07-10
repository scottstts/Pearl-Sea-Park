import {
  AdditiveBlending,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Object3D,
  PointLight,
  SphereGeometry,
} from 'three'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import {
  abs,
  cos,
  float,
  fract,
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
  vec4,
} from 'three/tsl'
import { registerBookmark } from '../core/debug'
import { markMainDetail } from '../render/layers'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { SeaMediumSystem } from '../sea/medium'
import type { DistrictServices } from '../world/districts/atrium'
import { PARK_PLAN, anchorGround } from '../world/parkPlan'

const JET_COUNT = 32
const SHOW_SECONDS = 180

export interface FountainSnapshot {
  active: boolean
  validation: boolean
  localTime: number
  section: string
  envelope: number
  heightMeters: number
  ringRadiusMeters: number
  bubbles: number
  drawCalls: number
}

/**
 * Tidal Court's recurring three-minute grand show. One analytic bubble pool
 * and one analytic shaft pool cover every cue; instances recycle by age, so
 * choreography never creates or destroys GPU objects during play.
 */
export class BubbleFountainSystem implements GameSystem {
  readonly id = 'bubble-fountain'

  private readonly services: DistrictServices
  private readonly medium: SeaMediumSystem
  private readonly group = new Object3D()
  private readonly timeUniform = uniform(0)
  private readonly activeUniform = uniform(0)
  private readonly envelopeUniform = uniform(0)
  private readonly heightUniform = uniform(8)
  private readonly radiusUniform = uniform(10)
  private readonly spiralUniform = uniform(0)
  private readonly fanUniform = uniform(0)
  private readonly warmthUniform = uniform(0)
  private readonly lights: PointLight[] = []
  private bubbleCount = 0
  private active = false
  private validation = false
  private startTime = 0
  private localTime = 0
  private section = 'waiting'
  private debugCanvas: HTMLCanvasElement | null = null

  constructor(services: DistrictServices, medium: SeaMediumSystem) {
    this.services = services
    this.medium = medium
  }

  init(ctx: GameContext): void {
    const { x, z } = PARK_PLAN.tidalCourt
    const waterY = anchorGround(PARK_PLAN.tidalCourt) + 0.62
    this.validation = ctx.flags.view === 'fountain'
    this.bubbleCount = ctx.quality.params.bubbleBudget
    this.buildBubbles(ctx, x, waterY, z)
    this.buildShafts(ctx, x, waterY, z)
    this.buildNozzles(x, waterY, z)
    this.buildLights(x, waterY, z)
    this.group.visible = this.validation
    ctx.scene.add(this.group)
    if (ctx.flags.debug) this.debugCanvas = ctx.renderer.domElement

    ctx.events.on('schedule/event', ({ name, phase }) => {
      if (name !== 'fountain-show' || this.validation) return
      if (phase === 'start') {
        this.active = true
        this.startTime = ctx.time.elapsed
        this.group.visible = true
        ctx.events.emit('wildlife/fish-attractor', {
          x,
          y: waterY + 5,
          z,
          strength: 0.72,
          radius: 70,
          duration: SHOW_SECONDS,
        })
      } else {
        this.active = false
      }
    })

    registerBookmark({
      name: 'fountain',
      position: [x + 45, waterY + 4.1, z + 51],
      look: [x, waterY + 13, z],
      note: 'Postcard 10 — the Bubble Fountain crown over Tidal Court',
    })
  }

  update(ctx: GameContext): void {
    if (this.validation) {
      this.active = true
      this.localTime = 126 + Math.sin(ctx.time.elapsed * 0.08) * 2.5
      this.group.visible = true
    } else if (this.active) {
      this.localTime = Math.max(0, ctx.time.elapsed - this.startTime)
      if (this.localTime >= SHOW_SECONDS) this.active = false
    }

    const cue = fountainCue(this.localTime, this.active)
    this.section = cue.section
    this.timeUniform.value = this.localTime
    this.activeUniform.value = cue.active
    this.envelopeUniform.value = cue.envelope
    this.heightUniform.value = cue.height
    this.radiusUniform.value = cue.radius
    this.spiralUniform.value = cue.spiral
    this.fanUniform.value = cue.fan
    this.warmthUniform.value = cue.warmth
    for (let index = 0; index < this.lights.length; index++) {
      const pulse = 0.72 + 0.28 * Math.sin(this.localTime * 2.1 + index * 1.7)
      this.lights[index].intensity = cue.envelope * pulse * (cue.warmth > 0.5 ? 19 : 13)
      this.lights[index].visible = cue.active > 0.001
    }

    if (!this.validation && !this.active && cue.envelope < 0.002) this.group.visible = false
    if (this.debugCanvas && ctx.time.frame % 30 === 0) {
      this.debugCanvas.dataset.fountainState = JSON.stringify(this.debugSnapshot())
    }
  }

  debugSnapshot(): FountainSnapshot {
    return {
      active: this.active,
      validation: this.validation,
      localTime: this.localTime,
      section: this.section,
      envelope: Number(this.envelopeUniform.value),
      heightMeters: Number(this.heightUniform.value),
      ringRadiusMeters: Number(this.radiusUniform.value),
      bubbles: this.bubbleCount,
      drawCalls: 3,
    }
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
    this.group.traverse((object) => {
      if (!(object instanceof InstancedMesh)) return
      object.geometry.dispose()
      if (object.name === 'show:nozzle-ring') return
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) material.dispose()
    })
    if (this.debugCanvas) delete this.debugCanvas.dataset.fountainState
  }

  private buildBubbles(ctx: GameContext, x: number, y: number, z: number): void {
    const material = new MeshStandardNodeMaterial()
    material.transparent = true
    material.depthWrite = false
    material.side = DoubleSide
    material.roughness = 0.07
    material.metalness = 0.16
    material.envMapIntensity = 1.35

    const jet = float(instanceIndex.mod(JET_COUNT))
    const bubbleSeed = hash(instanceIndex.add(17))
    const age = fract(
      this.timeUniform.mul(mix(0.13, 0.21, hash(instanceIndex.add(53)))).add(bubbleSeed),
    )
    const angle = jet
      .div(JET_COUNT)
      .mul(Math.PI * 2)
      .add(this.timeUniform.mul(this.spiralUniform).mul(0.16))
      .add(bubbleSeed.sub(0.5).mul(0.13))
    const inner = instanceIndex.mod(5).equal(0).select(float(0.34), float(1))
    const radius = this.radiusUniform.mul(inner)
    const radial = vec3(sin(angle), 0, cos(angle))
    const tangent = vec3(radial.z, 0, radial.x.negate())
    const height = age
      .mul(this.heightUniform)
      .mul(hash(instanceIndex.add(101)).mul(0.38).add(0.72))
    const fan = radial.mul(this.fanUniform.mul(sin(age.mul(Math.PI))).mul(7.5))
    const helix = tangent
      .mul(sin(age.mul(Math.PI * 6).add(bubbleSeed.mul(11))).mul(this.spiralUniform).mul(1.8))
    const center = vec3(x, y, z)
      .add(radial.mul(radius))
      .add(fan)
      .add(helix)
      .add(vec3(0, height, 0))
    const size = mix(0.045, 0.19, hash(instanceIndex.add(211))).mul(mix(0.72, 1.15, age))
    material.positionNode = center.add(positionGeometry.mul(size))

    const rim = float(1)
      .sub(abs(normalView.dot(positionViewDirection)))
      .pow(2.25)
    const ageFade = smoothstep(0, 0.08, age).mul(float(1).sub(smoothstep(0.78, 1, age)))
    const visible = ageFade.mul(this.envelopeUniform).mul(this.activeUniform)
    const cool = vec3(0.16, 0.72, 1.05)
    const warm = vec3(1.18, 0.52, 0.12)
    const lightColor = mix(cool, warm, this.warmthUniform)
    material.colorNode = mix(vec3(0.04, 0.15, 0.2), lightColor, rim)
    material.emissiveNode = lightColor.mul(rim.pow(3).mul(1.35).mul(visible))
    material.opacityNode = rim.mul(0.68).add(0.025).mul(visible)
    this.medium.applyCaustics(material, 0.18)

    if (ctx.flags.pass === 'fountain-age') {
      material.colorNode = vec3(age)
      material.emissiveNode = vec3(age)
    } else if (ctx.flags.pass === 'fountain-envelope') {
      material.colorNode = vec3(this.envelopeUniform)
      material.emissiveNode = vec3(this.envelopeUniform)
    }

    const bubbles = new InstancedMesh(new SphereGeometry(1, 12, 8), material, this.bubbleCount)
    fillIdentityInstances(bubbles)
    bubbles.frustumCulled = false
    bubbles.castShadow = false
    bubbles.receiveShadow = false
    markMainDetail(bubbles)
    bubbles.name = 'show:bubble-pool'
    this.group.add(bubbles)
  }

  private buildShafts(ctx: GameContext, x: number, y: number, z: number): void {
    const material = new MeshBasicNodeMaterial()
    material.transparent = true
    material.depthWrite = false
    material.side = DoubleSide
    material.blending = AdditiveBlending
    const jet = float(instanceIndex)
    const angle = jet
      .div(JET_COUNT)
      .mul(Math.PI * 2)
      .add(this.timeUniform.mul(this.spiralUniform).mul(0.16))
    const radial = vec3(sin(angle), 0, cos(angle))
    const tangent = vec3(radial.z, 0, radial.x.negate())
    const localHeight = positionGeometry.y.add(0.5)
    const shaftHeight = this.heightUniform.mul(0.96)
    const width = mix(0.12, 0.34, hash(instanceIndex.add(317)))
    const shaped = vec3(
      positionGeometry.x.mul(width),
      localHeight.mul(shaftHeight),
      positionGeometry.z.mul(width),
    )
    const center = vec3(x, y, z)
      .add(radial.mul(this.radiusUniform))
      .add(radial.mul(this.fanUniform.mul(localHeight).mul(6.5)))
      .add(tangent.mul(sin(localHeight.mul(Math.PI * 2)).mul(this.spiralUniform).mul(1.4)))
    material.positionNode = center.add(shaped)
    const verticalFade = sin(localHeight.mul(Math.PI)).pow(0.7)
    const pulse = sin(this.timeUniform.mul(2.4).add(jet.mul(0.61))).mul(0.2).add(0.8)
    const cool = vec3(0.08, 0.7, 1.18)
    const warm = vec3(1.42, 0.56, 0.08)
    material.colorNode = vec4(mix(cool, warm, this.warmthUniform).mul(1.15), 1)
    material.opacityNode = verticalFade
      .mul(pulse)
      .mul(this.envelopeUniform)
      .mul(this.activeUniform)
      .mul(0.3)

    if (ctx.flags.pass === 'fountain-envelope') {
      material.colorNode = vec4(vec3(this.envelopeUniform), 1)
      material.opacityNode = this.activeUniform
    }

    const shafts = new InstancedMesh(
      new CylinderGeometry(0.3, 1, 1, 10, 1, true),
      material,
      JET_COUNT,
    )
    fillIdentityInstances(shafts)
    shafts.frustumCulled = false
    shafts.castShadow = false
    shafts.receiveShadow = false
    markMainDetail(shafts)
    shafts.name = 'show:light-shafts'
    this.group.add(shafts)
  }

  private buildNozzles(x: number, y: number, z: number): void {
    const lib = this.services.materials.lib
    if (!lib) throw new Error('BubbleFountainSystem requires park materials')
    const geometry = new CylinderGeometry(0.12, 0.17, 0.28, 12)
    const nozzles = new InstancedMesh(geometry, lib.brass, JET_COUNT)
    const matrix = new Matrix4()
    for (let index = 0; index < JET_COUNT; index++) {
      const angle = (index / JET_COUNT) * Math.PI * 2
      matrix.makeTranslation(x + Math.sin(angle) * 21.5, y - 0.05, z + Math.cos(angle) * 21.5)
      nozzles.setMatrixAt(index, matrix)
    }
    nozzles.instanceMatrix.setUsage(DynamicDrawUsage)
    nozzles.instanceMatrix.needsUpdate = true
    nozzles.castShadow = true
    nozzles.receiveShadow = true
    nozzles.name = 'show:nozzle-ring'
    this.group.add(nozzles)
  }

  private buildLights(x: number, y: number, z: number): void {
    for (let index = 0; index < 4; index++) {
      const angle = (index / 4) * Math.PI * 2 + Math.PI / 4
      const light = new PointLight(index % 2 === 0 ? 0x4ad9ff : 0xffb347, 0, 42, 1.45)
      light.position.set(x + Math.sin(angle) * 17, y + 1.1, z + Math.cos(angle) * 17)
      light.visible = false
      this.group.add(light)
      this.lights.push(light)
    }
  }
}

function fillIdentityInstances(mesh: InstancedMesh): void {
  const identity = new Matrix4()
  for (let index = 0; index < mesh.count; index++) mesh.setMatrixAt(index, identity)
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  mesh.instanceMatrix.needsUpdate = true
}

function fountainCue(time: number, active: boolean) {
  if (!active) {
    return {
      active: 0,
      section: 'waiting',
      envelope: 0,
      height: 7,
      radius: 10,
      spiral: 0,
      fan: 0,
      warmth: 0,
    }
  }
  const whole = smoothCpu(0, 4, time) * (1 - smoothCpu(174, 180, time))
  if (time < 18) {
    const p = smoothCpu(0, 18, time)
    return { active: 1, section: 'overture', envelope: whole * 0.55, height: 7 + p * 7, radius: 8 + p * 6, spiral: 0, fan: 0, warmth: 0.1 }
  }
  if (time < 55) {
    const p = smoothCpu(18, 55, time)
    return { active: 1, section: 'fans', envelope: whole * 0.78, height: 14 + p * 8, radius: 15 + p * 3, spiral: 0.08, fan: 0.25 + p * 0.75, warmth: 0.2 }
  }
  if (time < 96) {
    const p = smoothCpu(55, 96, time)
    return { active: 1, section: 'spiral', envelope: whole * 0.88, height: 21 + Math.sin(p * Math.PI) * 8, radius: 18 - p * 5, spiral: 0.35 + p * 0.65, fan: 0.18, warmth: p * 0.35 }
  }
  if (time < 138) {
    const p = smoothCpu(96, 138, time)
    return { active: 1, section: 'crown', envelope: whole, height: 30 + Math.sin(p * Math.PI * 2) * 3, radius: 16 + Math.sin(p * Math.PI) * 6, spiral: 0.82, fan: 0.32, warmth: 0.35 + p * 0.45 }
  }
  if (time < 170) {
    const beat = 0.86 + 0.14 * Math.sin(time * Math.PI * 0.8) ** 2
    return { active: 1, section: 'chorus', envelope: whole * beat, height: 32 + beat * 5, radius: 21, spiral: 0.55, fan: 0.85, warmth: 0.82 }
  }
  const finale = smoothCpu(170, 176, time)
  return { active: 1, section: 'finale', envelope: whole, height: 36 + finale * 8, radius: 22 - finale * 5, spiral: 1, fan: 1, warmth: 1 }
}

function smoothCpu(edge0: number, edge1: number, value: number): number {
  const x = Math.max(0, Math.min(1, (value - edge0) / Math.max(1e-6, edge1 - edge0)))
  return x * x * (3 - 2 * x)
}
