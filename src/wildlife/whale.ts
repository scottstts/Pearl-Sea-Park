import {
  CatmullRomCurve3,
  Color,
  Mesh,
  Object3D,
  SphereGeometry,
  Vector3,
} from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import {
  attribute,
  mix,
  positionGeometry,
  positionLocal,
  sin,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl'
import { registerBookmark } from '../core/debug'
import { markDynamicShadowCasters } from '../render/layers'
import type { GameContext } from '../runtime/context'
import type { SeaMediumSystem } from '../sea/medium'
import { terrainHeight } from '../world/terrain'
import { createWhaleGeometry, geometryMetrics } from './speciesGeometry'
import type { GeometryMetrics } from './speciesGeometry'

export type WhaleCue = 'approach' | 'visible' | 'depart' | 'end'

export interface WhaleSnapshot {
  active: boolean
  phase: number
  cue: WhaleCue | 'idle'
  position: [number, number, number]
  lengthMeters: number
  geometry: GeometryMetrics
}

/**
 * One 14 m humpback on an authored drop-off path. The 90 s schedule reserves
 * its first 12 s for song and an overhead shadow; only then does the body
 * descend past the Overlook, with the near-side eye held at guest height.
 */
export class WhalePass {
  readonly group = new Object3D()

  private readonly medium: SeaMediumSystem
  private readonly path: CatmullRomCurve3
  private readonly swimUniform = uniform(0)
  private readonly body: Object3D
  private readonly metrics: GeometryMetrics
  private active = false
  private validation = false
  private eventStart = 0
  private phase = 0
  private cue: WhaleCue | 'idle' = 'idle'
  private readonly position = new Vector3()
  private readonly tangent = new Vector3()

  constructor(medium: SeaMediumSystem) {
    this.medium = medium
    this.path = new CatmullRomCurve3(
      [
        new Vector3(-320, -14, -312),
        new Vector3(-258, -16, -284),
        new Vector3(-205, -19, -267),
        new Vector3(-163, -24.8, -256),
        new Vector3(-126, -24.4, -255),
        new Vector3(-74, -30, -272),
        new Vector3(12, -45, -314),
      ],
      false,
      'centripetal',
      0.5,
    )

    const geometry = createWhaleGeometry()
    this.metrics = geometryMetrics(geometry)
    const material = new MeshStandardNodeMaterial()
    material.roughness = 0.68
    material.metalness = 0.01
    material.color = new Color(0xffffff)
    const flexWeight = attribute('morphWeight', 'float') as unknown as Node<'float'>
    const flex = sin(this.swimUniform.mul(Math.PI * 2).sub(positionLocal.z.mul(0.22)))
      .mul(flexWeight)
      .mul(0.52)
    material.positionNode = positionLocal.add(vec3(flex, flex.abs().mul(-0.08), 0))
    const belly = smoothstep(-1.1, 0.3, positionGeometry.y)
    material.colorNode = mix(vec3(0.3, 0.35, 0.36), vec3(0.075, 0.105, 0.12), belly)
    this.medium.applyCaustics(material, 0.72)
    const bodyMesh = new Mesh(geometry, material)
    bodyMesh.castShadow = true
    bodyMesh.receiveShadow = true
    bodyMesh.frustumCulled = true
    bodyMesh.name = 'wildlife-whale:body'
    markDynamicShadowCasters(bodyMesh)

    const body = new Object3D()
    body.add(bodyMesh)
    const eyeMaterial = new MeshStandardNodeMaterial()
    eyeMaterial.color = new Color(0x050607)
    eyeMaterial.roughness = 0.12
    eyeMaterial.metalness = 0.18
    for (const side of [-1, 1]) {
      const eye = new Mesh(new SphereGeometry(0.13, 16, 10), eyeMaterial)
      eye.position.set(side * 1.03, 0.38, 4.82)
      eye.scale.set(1, 0.78, 0.52)
      body.add(eye)
    }
    this.body = body
    this.group.add(body)
    this.group.visible = false
  }

  init(ctx: GameContext): void {
    this.validation = ctx.flags.view === 'whale'
    ctx.scene.add(this.group)
    ctx.events.on('schedule/event', ({ name, phase }) => {
      if (name !== 'whale-passage') return
      if (phase === 'start') {
        this.active = true
        this.eventStart = ctx.time.elapsed
        this.setCue(ctx, 'approach')
      } else if (!this.validation) {
        this.active = false
        this.group.visible = false
        this.setCue(ctx, 'end')
      }
    })

    const overlookY = terrainHeight(-140, -234)
    registerBookmark({
      name: 'whale',
      position: [-140, overlookY + 1.75, -228],
      look: [-158, overlookY + 0.15, -257],
      note: 'Leviathan Overlook — the scheduled eye-to-eye passage',
    })
  }

  update(ctx: GameContext): void {
    if (this.validation) {
      this.active = true
      this.phase = 0.46 + Math.sin(ctx.time.elapsed * 0.08) * 0.025
      this.group.visible = true
      if (this.cue === 'idle') this.setCue(ctx, 'visible')
    } else if (this.active) {
      const local = ctx.time.elapsed - this.eventStart
      if (local < 12) {
        this.phase = 0
        this.group.visible = false
        if (this.cue !== 'approach') this.setCue(ctx, 'approach')
        return
      }
      this.phase = Math.max(0, Math.min(1, (local - 12) / 68))
      this.group.visible = this.phase < 1
      if (this.phase < 0.72 && this.cue !== 'visible') this.setCue(ctx, 'visible')
      if (this.phase >= 0.72 && this.cue !== 'depart') this.setCue(ctx, 'depart')
      if (this.phase >= 1) {
        this.active = false
        this.group.visible = false
        this.setCue(ctx, 'end')
        return
      }
    } else {
      this.group.visible = false
      return
    }

    this.path.getPointAt(this.phase, this.position)
    this.path.getTangentAt(this.phase, this.tangent).normalize()
    this.body.position.copy(this.position)
    this.body.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), this.tangent)
    this.body.rotateZ(Math.sin(this.phase * Math.PI) * 0.035)
    this.swimUniform.value = ctx.time.elapsed * 0.115
  }

  private setCue(ctx: GameContext, cue: WhaleCue): void {
    this.cue = cue
    ctx.events.emit('wildlife/whale-cue', { phase: cue })
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
    this.group.traverse((object) => {
      if (!(object instanceof Mesh)) return
      object.geometry.dispose()
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) material.dispose()
    })
  }

  debugSnapshot(): WhaleSnapshot {
    return {
      active: this.active,
      phase: this.phase,
      cue: this.cue,
      position: [this.position.x, this.position.y, this.position.z],
      lengthMeters: 14.15,
      geometry: this.metrics,
    }
  }
}
