import { Mesh, PlaneGeometry } from 'three'
import { uniform } from 'three/tsl'
import { registerBookmark } from '../core/debug'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { RenderPipelineSystem } from '../render/pipeline'
import { CausticsPass } from './caustics'
import { runFftSelfTest } from './fftCompute'
import {
  createOceanSurfaceMaterial,
  oceanOpticsDebugMode,
} from './oceanSurfaceMaterial'
import {
  InterfaceStructureLayer,
  type InterfaceStructureRegistration,
} from './interfaceStructureLayer'
import { OceanReflectionPass } from './oceanReflection'
import { createOceanSkirtGeometry, OCEAN_INNER_HALF_SIZE } from './oceanSkirtGeometry'
import { createSeabedHeightField, type SeabedHeightField } from './seabedRadiance'
import { SurfaceSunShadow } from './surfaceSunShadow'
import { UnderseaRadianceField, type UnderseaBakeHooks } from './underseaRadiance'
import { WakeFoamMap } from './wakeFoamMap'
import { WaterlineProbe } from './waterlineProbe'
import { WaveSim } from './waveSim'

const INNER_SIZE = OCEAN_INNER_HALF_SIZE * 2

/**
 * The sea: spectral wave sim + inner high-density surface + far skirt ring,
 * both camera-following on a vertex-stable grid. Emits waterline crossings.
 * The Silver Ceiling is this same surface seen from below.
 */
export class SeaSystem implements GameSystem {
  readonly id = 'ocean-surface'

  sim: WaveSim | null = null
  /** Persistent vessel wake foam field — vehicles splat, the surface reads. */
  wakeFoam: WakeFoamMap | null = null
  /**
   * The one caustic projector, generated from this system's wave sim and read
   * by the medium, every lit underwater material, and the ocean's own
   * transmitted bottom. Owned here so it exists before the surface material
   * that samples it is built.
   */
  caustics: CausticsPass | null = null
  private inner: Mesh | null = null
  private outer: Mesh | null = null
  private probe: WaterlineProbe | null = null
  private interfaceStructures: InterfaceStructureLayer | null = null
  private reflection: OceanReflectionPass | null = null
  private surfaceShadow: SurfaceSunShadow | null = null
  private seabed: SeabedHeightField | null = null
  private undersea: UnderseaRadianceField | null = null
  private readonly timeUniform = uniform(0)
  private readonly pipeline: RenderPipelineSystem
  private submerged = false
  private followStep = 1

  /**
   * The render pipeline is held only for its scene pass: both the mirrored
   * reflection and the undersea capture must render through its exact MRT, or
   * they hand the main pass node builder states built for a different output
   * layout (the cache key does not carry the MRT).
   */
  constructor(pipeline: RenderPipelineSystem) {
    this.pipeline = pipeline
  }

  init(ctx: GameContext): void {
    const sim = new WaveSim(ctx.rng)
    this.sim = sim
    this.probe = new WaterlineProbe(sim)
    this.probe.initialize(ctx.renderer)

    const segments = [256, 384, 448][ctx.quality.tier] ?? 384
    this.followStep = INNER_SIZE / segments

    const timeNode = this.timeUniform as unknown as import('three/webgpu').Node<'float'>
    const submergedNode = this.probe.visualSubmergedNode
    const debugMode = oceanOpticsDebugMode(ctx.flags.pass)
    this.surfaceShadow = new SurfaceSunShadow()
    this.interfaceStructures = new InterfaceStructureLayer(sim, submergedNode)
    this.reflection = new OceanReflectionPass()
    this.caustics = new CausticsPass(sim, ctx.quality.params.causticsSize)
    // Neither above-water optical source may be a screen-space trace: both
    // reflection and transmission are then gated on whether a ray direction's
    // vanishing point happens to be inside the frustum, which is a pure
    // function of camera pitch. The detailed sheet gets the world-anchored
    // pair; the skirt keeps the far-field palette, which the detailed sheet
    // also converges to.
    this.undersea = new UnderseaRadianceField()
    this.seabed = createSeabedHeightField()
    this.wakeFoam = new WakeFoamMap()
    const innerGeometry = new PlaneGeometry(INNER_SIZE, INNER_SIZE, segments, segments)
    innerGeometry.rotateX(-Math.PI / 2)
    const inner = new Mesh(
      innerGeometry,
      createOceanSurfaceMaterial(sim, timeNode, {
        detailed: true,
        edgeFadeHalfSize: INNER_SIZE / 2,
        interfaceStructures: this.interfaceStructures.nodes,
        reflection: this.reflection.nodes,
        sunShadow: this.surfaceShadow.node,
        submerged: submergedNode,
        undersea: this.undersea.nodes,
        seabedHeight: this.seabed.sampleHeight,
        wakeFoam: this.wakeFoam,
        debugMode,
      }),
    )
    inner.frustumCulled = false
    // Transparent queue only so the material can capture the completed opaque
    // scene for refraction. Draw before normal transparent effects (particles,
    // glass, foam), which must remain able to appear in front of the surface.
    inner.renderOrder = -100
    ctx.scene.add(inner)
    this.inner = inner

    const outer = new Mesh(
      createOceanSkirtGeometry(segments),
      createOceanSurfaceMaterial(sim, timeNode, {
        detailed: false,
        interfaceStructures: this.interfaceStructures.nodes,
        reflection: this.reflection.nodes,
        sunShadow: this.surfaceShadow.node,
        submerged: submergedNode,
        debugMode,
      }),
    )
    outer.frustumCulled = false
    // The skirt goes first so the detailed sheet always draws over it in the
    // overlap band rather than the other way round.
    outer.renderOrder = -101
    ctx.scene.add(outer)
    this.outer = outer

    registerBookmark({
      name: 'ceiling',
      position: [0, -14, 0],
      look: [0, -2, -40],
      note: 'Silver Ceiling + Snell window from below',
    })
    registerBookmark({
      name: 'ocean-seam',
      position: [6, -4, 318],
      look: [6, -6, -40],
      note: 'Grazing underwater regression view across the stitched ocean boundary',
    })

    if (ctx.flags.debug) {
      void runFftSelfTest(ctx.renderer).then(({ maxErrorConstant, maxErrorWave }) => {
        const pass = maxErrorConstant < 1e-3 && maxErrorWave < 1e-3
        console.info(
          `[sea] FFT self-test ${pass ? 'PASS' : 'FAIL'} — constant ${maxErrorConstant.toExponential(2)}, wave ${maxErrorWave.toExponential(2)}`,
        )
      })
    }
  }

  update(ctx: GameContext, dt: number): void {
    if (!this.sim) return
    this.timeUniform.value = ctx.time.elapsed
    this.sim.update(ctx.renderer, ctx.time.elapsed, dt)
    // Always project: caustics stay visible through the surface from above.
    this.caustics?.update(ctx.renderer)
    this.wakeFoam?.update(ctx.renderer, dt, ctx.time.elapsed)

    const step = this.followStep
    const qx = Math.round(ctx.camera.position.x / step) * step
    const qz = Math.round(ctx.camera.position.z / step) * step
    this.inner?.position.set(qx, 0, qz)
    this.outer?.position.set(qx, 0, qz)
  }

  lateUpdate(ctx: GameContext): void {
    // Player and ride systems own the camera later in regular update. Dispatch
    // the visual waterline only now: queue ordering makes its 1×1 state texture
    // visible to the immediately following render with no CPU round trip.
    this.probe?.update(
      ctx.renderer,
      ctx.camera.position.x,
      ctx.camera.position.z,
      ctx.camera.position.y,
    )
    this.interfaceStructures?.update(ctx)
    this.reflection?.update(ctx, this.surfaceHeightAtCamera, this.pipeline.scenePass)

    if (ctx.flags.debug && ctx.time.frame % 60 === 0) {
      ctx.renderer.domElement.dataset.waterInterfaceLayer = JSON.stringify(
        this.interfaceStructures?.debugSnapshot() ?? null,
      )
    }

    // Events/audio still use the asynchronous CPU height. Their latency must
    // never gate the ocean material or whole-frame underwater composite.
    const nowSubmerged = ctx.camera.position.y < this.surfaceHeightAtCamera
    if (nowSubmerged !== this.submerged) {
      this.submerged = nowSubmerged
      ctx.events.emit('sea/waterline-crossed', { submerged: nowSubmerged })
    }
  }

  get isSubmerged(): boolean {
    return this.submerged
  }

  /** True wave-displaced surface height above/below the camera (world m). */
  get surfaceHeightAtCamera(): number {
    return this.probe?.height ?? 0
  }

  /** Same-frame GPU gate shared by the surface and underwater composite. */
  get visualSubmergedNode(): import('three/webgpu').Node<'float'> | null {
    return this.probe?.visualSubmergedNode ?? null
  }

  /** Register a bounded opaque assembly with an observed interface continuity need. */
  registerInterfaceStructure(
    registration: InterfaceStructureRegistration,
  ): () => void {
    if (!this.interfaceStructures) {
      throw new Error('SeaSystem must initialize before interface structures register')
    }
    return this.interfaceStructures.register(registration)
  }

  /**
   * Capture the world-anchored undersea radiance field. Must run once, after
   * every world system has initialized and the static shadow casters are
   * sealed — the park has to be in the field for the water to show it.
   */
  async bakeUnderseaField(
    ctx: GameContext,
    hooks: UnderseaBakeHooks = {},
  ): Promise<void> {
    await this.undersea?.bake(ctx, this.pipeline.scenePass, hooks)
    // The one cast shadow the water itself shows. Same load-time slot, and it
    // must follow the undersea capture, which restores the world's visibility.
    this.surfaceShadow?.bake(ctx)
  }

  dispose(ctx: GameContext): void {
    if (this.inner) ctx.scene.remove(this.inner)
    if (this.outer) ctx.scene.remove(this.outer)
    this.probe?.dispose()
    this.probe = null
    this.wakeFoam?.dispose()
    this.wakeFoam = null
    this.seabed?.dispose()
    this.seabed = null
    this.undersea?.dispose()
    this.undersea = null
    this.caustics?.dispose()
    this.caustics = null
    this.reflection?.dispose()
    this.reflection = null
    this.surfaceShadow?.dispose()
    this.surfaceShadow = null
    this.interfaceStructures?.dispose()
    this.interfaceStructures = null
    delete ctx.renderer.domElement.dataset.waterInterfaceLayer
  }
}
