import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { Vector3 } from 'three'
import type { SeaMediumSystem } from '../sea/medium'
import type { DistrictServices } from '../world/districts/atrium'
import { AmbientLife } from './ambientLife'
import type { AmbientLifeSnapshot } from './ambientLife'
import { FishSchoolSystem } from './fishSchool'
import type { FishSchoolSnapshot } from './fishSchool'
import { WhalePass } from './whale'
import type { WhaleSnapshot } from './whale'

export interface WildlifeSnapshot {
  fish: FishSchoolSnapshot | null
  ambient: AmbientLifeSnapshot
  whale: WhaleSnapshot
  esplanadeEvent: { active: boolean; amount: number; phase: number }
}

/**
 * S12 composition root. The scheduled manta cue owns one shared 45 s
 * Esplanade choreography: the manta crosses high while up to six hero schools flow
 * beneath and split around the guest. Validation view `esplanade` holds the
 * event at its readable middle beat; normal play follows the park clock.
 */
export class WildlifeSystem implements GameSystem {
  readonly id = 'wildlife'

  private readonly medium: SeaMediumSystem
  private readonly ambient: AmbientLife
  private readonly whale: WhalePass
  private fish: FishSchoolSystem | null = null
  private eventActive = false
  private eventStart = 0
  private eventAmount = 0
  private eventPhase = 0
  private debugCanvas: HTMLCanvasElement | null = null
  private attractorRemaining = 0

  constructor(services: DistrictServices, medium: SeaMediumSystem) {
    this.medium = medium
    this.ambient = new AmbientLife(services, medium)
    this.whale = new WhalePass(medium)
  }

  init(ctx: GameContext): void {
    this.fish = new FishSchoolSystem(ctx, this.medium)
    ctx.scene.add(this.fish.group)
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
    ctx.events.on(
      'wildlife/fish-attractor',
      ({ x, y, z, strength, radius, duration }) => {
        this.fish?.setAttractor(new Vector3(x, y, z), strength, radius)
        this.attractorRemaining = Math.max(0, duration)
      },
    )
  }

  update(ctx: GameContext, dt: number): void {
    if (this.attractorRemaining > 0) {
      this.attractorRemaining = Math.max(0, this.attractorRemaining - dt)
      if (this.attractorRemaining === 0) this.fish?.clearAttractor()
    }
    if (ctx.flags.view === 'esplanade') {
      this.eventActive = true
      this.eventAmount = 1
      this.eventPhase = 0.43 + Math.sin(ctx.time.elapsed * 0.08) * 0.035
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

    this.fish?.update(ctx, dt, this.eventAmount, this.eventPhase)
    this.ambient.update(ctx, dt, this.eventAmount, this.eventPhase)
    this.whale.update(ctx)

    if (this.debugCanvas && ctx.time.frame % 60 === 0) {
      this.debugCanvas.dataset.wildlifeState = JSON.stringify(this.debugSnapshot())
    }
  }

  dispose(ctx: GameContext): void {
    if (this.fish) {
      ctx.scene.remove(this.fish.group)
      this.fish.dispose()
    }
    this.ambient.dispose(ctx)
    this.whale.dispose(ctx)
    if (this.debugCanvas) delete this.debugCanvas.dataset.wildlifeState
  }

  debugSnapshot(): WildlifeSnapshot {
    return {
      fish: this.fish?.debugSnapshot() ?? null,
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
