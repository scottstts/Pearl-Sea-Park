import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'

export interface ScheduleEntry {
  name: string
  /** Seconds between starts. */
  period: number
  /** Seconds into the period when the event fires. */
  offset: number
  /** Seconds the event stays active (phase 'end' fires after). */
  duration: number
}

/**
 * The park timetable (plan §12) — the park breathes on a schedule.
 * Events fire on the bus as `schedule/event` with phase start/end;
 * shows, the whale, the manta flyover, and chimes all subscribe.
 */
export const PARK_SCHEDULE: ScheduleEntry[] = [
  { name: 'chimes', period: 300, offset: 0, duration: 8 },
  { name: 'fountain-show', period: 720, offset: 90, duration: 180 },
  { name: 'manta-flyover', period: 900, offset: 300, duration: 45 },
  { name: 'whale-passage', period: 1200, offset: 600, duration: 90 },
]

export class SchedulerSystem implements GameSystem {
  readonly id = 'scheduler'
  private readonly active = new Set<string>()

  fixedUpdate(ctx: GameContext, _dt: number): void {
    const t = ctx.time.sim
    for (const entry of PARK_SCHEDULE) {
      const local = (t - entry.offset) % entry.period
      const isActive = t >= entry.offset && local >= 0 && local < entry.duration
      const wasActive = this.active.has(entry.name)
      if (isActive && !wasActive) {
        this.active.add(entry.name)
        ctx.events.emit('schedule/event', { name: entry.name, phase: 'start' })
      } else if (!isActive && wasActive) {
        this.active.delete(entry.name)
        ctx.events.emit('schedule/event', { name: entry.name, phase: 'end' })
      }
    }
  }

  isActive(name: string): boolean {
    return this.active.has(name)
  }
}
