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
  godrayResolutionScale: number
  causticsSize: number
  particulateCount: number
  seagrassDensity: number
  boidBudget: number
  bubbleBudget: number
  reflectorResolutionScale: number
}

export const TIERS: readonly QualityParams[] = [
  {
    renderScaleMin: 0.6,
    shadowMapSizes: [1024, 512, 512, 512],
    godraySteps: 8,
    godrayResolutionScale: 0.34,
    causticsSize: 512,
    particulateCount: 8_000,
    seagrassDensity: 0.35,
    boidBudget: 5_000,
    bubbleBudget: 800,
    reflectorResolutionScale: 0.2,
  },
  {
    renderScaleMin: 0.7,
    shadowMapSizes: [1024, 1024, 512, 512],
    godraySteps: 14,
    godrayResolutionScale: 0.42,
    causticsSize: 1024,
    particulateCount: 18_000,
    seagrassDensity: 0.7,
    boidBudget: 10_000,
    bubbleBudget: 1_400,
    reflectorResolutionScale: 0.28,
  },
  {
    renderScaleMin: 0.75,
    shadowMapSizes: [1024, 1024, 1024, 512],
    godraySteps: 22,
    godrayResolutionScale: 0.5,
    causticsSize: 1024,
    particulateCount: 30_000,
    seagrassDensity: 1,
    boidBudget: 15_000,
    bubbleBudget: 2_200,
    reflectorResolutionScale: 0.35,
  },
]

const TARGET_MS = 1000 / 60
const EMA = 0.06

export class QualityState {
  tier: number
  renderScale = 1
  private frameEma = TARGET_MS
  private cooldown = 0

  constructor(initialTier: number) {
    this.tier = Math.max(0, Math.min(TIERS.length - 1, initialTier))
  }

  get params(): QualityParams {
    return TIERS[this.tier]
  }

  /**
   * Feed measured frame ms; nudges render scale with hysteresis.
   * Returns true when the scale changed enough that targets must resize.
   */
  submitFrame(ms: number): boolean {
    this.frameEma += (Math.min(ms, 100) - this.frameEma) * EMA
    if (this.cooldown > 0) {
      this.cooldown--
      return false
    }
    const before = this.renderScale
    if (this.frameEma > TARGET_MS * 1.18) {
      this.renderScale = Math.max(this.params.renderScaleMin, this.renderScale - 0.05)
    } else if (this.frameEma < TARGET_MS * 0.82) {
      this.renderScale = Math.min(1, this.renderScale + 0.025)
    }
    if (this.renderScale !== before) {
      this.cooldown = 45
      return true
    }
    return false
  }
}
