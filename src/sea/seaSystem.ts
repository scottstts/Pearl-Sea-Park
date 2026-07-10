import { BufferAttribute, BufferGeometry, Mesh, PlaneGeometry } from 'three'
import { uniform, viewportTexture } from 'three/tsl'
import { registerBookmark } from '../core/debug'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { runFftSelfTest } from './fftCompute'
import { createOceanSurfaceMaterial } from './oceanSurfaceMaterial'
import { WaterlineProbe } from './waterlineProbe'
import { WaveSim } from './waveSim'

const INNER_SIZE = 700
// The skirt must END inside the sky dome (r 3400) — a wider skirt knifes
// through the dome's triangulation at the horizon as a sawtooth seam.
const OUTER_SIZE = 6400
// The inner mesh fades its fine cascades to zero at its edge, so at the seam
// both surfaces carry identical cascade-0 displacement; the skirt abuts and
// sits a hair lower to cover the crack.
const OUTER_HOLE_HALF = 348
const OUTER_SINK = 0.14

/** Plane with the inner square removed — the far skirt ring. */
function createSkirtGeometry(): BufferGeometry {
  const plane = new PlaneGeometry(OUTER_SIZE, OUTER_SIZE, 48, 48)
  plane.rotateX(-Math.PI / 2)
  const position = plane.getAttribute('position')
  const index = plane.getIndex()!
  const kept: number[] = []
  for (let i = 0; i < index.count; i += 3) {
    let inside = true
    for (let v = 0; v < 3; v++) {
      const vi = index.getX(i + v)
      const x = position.getX(vi)
      const z = position.getZ(vi)
      if (Math.max(Math.abs(x), Math.abs(z)) > OUTER_HOLE_HALF) inside = false
    }
    if (!inside) {
      kept.push(index.getX(i), index.getX(i + 1), index.getX(i + 2))
    }
  }
  plane.setIndex(new BufferAttribute(new Uint32Array(kept), 1))
  return plane
}

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

    const segments = [256, 384, 448][ctx.quality.tier] ?? 384
    this.followStep = INNER_SIZE / segments

    const timeNode = this.timeUniform as unknown as import('three/webgpu').Node<'float'>
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
      createSkirtGeometry(),
      createOceanSurfaceMaterial(sim, timeNode, { detailed: false, sceneBackdrop }),
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
    this.outer?.position.set(qx, -OUTER_SINK, qz)

    // The crossing test uses the true displaced surface at the camera XZ —
    // the swell is metres tall and dunks the camera long before y < 0.
    this.probe?.update(ctx.renderer, ctx.camera.position.x, ctx.camera.position.z)
  }

  lateUpdate(ctx: GameContext): void {
    // Player and ride systems own the camera later in the regular update
    // order. Classify only after they settle the pose rendered this frame.
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

  dispose(ctx: GameContext): void {
    if (this.inner) ctx.scene.remove(this.inner)
    if (this.outer) ctx.scene.remove(this.outer)
  }
}
