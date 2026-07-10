import { DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three'
import { StorageBufferAttribute, StorageTexture } from 'three/webgpu'
import type { ComputeNode, WebGPURenderer } from 'three/webgpu'
import {
  Fn,
  instanceIndex,
  int,
  ivec2,
  storage,
  texture,
  textureLoad,
  textureStore,
  uint,
  vec2,
  vec4,
} from 'three/tsl'

/**
 * Inverse FFT for packed complex fields on WebGPU compute (spectral-ocean
 * reference §5). One texture carries TWO independent complex fields
 * (.xy and .zw) through the same butterfly stages.
 *
 * Submission contract: one stage per renderer.compute() boundary — callers
 * batch the same stage across cascades into one call, never across stages.
 */

function bitReverse(value: number, bits: number): number {
  let reversed = 0
  for (let bit = 0; bit < bits; bit++) {
    reversed = (reversed << 1) | ((value >> bit) & 1)
  }
  return reversed
}

/** Butterfly table: width N × height log2N; [twiddleRe, twiddleIm, indexA, indexB]. */
export function createButterflyTexture(n: number): DataTexture {
  const stages = Math.log2(n)
  const data = new Float32Array(n * stages * 4)
  for (let stage = 0; stage < stages; stage++) {
    const groupSize = 1 << (stage + 1)
    const halfSize = 1 << stage
    for (let i = 0; i < n; i++) {
      const inGroup = i % groupSize
      const top = inGroup < halfSize
      const j = i % halfSize
      // Inverse transform → positive twiddle exponent.
      const angle = (Math.PI * 2 * j) / groupSize
      const sign = top ? 1 : -1
      let indexA: number
      let indexB: number
      if (stage === 0) {
        const pair = i - (i % 2)
        indexA = bitReverse(pair, stages)
        indexB = bitReverse(pair + 1, stages)
      } else {
        const base = top ? i : i - halfSize
        indexA = base
        indexB = base + halfSize
      }
      const out = (stage * n + i) * 4
      data[out] = Math.cos(angle) * sign
      data[out + 1] = Math.sin(angle) * sign
      data[out + 2] = indexA
      data[out + 3] = indexB
    }
  }
  const tex = new DataTexture(data, n, stages, RGBAFormat, FloatType)
  tex.minFilter = NearestFilter
  tex.magFilter = NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

export function createFrequencyTexture(n: number): StorageTexture {
  const tex = new StorageTexture(n, n)
  tex.type = FloatType
  tex.minFilter = NearestFilter
  tex.magFilter = NearestFilter
  tex.generateMipmaps = false
  return tex
}

export class PackedIFFT {
  readonly stages: ComputeNode[] = []
  /** Where the spatial result lives after all stages run (ping-pong parity). */
  readonly output: StorageTexture

  constructor(butterfly: DataTexture, ping: StorageTexture, pong: StorageTexture, n: number) {
    const logN = Math.log2(n)
    const mask = uint(n - 1)
    const shift = uint(logN)

    const makeStage = (source: StorageTexture, dest: StorageTexture, stage: number, horizontal: boolean) =>
      Fn(() => {
        const x = int(instanceIndex.bitAnd(mask))
        const y = int(instanceIndex.shiftRight(shift))
        const line = horizontal ? x : y
        const entry = textureLoad(texture(butterfly), ivec2(line, int(stage)))
        const w = entry.xy
        const indexA = int(entry.z)
        const indexB = int(entry.w)
        const coordA = horizontal ? ivec2(indexA, y) : ivec2(x, indexA)
        const coordB = horizontal ? ivec2(indexB, y) : ivec2(x, indexB)
        const a = textureLoad(texture(source), coordA)
        const b = textureLoad(texture(source), coordB)
        const field1 = a.xy.add(
          vec2(b.x.mul(w.x).sub(b.y.mul(w.y)), b.x.mul(w.y).add(b.y.mul(w.x))),
        )
        const field2 = a.zw.add(
          vec2(b.z.mul(w.x).sub(b.w.mul(w.y)), b.z.mul(w.y).add(b.w.mul(w.x))),
        )
        textureStore(dest, ivec2(x, y), vec4(field1, field2))
      })().compute(n * n)

    // log2N horizontal stages then log2N vertical stages, strict ping-pong.
    let src = ping
    let dst = pong
    for (let stage = 0; stage < logN; stage++) {
      this.stages.push(makeStage(src, dst, stage, true))
      ;[src, dst] = [dst, src]
    }
    for (let stage = 0; stage < logN; stage++) {
      this.stages.push(makeStage(src, dst, stage, false))
      ;[src, dst] = [dst, src]
    }
    this.output = src
  }
}

/**
 * FFT hard gate (reference §6). Test A: DC impulse → constant field.
 * Test B: one-bin X impulse → cos/sin along x. Both must pass before the
 * spectrum is trusted. Centering sign (-1)^(x+y) is applied in comparison,
 * matching its application point in the assembly kernel.
 */
export async function runFftSelfTest(
  renderer: WebGPURenderer,
  n = 64,
): Promise<{ maxErrorConstant: number; maxErrorWave: number }> {
  const butterfly = createButterflyTexture(n)
  const ping = createFrequencyTexture(n)
  const pong = createFrequencyTexture(n)
  const ifft = new PackedIFFT(butterfly, ping, pong, n)

  // Readback goes through a storage buffer — never through a material blit,
  // which would route the data through tone mapping / color-space transforms
  // (AgX clamps negatives to zero and silently corrupts the comparison).
  const readBuffer = new StorageBufferAttribute(new Float32Array(n * n * 4), 4)

  const runCase = async (impulseX: number, impulseY: number): Promise<Float32Array> => {
    const data = new Float32Array(n * n * 4)
    data[(impulseY * n + impulseX) * 4] = 1
    const input = new DataTexture(data, n, n, RGBAFormat, FloatType)
    input.minFilter = NearestFilter
    input.magFilter = NearestFilter
    input.needsUpdate = true

    const mask = uint(n - 1)
    const shift = uint(Math.log2(n))
    const upload = Fn(() => {
      const x = int(instanceIndex.bitAnd(mask))
      const y = int(instanceIndex.shiftRight(shift))
      textureStore(ping, ivec2(x, y), textureLoad(texture(input), ivec2(x, y)))
    })().compute(n * n)
    renderer.compute(upload)
    for (const stage of ifft.stages) renderer.compute(stage)

    const download = Fn(() => {
      const x = int(instanceIndex.bitAnd(mask))
      const y = int(instanceIndex.shiftRight(shift))
      const value = textureLoad(texture(ifft.output), ivec2(x, y))
      storage(readBuffer, 'vec4', n * n).element(instanceIndex).assign(value)
    })().compute(n * n)
    renderer.compute(download)

    const pixels = new Float32Array(await renderer.getArrayBufferAsync(readBuffer))
    input.dispose()
    return pixels
  }

  // Test A: impulse at the centered DC bin.
  const constant = await runCase(n / 2, n / 2)
  let maxErrorConstant = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const sign = (x + y) % 2 === 0 ? 1 : -1
      const re = constant[(y * n + x) * 4] * sign
      const im = constant[(y * n + x) * 4 + 1] * sign
      maxErrorConstant = Math.max(maxErrorConstant, Math.abs(re - 1), Math.abs(im))
    }
  }

  // Test B: one bin above DC on X → complex exponential along x.
  const wave = await runCase(n / 2 + 1, n / 2)
  let maxErrorWave = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const sign = (x + y) % 2 === 0 ? 1 : -1
      const re = wave[(y * n + x) * 4] * sign
      const im = wave[(y * n + x) * 4 + 1] * sign
      const phase = (Math.PI * 2 * x) / n
      maxErrorWave = Math.max(
        maxErrorWave,
        Math.abs(re - Math.cos(phase)),
        Math.abs(im - Math.sin(phase)),
      )
    }
  }

  butterfly.dispose()
  return { maxErrorConstant, maxErrorWave }
}
