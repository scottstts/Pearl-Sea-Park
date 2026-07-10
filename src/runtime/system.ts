import type { GameContext } from './context'

/**
 * A game system: one self-contained feature module with a lifecycle.
 * The runtime is only an orchestrator — all behavior lives in systems.
 */
export interface GameSystem {
  readonly id: string
  /** One-time setup; may be async (world generation, GPU warmup). */
  init?(ctx: GameContext): void | Promise<void>
  /** Deterministic simulation step at a fixed 60 Hz cadence. */
  fixedUpdate?(ctx: GameContext, dt: number): void
  /** Per rendered frame; `alpha` interpolates between fixed steps. */
  update?(ctx: GameContext, dt: number, alpha: number): void
  /** Per rendered frame after all regular updates, for final camera-dependent state. */
  lateUpdate?(ctx: GameContext, dt: number, alpha: number): void
  dispose?(ctx: GameContext): void
}
