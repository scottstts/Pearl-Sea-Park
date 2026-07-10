import { Vector2 } from 'three'
import { StorageBufferAttribute } from 'three/webgpu'
import type { ComputeNode, Node, WebGPURenderer } from 'three/webgpu'
import { Fn, instanceIndex, storage, uniform, vec4 } from 'three/tsl'
import type { WaveSim } from './waveSim'

/**
 * The waterline authority: samples the same three displacement cascades the
 * ocean surface renders with — at one world XZ, with fixed-point correction
 * for the horizontal choppy displacement — and reads the true surface height
 * back asynchronously. The FFT swell is metres tall; anything gating on the
 * waterline (underwater medium, crossing events, lens water) must key off
 * this, never off sea level y = 0.
 */
export class WaterlineProbe {
  /** Latest surface height (world m) at the probed XZ; ~1–2 frames latent. */
  height = 0

  private readonly probeXZ = uniform(new Vector2(0, 0))
  private readonly probe: ComputeNode
  private readonly buffer: StorageBufferAttribute
  private reading = false

  constructor(sim: WaveSim) {
    this.buffer = new StorageBufferAttribute(1, 4)
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
      const p = this.probeXZ as unknown as Node<'vec2'>
      const d0 = displacementAt(p)
      const d1 = displacementAt(p.sub(d0.xz))
      const d2 = displacementAt(p.sub(d1.xz))
      storage(this.buffer, 'vec4', 1).element(instanceIndex).assign(vec4(d2, 1))
    })().compute(1)
  }

  /** Dispatch the one-thread probe and (re)arm the asynchronous readback. */
  update(renderer: WebGPURenderer, x: number, z: number): void {
    this.probeXZ.value.set(x, z)
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
}
