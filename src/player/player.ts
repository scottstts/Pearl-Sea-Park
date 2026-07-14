import { Vector3 } from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { PhysicsSystem } from '../physics/physicsWorld'
import { terrainHeight } from '../world/terrain'

const WALK_SPEED = 2.4 // 1.5× the original composed stroll
const BRISK_SPEED = 4.65 // 1.5× the original brisk pace (Shift)
const EYE_HEIGHT = 1.7
const CAPSULE_RADIUS = 0.35
const CAPSULE_HALF = 0.5 // capsule cylinder half-height; total ≈ 1.7 m
const LOOK_SENSITIVITY = 0.0023
const PITCH_LIMIT = Math.PI * 0.485
const SNAP_TO_GROUND = 0.45

// The sea is modelled as air, but a jump reads as a diver's push-off: below
// the waterline gravity is a fraction of the surface value, so a leap drifts
// up and settles slowly. Above the surface (the arrival deck) gravity is
// ordinary — the effective pull follows the medium, not a mode flag.
const AIR_GRAVITY = 9.81
const SWIM_GRAVITY = 2.6
const JUMP_SPEED = 3.15

/** Body-centre height above the feet (`placeAt` y) — capsule half + radius. */
export const PLAYER_CAPSULE_OFFSET = CAPSULE_HALF + CAPSULE_RADIUS

/**
 * First-person guest (plan §8): Rapier kinematic character controller,
 * pointer-lock look, smooth-step stairs, and a buoyant underwater jump.
 * Motion is tuned for composure — a stroll, not a shooter — and the leap is
 * a slow diver's push-off, not a platformer hop.
 */
export class PlayerSystem implements GameSystem {
  readonly id = 'player'

  /** External systems (seats, rides) borrow control by setting this false. */
  controlEnabled = true

  /**
   * A modal freeze (teleport menu / transition) that is deliberately separate
   * from `controlEnabled`: rides and the pause card own `controlEnabled`, so
   * layering another owner on it strands control if a pause captures the
   * borrowed value. `inputFrozen` stops walking and look without that hazard.
   */
  inputFrozen = false

  private readonly physics: PhysicsSystem
  private body: RAPIER.RigidBody | null = null
  private collider: RAPIER.Collider | null = null
  private controller: RAPIER.KinematicCharacterController | null = null

  private yaw = 0 // camera default looks -z = north (toward the park)
  private pitch = 0
  private verticalVelocity = 0
  private jumping = false
  private jumpQueued = false
  private submerged = false // set by the waterline crossing; gates the jump
  private readonly keys = new Set<string>()
  private readonly moveIntent = new Vector3()
  private readonly velocity = new Vector3()
  private bobPhase = 0
  private locked = false

  constructor(physics: PhysicsSystem) {
    this.physics = physics
  }

  init(ctx: GameContext): void {
    const { world, rapier } = this.physics
    if (!world || !rapier) throw new Error('PlayerSystem requires PhysicsSystem')

    const spawnX = 0
    const spawnZ = 130
    const spawnY = terrainHeight(spawnX, spawnZ) + CAPSULE_HALF + CAPSULE_RADIUS + 0.3

    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(spawnX, spawnY, spawnZ),
    )
    this.collider = world.createCollider(
      rapier.ColliderDesc.capsule(CAPSULE_HALF, CAPSULE_RADIUS),
      this.body,
    )
    const controller = world.createCharacterController(0.05)
    controller.enableAutostep(0.45, 0.25, true)
    controller.enableSnapToGround(SNAP_TO_GROUND)
    controller.setMaxSlopeClimbAngle((52 * Math.PI) / 180)
    controller.setMinSlopeSlideAngle((65 * Math.PI) / 180)
    this.controller = controller

    const canvas = ctx.renderer.domElement
    canvas.addEventListener('click', () => {
      if (!this.locked) void canvas.requestPointerLock()
    })
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas
    })
    window.addEventListener('mousemove', (event) => {
      if (!this.locked || !this.controlEnabled || this.inputFrozen) return
      this.yaw -= event.movementX * LOOK_SENSITIVITY
      this.pitch -= event.movementY * LOOK_SENSITIVITY
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch))
    })
    window.addEventListener('keydown', (event) => {
      // Edge-triggered jump: `repeat` filters the OS auto-repeat so a held
      // Space is one launch, not a stutter.
      if (event.code === 'Space' && !event.repeat) this.jumpQueued = true
      this.keys.add(event.code)
    })
    window.addEventListener('keyup', (event) => {
      this.keys.delete(event.code)
    })
    window.addEventListener('blur', () => this.keys.clear())

    // The medium owns "am I in the park": below the waterline the jump arms and
    // gravity softens; above it (the arrival deck) both revert to air.
    ctx.events.on('sea/waterline-crossed', ({ submerged }) => {
      this.submerged = submerged
    })

    ctx.events.on('park/entered', () => void canvas.requestPointerLock())
  }

  fixedUpdate(_ctx: GameContext, dt: number): void {
    const { body, collider, controller } = this
    if (!body || !collider || !controller || !this.physics.world) return
    // Drop any buffered jump while control is borrowed (rides, pause) or
    // frozen (teleport). Otherwise a Space pressed mid-ride would survive
    // the handoff and launch a jump the instant the guest steps off.
    if (!this.controlEnabled || this.inputFrozen) {
      this.jumpQueued = false
      return
    }

    // Desired planar velocity from keys, camera-relative.
    this.moveIntent.set(0, 0, 0)
    if (this.keys.has('KeyW')) this.moveIntent.z -= 1
    if (this.keys.has('KeyS')) this.moveIntent.z += 1
    if (this.keys.has('KeyA')) this.moveIntent.x -= 1
    if (this.keys.has('KeyD')) this.moveIntent.x += 1
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? BRISK_SPEED : WALK_SPEED
    if (this.moveIntent.lengthSq() > 0) {
      this.moveIntent.normalize().multiplyScalar(speed)
      this.moveIntent.applyAxisAngle(UP, this.yaw)
    }

    // Ease toward intent (gentle, composed acceleration).
    const ease = 1 - Math.exp(-dt * 10)
    this.velocity.x += (this.moveIntent.x - this.velocity.x) * ease
    this.velocity.z += (this.moveIntent.z - this.velocity.z) * ease

    // Vertical motion: gravity, plus the underwater jump. Effective gravity
    // follows the medium so the arc floats below the surface and falls
    // ordinarily above it.
    const gravity = this.submerged ? SWIM_GRAVITY : AIR_GRAVITY
    const grounded = controller.computedGrounded()

    // Launch only from solid footing and only in the underwater park. Snap-to-
    // ground is suspended for the arc, otherwise Rapier glues the leap back to
    // the floor before it can rise.
    if (this.jumpQueued && grounded && this.submerged && !this.jumping) {
      this.verticalVelocity = JUMP_SPEED
      this.jumping = true
      controller.disableSnapToGround()
    }
    this.jumpQueued = false

    if (this.jumping) {
      this.verticalVelocity -= gravity * dt
      if (grounded && this.verticalVelocity <= 0) {
        this.jumping = false
        this.verticalVelocity = -0.4
        controller.enableSnapToGround(SNAP_TO_GROUND)
      }
    } else {
      // Grounded: a gentle downward bias keeps snap-to-ground engaged on
      // stairs and slopes. Airborne (a genuine drop): fall with the medium.
      this.verticalVelocity = grounded ? -0.4 : this.verticalVelocity - gravity * dt
    }

    const desired = {
      x: this.velocity.x * dt,
      y: this.verticalVelocity * dt,
      z: this.velocity.z * dt,
    }
    controller.computeColliderMovement(collider, desired)
    const movement = controller.computedMovement()
    const current = body.translation()
    body.setNextKinematicTranslation({
      x: current.x + movement.x,
      y: current.y + movement.y,
      z: current.z + movement.z,
    })

    // Head bob phase advances with planar speed.
    const planar = Math.hypot(this.velocity.x, this.velocity.z)
    this.bobPhase += planar * dt * 1.9
  }

  update(ctx: GameContext): void {
    if (!this.body || !this.controlEnabled) return
    const translation = this.body.translation()
    const camera = ctx.camera

    const bob = Math.sin(this.bobPhase * Math.PI) * 0.014
    camera.position.set(
      translation.x,
      translation.y + EYE_HEIGHT - CAPSULE_HALF - CAPSULE_RADIUS + bob,
      translation.z,
    )
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
  }

  /** Adopt a camera orientation (ride exits hand back without a snap). */
  setLook(yaw: number, pitch: number): void {
    this.yaw = yaw
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch))
  }

  /** Teleport (bell arrivals, ride exits, the teleport network). */
  placeAt(x: number, y: number, z: number, yaw?: number): void {
    this.body?.setTranslation({ x, y: y + CAPSULE_HALF + CAPSULE_RADIUS, z }, true)
    if (yaw !== undefined) this.yaw = yaw
    this.verticalVelocity = 0
    // Arrive settled: clear any in-flight or buffered jump and re-arm snap-to-
    // ground so the controller does not carry a suspended state across the move.
    this.jumping = false
    this.jumpQueued = false
    this.controller?.enableSnapToGround(SNAP_TO_GROUND)
  }

  get position(): Vector3 {
    const t = this.body?.translation()
    return t ? new Vector3(t.x, t.y, t.z) : new Vector3()
  }

  /** The guest capsule — vehicles that carry the body exclude it from their
   *  own collision queries (it rides inside their hull). */
  get capsuleCollider(): RAPIER.Collider | null {
    return this.collider
  }
}

const UP = new Vector3(0, 1, 0)
