import { Vector3 } from 'three'
import type { HeldItemSystem } from '../player/heldItems'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { SeaMediumSystem } from '../sea/medium'
import type { DistrictServices } from '../world/districts/atrium'
import { PhysicsToys } from './physicsToys'
import { SmallWonders } from './smallWonders'
import type { ArmThrow, ThrowRequest } from './types'
import { WishingWell } from './wishingWell'

/** S13 composition root and the one owner of click-to-throw handoffs. */
export class GamesSystem implements GameSystem {
  readonly id = 'games-and-wonders'

  private readonly held: HeldItemSystem | null
  private readonly toys: PhysicsToys
  private readonly wonders: SmallWonders
  private readonly well: WishingWell
  private activeThrow: ThrowRequest | null = null
  private ctx: GameContext | null = null
  private debugCanvas: HTMLCanvasElement | null = null
  private readonly direction = new Vector3()
  private readonly origin = new Vector3()
  private pointerListener: ((event: PointerEvent) => void) | null = null

  constructor(services: DistrictServices, medium: SeaMediumSystem, held: HeldItemSystem | null) {
    this.held = held
    const armThrow: ArmThrow = (request) => this.arm(request)
    this.toys = new PhysicsToys(services, armThrow)
    this.wonders = new SmallWonders(services, held)
    this.well = new WishingWell(services, medium, armThrow)
  }

  init(ctx: GameContext): void {
    this.ctx = ctx
    if (ctx.flags.debug) this.debugCanvas = ctx.renderer.domElement
    this.toys.init(ctx)
    this.wonders.init(ctx)
    this.well.init(ctx)
    this.pointerListener = (event) => {
      if (event.button !== 0) return
      this.releaseThrow()
    }
    window.addEventListener('pointerdown', this.pointerListener)
  }

  private arm(request: ThrowRequest): void {
    if (!this.held) return
    this.activeThrow = { ...request, remaining: Math.max(1, request.remaining) }
    this.held.hold(request.kind)
  }

  private releaseThrow(): void {
    const request = this.activeThrow
    const ctx = this.ctx
    if (!request || !ctx) return
    ctx.camera.getWorldDirection(this.direction).normalize()
    this.origin
      .copy(ctx.camera.position)
      .addScaledVector(this.direction, 0.62)
      .add(new Vector3(0, -0.22, 0))
    request.spawn(this.origin.clone(), this.direction.clone())
    request.remaining--
    if (request.remaining <= 0) {
      this.activeThrow = null
      this.held?.hold('ticket')
    } else {
      this.held?.hold(request.kind)
    }
  }

  fixedUpdate(ctx: GameContext, dt: number): void {
    this.toys.fixedUpdate(ctx, dt)
    this.well.fixedUpdate(ctx, dt)
  }

  update(ctx: GameContext, dt: number): void {
    this.toys.update()
    this.wonders.update(ctx, dt)
    this.well.update(ctx, dt)
    if (this.debugCanvas && ctx.time.frame % 60 === 0) {
      this.debugCanvas.dataset.gamesState = JSON.stringify(this.debugSnapshot())
    }
  }

  dispose(ctx: GameContext): void {
    if (this.pointerListener) window.removeEventListener('pointerdown', this.pointerListener)
    this.toys.dispose(ctx)
    this.wonders.dispose(ctx)
    this.well.dispose(ctx)
    if (this.debugCanvas) delete this.debugCanvas.dataset.gamesState
  }

  debugSnapshot(): object {
    return {
      armed: this.activeThrow
        ? { kind: this.activeThrow.kind, remaining: this.activeThrow.remaining }
        : null,
      toys: this.toys.debugSnapshot(),
      wonders: this.wonders.debugSnapshot(),
      well: this.well.debugSnapshot(),
      held: this.held
        ? { item: this.held.currentItem, stamps: this.held.stampCount, pennies: this.held.pennyCount }
        : null,
    }
  }
}
