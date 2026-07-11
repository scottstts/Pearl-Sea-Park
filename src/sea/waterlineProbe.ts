import { HalfFloatType, NearestFilter, Vector3 } from 'three'
import { StorageBufferAttribute, StorageTexture } from 'three/webgpu'
import type { ComputeNode, Node, WebGPURenderer } from 'three/webgpu'
import {
  Fn,
  instanceIndex,
  ivec2,
  step,
  storage,
  texture,
  textureLoad,
  textureStore,
  uniform,
  vec4,
} from 'three/tsl'
import type { WaveSim } from './waveSim'

/**
 * The waterline authority: samples the same three displacement cascades the
 * ocean surface renders with — at one world XZ, with fixed-point correction
 * for the horizontal choppy displacement — and reads the true surface height
 * back asynchronously. The FFT swell is metres tall; anything gating on the
 * The same-frame visual state stays on the GPU; the asynchronous height copy
 * exists only for CPU events and gameplay. Nothing uses sea level y = 0 as a
 * substitute for the displaced surface.
 */
export class WaterlineProbe {
  /** Latest CPU surface height; asynchronous and potentially several frames latent. */
  height = 0
  /**
   * Same-frame visual authority. The 1×1 texture is written after the final
   * camera pose and sampled by the ocean/medium in the following render.
   */
  readonly visualSubmergedNode: Node<'float'>

  private readonly probePosition = uniform(new Vector3(0, 0, 0))
  private readonly probe: ComputeNode
  private readonly setAbove: ComputeNode
  private readonly setBelow: ComputeNode
  private readonly buffer: StorageBufferAttribute
  private readonly visualState: StorageTexture
  private reading = false
  private zone: 'uninitialized' | 'above' | 'band' | 'below' = 'uninitialized'

  constructor(sim: WaveSim) {
    this.buffer = new StorageBufferAttribute(1, 4)
    this.visualState = new StorageTexture(1, 1)
    this.visualState.type = HalfFloatType
    this.visualState.minFilter = NearestFilter
    this.visualState.magFilter = NearestFilter
    this.visualState.generateMipmaps = false
    this.visualSubmergedNode = textureLoad(texture(this.visualState), ivec2(0)).x as Node<'float'>
    const patch = sim.patchLengths

    const displacementAt = (xz: Node<'vec2'>): Node<'vec3'> => {
      let sum = sim.displacementNodes[0].sample(xz.div(patch[0])).xyz as Node<'vec3'>
      for (let i = 1; i < sim.displacementNodes.length; i++) {
        sum = sum.add(sim.displacementNodes[i].sample(xz.div(patch[i])).xyz) as Node<'vec3'>
      }
      return sum
    }

    this.probe = Fn(() => {
      // The surface point above the probe XZ originated at xz − D.xz; two
      // fixed-point rounds resolve the choppy horizontal displacement.
      const camera = this.probePosition as unknown as Node<'vec3'>
      const p = camera.xz
      const d0 = displacementAt(p)
      const d1 = displacementAt(p.sub(d0.xz))
      const d2 = displacementAt(p.sub(d1.xz))
      const submerged = step(camera.y, d2.y)
      textureStore(this.visualState, ivec2(0), vec4(submerged, d2.y, 0, 1))
      storage(this.buffer, 'vec4', 1).element(instanceIndex).assign(vec4(d2, 1))
    })().compute(1)

    const knownState = (submerged: number): ComputeNode =>
      Fn(() => {
        textureStore(this.visualState, ivec2(0), vec4(submerged, 0, 0, 1))
      })().compute(1)
    this.setAbove = knownState(0)
    this.setBelow = knownState(1)
  }

  /** Give paused/first-frame renders a deterministic above-water state. */
  initialize(renderer: WebGPURenderer): void {
    renderer.compute(this.setAbove)
    this.zone = 'above'
  }

  /**
   * Dispatch after every camera owner has settled the pose. The GPU texture is
   * current for this frame's render; only the event-oriented CPU height waits
   * on asynchronous mapping.
   */
  update(renderer: WebGPURenderer, x: number, z: number, cameraY: number): void {
    // Outside ±3 m the authored ~0.5 m surface cannot be crossed. Write the
    // guaranteed state once when changing zones, then submit no waterline work
    // while roaming safely deep/above.
    if (cameraY > 3) {
      if (this.zone !== 'above') renderer.compute(this.setAbove)
      this.zone = 'above'
      return
    }
    if (cameraY < -3) {
      if (this.zone !== 'below') renderer.compute(this.setBelow)
      this.zone = 'below'
      return
    }

    this.zone = 'band'
    this.probePosition.value.set(x, cameraY, z)
    renderer.compute(this.probe)
    if (this.reading) return
    this.reading = true
    void renderer
      .getArrayBufferAsync(this.buffer)
      .then((data) => {
        this.height = new Float32Array(data)[1]
      })
      .catch(() => {
        // Async mapping denied (rare adapters): keep the last known height.
      })
      .finally(() => {
        this.reading = false
      })
  }

  dispose(): void {
    this.visualState.dispose()
  }
}
