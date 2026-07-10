import { RGBAFormat, UnsignedByteType } from 'three'
import type { Node, WebGPURenderer } from 'three/webgpu'
import {
  clamp,
  length,
  log2,
  luminance,
  max,
  rtt,
  screenUV,
  smoothstep,
  vec2,
  vec4,
} from 'three/tsl'
import type RTTNode from 'three/src/nodes/utils/RTTNode.js'
import type { GameContext } from '../runtime/context'
import { gradeParams } from './grade'

const WIDTH = 64
const HEIGHT = 36
const READ_INTERVAL = 30
const LOG_MIN = -12
const LOG_RANGE = 16

export interface ExposureSnapshot {
  resolution: [number, number]
  weightedLogAverage: number
  peakLogLuminance: number
  targetEV: number
  adaptedEV: number
  readbacks: number
}

/** 64×36 encoded luminance target with asynchronous readback and eye adaptation. */
export class ExposureMeter {
  readonly textureNode: RTTNode

  private readonly renderer: WebGPURenderer
  private reading = false
  private lastReadTime = performance.now()
  private weightedLogAverage = -2.47
  private peakLogLuminance = 0
  private targetEV = 0
  private readbacks = 0
  private debugCanvas: HTMLCanvasElement | null = null

  constructor(renderer: WebGPURenderer, hdrNode: Node<'vec4'>, debug: boolean) {
    this.renderer = renderer
    const logLum = log2(max(luminance(hdrNode.rgb), 1e-5))
    const encoded = clamp(logLum.sub(LOG_MIN).div(LOG_RANGE), 0, 1)
    const centerDistance = length(screenUV.sub(0.5).mul(vec2(1, 1.65)))
    const weight = smoothstep(0.82, 0.12, centerDistance).mul(0.82).add(0.18)
    const highlight = smoothstep(0.25, 1, encoded)
    this.textureNode = rtt(
      vec4(encoded, weight, highlight, 1),
      WIDTH,
      HEIGHT,
      { type: UnsignedByteType, format: RGBAFormat, depthBuffer: false },
    )
    this.textureNode.setName('encodedLuminanceMeter')
    if (debug) this.debugCanvas = renderer.domElement
  }

  afterRender(ctx: GameContext): void {
    if (this.reading || ctx.time.paused || ctx.time.frame % READ_INTERVAL !== 0) return
    const target = this.textureNode.renderTarget
    if (!target) return
    this.reading = true
    void this.renderer
      .readRenderTargetPixelsAsync(target, 0, 0, WIDTH, HEIGHT)
      .then((pixels) => this.consume(pixels, ctx))
      .catch(() => {
        // Some adapters can render the meter but deny asynchronous mapping.
      })
      .finally(() => {
        this.reading = false
      })
  }

  debugSnapshot(): ExposureSnapshot {
    return {
      resolution: [WIDTH, HEIGHT],
      weightedLogAverage: this.weightedLogAverage,
      peakLogLuminance: this.peakLogLuminance,
      targetEV: this.targetEV,
      adaptedEV: Number(gradeParams.exposureEV.value),
      readbacks: this.readbacks,
    }
  }

  dispose(): void {
    this.textureNode.dispose()
    if (this.debugCanvas) delete this.debugCanvas.dataset.exposureState
  }

  private consume(pixels: ArrayBufferView, ctx: GameContext): void {
    const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
    let weightedLog = 0
    let totalWeight = 0
    const histogram = new Float64Array(64)
    for (let offset = 0; offset + 3 < bytes.length; offset += 4) {
      const encoded = bytes[offset] / 255
      const weight = bytes[offset + 1] / 255
      const logLum = LOG_MIN + encoded * LOG_RANGE
      weightedLog += logLum * weight
      totalWeight += weight
      histogram[Math.min(63, Math.floor(encoded * 64))] += weight
    }
    if (totalWeight <= 0) return
    this.weightedLogAverage = weightedLog / totalWeight
    const percentileWeight = totalWeight * 0.995
    let cumulative = 0
    let highlightBin = 63
    for (let bin = 0; bin < histogram.length; bin++) {
      cumulative += histogram[bin]
      if (cumulative >= percentileWeight) {
        highlightBin = bin
        break
      }
    }
    this.peakLogLuminance = LOG_MIN + ((highlightBin + 0.5) / 64) * LOG_RANGE
    const keyEV = Math.log2(0.18) - this.weightedLogAverage
    const highlightEV = 2.25 - this.peakLogLuminance
    this.targetEV = Math.max(-2.5, Math.min(1.8, Math.min(keyEV, highlightEV + 0.55)))

    const now = performance.now()
    const dt = Math.max(0.01, Math.min(1, (now - this.lastReadTime) / 1000))
    this.lastReadTime = now
    const current = Number(gradeParams.exposureEV.value)
    const rate = this.targetEV > current ? 0.72 : 1.75
    gradeParams.exposureEV.value = current + (this.targetEV - current) * (1 - Math.exp(-rate * dt))
    this.readbacks++
    if (this.debugCanvas) {
      this.debugCanvas.dataset.exposureState = JSON.stringify(this.debugSnapshot())
    }
    void ctx
  }
}
