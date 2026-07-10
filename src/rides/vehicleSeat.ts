import { Euler, Object3D, PerspectiveCamera, Quaternion, Vector3 } from 'three'
import type { PlayerSystem } from '../player/player'

const BLEND_IN = 1.2
const BLEND_OUT = 0.9
const LOOK_SENSITIVITY = 0.0023
const PITCH_LIMIT = Math.PI * 0.42

/**
 * Camera rig for moving vehicles (bell, gondola cabins — plan §9 common
 * framework): smooth authored move in, camera locked to the vehicle with
 * seated free-look, smooth move out. No cuts. The player body stays parked
 * at the ride exit the whole time, so control hand-back is seamless.
 */
export class VehicleSeatRig {
  private readonly player: PlayerSystem
  private vehicle: Object3D | null = null
  private readonly localEye = new Vector3()
  private baseYaw = 0

  private phase: 'in' | 'riding' | 'out' = 'in'
  private blend = 1
  private lookYaw = 0
  private lookPitch = 0
  private readonly fromPosition = new Vector3()
  private readonly fromQuaternion = new Quaternion()
  private readonly eyeWorld = new Vector3()
  private readonly targetQuaternion = new Quaternion()
  private readonly seatQuaternion = new Quaternion()
  private readonly scratch = new Object3D()
  private exitTarget: Vector3 | null = null

  /** Rides flip this at docks; requestExit is ignored while it is false. */
  canExit = false
  onExited: (() => void) | null = null

  constructor(player: PlayerSystem) {
    this.player = player
    window.addEventListener('mousemove', (event) => {
      if (!this.vehicle || this.phase === 'out') return
      // Same rule as the walking controller: look only under pointer lock,
      // otherwise stray cursor motion drifts the seat view.
      if (!document.pointerLockElement) return
      this.lookYaw -= event.movementX * LOOK_SENSITIVITY
      this.lookPitch -= event.movementY * LOOK_SENSITIVITY
      this.lookPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.lookPitch))
    })
  }

  get seated(): boolean {
    return this.vehicle !== null
  }

  /** Begin the boarding move toward a vehicle-local eye position. */
  attach(vehicle: Object3D, localEye: Vector3, baseYaw = 0, camera?: PerspectiveCamera): void {
    if (this.vehicle) return
    this.vehicle = vehicle
    this.localEye.copy(localEye)
    this.baseYaw = baseYaw
    this.phase = 'in'
    this.blend = 0
    this.lookYaw = 0
    this.lookPitch = 0
    this.canExit = false
    this.player.controlEnabled = false
    if (camera) {
      this.fromPosition.copy(camera.position)
      this.fromQuaternion.copy(camera.quaternion)
    }
  }

  /** Place the camera in the seat instantly (opening sequence start). */
  attachImmediate(vehicle: Object3D, localEye: Vector3, baseYaw = 0): void {
    this.attach(vehicle, localEye, baseYaw)
    this.phase = 'riding'
    this.blend = 1
  }

  /** Step out toward a standing point; honored only when `canExit`. */
  requestExit(exit: Vector3): void {
    if (!this.vehicle || !this.canExit || this.phase === 'out') return
    this.exitTarget = exit.clone()
    this.phase = 'out'
    this.blend = 0
  }

  /** Drive the camera; call every frame while a guest is aboard. */
  update(camera: PerspectiveCamera, dt: number): void {
    const vehicle = this.vehicle
    if (!vehicle) return

    vehicle.updateMatrixWorld(true)
    this.eyeWorld.copy(this.localEye)
    vehicle.localToWorld(this.eyeWorld)

    // Seat orientation: vehicle attitude × seat facing × free-look.
    vehicle.getWorldQuaternion(this.seatQuaternion)
    this.scratch.quaternion.copy(this.seatQuaternion)
    this.scratch.rotateY(this.baseYaw + this.lookYaw)
    this.scratch.rotateX(this.lookPitch)
    this.targetQuaternion.copy(this.scratch.quaternion)

    if (this.phase === 'in') {
      this.blend = Math.min(1, this.blend + dt / BLEND_IN)
      const t = this.blend
      const eased = t * t * (3 - 2 * t)
      camera.position.lerpVectors(this.fromPosition, this.eyeWorld, eased)
      camera.quaternion.copy(this.fromQuaternion).slerp(this.targetQuaternion, eased)
      if (t >= 1) this.phase = 'riding'
    } else if (this.phase === 'riding') {
      camera.position.copy(this.eyeWorld)
      camera.quaternion.copy(this.targetQuaternion)
    } else if (this.exitTarget) {
      if (this.blend === 0) {
        this.fromPosition.copy(camera.position)
        this.fromQuaternion.copy(camera.quaternion)
      }
      this.blend = Math.min(1, this.blend + dt / BLEND_OUT)
      const t = this.blend
      const eased = t * t * (3 - 2 * t)
      const standing = this.eyeWorld // reuse: standing eye at exit
      standing.set(this.exitTarget.x, this.exitTarget.y + 1.7, this.exitTarget.z)
      camera.position.lerpVectors(this.fromPosition, standing, eased)
      camera.quaternion.copy(this.fromQuaternion)
      if (t >= 1) {
        const exit = this.exitTarget
        const euler = new Euler().setFromQuaternion(camera.quaternion, 'YXZ')
        this.player.setLook(euler.y, euler.x)
        this.player.placeAt(exit.x, exit.y, exit.z)
        this.player.controlEnabled = true
        this.vehicle = null
        this.exitTarget = null
        this.onExited?.()
        this.onExited = null
      }
    }
  }
}
