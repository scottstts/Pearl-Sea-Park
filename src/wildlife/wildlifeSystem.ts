import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { registerBookmark } from '../core/debug'
import type { SeaMediumSystem } from '../sea/medium'
import type { DistrictServices } from '../world/districts/atrium'
import { AmbientLife } from './ambientLife'
import type { AmbientLifeSnapshot } from './ambientLife'
import { WhalePass } from './whale'
import type { WhaleSnapshot } from './whale'
import { terrainHeight } from '../world/terrain'

export interface WildlifeSnapshot {
  ambient: AmbientLifeSnapshot
  whale: WhaleSnapshot
  esplanadeEvent: { active: boolean; amount: number; phase: number }
}

/**
 * S12 composition root. The scheduled manta cue owns one shared 45 s
 * Esplanade choreography: the manta crosses high above the boulevard.
 * Validation view `esplanade` holds the
 * event at its readable middle beat; normal play follows the park clock.
 */
export class WildlifeSystem implements GameSystem {
  readonly id = 'wildlife'

  private readonly ambient: AmbientLife
  private readonly whale: WhalePass
  private eventActive = false
  private eventStart = 0
  private eventAmount = 0
  private eventPhase = 0
  private debugCanvas: HTMLCanvasElement | null = null

  constructor(services: DistrictServices, medium: SeaMediumSystem) {
    this.ambient = new AmbientLife(services, medium)
    this.whale = new WhalePass(medium)
  }

  init(ctx: GameContext): void {
    this.ambient.init(ctx)
    this.whale.init(ctx)
    if (ctx.flags.debug) this.debugCanvas = ctx.renderer.domElement

    ctx.events.on('schedule/event', ({ name, phase }) => {
      if (name !== 'manta-flyover') return
      if (phase === 'start') {
        this.eventActive = true
        this.eventStart = ctx.time.elapsed
      } else {
        this.eventActive = false
      }
    })
    const mantaGround = terrainHeight(-4, 164)
    registerBookmark({
      name: 'manta',
      position: [-4, mantaGround + 1.75, 164],
      look: [0, mantaGround + 10.5, 143],
      note: 'Postcard 5 — the scheduled manta and its marble-crossing shadow',
    })
  }

  update(ctx: GameContext, dt: number): void {
    if (ctx.flags.view === 'esplanade' || ctx.flags.view === 'manta') {
      this.eventActive = true
      this.eventAmount = 1
      const center = ctx.flags.view === 'manta' ? 0.5 : 0.43
      this.eventPhase = center + Math.sin(ctx.time.elapsed * 0.08) * 0.035
    } else if (this.eventActive) {
      const local = Math.max(0, ctx.time.elapsed - this.eventStart)
      this.eventPhase = Math.min(1, local / 45)
      const fadeIn = Math.min(1, local / 5)
      const fadeOut = Math.min(1, Math.max(0, (45 - local) / 6))
      this.eventAmount = smoothstep(fadeIn) * smoothstep(fadeOut)
    } else {
      this.eventAmount = 0
      this.eventPhase = 0
    }

    this.ambient.update(ctx, dt, this.eventAmount, this.eventPhase)
    this.whale.update(ctx)

    if (this.debugCanvas && ctx.time.frame % 60 === 0) {
      this.debugCanvas.dataset.wildlifeState = JSON.stringify(this.debugSnapshot())
    }
  }

  dispose(ctx: GameContext): void {
    this.ambient.dispose(ctx)
    this.whale.dispose(ctx)
    if (this.debugCanvas) delete this.debugCanvas.dataset.wildlifeState
  }

  debugSnapshot(): WildlifeSnapshot {
    return {
      ambient: this.ambient.debugSnapshot(),
      whale: this.whale.debugSnapshot(),
      esplanadeEvent: {
        active: this.eventActive,
        amount: this.eventAmount,
        phase: this.eventPhase,
      },
    }
  }
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value)
}
