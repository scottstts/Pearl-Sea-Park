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
// Target refresh cadence. At 30 frames the target lagged half a second behind
// a view change on top of the adaptation time constant — the "look back up
// and it stays dark for a while" complaint. The readback is a 9 KB async map
// of a 64×36 byte target; 12 frames is still far from any stall.
const READ_INTERVAL = 12
const LOG_MIN = -12
const LOG_RANGE = 16

// ── Adaptation response shaping ─────────────────────────────────────────────
// The meter must read as gentle eye adaptation, not an auto-iris. Two past
// defects define the tuning:
//  · Looking DOWN at caustic-lit sand filled the meter with bright pixels and
//    keyEV crushed the whole scene ("much darker"), then recovery crawled.
//  · On the Torrent, void-dominated frames (the precipice, the vertical dive)
//    pushed keyEV to the old +1.8 clamp — the visible sand wall blew out to
//    white while ripple shading stayed dark: "extreme contrast" seabed.
// RESPONSE_GAIN compresses the swing in both directions around the authored
// EV 0 (bright scenes stay a touch bright, dark scenes stay dark — the fixed
// golden-afternoon grade owns the look, the meter only breathes around it),
// and the clamp ceiling drops so an abyss view can never over-brighten what
// little bright content it contains. The floor stays at −2.5: above-water
// frames legitimately meter ~4 EV hotter and were fine.
const RESPONSE_GAIN = 0.6
const TARGET_EV_MIN = -2.5
const TARGET_EV_MAX = 0.75
// Highlight guard: place the weighted 98th-percentile pixel no higher than
// ~1.9 + 0.35 EV over mid grey. 99.5 % missed small-but-important bright
// regions (a sand wall beside the void) entirely.
const HIGHLIGHT_PERCENTILE = 0.98
const HIGHLIGHT_ANCHOR = 1.9
const HIGHLIGHT_HEADROOM = 0.35
// Per-second smoothing rates. Darkening (light adaptation) stays faster than
// brightening (dark adaptation) — physiology — but recovery doubles so a
// glance at the seabed no longer dims the park for seconds afterwards.
const BRIGHTEN_RATE = 1.4
const DARKEN_RATE = 2.3

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
      .then((pixels) => this.consume(pixels))
      .catch(() => {
        // Some adapters can render the meter but deny asynchronous mapping.
      })
      .finally(() => {
        this.reading = false
      })
  }

  /** Smooth the current EV every frame; readbacks only replace the target. */
  update(dt: number): void {
    if (dt <= 0) return
    const current = Number(gradeParams.exposureEV.value)
    const rate = this.targetEV > current ? BRIGHTEN_RATE : DARKEN_RATE
    const frameDt = Math.min(dt, 0.25)
    gradeParams.exposureEV.value =
      current + (this.targetEV - current) * (1 - Math.exp(-rate * frameDt))
    if (this.debugCanvas) {
      this.debugCanvas.dataset.exposureState = JSON.stringify(this.debugSnapshot())
    }
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

  private consume(pixels: ArrayBufferView): void {
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
    const percentileWeight = totalWeight * HIGHLIGHT_PERCENTILE
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
    const highlightEV = HIGHLIGHT_ANCHOR - this.peakLogLuminance
    this.targetEV = Math.max(
      TARGET_EV_MIN,
      Math.min(
        TARGET_EV_MAX,
        RESPONSE_GAIN * Math.min(keyEV, highlightEV + HIGHLIGHT_HEADROOM),
      ),
    )

    this.readbacks++
  }
}
