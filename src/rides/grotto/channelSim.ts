import { DataTexture, FloatType, LinearFilter, RedFormat, RGFormat, Vector4 } from 'three'
import { StorageTexture } from 'three/webgpu'
import type { ComputeNode, Node, WebGPURenderer } from 'three/webgpu'
import {
  Fn,
  exp,
  float,
  instanceIndex,
  int,
  ivec2,
  mix,
  texture,
  textureLoad,
  textureStore,
  uint,
  uniformArray,
  vec4,
} from 'three/tsl'

const MAX_IMPULSES = 8
export const CHANNEL_HEAVE_SCALE = 0.42
const BUOYANCY_RESOLUTION = 64

/**
 * Bounded heightfield water (water-optics skill): the grotto channel is the
 * game's one real liquid. State = (height, velocity) ping-ponged between RG
 * storage textures; a static mask holds the channel shape so ripples reflect
 * off the banks. Impulses (bow wake, drips, the drop splash) inject velocity
 * as gaussian bumps — unused slots simply carry zero amplitude.
 */
export class ChannelSim {
  readonly size: number
  readonly minX: number
  readonly minZ: number
  readonly worldWidth: number
  readonly worldDepth: number

  private readonly renderer: WebGPURenderer
  private readonly state: [StorageTexture, StorageTexture]
  private current = 0
  private readonly impulses = uniformArray(
    Array.from({ length: MAX_IMPULSES }, () => new Vector4(0, 0, 1, 0)),
  )
  private pending: Vector4[] = []
  private readonly steps: [ComputeNode | null, ComputeNode | null] = [null, null]
  private readonly clearSteps: ComputeNode[]
  private initialized = false
  private accumulator = 0

  /**
   * A low-resolution CPU mirror of the same masked wave equation supplies
   * four-point boat buoyancy without stalling WebGPU for texture readback.
   * It receives the exact same impulses as the 256² visual simulation.
   */
  private readonly buoyancySize = BUOYANCY_RESOLUTION
  private readonly buoyancyMask: Float32Array
  private readonly buoyancyBase: Float32Array
  private buoyancyHeight = new Float32Array(BUOYANCY_RESOLUTION ** 2)
  private buoyancyVelocity = new Float32Array(BUOYANCY_RESOLUTION ** 2)
  private buoyancyNextHeight = new Float32Array(BUOYANCY_RESOLUTION ** 2)
  private buoyancyNextVelocity = new Float32Array(BUOYANCY_RESOLUTION ** 2)

  constructor(
    renderer: WebGPURenderer,
    size: number,
    bounds: { minX: number; minZ: number; width: number; depth: number },
    maskAt: (x: number, z: number) => number,
    baseHeightAt: (x: number, z: number) => number = () => 0,
  ) {
    this.renderer = renderer
    this.size = size
    this.minX = bounds.minX
    this.minZ = bounds.minZ
    this.worldWidth = bounds.width
    this.worldDepth = bounds.depth

    const make = () => {
      const t = new StorageTexture(size, size)
      t.type = FloatType
      t.format = RGFormat
      t.minFilter = LinearFilter
      t.magFilter = LinearFilter
      t.generateMipmaps = false
      return t
    }
    this.state = [make(), make()]

    const mask = new Float32Array(size * size)
    const baseHeight = new Float32Array(size * size)
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const x = this.minX + ((i + 0.5) / size) * this.worldWidth
        const z = this.minZ + ((j + 0.5) / size) * this.worldDepth
        mask[j * size + i] = maskAt(x, z)
        baseHeight[j * size + i] = baseHeightAt(x, z)
      }
    }
    this.maskTexture = new DataTexture(mask, size, size, RedFormat, FloatType)
    this.maskTexture.needsUpdate = true
    this.baseHeightTexture = new DataTexture(baseHeight, size, size, RedFormat, FloatType)
    this.baseHeightTexture.needsUpdate = true
    this.heightNode = texture(this.state[0])
    this.maskNode = texture(this.maskTexture)
    this.baseHeightNode = texture(this.baseHeightTexture)

    const buoyancyCells = this.buoyancySize ** 2
    this.buoyancyMask = new Float32Array(buoyancyCells)
    this.buoyancyBase = new Float32Array(buoyancyCells)
    for (let j = 0; j < this.buoyancySize; j++) {
      for (let i = 0; i < this.buoyancySize; i++) {
        const x = this.minX + ((i + 0.5) / this.buoyancySize) * this.worldWidth
        const z = this.minZ + ((j + 0.5) / this.buoyancySize) * this.worldDepth
        const index = j * this.buoyancySize + i
        this.buoyancyMask[index] = maskAt(x, z)
        this.buoyancyBase[index] = baseHeightAt(x, z)
      }
    }

    this.clearSteps = this.state.map((target) =>
      Fn(() => {
        const x = int(instanceIndex.bitAnd(size - 1))
        const y = int(instanceIndex.shiftRight(Math.log2(size)))
        textureStore(target, ivec2(x, y), vec4(0, 0, 0, 0)).toWriteOnly()
      })().compute(size * size) as unknown as ComputeNode,
    )
  }

  private readonly maskTexture: DataTexture
  private readonly baseHeightTexture: DataTexture
  /** Stable texture node for materials — repointed after every ping-pong. */
  readonly heightNode: ReturnType<typeof texture>
  readonly maskNode: ReturnType<typeof texture>
  readonly baseHeightNode: ReturnType<typeof texture>

  /** Queue a velocity impulse at world (x, z). */
  addImpulse(x: number, z: number, radius: number, strength: number): void {
    if (this.pending.length >= MAX_IMPULSES) return
    const u = ((x - this.minX) / this.worldWidth) * this.size
    const v = ((z - this.minZ) / this.worldDepth) * this.size
    const cells = Math.max(1, radius / (this.worldWidth / this.size))
    this.pending.push(new Vector4(u, v, cells, strength))
  }

  private buildStep(read: StorageTexture, write: StorageTexture): ComputeNode {
    const size = this.size
    const bits = Math.log2(size)
    const impulses = this.impulses
    const maskTexture = this.maskTexture
    return Fn(() => {
      const x = int(instanceIndex.bitAnd(size - 1))
      const y = int(instanceIndex.shiftRight(bits))
      const here = textureLoad(texture(read), ivec2(x, y))
      const mask = textureLoad(texture(maskTexture), ivec2(x, y)).r

      // The channel never touches the texture edge; power-of-two wrapping
      // keeps the integer indexing branchless while the mask closes the banks.
      const edgeMask = uint(size - 1)
      const xm = int(uint(x.add(size - 1)).bitAnd(edgeMask))
      const xp = int(uint(x.add(1)).bitAnd(edgeMask))
      const ym = int(uint(y.add(size - 1)).bitAnd(edgeMask))
      const yp = int(uint(y.add(1)).bitAnd(edgeMask))
      // Neumann banks: outside-channel neighbours repeat the current height,
      // so wave energy reflects from the rock instead of draining to zero.
      const leftMask = textureLoad(texture(maskTexture), ivec2(xm, y)).r
      const rightMask = textureLoad(texture(maskTexture), ivec2(xp, y)).r
      const southMask = textureLoad(texture(maskTexture), ivec2(x, ym)).r
      const northMask = textureLoad(texture(maskTexture), ivec2(x, yp)).r
      const left = mix(here.r, textureLoad(texture(read), ivec2(xm, y)).r, leftMask)
      const right = mix(here.r, textureLoad(texture(read), ivec2(xp, y)).r, rightMask)
      const south = mix(here.r, textureLoad(texture(read), ivec2(x, ym)).r, southMask)
      const north = mix(here.r, textureLoad(texture(read), ivec2(x, yp)).r, northMask)
      const laplacian = left.add(right).add(south).add(north).sub(here.r.mul(4))

      // Symplectic height/velocity step. For a 2D five-point Laplacian the
      // normalized coupling must remain well below 0.5; 0.018 gives a calm
      // channel-scale propagation speed at 120 Hz.
      let velocity = here.g.add(laplacian.mul(0.018)).mul(0.992)

      const px = float(x)
      const py = float(y)
      for (let k = 0; k < MAX_IMPULSES; k++) {
        const imp = impulses.element(int(k)) as unknown as Node<'vec4'>
        const dx = px.sub(imp.x)
        const dy = py.sub(imp.y)
        const q = dx.mul(dx).add(dy.mul(dy)).div(imp.z.mul(imp.z))
        // Zero-mean Mexican-hat impulse: a crest and compensating trough.
        // Positive Gaussians permanently raise the conserved channel mean.
        const falloff = exp(q.negate()).mul(float(1).sub(q))
        velocity = velocity.add(falloff.mul(imp.w))
      }

      velocity = velocity.clamp(-0.35, 0.35)
      const height = here.r.add(velocity).clamp(-0.55, 0.55).mul(mask)
      textureStore(write, ivec2(x, y), vec4(height, velocity.mul(mask), 0, 0)).toWriteOnly()
    })().compute(size * size) as unknown as ComputeNode
  }

  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true
    this.renderer.compute(this.clearSteps)
  }

  private stepBuoyancy(impulses: readonly Vector4[]): void {
    const n = this.buoyancySize
    const height = this.buoyancyHeight
    const velocity = this.buoyancyVelocity
    const nextHeight = this.buoyancyNextHeight
    const nextVelocity = this.buoyancyNextVelocity
    const mask = this.buoyancyMask
    const gpuToCpu = n / this.size
    const coupling = 0.018 * gpuToCpu * gpuToCpu

    for (let y = 0; y < n; y++) {
      const ym = Math.max(0, y - 1)
      const yp = Math.min(n - 1, y + 1)
      for (let x = 0; x < n; x++) {
        const xm = Math.max(0, x - 1)
        const xp = Math.min(n - 1, x + 1)
        const index = y * n + x
        const h = height[index]
        const neighbour = (nx: number, ny: number) => {
          const ni = ny * n + nx
          return h + (height[ni] - h) * mask[ni]
        }
        const laplacian =
          neighbour(xm, y) + neighbour(xp, y) + neighbour(x, ym) + neighbour(x, yp) - h * 4
        let v = (velocity[index] + laplacian * coupling) * 0.992
        for (const impulse of impulses) {
          const dx = x - impulse.x * gpuToCpu
          const dy = y - impulse.y * gpuToCpu
          // Keep at least 1.25 CPU cells so the zero-mean kernel is resolved;
          // a sub-cell Mexican hat degenerates back into a positive spike.
          const radius = Math.max(1.25, impulse.z * gpuToCpu)
          const q = (dx * dx + dy * dy) / (radius * radius)
          v += Math.exp(-q) * (1 - q) * impulse.w
        }
        v = Math.max(-0.35, Math.min(0.35, v))
        nextVelocity[index] = v * mask[index]
        nextHeight[index] = Math.max(-0.55, Math.min(0.55, h + v)) * mask[index]
      }
    }

    this.buoyancyHeight = nextHeight
    this.buoyancyVelocity = nextVelocity
    this.buoyancyNextHeight = height
    this.buoyancyNextVelocity = velocity
  }

  /** Advance the sim (two 120 Hz substeps per 60 Hz frame). */
  update(dt: number): void {
    this.ensureInitialized()
    this.accumulator = Math.min(this.accumulator + dt, 0.1)
    const step = 1 / 120
    while (this.accumulator >= step) {
      this.accumulator -= step
      // Load queued impulses into the uniform slots (unused = amplitude 0).
      const list = this.pending
      for (let i = 0; i < MAX_IMPULSES; i++) {
        const slot = this.impulses.array[i] as Vector4
        if (i < list.length) slot.copy(list[i])
        else slot.set(0, 0, 1, 0)
      }
      this.pending = []
      this.stepBuoyancy(list)
      let node = this.steps[this.current]
      if (!node) {
        node = this.buildStep(this.state[this.current], this.state[1 - this.current])
        this.steps[this.current] = node
      }
      this.renderer.compute(node)
      this.current = 1 - this.current
      this.heightNode.value = this.state[this.current]
    }
  }

  /** Texture holding (height, velocity) — sample .r for height. */
  get heightTexture(): StorageTexture {
    return this.state[this.current]
  }

  /** Base channel profile + dynamic surface height at a world-space sample. */
  sampleSurfaceOffset(x: number, z: number): number {
    const u = Math.max(0, Math.min(0.999999, (x - this.minX) / this.worldWidth))
    const v = Math.max(0, Math.min(0.999999, (z - this.minZ) / this.worldDepth))
    const fx = u * (this.buoyancySize - 1)
    const fy = v * (this.buoyancySize - 1)
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const x1 = Math.min(this.buoyancySize - 1, x0 + 1)
    const y1 = Math.min(this.buoyancySize - 1, y0 + 1)
    const tx = fx - x0
    const ty = fy - y0
    const sample = (data: Float32Array) => {
      const a = data[y0 * this.buoyancySize + x0]
      const b = data[y0 * this.buoyancySize + x1]
      const c = data[y1 * this.buoyancySize + x0]
      const d = data[y1 * this.buoyancySize + x1]
      return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
    }
    return sample(this.buoyancyBase) + sample(this.buoyancyHeight) * CHANNEL_HEAVE_SCALE
  }

  debugSnapshot(): {
    gpuResolution: number
    buoyancyResolution: number
    maxAbsHeight: number
    maxAbsVelocity: number
  } {
    let maxAbsHeight = 0
    let maxAbsVelocity = 0
    for (let i = 0; i < this.buoyancyHeight.length; i++) {
      maxAbsHeight = Math.max(maxAbsHeight, Math.abs(this.buoyancyHeight[i]))
      maxAbsVelocity = Math.max(maxAbsVelocity, Math.abs(this.buoyancyVelocity[i]))
    }
    return {
      gpuResolution: this.size,
      buoyancyResolution: this.buoyancySize,
      maxAbsHeight,
      maxAbsVelocity,
    }
  }

  dispose(): void {
    this.state[0].dispose()
    this.state[1].dispose()
    this.maskTexture.dispose()
    this.baseHeightTexture.dispose()
  }
}
