import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'

export type HeldItemKind =
  | 'ticket'
  | 'ring'
  | 'pearl'
  | 'coin'
  | 'food-cone'
  | 'ice-cream'
  | 'plush-kraken'
  | 'penny-book'
  | 'park-model'

const REQUIRED_RIDE_STAMPS = [
  'descent-bell',
  'pearl-line',
  'great-wheel',
  'carousel',
  'torrent',
  'grotto',
] as const

/**
 * Guest possessions and progress — state only. The game is a clean
 * first-person POV: no player body, no hand rig, nothing parented to the
 * camera. Rides and games still award and query items (ticket stamps,
 * pressed pennies, prizes); the completion event still fires — the pocket
 * simply isn't rendered.
 */
export class HeldItemSystem implements GameSystem {
  readonly id = 'held-items'

  private readonly ticketStamps = new Set<string>()
  private readonly pressedPennies = new Set<string>()
  private readonly owned = new Set<HeldItemKind>(['ticket'])
  private activeKind: HeldItemKind = 'ticket'
  private hatWorn = false
  private ticketComplete = false

  init(ctx: GameContext): void {
    ctx.events.on('ticket/punched', ({ ride }) => {
      if (this.ticketStamps.has(ride)) return
      this.ticketStamps.add(ride)
      if (
        !this.ticketComplete &&
        REQUIRED_RIDE_STAMPS.every((required) => this.ticketStamps.has(required))
      ) {
        this.ticketComplete = true
        ctx.events.emit('ticket/completed', { stamps: REQUIRED_RIDE_STAMPS.length })
      }
    })
  }

  hold(kind: HeldItemKind): void {
    if (['plush-kraken', 'penny-book', 'park-model'].includes(kind)) this.owned.add(kind)
    this.activeKind = kind
  }

  holdIceCream(): void {
    this.hold('ice-cream')
  }

  wearPaperHat(): void {
    this.hatWorn = true
  }

  addPressedPenny(motif: string): void {
    this.pressedPennies.add(motif)
  }

  get stampCount(): number {
    return this.ticketStamps.size
  }

  get pennyCount(): number {
    return this.pressedPennies.size
  }

  get currentItem(): HeldItemKind {
    return this.activeKind
  }

  get wearsPaperHat(): boolean {
    return this.hatWorn
  }
}
