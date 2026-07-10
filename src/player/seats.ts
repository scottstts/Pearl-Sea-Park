import { Quaternion, Vector3 } from 'three'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { InteractionSystem } from './interact'
import type { PlayerSystem } from './player'

export interface Seat {
  /** Eye position when seated. */
  eye: Vector3
  /** Point the camera settles looking toward. */
  lookAt: Vector3
  /** Where the guest stands when leaving. */
  exit: Vector3
  prompt: string
}

const TRANSITION = 0.9

/**
 * Sitting anywhere (plan §8): smooth authored camera moves in and out, no
 * cuts. Rides reuse this via `enter/leave` with their own seat definitions.
 */
export class SeatSystem implements GameSystem {
  readonly id = 'seats'

  private readonly player: PlayerSystem
  private readonly interaction: InteractionSystem
  private seated: Seat | null = null
  private transition = 0
  private direction: 1 | -1 = 1
  private readonly fromPosition = new Vector3()
  private readonly fromQuaternion = new Quaternion()
  private readonly targetQuaternion = new Quaternion()
  private leaveListener: ((event: KeyboardEvent) => void) | null = null

  constructor(player: PlayerSystem, interaction: InteractionSystem) {
    this.player = player
    this.interaction = interaction
  }

  registerBenchSeat(seat: Seat): () => void {
    return this.interaction.register({
      position: seat.eye.clone().setY(seat.eye.y - 0.4),
      radius: 2.4,
      prompt: seat.prompt,
      onInteract: () => this.enter(seat),
    })
  }

  enter(seat: Seat): void {
    if (this.seated) return
    this.seated = seat
    this.transition = 0
    this.direction = 1
    this.player.controlEnabled = false
  }

  leave(): void {
    if (!this.seated || this.direction === -1) return
    this.direction = -1
    this.transition = 0
  }

  get isSeated(): boolean {
    return this.seated !== null
  }

  init(_ctx: GameContext): void {
    this.leaveListener = (event) => {
      if (!this.seated) return
      if (['KeyE', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(event.code)) {
        this.leave()
      }
    }
    window.addEventListener('keydown', this.leaveListener)
  }

  update(ctx: GameContext, dt: number): void {
    const seat = this.seated
    if (!seat) return
    const camera = ctx.camera

    if (this.transition === 0) {
      this.fromPosition.copy(camera.position)
      this.fromQuaternion.copy(camera.quaternion)
    }
    this.transition = Math.min(1, this.transition + dt / TRANSITION)
    const t = this.transition
    const eased = t * t * (3 - 2 * t)

    if (this.direction === 1) {
      camera.position.lerpVectors(this.fromPosition, seat.eye, eased)
      camera.quaternion.copy(this.fromQuaternion)
      const look = camera.clone()
      look.position.copy(seat.eye)
      look.lookAt(seat.lookAt)
      this.targetQuaternion.copy(look.quaternion)
      camera.quaternion.slerp(this.targetQuaternion, eased)
    } else {
      const standing = seat.exit
        .clone()
        .setY(seat.exit.y + 1.7)
      camera.position.lerpVectors(this.fromPosition, standing, eased)
      if (t >= 1) {
        this.player.placeAt(seat.exit.x, seat.exit.y, seat.exit.z)
        this.player.controlEnabled = true
        this.seated = null
      }
    }
  }

  dispose(): void {
    if (this.leaveListener) window.removeEventListener('keydown', this.leaveListener)
  }
}
