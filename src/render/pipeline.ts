import { AgXToneMapping, NoToneMapping, SRGBColorSpace } from 'three'
import { RenderPipeline } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import {
  Fn,
  If,
  abs,
  dot,
  exp,
  exp2,
  float,
  getViewPosition,
  max,
  mix,
  mrt,
  normalView,
  output,
  pass,
  pow,
  renderOutput,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { getDebugPane } from '../core/debugOverlay'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { dreamGrade, gradeParams } from './grade'
import { ExposureMeter } from './exposureMeter'
import { recommendedPixelRatio } from './renderer'

/**
 * The one owner of the final image (plan §4).
 * Signal order: scene MRT (color/normal/depth, MSAA 4×) → GTAO (half-res,
 * multiplied into HDR) → bloom (HDR, pre-tonemap) → exposure → AgX tonemap +
 * sRGB via renderOutput → dream grade (display-referred).
 *
 * `?pass=` isolation views: ao · bloom · depth · normal · no-post · no-grade.
 * S3 composites (aquatic fog, god rays) splice in between AO and bloom.
 */
export class RenderPipelineSystem implements GameSystem {
  readonly id = 'render-pipeline'
  readonly debugNodes: Record<string, object> = {}

  private pipeline: RenderPipeline | null = null
  private appliedScale = 1
  private basePixelRatio = recommendedPixelRatio()
  private paneWired = false
  private meter: ExposureMeter | null = null
  private context: GameContext | null = null

  /**
   * S3 hook: the medium system replaces this to composite aquatic fog and
   * god rays into the HDR chain. `extras.viewZNode` carries scene depth.
   */
  hdrTransform: (hdrColor: object, extras: { viewZNode: object }) => object = (c) => c

  /**
   * Lens hook, applied after the medium and before bloom: screen-space water
   * on the camera lens (droplets, streaks, the draining film after the camera
   * breaks the surface). `extras.sceneColorNode` is the resolved scene texture
   * for arbitrary-UV refraction sampling.
   */
  lensTransform: (hdrColor: object, extras: { sceneColorNode: object }) => object = (c) => c

  init(ctx: GameContext): void {
    const { renderer, scene, camera, flags } = ctx
    this.context = ctx
    this.paneWired = !flags.debug
    ctx.events.on('render/resized', ({ width, height }) => {
      this.basePixelRatio = recommendedPixelRatio(width, height)
      renderer.setPixelRatio(this.basePixelRatio * ctx.quality.renderScale)
    })

    // The renderer itself NEVER tone-maps: every side render target (caustic
    // tiles, water sims, readbacks) must stay linear HDR. The one and only
    // output transform is the explicit renderOutput() below.
    renderer.toneMapping = NoToneMapping

    const scenePass = pass(scene, camera, { samples: 4 })
    // Alpha is an AO-receiver channel. Lit opaque materials inherit 1; water
    // overrides only this named MRT output to 0. Reusing the normal target's
    // otherwise spare alpha avoids another full-resolution multisampled MRT.
    scenePass.setMRT(mrt({ output, normal: vec4(normalView, 1) }))

    const sceneColor = scenePass.getTextureNode('output')
    const sceneNormal = scenePass.getTextureNode('normal')
    const sceneDepth = scenePass.getTextureNode('depth')

    const aoNode = ao(sceneDepth, sceneNormal, camera)
    aoNode.resolutionScale = 0.5
    const aoTexture = aoNode.getTextureNode()
    const aoResolution = aoNode.resolution as unknown as Node<'vec2'>

    // Three r185 GTAO emits a raw, half-resolution 5x5 magic-square-noise
    // pattern and performs no denoise unless the owner adds one. Reconstruct
    // at full resolution with the exact eight-neighbour ring: depth rejects
    // foreground/background bleeding and normal similarity preserves edges.
    const projectionInverse = uniform(camera.projectionMatrixInverse)
    const filteredAo = Fn(() => {
      const centerUv = uv()
      const centerDepth = sceneDepth.sample(centerUv).r
      const centerView = getViewPosition(centerUv, centerDepth, projectionInverse)
      const centerNormal = sceneNormal.sample(centerUv).rgb.normalize()
      const centerVisibility = aoTexture.sample(centerUv).r
      const texel = vec2(1).div(aoResolution)
      const visibilitySum = float(0).toVar()
      const weightSum = float(0).toVar()
      const offsets = [
        [-1, -1], [0, -1], [1, -1],
        [-1, 0], [1, 0],
        [-1, 1], [0, 1], [1, 1],
      ] as const

      for (const [x, y] of offsets) {
        const sampleUv = centerUv.add(texel.mul(vec2(x, y)))
        const sampleDepth = sceneDepth.sample(sampleUv).r
        const sampleView = getViewPosition(sampleUv, sampleDepth, projectionInverse)
        const sampleNormal = sceneNormal.sample(sampleUv).rgb.normalize()
        const depthWeight = exp(abs(sampleView.z.sub(centerView.z)).div(-0.5))
        const normalWeight = pow(max(dot(centerNormal, sampleNormal), 0), 12)
        const spatialWeight = x !== 0 && y !== 0 ? 0.70710678 : 1
        const weight = depthWeight.mul(normalWeight).mul(spatialWeight)
        visibilitySum.addAssign(aoTexture.sample(sampleUv).r.mul(weight))
        weightSum.addAssign(weight)
      }

      const result = centerVisibility.toVar()
      If(centerDepth.lessThan(0.999999), () => {
        If(weightSum.greaterThan(0.01), () => {
          result.assign(visibilitySum.div(weightSum))
        })
      })
      return result
    })()

    // AO is a contact effect. Fade the reconstructed visibility when its world
    // radius is sub-pixel, then honor the per-material receiver mask. The ocean
    // is reflective/transmissive optics, not indirect diffuse, and explicitly
    // writes zero; applying screen-space cavity shading to it caused the gray
    // fabric field in grazing views.
    const viewZNode = scenePass.getViewZNode()
    const aoDistance = viewZNode.negate()
    const distanceFilteredAo = mix(filteredAo, float(1), smoothstep(60.0, 160.0, aoDistance))
    const aoReceiver = sceneNormal.a.clamp(0, 1)
    const aoAmount = mix(float(1), distanceFilteredAo, aoReceiver)
    const occluded = sceneColor.mul(aoAmount)
    const withMedium = this.hdrTransform(occluded, { viewZNode }) as typeof occluded
    const withLens = this.lensTransform(withMedium, { sceneColorNode: sceneColor }) as typeof occluded
    const bloomNode = bloom(withLens, 0.35, 0.55, 1.0)
    const hdr = withLens.add(bloomNode)
    const meter = new ExposureMeter(renderer, hdr, flags.debug)
    this.meter = meter

    const exposed = hdr.mul(exp2(gradeParams.exposureEV))
    const mapped = renderOutput(exposed, AgXToneMapping, SRGBColorSpace)
    const graded = dreamGrade(mapped)

    let outputNode
    switch (flags.pass) {
      case 'ao':
        outputNode = vec4(vec3(aoTexture.r), 1.0)
        break
      case 'ao-filtered':
        outputNode = vec4(vec3(filteredAo), 1.0)
        break
      case 'ao-applied':
        outputNode = vec4(vec3(aoAmount), 1.0)
        break
      case 'ao-mask':
        outputNode = vec4(vec3(aoReceiver), 1.0)
        break
      case 'bloom':
        outputNode = renderOutput(bloomNode, AgXToneMapping, SRGBColorSpace)
        break
      case 'depth': {
        const linearDepth = scenePass.getLinearDepthNode()
        outputNode = vec4(vec3(linearDepth), 1.0)
        break
      }
      case 'normal':
        outputNode = vec4(sceneNormal.rgb.mul(0.5).add(0.5), 1.0)
        break
      case 'exposure':
        outputNode = vec4(vec3(meter.textureNode.r), 1)
        break
      case 'rays':
        outputNode = renderOutput(
          (this.debugNodes.rays ?? vec4(0)) as typeof sceneColor,
          AgXToneMapping,
          SRGBColorSpace,
        )
        break
      case 'caustics':
        outputNode = renderOutput(
          (this.debugNodes.caustics ?? vec4(0)) as typeof sceneColor,
          AgXToneMapping,
          SRGBColorSpace,
        )
        break
      case 'no-rays':
        outputNode = renderOutput(
          (this.debugNodes['no-rays'] ?? sceneColor) as typeof sceneColor,
          AgXToneMapping,
          SRGBColorSpace,
        )
        break
      case 'no-post':
        outputNode = renderOutput(sceneColor, AgXToneMapping, SRGBColorSpace)
        break
      case 'no-grade':
        outputNode = mapped
        break
      default:
        // Sampling the meter at zero weight keeps its 64×36 RTT in the final
        // graph without changing the image.
        outputNode = graded.add(vec4(vec3(meter.textureNode.r.mul(0)), 0))
    }

    const pipeline = new RenderPipeline(renderer, outputNode)
    // renderOutput() is placed explicitly in the graph above — the pipeline
    // must not apply a second output transform.
    pipeline.outputColorTransform = false
    this.pipeline = pipeline
  }

  /** Bound to GameLoop.renderFrame by main.ts. */
  render(): void {
    void this.pipeline?.render()
    if (this.context) this.meter?.afterRender(this.context)
  }

  update(ctx: GameContext, dt: number): void {
    this.meter?.update(dt)

    // Dynamic resolution: quality breathes render scale; pass targets follow
    // the renderer's drawing-buffer size automatically.
    const target = ctx.quality.renderScale
    if (Math.abs(target - this.appliedScale) > 0.01) {
      this.appliedScale = target
      ctx.renderer.setPixelRatio(this.basePixelRatio * target)
    }

    if (!this.paneWired) {
      const pane = getDebugPane()
      if (pane) {
        this.paneWired = true
        const folder = pane.addFolder({ title: 'grade', expanded: false })
        folder.addBinding(gradeParams.exposureEV, 'value', { min: -3, max: 3, label: 'exposure ev' })
        folder.addBinding(gradeParams.lutIntensity, 'value', { min: 0, max: 1, label: 'lut' })
        folder.addBinding(gradeParams.vignette, 'value', { min: 0, max: 0.4, label: 'vignette' })
      }
    }
  }

  dispose(): void {
    this.pipeline?.dispose()
    this.meter?.dispose()
    this.pipeline = null
    this.meter = null
    this.context = null
  }
}
