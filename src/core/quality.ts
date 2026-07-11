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
const DOWNSCALE_THRESHOLD = TARGET_MS * 1.28
const UPSCALE_THRESHOLD = TARGET_MS * 1.08
const ISOLATED_HITCH_MS = 50
const SUSTAINED_HITCH_FRAMES = 8
const DOWNSCALE_PRESSURE_SECONDS = 2
const UPSCALE_HEALTHY_SECONDS = 10
const DOWNSCALE_COOLDOWN_MS = 5_000
const UPSCALE_COOLDOWN_MS = 10_000

export interface DynamicResolutionSnapshot {
  frameEmaMs: number
  pressureSeconds: number
  healthySeconds: number
  outlierStreak: number
  scaleChanges: number
}

export class QualityState {
  tier: number
  renderScale = 1
  private frameEma = TARGET_MS
  private pressureSeconds = 0
  private healthySeconds = 0
  private outlierStreak = 0
  private cooldownUntilMs = 0
  private scaleChanges = 0

  constructor(initialTier: number, initialRenderScale = 1) {
    this.tier = Math.max(0, Math.min(TIERS.length - 1, initialTier))
    this.renderScale = Math.min(1, Math.max(this.params.renderScaleMin, initialRenderScale))
  }

  get params(): QualityParams {
    return TIERS[this.tier]
  }

  /**
   * Feed measured frame cadence; resize only under sustained pressure.
   *
   * A render-scale change reallocates the canvas and the pipeline's large
   * MRT/post targets. Treating one long frame as GPU pressure creates a
   * feedback loop: the hitch requests a resize, and the resize creates the
   * next hitch. Isolated >50 ms frames are therefore recorded but ignored by
   * the controller unless they persist for several consecutive frames.
   * Returns true when the scale changed enough that targets must resize.
   */
  submitFrame(ms: number, nowMs: number): boolean {
    const sample = Math.min(Math.max(ms, 1), 100)
    const sampleSeconds = Math.min(sample, ISOLATED_HITCH_MS) / 1000
    const outlier = sample > ISOLATED_HITCH_MS
    this.outlierStreak = outlier ? this.outlierStreak + 1 : 0
    const sustainedOutlier = outlier && this.outlierStreak >= SUSTAINED_HITCH_FRAMES
    const acceptedSample = outlier && !sustainedOutlier ? null : Math.min(sample, ISOLATED_HITCH_MS)

    if (acceptedSample !== null) {
      const alpha = 1 - Math.exp(-sampleSeconds / 0.75)
      this.frameEma += (acceptedSample - this.frameEma) * alpha
    }

    const underPressure = sustainedOutlier || (!outlier && sample > DOWNSCALE_THRESHOLD)
    const healthy = !outlier && sample <= UPSCALE_THRESHOLD
    if (underPressure) {
      this.pressureSeconds += sampleSeconds
      this.healthySeconds = 0
    } else if (healthy) {
      this.healthySeconds += sampleSeconds
      this.pressureSeconds = Math.max(0, this.pressureSeconds - sampleSeconds * 2)
    } else {
      this.pressureSeconds = Math.max(0, this.pressureSeconds - sampleSeconds * 0.5)
      this.healthySeconds = Math.max(0, this.healthySeconds - sampleSeconds)
    }

    if (nowMs < this.cooldownUntilMs) return false
    const before = this.renderScale
    if (this.pressureSeconds >= DOWNSCALE_PRESSURE_SECONDS) {
      const pressure = this.frameEma / TARGET_MS
      const step = pressure >= 1.6 ? 0.05 : 0.025
      this.renderScale = Math.max(this.params.renderScaleMin, this.renderScale - step)
      this.pressureSeconds = 0
      this.healthySeconds = 0
      this.cooldownUntilMs = nowMs + DOWNSCALE_COOLDOWN_MS
    } else if (this.healthySeconds >= UPSCALE_HEALTHY_SECONDS && this.renderScale < 1) {
      this.renderScale = Math.min(1, this.renderScale + 0.025)
      this.pressureSeconds = 0
      this.healthySeconds = 0
      this.cooldownUntilMs = nowMs + UPSCALE_COOLDOWN_MS
    }
    if (this.renderScale !== before) {
      this.scaleChanges++
      return true
    }
    return false
  }

  debugSnapshot(): DynamicResolutionSnapshot {
    return {
      frameEmaMs: this.frameEma,
      pressureSeconds: this.pressureSeconds,
      healthySeconds: this.healthySeconds,
      outlierStreak: this.outlierStreak,
      scaleChanges: this.scaleChanges,
    }
  }
}
