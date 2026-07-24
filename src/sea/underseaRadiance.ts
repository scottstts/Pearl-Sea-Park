import {
  Color,
  DepthTexture,
  DoubleSide,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  NoBlending,
  OrthographicCamera,
  RedFormat,
  RenderTarget,
  Vector3,
} from 'three'
import type { Material, Mesh, Object3D, RenderTargetOptions } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import type { Node, PassNode } from 'three/webgpu'
import { positionWorld, texture, vec4 } from 'three/tsl'
import { isOpaqueAuxiliaryCapture } from '../materials/glass'
import { MAIN_DETAIL_LAYER } from '../render/layers'
import type { GameContext } from '../runtime/context'
import { causticBakeNeutral } from './caustics'
import { seabedShadowCaptureKeep } from './medium'
import { seabedRippleBakeFlat } from '../world/seabedSurface'

/**
 * The world-anchored undersea radiance field: what an above-water pixel sees
 * THROUGH the surface, indexed by world XZ instead of by screen position.
 *
 * A screen-space refraction trace can only report geometry inside the current
 * frustum, and the refracted direction leaves that frustum under pure camera
 * pitch — air→water bends every ray to within 48.6° of straight down, so at a
 * 55° FOV nothing traces at all near the horizon and the valid set sweeps in
 * as the head tilts. Any radiance only such a trace can supply is therefore
 * frustum-shaped: standing still and looking down grew a band of real seabed
 * out of a flat tint. World XZ has no such failure mode.
 *
 * One orthographic top-down capture of the assembled park at load supplies:
 *   • `radiance` — lit radiance of the topmost underwater surface, as the
 *     opaque scene renders it IN AIR (the ocean applies its own transport),
 *     carrying real sand tone, park structures, flora, and sun shadows.
 *   • `canopyHeight` — the world y of that surface, which is what the water's
 *     landing solve must aim at: a roof at −8 m is not the seabed at −26 m.
 *
 * Two signals are deliberately EXCLUDED from the capture and restored
 * analytically on the water side, because 0.78 m/texel cannot carry them: the
 * sand's ~3 m ripple band (world/seabedSurface.ts) and the live caustic web
 * (sea/caustics.ts). Both are captured at their mean so the water side can
 * restore them as a ratio against that mean without double-counting.
 */

/**
 * Half-extent (m). The park is ±300 and Arrival sits at z = 320; the
 * transmitted transport itself fades out by ~800 m from a 40 m eye.
 */
export const UNDERSEA_FIELD_EXTENT = 800
const RESOLUTION = 2048
/** Metres per texel — the LOD scale every consumer measures against. */
export const UNDERSEA_FIELD_TEXEL = (UNDERSEA_FIELD_EXTENT * 2) / RESOLUTION
/** The radiance capture renders TILES² of these and copies each into place. */
const TILES = 2
const TILE_RESOLUTION = RESOLUTION / TILES
const TILE_ORIGIN = new Vector3()

/** Capture height; `near` puts the clip plane exactly at the mean waterline. */
const CAMERA_Y = 200
/** Deepest captured surface: the abyss floor is −300. */
const FLOOR_Y = -400

/**
 * Where `ctx.camera` sits while the capture runs, which is what the sun's
 * shadow clipmap centres on. Level 2 covers ±252 m at full resolution, so
 * z = 120 puts BOTH the park core and the Arrival pavilion inside it — the two
 * places a player ever stands above water and looks down.
 */
const SHADOW_CENTER_Z = 120

export interface UnderseaFieldNodes {
  /** Lit radiance of the topmost underwater surface at a world XZ. */
  radiance: (worldXZ: Node<'vec2'>, lod: Node<'float'>) => Node<'vec3'>
  /** World y of that surface (always ≤ −0.5). */
  canopyHeight: (worldXZ: Node<'vec2'>) => Node<'float'>
  /** Metres per texel. */
  texelSize: number
}

export interface UnderseaBakeHooks {
  /** Force every cached shadow level to re-render at the capture centre. */
  invalidateShadows?: () => void
}

export class UnderseaRadianceField {
  readonly nodes: UnderseaFieldNodes

  private readonly radianceTarget: RenderTarget
  private readonly canopyTarget: RenderTarget
  private readonly camera: OrthographicCamera
  private readonly canopyMaterial: MeshBasicNodeMaterial
  private readonly savedClearColor = new Color()
  private readonly canopyClearColor = new Color()
  private baked = false

  constructor() {
    this.radianceTarget = new RenderTarget(RESOLUTION, RESOLUTION, {
      type: HalfFloatType,
      depthBuffer: true,
    })
    const radianceTexture = this.radianceTarget.texture
    radianceTexture.colorSpace = LinearSRGBColorSpace
    radianceTexture.magFilter = LinearFilter
    // Snell compression and distance both minify this field hard; without a
    // mip chain the sand tone and every structure edge alias against the moving
    // wave normal, which reads as crawling grain on distant water.
    radianceTexture.minFilter = LinearMipmapLinearFilter
    radianceTexture.generateMipmaps = true

    this.canopyTarget = new RenderTarget(RESOLUTION, RESOLUTION, {
      type: HalfFloatType,
      format: RedFormat,
      depthBuffer: true,
    })
    this.canopyTarget.texture.minFilter = LinearFilter
    this.canopyTarget.texture.magFilter = LinearFilter
    this.canopyTarget.texture.generateMipmaps = false

    const extent = UNDERSEA_FIELD_EXTENT
    this.camera = new OrthographicCamera(
      -extent,
      extent,
      extent,
      -extent,
      CAMERA_Y,
      CAMERA_Y - FLOOR_Y,
    )
    this.camera.position.set(0, CAMERA_Y, 0)
    // Straight down, with the image's +x axis on world +x and its +y axis on
    // world −z. That is the `up` that makes `fieldUv` a plain remap with no
    // flip on either axis, and therefore identical to the seabed height
    // field's — the two are compared per texel, so they must agree exactly.
    //
    // Chain: WebGPU puts NDC y = +1 at the framebuffer top, WGSL samples v = 0
    // at texture row 0, so v = 0 is world z = −extent. `createSeabedHeightField`
    // writes its data row 0 at z = −extent and DataTexture.flipY is false, so
    // its v = 0 is world z = −extent too.
    this.camera.up.set(0, 0, -1)
    this.camera.lookAt(0, 0, 0)
    // Layer 0 (the static world) plus MAIN_DETAIL (static seabed dressing).
    // DYNAMIC_SHADOW_LAYER is excluded on purpose: rides, wildlife, and the
    // submarine must not be frozen into a static field in a load-time pose.
    this.camera.layers.set(0)
    this.camera.layers.enable(MAIN_DETAIL_LAYER)
    this.camera.updateMatrixWorld(true)

    // One override material for the whole capture: the topmost surface's world
    // height falls out of ordinary depth testing, with no depth-buffer readback
    // and no per-source-material pipeline variant.
    this.canopyMaterial = new MeshBasicNodeMaterial()
    this.canopyMaterial.fog = false
    // Whatever is topmost, regardless of winding — a one-sided soffit facing
    // down is still the surface the water's ray stops at.
    this.canopyMaterial.side = DoubleSide
    // MANDATORY, not tidiness. `Renderer.renderObject` OVERWRITES an override
    // material's `transparent` flag from each source material it stands in for
    // (and never restores it), so a single transmissive or alpha-blended
    // source turns this into a blended pipeline. Against a single-channel
    // target that is a hard WebGPU validation failure — "srcFactor is reading
    // alpha but it is missing from fragment output" — and the draw is dropped,
    // punching holes in the height field. NoBlending is tested first in the
    // backend's blend-state derivation, so it short-circuits the whole path.
    this.canopyMaterial.blending = NoBlending
    this.canopyMaterial.colorNode = vec4(positionWorld.y, 0, 0, 1)
    this.canopyClearColor.setRGB(FLOOR_Y, 0, 0)

    const radianceNode = texture(radianceTexture)
    const canopyNode = texture(this.canopyTarget.texture)
    const fieldUv = (worldXZ: Node<'vec2'>): Node<'vec2'> =>
      worldXZ.div(extent * 2).add(0.5) as Node<'vec2'>

    this.nodes = {
      radiance: (worldXZ, lod) =>
        radianceNode.sample(fieldUv(worldXZ)).level(lod).rgb as Node<'vec3'>,
      // The capture's near plane sits at the mean waterline, so every recorded
      // surface is below it; the clamp only guards the field's clamp-to-edge
      // band, where the transport has already handed back to the palette.
      canopyHeight: (worldXZ) =>
        canopyNode.sample(fieldUv(worldXZ)).r.clamp(FLOOR_Y, -0.5) as Node<'float'>,
      texelSize: UNDERSEA_FIELD_TEXEL,
    }
  }

  get isBaked(): boolean {
    return this.baked
  }

  /**
   * Capture the field. Must run after every world system has initialized and
   * the static shadow casters are sealed — the whole point is that the park is
   * IN the field.
   */
  async bake(
    ctx: GameContext,
    scenePass: PassNode | null,
    hooks: UnderseaBakeHooks = {},
  ): Promise<void> {
    const { renderer, scene, camera } = ctx

    // ── Freeze the world into its capturable state ────────────────────────
    const hidden: Object3D[] = []
    scene.traverse((object) => {
      const mesh = object as Mesh
      if (!mesh.isMesh || !mesh.visible || !mesh.material) return
      const materials: Material[] = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]
      // One shared predicate with the mirrored reflection pass: it removes the
      // sky dome, both ocean sheets, particulates, bubble threads, wake
      // sheets, and glass — everything whose contribution to a flat top-down
      // capture would be wrong rather than merely absent.
      if (materials.every(isOpaqueAuxiliaryCapture)) return
      mesh.visible = false
      hidden.push(mesh)
    })

    const cameraPosition = camera.position.clone()
    camera.position.set(0, 0, SHADOW_CENTER_Z)
    camera.updateMatrixWorld(true)
    hooks.invalidateShadows?.()

    seabedRippleBakeFlat.value = 1
    causticBakeNeutral.value = 1
    seabedShadowCaptureKeep.value = 0

    const previousTarget = renderer.getRenderTarget()
    const previousMrt = renderer.getMRT()
    const previousAlpha = renderer.getClearAlpha()
    const previousOverride = scene.overrideMaterial
    renderer.getClearColor(this.savedClearColor)

    try {
      // FRAME-scoped node updates (the shadow clipmap above all) key off the
      // renderer's node frame, which the animation loop has not started
      // advancing yet. Without this tick the invalidated levels would not
      // re-render before the capture reads them.
      const nodeFrame = (
        renderer as unknown as { _nodes?: { nodeFrame?: { update(): void } } }
      )._nodes?.nodeFrame
      nodeFrame?.update()

      // ── Radiance ───────────────────────────────────────────────────────
      const radianceRenderStart = performance.now()
      this.captureRadiance(ctx, scenePass)

      // ── Canopy height ──────────────────────────────────────────────────
      scene.overrideMaterial = this.canopyMaterial
      renderer.setRenderTarget(this.canopyTarget)
      renderer.setMRT(null)
      // Clear below the abyss so an uncovered texel reads as "no bottom"
      // rather than as a bright surface-height path. The terrain reaches
      // ±1400 m, so inside this ±800 m field nothing is actually uncovered.
      renderer.setClearColor(this.canopyClearColor, 1)
      const canopyRenderStart = performance.now()
      renderer.clear()
      renderer.render(scene, this.camera)
      if (ctx.flags.debug) {
        const end = performance.now()
        console.info(
          `[undersea] radiance ${Math.round(canopyRenderStart - radianceRenderStart)}ms, ` +
            `canopy ${Math.round(end - canopyRenderStart)}ms`,
        )
      }
    } finally {
      scene.overrideMaterial = previousOverride
      renderer.setRenderTarget(previousTarget)
      renderer.setMRT(previousMrt)
      renderer.setClearColor(this.savedClearColor, previousAlpha)

      seabedRippleBakeFlat.value = 0
      causticBakeNeutral.value = 0
      seabedShadowCaptureKeep.value = 1

      for (const object of hidden) object.visible = true
      camera.position.copy(cameraPosition)
      camera.updateMatrixWorld(true)
      // The clipmap is still centred on the capture point; hand it back to
      // wherever the player actually is.
      hooks.invalidateShadows?.()
    }

    this.baked = true
  }

  /**
   * Render the radiance capture in tiles through a target that MATCHES THE
   * SCENE PASS's render context exactly — same colour type/format, attachment
   * count, sample count, and MRT.
   *
   * This is not a detail. The WebGPU render-pipeline cache key carries all of
   * those, so a target that differs in any one of them forces a second full
   * set of pipelines for every material in the park. Measured on a mismatched
   * target: 76 s awaiting `compileAsync`, or 14 s of synchronous pipeline
   * building inside `render()`, against a 35 ms render. Matched, the capture
   * builds the very pipelines the warmup was about to build anyway, so the
   * cost is not added to load at all — it is moved a few seconds earlier.
   *
   * Tiling is what keeps that affordable in memory: a 4x multisampled 2048²
   * pair plus depth is roughly 400 MB, while 1024² tiles are ~100 MB, freed as
   * soon as the capture ends. Resolution is unaffected — the persistent field
   * is assembled from the tiles at the full 0.78 m/texel.
   */
  private captureRadiance(ctx: GameContext, scenePass: PassNode | null): void {
    const { renderer, scene } = ctx
    const source = scenePass?.renderTarget
    const capture = new RenderTarget(TILE_RESOLUTION, TILE_RESOLUTION, {
      type: source?.texture.type ?? HalfFloatType,
      format: source?.texture.format as RenderTargetOptions['format'],
      count: source?.textures.length ?? 1,
      samples: source?.samples ?? 0,
      depthBuffer: true,
    })
    if (source?.depthTexture) {
      const depthTexture = new DepthTexture(TILE_RESOLUTION, TILE_RESOLUTION)
      depthTexture.type = source.depthTexture.type
      capture.depthTexture = depthTexture
    }
    // MANDATORY. `MRTNode.setup` resolves each output NAME against the bound
    // render target's texture names and silently skips the ones it cannot
    // find, so an unnamed attachment produces an EMPTY fragment struct and
    // WGSL rejects the shader outright ("structures must have at least one
    // member"). Copy the scene pass's names rather than hard-coding them.
    if (source) {
      for (let i = 0; i < capture.textures.length; i++) {
        capture.textures[i].name = source.textures[i]?.name ?? ''
      }
    }

    const extent = UNDERSEA_FIELD_EXTENT
    const tileExtent = (extent * 2) / TILES
    try {
      renderer.setRenderTarget(capture)
      renderer.setMRT(scenePass?.getMRT() ?? null)
      if (ctx.flags.debug) {
        // Attachment names and sample count are the whole contract with the
        // scene pass; if either drifts, the shader either fails to build or a
        // second pipeline set silently reappears.
        console.info(
          `[undersea] capture [${capture.textures.map((t) => t.name).join('|')}] ` +
            `x${capture.samples} mrt=${renderer.getMRT() !== null}`,
        )
      }
      renderer.setClearColor(0x000000, 1)
      for (let tileZ = 0; tileZ < TILES; tileZ++) {
        for (let tileX = 0; tileX < TILES; tileX++) {
          const x0 = -extent + tileX * tileExtent
          const z0 = -extent + tileZ * tileExtent
          // The camera's x axis is world +x and its y axis is world −z, so the
          // vertical bounds are the negated z range, high end first.
          this.camera.left = x0
          this.camera.right = x0 + tileExtent
          this.camera.top = -z0
          this.camera.bottom = -(z0 + tileExtent)
          this.camera.updateProjectionMatrix()
          renderer.clear()
          renderer.render(scene, this.camera)
          // Row 0 of both the tile and the field is world z = −extent, so the
          // destination origin is a plain scaled offset with no flip.
          TILE_ORIGIN.set(tileX * TILE_RESOLUTION, tileZ * TILE_RESOLUTION, 0)
          renderer.copyTextureToTexture(
            capture.texture,
            this.radianceTarget.texture,
            null,
            TILE_ORIGIN,
          )
        }
      }
    } finally {
      capture.dispose()
    }
  }

  dispose(): void {
    this.radianceTarget.dispose()
    this.canopyTarget.dispose()
    this.canopyMaterial.dispose()
  }
}
