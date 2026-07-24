import {
  Color,
  DepthTexture,
  LinearFilter,
  LinearSRGBColorSpace,
  NearestFilter,
  PerspectiveCamera,
  Plane,
  RenderTarget,
  Vector2,
  Vector3,
  Vector4,
  WebGPUCoordinateSystem,
} from 'three'
import type { RenderTargetOptions } from 'three'
import type { Node, PassNode } from 'three/webgpu'
import { texture, uniform } from 'three/tsl'
import { WATER_REFLECTION_LAYER } from '../render/layers'
import type { GameContext } from '../runtime/context'

/** Stand-in until the first frame builds a scene-pass-matched target. */
const _placeholder = new RenderTarget(1, 1)

/**
 * Above-water reflections from a mirrored camera, not a screen-space trace.
 *
 * The deleted trace projected each reflected ray direction and required its
 * vanishing point to land inside the frustum — a purely angular test between
 * the ray and where the camera happened to point. Standing still and pitching
 * down past roughly 20° put every reflected direction outside the view cone,
 * so the pavilion's reflection simply switched off. A mirrored render has no
 * such test: its frustum is the mirror image of the main one, so it covers
 * exactly what the water can show and nothing more, whatever the head does.
 *
 * Only registered surface-breaking objects render (WATER_REFLECTION_LAYER) —
 * the analytic sky remains the reflection base, so the dome stays out and its
 * HDR sun disc cannot be double-counted against the surface's own GGX glint.
 * An oblique near plane on the mirrored projection clips everything below the
 * mean waterline, which is what stops the submerged park from appearing as a
 * floating city in the reflection.
 */

const TARGET_SCALE = 0.5
const TARGET_MAX_EDGE = 1440
/** Keep the pass armed slightly past the crossing so it never blinks off. */
const SUBMERGED_MARGIN = 1.5

const MIRROR_NORMAL = new Vector3(0, 1, 0)
const REFLECTION_PLANE = new Plane(MIRROR_NORMAL.clone(), 0)
const CLIP_PLANE = new Vector4()
const OBLIQUE_Q = new Vector4()
const LOOK_TARGET = new Vector3()
const MIRRORED_UP = new Vector3()
const SOURCE_POSITION = new Vector3()

export interface OceanReflectionNodes {
  color: { sample: (uv: Node<'vec2'>) => Node<'vec4'> }
  /** 0 while the pass is skipped, so the ocean falls back to the analytic sky. */
  active: Node<'float'>
}

export class OceanReflectionPass {
  readonly nodes: OceanReflectionNodes

  private target: RenderTarget | null = null
  private readonly camera = new PerspectiveCamera()
  private readonly activeUniform = uniform(0)
  private readonly colorNode = texture(_placeholder.texture)
  private readonly size = new Vector2()
  private readonly clearColor = new Color()
  private warmed = false

  constructor() {
    this.camera.layers.set(WATER_REFLECTION_LAYER)
    this.nodes = {
      color: this.colorNode,
      active: this.activeUniform,
    }
  }

  update(ctx: GameContext, surfaceHeightAtCamera: number, scenePass: PassNode | null): void {
    if (!scenePass) return
    const source = ctx.camera
    const active = source.getWorldPosition(SOURCE_POSITION).y >
      surfaceHeightAtCamera - SUBMERGED_MARGIN
    this.activeUniform.value = active ? 1 : 0
    if (!active && this.warmed) return

    const target = this.syncTarget(ctx.renderer, scenePass)
    this.mirrorCamera(source)

    const renderer = ctx.renderer
    const previousTarget = renderer.getRenderTarget()
    const previousMrt = renderer.getMRT()
    const previousAlpha = renderer.getClearAlpha()
    renderer.getClearColor(this.clearColor)
    renderer.setRenderTarget(target)
    // The scene pass's MRT, NOT null. A node builder state is cached per
    // material WITHOUT the MRT in its key, so rendering the park's own
    // materials here under a different output layout would hand the main pass
    // a shader whose fragment struct no longer matches its attachments —
    // observed as "structures must have at least one member" and a dropped
    // draw. `InterfaceStructureLayer` sidesteps the same trap by cloning its
    // materials; this pass uses the originals, so it must match instead.
    renderer.setMRT(scenePass.getMRT())
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    void renderer.render(ctx.scene, this.camera)
    renderer.setRenderTarget(previousTarget)
    renderer.setMRT(previousMrt)
    renderer.setClearColor(this.clearColor, previousAlpha)
    this.warmed = true
  }

  dispose(): void {
    this.target?.dispose()
    this.target = null
  }

  /**
   * Build (or resize) a target whose colour type, format, attachment count and
   * sample count all match the scene pass, so both the node builder states and
   * the render pipelines are shared rather than duplicated.
   */
  private syncTarget(renderer: GameContext['renderer'], scenePass: PassNode): RenderTarget {
    renderer.getSize(this.size)
    const scale = Math.min(
      TARGET_SCALE,
      TARGET_MAX_EDGE / Math.max(1, this.size.x, this.size.y),
    )
    const width = Math.max(1, Math.round(this.size.x * scale))
    const height = Math.max(1, Math.round(this.size.y * scale))

    if (this.target === null) {
      const source = scenePass.renderTarget
      const depthTexture = new DepthTexture(width, height)
      depthTexture.type = source.depthTexture?.type ?? depthTexture.type
      depthTexture.minFilter = NearestFilter
      depthTexture.magFilter = NearestFilter
      this.target = new RenderTarget(width, height, {
        type: source.texture.type,
        format: source.texture.format as RenderTargetOptions['format'],
        count: source.textures.length,
        samples: source.samples,
        depthBuffer: true,
        depthTexture,
      })
      // MANDATORY. `MRTNode.setup` resolves each output NAME against the bound
      // target's texture names and silently skips misses, so unnamed
      // attachments yield an EMPTY fragment struct and WGSL rejects the shader
      // ("structures must have at least one member"). Copy the scene pass's
      // names rather than hard-coding them.
      for (let i = 0; i < this.target.textures.length; i++) {
        this.target.textures[i].name = source.textures[i]?.name ?? ''
      }
      this.target.texture.colorSpace = LinearSRGBColorSpace
      this.target.texture.minFilter = LinearFilter
      this.target.texture.magFilter = LinearFilter
      this.target.texture.generateMipmaps = false
      this.colorNode.value = this.target.texture
    } else if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height)
    }
    return this.target
  }

  /**
   * Mirror the source camera across y = 0 and replace the projection's near
   * plane with the water plane itself (Lengyel's oblique frustum), so nothing
   * below the surface can enter the reflection.
   */
  private mirrorCamera(source: PerspectiveCamera): void {
    const mirrored = this.camera
    // Everything comes from matrixWorld (getWorldDirection refreshes it), so
    // the mirror stays correct if the camera is ever parented to a ride rig
    // instead of driven in world space as it is today.
    source.getWorldDirection(LOOK_TARGET)
    SOURCE_POSITION.setFromMatrixPosition(source.matrixWorld)
    LOOK_TARGET.add(SOURCE_POSITION)
    const basis = source.matrixWorld.elements
    MIRRORED_UP.set(basis[4], basis[5], basis[6])

    mirrored.position.set(SOURCE_POSITION.x, -SOURCE_POSITION.y, SOURCE_POSITION.z)
    LOOK_TARGET.set(LOOK_TARGET.x, -LOOK_TARGET.y, LOOK_TARGET.z)
    mirrored.up.set(MIRRORED_UP.x, -MIRRORED_UP.y, MIRRORED_UP.z)
    mirrored.lookAt(LOOK_TARGET)

    mirrored.near = source.near
    mirrored.far = source.far
    mirrored.fov = source.fov
    mirrored.aspect = source.aspect
    mirrored.coordinateSystem = source.coordinateSystem
    mirrored.updateMatrixWorld(true)
    mirrored.projectionMatrix.copy(source.projectionMatrix)

    REFLECTION_PLANE.normal.copy(MIRROR_NORMAL)
    REFLECTION_PLANE.constant = 0
    REFLECTION_PLANE.applyMatrix4(mirrored.matrixWorldInverse)
    CLIP_PLANE.set(
      REFLECTION_PLANE.normal.x,
      REFLECTION_PLANE.normal.y,
      REFLECTION_PLANE.normal.z,
      REFLECTION_PLANE.constant,
    )

    const projection = mirrored.projectionMatrix
    OBLIQUE_Q.x = (Math.sign(CLIP_PLANE.x) + projection.elements[8]) / projection.elements[0]
    OBLIQUE_Q.y = (Math.sign(CLIP_PLANE.y) + projection.elements[9]) / projection.elements[5]
    OBLIQUE_Q.z = -1
    OBLIQUE_Q.w = (1 + projection.elements[10]) / projection.elements[14]
    CLIP_PLANE.multiplyScalar(1 / CLIP_PLANE.dot(OBLIQUE_Q))

    projection.elements[2] = CLIP_PLANE.x
    projection.elements[6] = CLIP_PLANE.y
    projection.elements[10] =
      mirrored.coordinateSystem === WebGPUCoordinateSystem ? CLIP_PLANE.z : CLIP_PLANE.z + 1
    projection.elements[14] = CLIP_PLANE.w
    mirrored.projectionMatrixInverse.copy(projection).invert()
  }

}
