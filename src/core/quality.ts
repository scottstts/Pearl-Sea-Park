/**
 * Quality tiers + dynamic resolution (plan §14).
 * Tier picks feature budgets; within a tier, render scale breathes between
 * `renderScaleMin` and 1.0 driven by a smoothed frame-time controller.
 */

export interface QualityParams {
  renderScaleMin: number
  shadowMapSize: number
  godraySteps: number
  causticsSize: number
  particulateCount: number
  seagrassDensity: number
  boidBudget: number
}

export const TIERS: readonly QualityParams[] = [
  {
    renderScaleMin: 0.6,
    shadowMapSize: 1024,
    godraySteps: 8,
    causticsSize: 512,
    particulateCount: 8_000,
    seagrassDensity: 0.35,
    boidBudget: 5_000,
  },
  {
    renderScaleMin: 0.7,
    shadowMapSize: 2048,
    godraySteps: 14,
    causticsSize: 1024,
    particulateCount: 18_000,
    seagrassDensity: 0.7,
    boidBudget: 10_000,
  },
  {
    renderScaleMin: 0.75,
    shadowMapSize: 2048,
    godraySteps: 22,
    causticsSize: 1024,
    particulateCount: 30_000,
    seagrassDensity: 1,
    boidBudget: 15_000,
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
