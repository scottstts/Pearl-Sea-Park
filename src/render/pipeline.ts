import { AgXToneMapping, NoToneMapping, SRGBColorSpace } from 'three'
import { RenderPipeline } from 'three/webgpu'
import {
  exp2,
  float,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  smoothstep,
  vec3,
  vec4,
} from 'three/tsl'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { getDebugPane } from '../core/debugOverlay'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { dreamGrade, gradeParams } from './grade'

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

  private pipeline: RenderPipeline | null = null
  private appliedScale = 1
  private readonly basePixelRatio = Math.min(window.devicePixelRatio, 2)
  private paneWired = false

  /**
   * S3 hook: the medium system replaces this to composite aquatic fog and
   * god rays into the HDR chain. `extras.viewZNode` carries scene depth.
   */
  hdrTransform: (hdrColor: object, extras: { viewZNode: object }) => object = (c) => c

  init(ctx: GameContext): void {
    const { renderer, scene, camera, flags } = ctx
    this.paneWired = !flags.debug

    // The renderer itself NEVER tone-maps: every side render target (caustic
    // tiles, water sims, readbacks) must stay linear HDR. The one and only
    // output transform is the explicit renderOutput() below.
    renderer.toneMapping = NoToneMapping

    const scenePass = pass(scene, camera, { samples: 4 })
    scenePass.setMRT(mrt({ output, normal: normalView }))

    const sceneColor = scenePass.getTextureNode('output')
    const sceneNormal = scenePass.getTextureNode('normal')
    const sceneDepth = scenePass.getTextureNode('depth')

    const aoNode = ao(sceneDepth, sceneNormal, camera)
    aoNode.resolutionScale = 0.5
    const aoTexture = aoNode.getTextureNode()

    // GTAO writes a RedFormat target — multiply by the scalar, not the vec4.
    // AO is a *contact* effect: past ~100 m the half-res horizon sampling on
    // grazing geometry (ocean waves) turns to dither, so fade it to neutral.
    const viewZNode = scenePass.getViewZNode()
    const aoDistance = viewZNode.negate()
    const aoAmount = mix(aoTexture.r, float(1), smoothstep(60.0, 160.0, aoDistance))
    const occluded = sceneColor.mul(aoAmount)
    const withMedium = this.hdrTransform(occluded, { viewZNode }) as typeof occluded
    const bloomNode = bloom(withMedium, 0.35, 0.55, 1.0)
    const hdr = withMedium.add(bloomNode)

    const exposed = hdr.mul(exp2(gradeParams.exposureEV))
    const mapped = renderOutput(exposed, AgXToneMapping, SRGBColorSpace)
    const graded = dreamGrade(mapped)

    let outputNode
    switch (flags.pass) {
      case 'ao':
        outputNode = vec4(vec3(aoTexture.r), 1.0)
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
      case 'no-post':
        outputNode = renderOutput(sceneColor, AgXToneMapping, SRGBColorSpace)
        break
      case 'no-grade':
        outputNode = mapped
        break
      default:
        outputNode = graded
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
  }

  update(ctx: GameContext): void {
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
        folder.addBinding(gradeParams.vibrance, 'value', { min: 0, max: 0.5, label: 'vibrance' })
        folder.addBinding(gradeParams.vignette, 'value', { min: 0, max: 0.4, label: 'vignette' })
        folder.addBinding(gradeParams.gamma, 'value', { min: 0.8, max: 1.25, label: 'gamma' })
      }
    }
  }

  dispose(): void {
    this.pipeline?.dispose()
    this.pipeline = null
  }
}
