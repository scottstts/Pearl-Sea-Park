import {
  AdditiveBlending,
  InstancedMesh,
  TetrahedronGeometry,
} from 'three'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import {
  Fn,
  If,
  Loop,
  cameraPosition,
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  exp,
  float,
  fract,
  hash,
  instanceIndex,
  max,
  mix,
  positionGeometry,
  positionWorld,
  pow,
  screenUV,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { registerBookmark } from '../core/debug'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { RenderPipelineSystem } from '../render/pipeline'
import { markMainDetail } from '../render/layers'
import { sunColorUniform, sunDirectionUniform } from '../sky/sun'
import { CausticsPass, causticWorldSample } from './caustics'
import { currentFlow } from './current'
import type { SeaSystem } from './seaSystem'

/** Aquatic extinction — the dream-clarity lever (plan §0): ~250 m visibility. */
const SIGMA = vec3(0.026, 0.0085, 0.005)
const AMBIENT_DOWN = vec3(0.01, 0.075, 0.14)
const AMBIENT_UP = vec3(0.1, 0.32, 0.37)
// NOTE: a "near-surface scattering layer" was tried here twice to mask the
// horizon gap and REMOVED. For any camera below such a slab, up-grazing rays
// integrate along it while down-grazing rays exit it — a brightness step
// pinned to the exact view horizon, which reads as a screen-space artifact.
// The gap's real fixes: the lagoon saucer (terrain) and a physically bright
// TIR underside on the ocean surface (oceanSurfaceMaterial tirBody).

/**
 * The undersea medium (plan §5): aquatic-perspective fog + volumetric god
 * rays composited in the HDR pipeline hook, the caustics projector, drifting
 * particulates, and the submerged gate. Above the surface it is a strict
 * no-op — crossing the waterline swaps worlds.
 */
export class SeaMediumSystem implements GameSystem {
  readonly id = 'sea-medium'

  /** 0 above water → 1 below; smoothed across the crossing frames. */
  private readonly submerged = uniform(0)
  private readonly timeUniform = uniform(0)
  /** 0 = open sea, 1 = deep inside an interior (grotto): kills fog glow + rays. */
  private readonly interior = uniform(0)
  private caustics: CausticsPass | null = null
  private particulates: InstancedMesh | null = null
  private causticSampler: ReturnType<typeof causticWorldSample> | null = null

  private readonly pipeline: RenderPipelineSystem
  private readonly sea: SeaSystem

  constructor(pipeline: RenderPipelineSystem, sea: SeaSystem) {
    this.pipeline = pipeline
    this.sea = sea
  }

  init(ctx: GameContext): void {
    const sim = this.sea.sim
    if (!sim) throw new Error('SeaMediumSystem requires SeaSystem to init first')

    const caustics = new CausticsPass(sim, ctx.quality.params.causticsSize)
    this.caustics = caustics
    const sampler = causticWorldSample(caustics.textureNode)
    this.causticSampler = sampler
    this.pipeline.debugNodes.caustics = vec4(caustics.textureNode.rgb, 1)

    const godraySteps = ctx.quality.params.godraySteps
    const submerged = this.submerged

    // ── HDR composite: fog + god rays, spliced before bloom ───────────────
    this.pipeline.hdrTransform = (color, extras) => {
      const viewZ = (extras as { viewZNode: Node<'float'> }).viewZNode
      const scene = (color as Node<'vec4'>).rgb

      const foggedNode = Fn(() => {
        const dist = viewZ.negate().min(3500).toVar()

        // World-space ray from screen UV + camera matrices.
        const ndc = vec2(screenUV.x.mul(2).sub(1), float(1).sub(screenUV.y).mul(2).sub(1))
        const far4 = cameraProjectionMatrixInverse.mul(vec4(ndc, 1.0, 1.0))
        const farView = far4.xyz.div(far4.w)
        const viewPos = farView.mul(viewZ.div(farView.z))
        const worldPos = cameraWorldMatrix.mul(vec4(viewPos, 1.0)).xyz
        const rayDir = worldPos.sub(cameraPosition).div(max(dist, 1e-4))

        const transmittance = exp(SIGMA.mul(dist).negate())
        const upness = smoothstep(-0.5, 0.75, rayDir.y)
        const cameraDim = exp(cameraPosition.y.min(0).mul(0.03))
        const sunward = pow(max(rayDir.dot(sunDirectionUniform), 0.0), 6.0).mul(0.06)
        const interiorKeep = float(1).sub(this.interior.mul(0.94))
        const inscatter = mix(AMBIENT_DOWN, AMBIENT_UP, upness)
          .mul(cameraDim)
          .add(sunColorUniform.mul(sunward))
          .mul(interiorKeep)
        const fogged = scene
          .mul(transmittance)
          .add(inscatter.mul(float(1).sub(transmittance.g)))
        return vec4(mix(scene, fogged, submerged), 1)
      })()

      // Preserve the pre-S14 full-resolution mechanism. The caustic field's
      // fine separated shafts depend on independent per-output-pixel ray
      // integration; a reduced target has no velocity/history contract with
      // which to reconstruct that signal without mud, grain, or tile patterns.
      const resolvedRays = Fn(() => {
        const dist = viewZ.negate().min(3500).toVar()
        const ndc = vec2(screenUV.x.mul(2).sub(1), float(1).sub(screenUV.y).mul(2).sub(1))
        const far4 = cameraProjectionMatrixInverse.mul(vec4(ndc, 1, 1))
        const farView = far4.xyz.div(far4.w)
        const viewPos = farView.mul(viewZ.div(farView.z))
        const worldPos = cameraWorldMatrix.mul(vec4(viewPos, 1)).xyz
        const rayDir = worldPos.sub(cameraPosition).div(max(dist, 1e-4))
        const marchLength = dist.min(85.0)
        const stepLength = marchLength.div(godraySteps)
        const jitter = fract(
          sin(screenUV.x.mul(1741.37).add(screenUV.y.mul(921.13))).mul(43758.55),
        )
        const shaft = float(0).toVar()
        // `submerged` is uniform across the draw, so this is a coherent branch:
        // it preserves the exact underwater loop while eliminating all caustic
        // texture samples from above-water frames.
        If(submerged.greaterThan(0.001), () => {
          Loop({ start: 0, end: godraySteps }, (loopVars) => {
            const i = (loopVars as { i: Node<'int'> }).i
            const t = stepLength.mul(float(i).add(jitter))
            const samplePos = cameraPosition.add(rayDir.mul(t))
            const light = sampler(samplePos).g
            shaft.addAssign(light.mul(exp(t.mul(-0.03))))
          })
        })
        const interiorKeep = float(1).sub(this.interior.mul(0.94))
        const rays = sunColorUniform
          .mul(shaft.mul(stepLength).mul(0.007))
          .mul(interiorKeep)
          .mul(submerged)
        return rays
      })()
      const combined = vec4(foggedNode.rgb.add(resolvedRays), 1)
      this.pipeline.debugNodes.rays = vec4(resolvedRays, 1)
      this.pipeline.debugNodes['no-rays'] = foggedNode
      return combined
    }

    this.buildParticulates(ctx)

    registerBookmark({
      name: 'caustics',
      position: [0, -21, -8],
      look: [0, -26.5, 10],
      note: 'Caustic glints raking the seabed',
    })
  }

  /**
   * Caustic light on any lit material: modulates the received sun shadow, so
   * caustics inherit occlusion for free. Every underwater lit material gets
   * this (terrain, architecture, props).
   */
  /** Interiors (the grotto) fade the open-sea glow as the camera goes deep. */
  setInterior(value: number): void {
    this.interior.value = Math.min(1, Math.max(0, value))
  }

  applyCaustics(material: MeshStandardNodeMaterial, strength = 1.4): void {
    const sampler = this.causticSampler
    if (!sampler) return
    material.receivedShadowNode = Fn(([shadow]: [Node<'float'>]) => {
      const caustic = sampler(positionWorld).g
      return shadow.mul(caustic.mul(strength).add(1.0))
    }) as unknown as typeof material.receivedShadowNode
  }

  private buildParticulates(ctx: GameContext): void {
    const count = ctx.quality.params.particulateCount
    const material = new MeshBasicNodeMaterial()
    material.blending = AdditiveBlending
    material.depthWrite = false
    material.transparent = true

    const boxSize = float(60)
    const half = boxSize.div(2)
    const seed = vec3(
      hash(instanceIndex.add(1)),
      hash(instanceIndex.add(7919)),
      hash(instanceIndex.add(104729)),
    )
    const base = seed.mul(boxSize)
    const drift = currentFlow(base, this.timeUniform)
      .mul(4.0)
      .add(vec3(0, this.timeUniform.mul(0.06), 0))
    const wrapped = fract(base.add(drift).sub(cameraPosition).div(boxSize))
      .mul(boxSize)
      .sub(half)
    const center = cameraPosition.add(wrapped)
    const size = hash(instanceIndex.add(31)).mul(0.5).add(0.5).mul(0.02)

    material.positionNode = center.add(positionGeometry.mul(size))

    const camDist = wrapped.length()
    const fade = smoothstep(half.mul(0.95), half.mul(0.45), camDist)
    const depthGlow = exp(center.y.mul(0.04)).min(1)
    // Node materials blend via opacityNode — color alpha alone is ignored.
    material.colorNode = vec4(vec3(0.7, 0.82, 0.84).mul(0.5).mul(depthGlow), 1.0)
    material.opacityNode = fade.mul(this.submerged)

    const mesh = new InstancedMesh(new TetrahedronGeometry(1, 0), material, count)
    mesh.frustumCulled = false
    mesh.visible = false
    markMainDetail(mesh)
    ctx.scene.add(mesh)
    this.particulates = mesh
  }

  update(ctx: GameContext): void {
    this.timeUniform.value = ctx.time.elapsed
    // Always project: caustics stay visible through the surface from above.
    this.caustics?.update(ctx.renderer)
  }

  lateUpdate(ctx: GameContext): void {
    // Hard gate, locked to the true wave-displaced waterline: crossing the
    // surface swaps worlds in the same rendered frame. This runs after every
    // player/ride camera owner; the shader graph and binary uniform are
    // deliberately unchanged.
    const below = ctx.camera.position.y < this.sea.surfaceHeightAtCamera
    this.submerged.value = below ? 1 : 0
    if (this.particulates) this.particulates.visible = below
  }

  dispose(ctx: GameContext): void {
    if (this.particulates) ctx.scene.remove(this.particulates)
    this.caustics?.dispose()
    this.caustics = null
  }
}
