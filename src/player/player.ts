import { Vector3 } from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { PhysicsSystem } from '../physics/physicsWorld'
import { terrainHeight } from '../world/terrain'

const WALK_SPEED = 1.6
const BRISK_SPEED = 3.1
const EYE_HEIGHT = 1.7
const CAPSULE_RADIUS = 0.35
const CAPSULE_HALF = 0.5 // capsule cylinder half-height; total ≈ 1.7 m
const LOOK_SENSITIVITY = 0.0023
const PITCH_LIMIT = Math.PI * 0.485

/**
 * First-person guest (plan §8): Rapier kinematic character controller,
 * pointer-lock look, smooth-step stairs, no jump. Motion is tuned for
 * composure — this is a stroll, not a shooter.
 */
export class PlayerSystem implements GameSystem {
  readonly id = 'player'

  /** External systems (seats, rides) borrow control by setting this false. */
  controlEnabled = true

  private readonly physics: PhysicsSystem
  private body: RAPIER.RigidBody | null = null
  private collider: RAPIER.Collider | null = null
  private controller: RAPIER.KinematicCharacterController | null = null

  private yaw = 0 // camera default looks -z = north (toward the park)
  private pitch = 0
  private verticalVelocity = 0
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
    controller.enableSnapToGround(0.45)
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
      if (!this.locked || !this.controlEnabled) return
      this.yaw -= event.movementX * LOOK_SENSITIVITY
      this.pitch -= event.movementY * LOOK_SENSITIVITY
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch))
    })
    window.addEventListener('keydown', (event) => {
      this.keys.add(event.code)
    })
    window.addEventListener('keyup', (event) => {
      this.keys.delete(event.code)
    })
    window.addEventListener('blur', () => this.keys.clear())

    ctx.events.on('park/entered', () => void canvas.requestPointerLock())
  }

  fixedUpdate(_ctx: GameContext, dt: number): void {
    const { body, collider, controller } = this
    if (!body || !collider || !controller || !this.physics.world) return
    if (!this.controlEnabled) return

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

    // Gravity.
    this.verticalVelocity = controller.computedGrounded()
      ? -0.4
      : this.verticalVelocity - 9.81 * dt

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

  /** Teleport (bell arrivals, ride exits). */
  placeAt(x: number, y: number, z: number, yaw?: number): void {
    this.body?.setTranslation({ x, y: y + CAPSULE_HALF + CAPSULE_RADIUS, z }, true)
    if (yaw !== undefined) this.yaw = yaw
    this.verticalVelocity = 0
  }

  get position(): Vector3 {
    const t = this.body?.translation()
    return t ? new Vector3(t.x, t.y, t.z) : new Vector3()
  }
}

const UP = new Vector3(0, 1, 0)
