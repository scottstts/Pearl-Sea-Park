import type { GameContext } from './context'
import type { SystemRegistry } from './registry'

const FIXED_DT = 1 / 60
const MAX_SUBSTEPS = 5

/**
 * Fixed-timestep simulation (60 Hz) with variable-rate rendering.
 * Rendering itself is delegated: the render pipeline system owns
 * `renderFrame` so the loop never grows scene knowledge.
 */
export class GameLoop {
  /** Assigned by the render pipeline; called once per frame after updates. */
  renderFrame: () => void = () => {}
  /** Frame-time consumer (dynamic resolution, stats). */
  onFrameEnd?: (frameMs: number) => void

  private last: number | undefined
  private accumulator = 0
  private renderedWhilePaused = false
  private readonly ctx: GameContext
  private readonly registry: SystemRegistry

  constructor(ctx: GameContext, registry: SystemRegistry) {
    this.ctx = ctx
    this.registry = registry
  }

  start(): void {
    this.ctx.renderer.setAnimationLoop((timeMs: number) => this.tick(timeMs))
  }

  stop(): void {
    this.ctx.renderer.setAnimationLoop(null)
  }

  private tick(timeMs: number): void {
    const frameStart = performance.now()
    const t = timeMs / 1000
    let dt = this.last === undefined ? FIXED_DT : t - this.last
    this.last = t
    // Tab-away clamp: never simulate a giant catch-up.
    dt = Math.min(dt, 0.25)

    const time = this.ctx.time
    if (time.paused) {
      this.accumulator = 0
      if (!this.renderedWhilePaused) {
        this.renderFrame()
        time.frame++
        this.renderedWhilePaused = true
      }
      this.onFrameEnd?.(performance.now() - frameStart)
      return
    }
    this.renderedWhilePaused = false
    if (this.ctx.flags.fixedTime !== null) {
      time.elapsed = this.ctx.flags.fixedTime
      time.sim = this.ctx.flags.fixedTime
      this.accumulator = 0
      this.registry.update(this.ctx, 0, 0)
      this.renderFrame()
      time.frame++
      this.onFrameEnd?.(performance.now() - frameStart)
      return
    }
    time.elapsed += dt
    this.accumulator += dt

    let steps = 0
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.registry.fixedUpdate(this.ctx, FIXED_DT)
      time.sim += FIXED_DT
      this.accumulator -= FIXED_DT
      steps++
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0

    this.registry.update(this.ctx, dt, this.accumulator / FIXED_DT)
    this.renderFrame()
    time.frame++
    this.onFrameEnd?.(performance.now() - frameStart)
  }
}
