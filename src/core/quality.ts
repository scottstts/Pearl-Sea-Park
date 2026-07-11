/**
 * Quality tiers + dynamic resolution (plan §14).
 * Tier picks feature budgets; within a tier, render scale breathes between
 * `renderScaleMin` and 1.0 driven by a smoothed frame-time controller.
 */

export interface QualityParams {
  renderScaleMin: number
  /** One map per cached directional-shadow level, finest to coarsest. */
  shadowMapSizes: readonly number[]
  godraySteps: number
  causticsSize: number
  particulateCount: number
  seagrassDensity: number
  bubbleBudget: number
}

export const TIERS: readonly QualityParams[] = [
  {
    renderScaleMin: 0.82,
    shadowMapSizes: [1024, 512, 512, 512],
    godraySteps: 8,
    causticsSize: 512,
    particulateCount: 8_000,
    seagrassDensity: 0.35,
    bubbleBudget: 800,
  },
  {
    renderScaleMin: 0.88,
    shadowMapSizes: [1024, 1024, 512, 512],
    godraySteps: 14,
    causticsSize: 1024,
    particulateCount: 18_000,
    seagrassDensity: 0.7,
    bubbleBudget: 1_400,
  },
  {
    renderScaleMin: 0.9,
    shadowMapSizes: [1024, 1024, 1024, 512],
    godraySteps: 22,
    causticsSize: 1024,
    particulateCount: 30_000,
    seagrassDensity: 1,
    bubbleBudget: 2_200,
  },
]

const TARGET_MS = 1000 / 60
const RESPONSE_SECONDS = 0.35
const DOWNSCALE_THRESHOLD = TARGET_MS * 1.28
const UPSCALE_THRESHOLD = TARGET_MS * 1.08
const DOWNSCALE_COOLDOWN_MS = 350
const UPSCALE_COOLDOWN_MS = 4_000

export class QualityState {
  tier: number
  renderScale = 1
  private frameEma = TARGET_MS
  private downscaleCooldownUntilMs = 0
  private upscaleCooldownUntilMs = 0

  constructor(initialTier: number, initialRenderScale = 1) {
    this.tier = Math.max(0, Math.min(TIERS.length - 1, initialTier))
    this.renderScale = Math.min(1, Math.max(this.params.renderScaleMin, initialRenderScale))
  }

  get params(): QualityParams {
    return TIERS[this.tier]
  }

  /**
   * Feed measured frame ms; nudges render scale with hysteresis.
   * Returns true when the scale changed enough that targets must resize.
   */
  submitFrame(ms: number, nowMs: number): boolean {
    const sample = Math.min(ms, 100)
    const alpha = 1 - Math.exp(-sample / (RESPONSE_SECONDS * 1000))
    this.frameEma += (sample - this.frameEma) * alpha
    const before = this.renderScale
    if (this.frameEma > DOWNSCALE_THRESHOLD) {
      if (nowMs < this.downscaleCooldownUntilMs) return false
      const pressure = this.frameEma / TARGET_MS
      const step = pressure >= 2.4 ? 0.08 : pressure >= 1.6 ? 0.05 : 0.025
      this.renderScale = Math.max(this.params.renderScaleMin, this.renderScale - step)
    } else if (this.frameEma <= UPSCALE_THRESHOLD) {
      if (nowMs < this.upscaleCooldownUntilMs) return false
      this.renderScale = Math.min(1, this.renderScale + 0.025)
    }
    if (this.renderScale !== before) {
      // Presentation cadence is v-sync quantized. A healthy 60 Hz frame is
      // ~16.7 ms, so recovery must be possible near TARGET_MS rather than
      // requiring an impossible sub-refresh interval. Recovery probes stay
      // deliberately sparse to avoid visible scale oscillation.
      if (this.renderScale < before) {
        this.downscaleCooldownUntilMs = nowMs + DOWNSCALE_COOLDOWN_MS
        this.upscaleCooldownUntilMs = nowMs + UPSCALE_COOLDOWN_MS
      } else {
        this.upscaleCooldownUntilMs = nowMs + UPSCALE_COOLDOWN_MS
      }
      return true
    }
    return false
  }
}
