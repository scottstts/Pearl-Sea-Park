import { Mesh, PlaneGeometry } from 'three'
import { uniform, viewportTexture } from 'three/tsl'
import { registerBookmark } from '../core/debug'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { runFftSelfTest } from './fftCompute'
import { createOceanSurfaceMaterial } from './oceanSurfaceMaterial'
import { createOceanSkirtGeometry, OCEAN_INNER_HALF_SIZE } from './oceanSkirtGeometry'
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
  private inner: Mesh | null = null
  private outer: Mesh | null = null
  private probe: WaterlineProbe | null = null
  private readonly timeUniform = uniform(0)
  private submerged = false
  private followStep = 1

  init(ctx: GameContext): void {
    const sim = new WaveSim(ctx.rng)
    this.sim = sim
    this.probe = new WaterlineProbe(sim)
    this.probe.initialize(ctx.renderer)

    const segments = [256, 384, 448][ctx.quality.tier] ?? 384
    this.followStep = INNER_SIZE / segments

    const timeNode = this.timeUniform as unknown as import('three/webgpu').Node<'float'>
    const submergedNode = this.probe.visualSubmergedNode
    // Both ocean sheets sample one framebuffer copy. A shared base
    // ViewportTextureNode makes its per-surface samples resolve to the same
    // render-scoped texture instead of copying the 4 MP HDR target twice.
    const sceneBackdrop = viewportTexture()
    const innerGeometry = new PlaneGeometry(INNER_SIZE, INNER_SIZE, segments, segments)
    innerGeometry.rotateX(-Math.PI / 2)
    const inner = new Mesh(
      innerGeometry,
      createOceanSurfaceMaterial(sim, timeNode, {
        detailed: true,
        edgeFadeHalfSize: INNER_SIZE / 2,
        sceneBackdrop,
        submerged: submergedNode,
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
        sceneBackdrop,
        submerged: submergedNode,
      }),
    )
    outer.frustumCulled = false
    // The skirt goes first so the detailed sheet's backdrop is never replaced
    // by a previous draw over the central refraction region.
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

  dispose(ctx: GameContext): void {
    if (this.inner) ctx.scene.remove(this.inner)
    if (this.outer) ctx.scene.remove(this.outer)
    this.probe?.dispose()
    this.probe = null
  }
}
