import { Vector2 } from 'three'
import { StorageBufferAttribute } from 'three/webgpu'
import type { ComputeNode, Node, WebGPURenderer } from 'three/webgpu'
import { Fn, int, storage, uniform, vec4 } from 'three/tsl'
import type { WaveSim } from './waveSim'

const POINT_COUNT = 3

/**
 * Buoyancy sampling for floating craft: the true displaced surface height at
 * three hull points (bow, stern, beam), resolved on the GPU from the same
 * displacement cascades the ocean renders with — two fixed-point rounds for
 * the choppy horizontal offset, exactly like the waterline probe — and read
 * back asynchronously. This is gameplay CPU data only (a few frames latent
 * is fine for a heave spring); it never touches the waterline probe's
 * same-frame visual state texture.
 */
export class BuoyancyProbe {
  /** Latest displaced-surface heights (world y) per sample point. */
  readonly heights = new Float32Array(POINT_COUNT)

  private readonly points = [
    uniform(new Vector2()),
    uniform(new Vector2()),
    uniform(new Vector2()),
  ]
  private readonly probe: ComputeNode
  private readonly buffer: StorageBufferAttribute
  private reading = false

  constructor(sim: WaveSim) {
    this.buffer = new StorageBufferAttribute(POINT_COUNT, 4)
    const patch = sim.patchLengths

    const displacementAt = (xz: Node<'vec2'>): Node<'vec3'> => {
      let sum = sim.displacementNodes[0].sample(xz.div(patch[0])).xyz as Node<'vec3'>
      for (let i = 1; i < sim.displacementNodes.length; i++) {
        sum = sum.add(sim.displacementNodes[i].sample(xz.div(patch[i])).xyz) as Node<'vec3'>
      }
      return sum
    }

    this.probe = Fn(() => {
      const buf = storage(this.buffer, 'vec4', POINT_COUNT)
      for (let i = 0; i < POINT_COUNT; i++) {
        const p = this.points[i] as unknown as Node<'vec2'>
        const d0 = displacementAt(p)
        const d1 = displacementAt(p.sub(d0.xz))
        const d2 = displacementAt(p.sub(d1.xz))
        buf.element(int(i)).assign(vec4(d2, 1))
      }
    })().compute(1)
  }

  /** Dispatch for this frame's world XZ sample points and poll the readback. */
  update(renderer: WebGPURenderer, samplePoints: readonly [number, number][]): void {
    for (let i = 0; i < POINT_COUNT; i++) {
      this.points[i].value.set(samplePoints[i][0], samplePoints[i][1])
    }
    renderer.compute(this.probe)
    if (this.reading) return
    this.reading = true
    void renderer
      .getArrayBufferAsync(this.buffer)
      .then((data) => {
        const values = new Float32Array(data)
        for (let i = 0; i < POINT_COUNT; i++) this.heights[i] = values[i * 4 + 1]
      })
      .catch(() => {
        // Async mapping denied (rare adapters): keep the last known heights.
      })
      .finally(() => {
        this.reading = false
      })
  }
}
