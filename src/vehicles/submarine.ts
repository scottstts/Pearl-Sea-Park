import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import { registerBookmark } from '../core/debug'
import type { Rng } from '../core/prng'
import type { Interactable } from '../player/interact'
import type { PlayerSystem } from '../player/player'
import { PLAYER_CAPSULE_OFFSET } from '../player/player'
import { markDynamicShadowCasters } from '../render/layers'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { BuoyancyProbe } from '../sea/buoyancyProbe'
import type { SeaMediumSystem } from '../sea/medium'
import type { SeaSystem } from '../sea/seaSystem'
import type { DistrictServices } from '../world/districts/atrium'
import { seabedOrPavedWalkwayHeight } from '../world/pavedWalkways'
import type { SubmarineModel } from './submarineModel'
import { buildSubmarineModel, SUBMARINE_REST_HEIGHT, SUBMARINE_SCALE } from './submarineModel'
import { SubmarineWake } from './submarineWake'

/** Berth east of the arrival road, with extra clearance from the tower. */
const BERTH = { x: 9, z: 311, yaw: Math.PI } as const

// ── Handling (fixed 60 Hz dynamics; all speeds m/s, angles rad) ───────────
const MAX_FORWARD = 9.0
const MAX_REVERSE = 3.6
const MAX_VERTICAL = 3.4
const MAX_YAW_RATE = 0.85
const THRUST_RESPONSE = 1.6 // 1/s toward a larger command
const RELEASE_RESPONSE = 2.4 // 1/s toward zero — station-keeping is quick
const YAW_RESPONSE = 3.0
const VERTICAL_RESPONSE = 2.4
const ATTITUDE_RESPONSE = 3.0 // cosmetic pitch/bank easing

// The craft may breach to half-surfaced (hull axis at the displaced water
// surface) and may never push its belly into a supporting floor. The piloting
// floor equals the rest pose so boarding never pops the parked hull upward.
const GROUND_CLEARANCE = SUBMARINE_REST_HEIGHT
// The model's lowest member is the belly step centered 0.3 local metres
// forward of the hull origin. Ground its visible footprint, not the collision
// capsule/hull center, so it lands on raised paving and structure floors.
const GROUND_CONTACT_FORWARD = 0.3 * SUBMARINE_SCALE
const GROUND_CONTACT_HALF_WIDTH = 0.23 * SUBMARINE_SCALE
const GROUND_CONTACT_HALF_DEPTH = 0.17 * SUBMARINE_SCALE
const GROUND_CONTACT_SAMPLES = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [0, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const

// ── Surface floating (semi-physics) ───────────────────────────────────────
// Near the surface the hull is held by a damped buoyancy spring toward the
// TRUE displaced wave height at the hull (BuoyancyProbe), so it heaves with
// the rendered swell instead of pinning rigidly at y = 0. Water pushes back
// far harder than it lets go: the spring stiffens sharply once the axis
// breaches above the local wave. Wave slopes across bow/stern/beam feed
// pitch and roll so the hull rides the sea, not a plane.
const FLOAT_BAND = 0.55 // spring engages this far under the local wave
// Stiff enough to track the swell rhythm nearly 1:1 (ωn ≈ 2.5 rad/s vs the
// calm swell's ~1.1): the hull must visibly ebb and flow WITH the waves.
const FLOAT_SPRING = 6.5
const FLOAT_DAMP = 3.6
const FLOAT_SPRING_ABOVE = 12.0
const FLOAT_DAMP_ABOVE = 5.0
const FLOAT_CEIL_MARGIN = 0.75 // absolute failsafe above the local wave
const PROBE_BOW = 1.9 * SUBMARINE_SCALE // bow/stern sample reach
const PROBE_BEAM = 1.2 * SUBMARINE_SCALE // starboard sample reach
const WAVE_PITCH_MAX = 0.16
const WAVE_ROLL_MAX = 0.14
// Stepping out is granted only at rest on the seabed or a real solid floor: a
// craft abandoned mid-water would hover out of a walking guest's reach, and
// any unmanned auto-descent could ground the hull on a dome or ride. Under
// way, E answers with a gentle reminder instead. Floor support comes from
// upward-facing fixed Rapier surfaces, never broad vehicle-only envelopes.
const PARKED_EPSILON = 0.08

// Invisible force field around the park range: a soft inward push over the
// last metres, then a hard wall. Encloses every attraction incl. the
// Torrent's abyss helix and the arrival threshold.
const FIELD_CENTER_X = 0
const FIELD_CENTER_Z = 10
const FIELD_RADIUS = 380
const FIELD_SOFT_BAND = 28

// ── Propeller & wake ──────────────────────────────────────────────────────
const PROP_MAX = 22 // rad/s at full command (the real shaft rate)
const PROP_SPIN_UP = 3.0 // 1/s
const PROP_SPIN_DOWN = 1.1 // slower coast-down than spin-up
const PROP_WAKE_MIN = 3.0 // below this spin the screw sheds no bubbles
const WAKE_RATE_MAX = 1_600 // small bubbles/s at full spin underwater
const PROP_TIP_RADIUS = 0.62 * SUBMARINE_SCALE
// Surfaced wake foam is splatted into the ocean's persistent field
// (sea/wakeFoamMap.ts), never drawn as its own geometry. The stern fan
// opens at the Kelvin cusp angle; the long far V arms are deliberately NOT
// painted — in real wakes the persistent FOAM is the widening turbulent
// band behind the hull, while the far arms are wave texture, not bubbles.
const WAKE_FAN_TAN = Math.tan(Math.asin(1 / 3)) // 19.47° Kelvin cusp
const WAKE_FAN_STAMPS = [
  { back: 2.6, radius: 0.85, gain: 1.0 },
  { back: 5.6, radius: 1.2, gain: 0.78 },
  { back: 9.2, radius: 1.55, gain: 0.58 },
] as const
const WAKE_LEAD_REACH = 3.1 // breaking bow-wave splat ahead of the hull axis
// A fast screw is an illusion, never a keyframe at the true rate: above
// ~10 rad/s an 8-blade wheel strobes at render cadence. The mesh rotation
// is clamped readable, the blur disc fades in over BLUR_START→BLUR_FULL,
// the real blades hide once the disc carries the read, and the disc's
// ghost arcs drift at a slow film-camera rate.
const BLADE_SPIN_CLAMP = 9 // max visible mesh rate, rad/s
const BLUR_START = 7
const BLUR_FULL = 14
const BLADE_HIDE_AT = 0.65 // blur strength beyond which real blades hide
const GHOST_RATE = 0.1 // ghost-arc drift as a fraction of shaft rate

// ── Third-person chase camera ─────────────────────────────────────────────
// Close framing: the hull fills a good share of the frame while the eye
// still clears the dome to read the water ahead.
const CHASE_BACK = 7.0
const CHASE_UP = 2.7
const LOOK_AHEAD = 6.5
const LOOK_UP = 1.0
const CAM_POS_RESPONSE = 5.5
const CAM_LOOK_RESPONSE = 8.5
// A boat-cam holds its own height reference: if the eye follows the hull's
// wave heave 1:1, on screen the hull sits still and the OCEAN appears to
// move — the exact inverse of the intended read. Vertical follow is slow
// near the target and re-engages full speed for genuine dives/climbs.
const CAM_HEIGHT_RESPONSE = 0.45
const CAM_HEIGHT_CATCHUP_START = 0.7 // deviation (m) where catch-up begins
const CAM_HEIGHT_CATCHUP_FULL = 2.1
const BLEND_IN = 1.15
const BLEND_OUT = 0.9
// Step out to starboard, clear of the parked-hull blocker cylinder
// (r ≈ 2.87) plus the guest capsule radius and a margin.
const EXIT_SIDE = 3.5

type SubmarineMode = 'idle' | 'entering' | 'piloting' | 'exiting'

const STEER_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight'])

/**
 * The pilotable submarine (Le Nautile Blanc). Parked beside the park
 * threshold; E boards into a third-person chase view, WASD/Space/Shift
 * steer, and E steps out once the craft is settled on seabed or a solid floor —
 * under way it answers with a gentle reminder to park first. Collision is
 * deliberately the player's own capsule (a guest-sized ghost at the hull
 * axis), so the craft passes structures exactly where a guest could walk.
 * When no key is held the vessel holds position and the screw coasts down.
 */
export class SubmarineSystem implements GameSystem {
  readonly id = 'submarine'

  private readonly services: DistrictServices
  private readonly player: PlayerSystem | null
  private readonly medium: SeaMediumSystem
  private readonly sea: SeaSystem

  private model: SubmarineModel | null = null
  private wake: SubmarineWake | null = null
  private rng: Rng | null = null

  private body: RAPIER.RigidBody | null = null
  private collider: RAPIER.Collider | null = null
  private controller: RAPIER.KinematicCharacterController | null = null
  private blockerBody: RAPIER.RigidBody | null = null
  private blockerCollider: RAPIER.Collider | null = null
  // The guest capsule rides inside the hull and the parked blocker wraps it —
  // neither may answer the craft's own collide-and-slide queries.
  private readonly collisionFilter = (candidate: RAPIER.Collider): boolean =>
    candidate !== this.player?.capsuleCollider && candidate !== this.blockerCollider

  private mode: SubmarineMode = 'idle'
  private readonly keys = new Set<string>()

  // Authoritative pose advances at the fixed step; rendering interpolates.
  private readonly position = new Vector3()
  private readonly previousPosition = new Vector3()
  private yaw = BERTH.yaw
  private previousYaw = BERTH.yaw

  private forwardSpeed = 0
  private verticalSpeed = 0
  private yawRate = 0
  private visualPitch = 0
  private visualRoll = 0
  private propSpeed = 0
  private propTarget = 0
  private helmAngle = 0
  private steerInput = { forward: 0, turn: 0, vertical: 0 }

  // Surface-floating state (smoothed against the latent probe readback).
  private buoyancy: BuoyancyProbe | null = null
  private surfacedness = 0
  private surfacednessTarget = 0
  private wavePitch = 0
  private wavePitchTarget = 0
  private waveRoll = 0
  private waveRollTarget = 0

  // Camera rig state.
  private blend = 0
  private readonly blendFromPosition = new Vector3()
  private readonly blendFromQuaternion = new Quaternion()
  private readonly cameraPosition = new Vector3()
  private readonly cameraLook = new Vector3()
  private readonly exitPoint = new Vector3()

  private readonly promptAnchor = new Vector3()
  private exitInteractable: Interactable | null = null
  private wakeDebt = 0
  private humRunning = false
  private humSpin = 0

  // Scratch
  private readonly forward = new Vector3()
  private readonly right = new Vector3()
  private readonly scratch = new Vector3()
  private readonly scratchB = new Vector3()
  private readonly scratchMatrix = new Matrix4()
  private readonly scratchQuaternion = new Quaternion()

  constructor(
    services: DistrictServices,
    player: PlayerSystem | null,
    medium: SeaMediumSystem,
    sea: SeaSystem,
  ) {
    this.services = services
    this.player = player
    this.medium = medium
    this.sea = sea
  }

  init(ctx: GameContext): void {
    this.rng = ctx.rng.fork('submarine')
    const model = buildSubmarineModel(this.medium)
    this.model = model
    const berthY = this.groundFloorY(BERTH.x, 0, BERTH.z, BERTH.yaw)
    this.position.set(BERTH.x, berthY, BERTH.z)
    this.previousPosition.copy(this.position)
    model.group.rotation.order = 'YXZ'
    this.applyVisualPose(this.position, this.yaw)
    markDynamicShadowCasters(model.group)
    ctx.scene.add(model.group)

    if (!this.sea.sim) throw new Error('SubmarineSystem requires SeaSystem to init first')
    const wake = new SubmarineWake({
      qualityTier: ctx.quality.tier,
      debugPass: ctx.flags.pass,
    })
    this.wake = wake
    ctx.scene.add(...wake.meshes)

    registerBookmark({
      name: 'submarine',
      position: [BERTH.x + 6.5, berthY + 3.2, BERTH.z + 6.5],
      look: [BERTH.x, berthY, BERTH.z],
      note: 'Le Nautile Blanc berthed beside the park threshold',
    })

    // Piloting exists only with a guest; validation views still get the hull.
    const { physics, interaction } = this.services
    if (!this.player || !interaction || !physics.world || !physics.rapier) return
    const { world, rapier } = physics
    if (this.sea.sim) {
      this.buoyancy = new BuoyancyProbe(this.sea.sim)
      // One dispatch behind the ticket compiles the compute pipeline so the
      // first surfacing never pays a mid-gameplay stall.
      this.buoyancy.update(ctx.renderer, [
        [BERTH.x, BERTH.z],
        [BERTH.x, BERTH.z],
        [BERTH.x, BERTH.z],
      ])
    }

    // The craft's collision IS the guest capsule: same shape, hull axis.
    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(
        this.position.x,
        this.position.y,
        this.position.z,
      ),
    )
    this.collider = world.createCollider(rapier.ColliderDesc.capsule(0.5, 0.35), this.body)
    this.controller = world.createCharacterController(0.05)

    // While parked, a solid footprint keeps guests from walking through the
    // hull; it drops far below the park whenever the craft is under way.
    this.blockerBody = world.createRigidBody(
      rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(
        this.position.x,
        this.position.y,
        this.position.z,
      ),
    )
    this.blockerCollider = world.createCollider(
      rapier.ColliderDesc.cylinder(1.35, 2.35 * SUBMARINE_SCALE),
      this.blockerBody,
    )

    window.addEventListener('keydown', (event) => {
      // Capture during the boarding blend too: a W held while the camera
      // settles engages the moment the helm goes live (auto-repeat would
      // otherwise delay it by the OS repeat interval).
      if ((this.mode !== 'piloting' && this.mode !== 'entering') || !STEER_CODES.has(event.code)) return
      this.keys.add(event.code)
    })
    window.addEventListener('keyup', (event) => this.keys.delete(event.code))
    window.addEventListener('blur', () => this.keys.clear())

    this.promptAnchor.copy(this.position)
    const player = this.player
    interaction.register({
      position: this.promptAnchor,
      radius: 7.5,
      prompt: 'Pilot the submarine',
      onInteract: () => this.enter(ctx),
      enabled: () => this.mode === 'idle' && player.controlEnabled && !player.inputFrozen,
    })
    // The exit prompt anchors to the hull itself; the chase camera always
    // faces it, so the view-cone rule keeps it visible from the helm.
    this.exitInteractable = {
      position: this.promptAnchor,
      radius: 20,
      prompt: 'Step out',
      onInteract: () => this.requestExit(ctx),
      enabled: () => this.mode === 'piloting',
    }
    interaction.register(this.exitInteractable)
  }

  // ── Boarding & stepping out ─────────────────────────────────────────────

  private enter(ctx: GameContext): void {
    if (this.mode !== 'idle' || !this.player) return
    this.mode = 'entering'
    this.blend = 0
    this.keys.clear()
    this.blendFromPosition.copy(ctx.camera.position)
    this.blendFromQuaternion.copy(ctx.camera.quaternion)
    this.player.controlEnabled = false
    this.blockerBody?.setTranslation({ x: this.position.x, y: -500, z: this.position.z }, false)
    // Only the "step out" prompt exists while at the helm — every park gate,
    // ride, and game stays mute until the guest is back on foot.
    if (this.services.interaction) this.services.interaction.exclusive = this.exitInteractable
  }

  /** At rest on seabed or a real fixed floor beneath the belly step. */
  private isParkedOnGround(): boolean {
    const floorY = this.groundFloorY(this.position.x, this.position.y, this.position.z, this.yaw)
    return this.position.y <= floorY + PARKED_EPSILON
  }

  private groundFloorY(x: number, originY: number, z: number, yaw: number): number {
    const forwardX = Math.sin(yaw)
    const forwardZ = Math.cos(yaw)
    const rightX = Math.cos(yaw)
    const rightZ = -Math.sin(yaw)
    let supportY = -Infinity
    for (const [across, along] of GROUND_CONTACT_SAMPLES) {
      const localX = across * GROUND_CONTACT_HALF_WIDTH
      const localZ = GROUND_CONTACT_FORWARD + along * GROUND_CONTACT_HALF_DEPTH
      const contactX = x + rightX * localX + forwardX * localZ
      const contactZ = z + rightZ * localX + forwardZ * localZ
      supportY = Math.max(supportY, this.supportSurfaceY(contactX, originY, contactZ))
    }
    return supportY + GROUND_CLEARANCE
  }

  private supportSurfaceY(x: number, originY: number, z: number): number {
    const seabedOrWalkwayY = seabedOrPavedWalkwayHeight(x, z)
    const staticFloorY = this.services.physics.highestStaticSupportY(
      x,
      Math.max(originY, seabedOrWalkwayY + GROUND_CLEARANCE),
      z,
    )
    return staticFloorY === null ? seabedOrWalkwayY : Math.max(seabedOrWalkwayY, staticFloorY)
  }

  private requestExit(ctx: GameContext): void {
    if (this.mode !== 'piloting' || !this.player) return
    const interaction = this.services.interaction
    if (!this.isParkedOnGround()) {
      interaction?.notice('Settle on the seabed or a solid floor to step out')
      return
    }
    interaction?.dismissNotice()
    this.mode = 'exiting'
    this.blend = 0
    this.keys.clear()
    this.blendFromPosition.copy(ctx.camera.position)
    this.blendFromQuaternion.copy(ctx.camera.quaternion)
    // Step out to starboard onto the highest real floor beside the hull.
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    const exitX = this.position.x + this.right.x * EXIT_SIDE
    const exitZ = this.position.z + this.right.z * EXIT_SIDE
    const ground = this.supportSurfaceY(exitX, this.position.y, exitZ)
    this.exitPoint
      .copy(this.position)
      .addScaledVector(this.right, EXIT_SIDE)
      .setY(Math.max(ground + 0.05, this.position.y - 1.35))
    // The craft holds station where it was left: park the blocker there.
    this.blockerBody?.setTranslation(
      { x: this.position.x, y: this.position.y, z: this.position.z },
      false,
    )
  }

  private finishExit(ctx: GameContext): void {
    const player = this.player
    if (!player) return
    const euler = new Euler().setFromQuaternion(ctx.camera.quaternion, 'YXZ')
    player.setLook(euler.y, euler.x)
    player.placeAt(this.exitPoint.x, this.exitPoint.y, this.exitPoint.z)
    player.controlEnabled = true
    this.mode = 'idle'
    if (this.services.interaction) this.services.interaction.exclusive = null
  }

  // ── Fixed-step dynamics ─────────────────────────────────────────────────

  fixedUpdate(_ctx: GameContext, dt: number): void {
    this.previousPosition.copy(this.position)
    this.previousYaw = this.yaw
    if (this.mode !== 'piloting') {
      // Idle and both blend phases hold station; the screw coasts down.
      // (The hull never moves unmanned — exit requires a valid ground park.)
      this.settleDynamics(dt)
      return
    }

    // Steering intent.
    const forwardInput = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0)
    const turnInput = (this.keys.has('KeyA') ? 1 : 0) - (this.keys.has('KeyD') ? 1 : 0)
    const verticalInput =
      (this.keys.has('Space') ? 1 : 0) -
      (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 1 : 0)
    this.steerInput = { forward: forwardInput, turn: turnInput, vertical: verticalInput }

    const targetForward = forwardInput > 0 ? MAX_FORWARD : forwardInput < 0 ? -MAX_REVERSE : 0
    const targetYawRate = turnInput * MAX_YAW_RATE
    const targetVertical = verticalInput * MAX_VERTICAL

    this.forwardSpeed = approach(this.forwardSpeed, targetForward, dt, THRUST_RESPONSE, RELEASE_RESPONSE)
    this.yawRate = approach(this.yawRate, targetYawRate, dt, YAW_RESPONSE, YAW_RESPONSE)

    // True displaced wave heights at the hull (latent CPU readback; 0 until
    // the first surface visit — identical to a flat sea).
    const waveHeights = this.buoyancy?.heights
    const waveEq = waveHeights ? (waveHeights[0] + waveHeights[1]) / 2 : 0
    const floating = verticalInput >= 0 && this.position.y > waveEq - FLOAT_BAND
    if (floating) {
      // Buoyancy owns heave near the surface: a damped spring toward the
      // local wave, much stiffer above it (water pushes back harder than it
      // lets go), so arriving at speed plops and settles into a gentle bob.
      const depth = waveEq - this.position.y
      const spring = depth >= 0 ? FLOAT_SPRING : FLOAT_SPRING_ABOVE
      const damping = depth >= 0 ? FLOAT_DAMP : FLOAT_DAMP_ABOVE
      this.verticalSpeed += (depth * spring - this.verticalSpeed * damping) * dt
    } else {
      this.verticalSpeed = approach(this.verticalSpeed, targetVertical, dt, VERTICAL_RESPONSE, VERTICAL_RESPONSE)
    }

    this.yaw += this.yawRate * dt
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw))

    // Desired displacement this step.
    this.scratch
      .copy(this.forward)
      .multiplyScalar(this.forwardSpeed * dt)
      .add(this.scratchB.set(0, this.verticalSpeed * dt, 0))

    // Soft force field: an inward current rises over the last metres.
    const dx = this.position.x - FIELD_CENTER_X
    const dz = this.position.z - FIELD_CENTER_Z
    const radial = Math.hypot(dx, dz)
    const softStart = FIELD_RADIUS - FIELD_SOFT_BAND
    if (radial > softStart && radial > 1e-4) {
      const over = Math.min(1, (radial - softStart) / FIELD_SOFT_BAND)
      const push = over * over * 7.5 * dt
      this.scratch.x -= (dx / radial) * push
      this.scratch.z -= (dz / radial) * push
    }

    // Collide-and-slide with the guest capsule; the player's own parked
    // collider rides inside the hull and is excluded from the query.
    const { collider, controller, body } = this
    if (collider && controller && body) {
      controller.computeColliderMovement(
        collider,
        { x: this.scratch.x, y: this.scratch.y, z: this.scratch.z },
        undefined,
        undefined,
        this.collisionFilter,
      )
      const movement = controller.computedMovement()
      this.position.x += movement.x
      this.position.y += movement.y
      this.position.z += movement.z
    } else {
      this.position.add(this.scratch)
    }

    // Vertical envelope: highest real support beneath the belly-step footprint,
    // and a failsafe ceiling just above the local wave (buoyancy is authoritative).
    const floorY = this.groundFloorY(
      this.position.x,
      this.position.y,
      this.position.z,
      this.yaw,
    )
    if (this.position.y <= floorY) {
      this.position.y = floorY
      if (this.verticalSpeed < 0) this.verticalSpeed = 0
    }
    const ceilingY = waveEq + FLOAT_CEIL_MARGIN
    if (this.position.y >= ceilingY) {
      this.position.y = ceilingY
      if (this.verticalSpeed > 0) this.verticalSpeed = 0
    }

    // Ride the sea, not a plane: wave slope across bow/stern/beam becomes
    // pitch/roll, weighted by how surfaced the hull is.
    if (waveHeights) {
      this.surfacednessTarget = clamp01(1 - (waveEq - this.position.y) / 0.9)
      this.wavePitchTarget = clampAbs(
        Math.atan2(waveHeights[1] - waveHeights[0], 2 * PROBE_BOW),
        WAVE_PITCH_MAX,
      )
      this.waveRollTarget = clampAbs(
        Math.atan2(waveHeights[2] - waveEq, PROBE_BEAM),
        WAVE_ROLL_MAX,
      )
    }

    // Hard force-field wall.
    const dx2 = this.position.x - FIELD_CENTER_X
    const dz2 = this.position.z - FIELD_CENTER_Z
    const radial2 = Math.hypot(dx2, dz2)
    if (radial2 > FIELD_RADIUS) {
      const clampScale = FIELD_RADIUS / radial2
      this.position.x = FIELD_CENTER_X + dx2 * clampScale
      this.position.z = FIELD_CENTER_Z + dz2 * clampScale
    }

    body?.setNextKinematicTranslation({
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
    })
    // Carry the seated guest: their capsule (and world position) rides at
    // the hull axis, so wildlife, docks, and exits all see the pilot here.
    this.player?.placeAt(
      this.position.x,
      this.position.y - PLAYER_CAPSULE_OFFSET,
      this.position.z,
    )

    this.advanceSharedDynamics(dt)
  }

  /** Screw + attitude dynamics shared by every mode. */
  private advanceSharedDynamics(dt: number): void {
    const { forward, turn, vertical } = this.steerInput
    const anyInput = forward !== 0 || turn !== 0 || vertical !== 0
    const commanded = Math.max(Math.abs(forward), 0.6 * Math.abs(vertical), 0.45 * Math.abs(turn))
    this.propTarget = anyInput ? PROP_MAX * (0.35 + 0.65 * commanded) * (forward < 0 ? -1 : 1) : 0
    const spinRate = Math.abs(this.propTarget) > Math.abs(this.propSpeed) ? PROP_SPIN_UP : PROP_SPIN_DOWN
    this.propSpeed = approach(this.propSpeed, this.propTarget, dt, spinRate, spinRate)

    // Smooth the latent, stepwise wave-slope targets before applying them.
    const waveEase = 1 - Math.exp(-dt * 4.5)
    this.surfacedness += (this.surfacednessTarget - this.surfacedness) * (1 - Math.exp(-dt * 2.5))
    this.wavePitch += (this.wavePitchTarget - this.wavePitch) * waveEase
    this.waveRoll += (this.waveRollTarget - this.waveRoll) * waveEase

    // Cosmetic attitude: the bow lifts on ascent, banks into a turn, and at
    // the surface the hull rides the local wave slope.
    const targetPitch =
      (-this.verticalSpeed / MAX_VERTICAL) * 0.11 + this.wavePitch * this.surfacedness
    const speedFraction = Math.max(0, Math.min(1, this.forwardSpeed / MAX_FORWARD))
    const targetRoll =
      (this.yawRate / MAX_YAW_RATE) * 0.2 * speedFraction + this.waveRoll * this.surfacedness
    const attitudeEase = 1 - Math.exp(-dt * ATTITUDE_RESPONSE)
    this.visualPitch += (targetPitch - this.visualPitch) * attitudeEase
    this.visualRoll += (targetRoll - this.visualRoll) * attitudeEase
  }

  private settleDynamics(dt: number): void {
    this.forwardSpeed = approach(this.forwardSpeed, 0, dt, RELEASE_RESPONSE, RELEASE_RESPONSE)
    this.yawRate = approach(this.yawRate, 0, dt, YAW_RESPONSE, YAW_RESPONSE)
    this.verticalSpeed = approach(this.verticalSpeed, 0, dt, VERTICAL_RESPONSE, VERTICAL_RESPONSE)
    this.steerInput = { forward: 0, turn: 0, vertical: 0 }
    this.surfacednessTarget = 0 // parked hulls rest on a solid support
    this.advanceSharedDynamics(dt)
  }

  // ── Per-frame presentation ──────────────────────────────────────────────

  update(ctx: GameContext, dt: number, alpha: number): void {
    const model = this.model
    if (!model) return

    // Interpolated pose between fixed steps — never the raw physics step.
    this.scratch.lerpVectors(this.previousPosition, this.position, alpha)
    const renderYaw = this.previousYaw + (this.yaw - this.previousYaw) * alpha
    this.applyVisualPose(this.scratch, renderYaw)
    this.promptAnchor.copy(this.scratch)

    // Screw presentation: the mesh never keyframes the true shaft rate —
    // it spins readably, and past the strobe threshold the blur disc takes
    // over while the real blades hide beneath it.
    const spin = this.propSpeed
    const readableRate = Math.max(-BLADE_SPIN_CLAMP, Math.min(BLADE_SPIN_CLAMP, spin))
    model.propeller.rotation.z += readableRate * dt
    const blur = smooth01(clamp01((Math.abs(spin) - BLUR_START) / (BLUR_FULL - BLUR_START)))
    model.propellerBlur.strength.value = blur
    model.propellerBlur.ghost.value += spin * GHOST_RATE * dt
    model.propellerBlur.disc.visible = blur > 0.01
    const bladesVisible = blur < BLADE_HIDE_AT
    for (const bladeMesh of model.propellerBlades) bladeMesh.visible = bladesVisible

    const helmTarget = -this.steerInput.turn * 0.9
    this.helmAngle += (helmTarget - this.helmAngle) * (1 - Math.exp(-dt * 4))
    model.helmWheel.rotation.z = this.helmAngle

    // Screw voice: spin-hysteresis start/stop, with the shaft rate re-emitted
    // as it changes so the hum's pitch rides spin-up and coast-down. The
    // audio engine owns the sound itself (and its own camera-medium muffle);
    // the hum naturally outlives the throttle by the screw's coast-down.
    const shaftSpin = Math.abs(this.propSpeed)
    const spinFraction = shaftSpin / PROP_MAX
    if (!this.humRunning && shaftSpin > 1.2) {
      this.humRunning = true
      this.humSpin = spinFraction
      ctx.events.emit('vehicle/submarine-running', { running: true, spin: spinFraction })
    } else if (this.humRunning && shaftSpin < 0.6) {
      this.humRunning = false
      ctx.events.emit('vehicle/submarine-running', { running: false, spin: 0 })
    } else if (this.humRunning && Math.abs(spinFraction - this.humSpin) > 0.015) {
      this.humSpin = spinFraction
      ctx.events.emit('vehicle/submarine-running', { running: true, spin: spinFraction })
    }

    // Buoyancy sampling runs only near the surface while under way.
    if (this.buoyancy && this.mode !== 'idle' && this.position.y > -8) {
      const fx = Math.sin(this.yaw)
      const fz = Math.cos(this.yaw)
      const rx = Math.cos(this.yaw)
      const rz = -Math.sin(this.yaw)
      this.buoyancy.update(ctx.renderer, [
        [this.position.x + fx * PROBE_BOW, this.position.z + fz * PROBE_BOW],
        [this.position.x - fx * PROBE_BOW, this.position.z - fz * PROBE_BOW],
        [this.position.x + rx * PROBE_BEAM, this.position.z + rz * PROBE_BEAM],
      ])
    }

    this.emitWake(ctx, dt)
    this.wake?.update(ctx.time.elapsed, this.surfacedness >= 0.3)
    this.updateCamera(ctx, dt)

    // Numeric evidence for the wave coupling (agents + humans): read
    // canvas.dataset.submarine under ?debug while piloting.
    if (ctx.flags.debug && this.mode === 'piloting' && ctx.time.frame % 30 === 0) {
      const heights = this.buoyancy?.heights
      ctx.renderer.domElement.dataset.submarine = JSON.stringify({
        y: Number(this.position.y.toFixed(3)),
        waveHeights: heights ? [...heights].map((v) => Number(v.toFixed(3))) : null,
        surfacedness: Number(this.surfacedness.toFixed(2)),
        wavePitch: Number(this.wavePitch.toFixed(3)),
        waveRoll: Number(this.waveRoll.toFixed(3)),
        propSpeed: Number(this.propSpeed.toFixed(2)),
      })
    }
  }

  private applyVisualPose(center: Vector3, yaw: number): void {
    const group = this.model?.group
    if (!group) return
    group.position.copy(center)
    group.rotation.set(this.visualPitch, yaw, this.visualRoll)
    group.updateMatrixWorld()
  }

  private emitWake(ctx: GameContext, dt: number): void {
    const model = this.model
    const wake = this.wake
    const rng = this.rng
    if (!model || !wake || !rng) return
    const spin = Math.abs(this.propSpeed)
    if (spin < PROP_WAKE_MIN) {
      this.wakeDebt = 0
      return
    }
    const now = ctx.time.elapsed

    model.propeller.getWorldPosition(this.scratchB) // prop hub, world
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw))
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    const washSign = this.propSpeed < 0 ? 1 : -1 // wake streams opposite thrust
    const axis = new Vector3().copy(this.forward).multiplyScalar(washSign)
    const axialBase = 2.1 + Math.abs(this.forwardSpeed) * 0.55
    const radial = new Vector3()
    const origin = new Vector3()
    const drive = new Vector3()

    // Mutually exclusive regimes: below the transition only bubbles can
    // emit/draw; at and above it only ocean-field foam splats accumulate.
    const spinFraction = spin / PROP_MAX
    const surfaceWake = this.surfacedness >= 0.3
    const bubbleGate = surfaceWake
      ? 0
      : 1 - smooth01(clamp01(this.surfacedness / 0.3))
    const foamGate = surfaceWake
      ? smooth01(clamp01((this.surfacedness - 0.3) / 0.5))
      : 0

    // ── Underwater: simple high-count bubbles across the prop disc ────────
    this.wakeDebt += WAKE_RATE_MAX * spinFraction * bubbleGate * dt
    let bubbles = Math.floor(this.wakeDebt)
    this.wakeDebt -= bubbles
    bubbles = Math.min(bubbles, 36)
    for (let i = 0; i < bubbles; i++) {
      const angle = rng.next() * Math.PI * 2
      const radius = Math.sqrt(rng.next()) * PROP_TIP_RADIUS * 0.9
      radial
        .copy(this.right)
        .multiplyScalar(Math.cos(angle) * radius)
        .addScaledVector(UP, Math.sin(angle) * radius)
      origin
        .copy(this.scratchB)
        .add(radial)
        .addScaledVector(axis, 0.08 + rng.next() * 0.12)
      drive
        .copy(axis)
        .multiplyScalar(axialBase * (0.72 + rng.next() * 0.45))
        .addScaledVector(radial, 0.1 + rng.next() * 0.08)
      wake.emitBubble(origin, drive, now)
    }

    // ── Surface foam: splats accumulated into the ocean's wake field ──────
    // The field is part of the ocean surface itself — the trail persists
    // when the throttle drops or the craft dives, widens and laces open as
    // it ages, and re-crossing it can only refresh it (max() deposits).
    const foam = this.sea.wakeFoam
    if (foam && foamGate > 0.01) {
      const speedFraction = Math.abs(this.forwardSpeed) / MAX_FORWARD
      // Stern churn: prop-aerated water at the hub. Lives on spin alone, so
      // holding station under helm still boils the water at the stern and a
      // pivot turn scribes its swing into the sea.
      const churn = foamGate * (0.3 + 0.7 * spinFraction) * (0.4 + 0.6 * speedFraction)
      foam.splat(
        this.scratchB.x + axis.x * 0.7,
        this.scratchB.z + axis.z * 0.7,
        1.35 + speedFraction * 0.6,
        churn,
        churn * 0.95,
      )
      // With way on, the churn opens into the widening stern fan (Kelvin
      // cusp angle) and the leading edge sheds a breaking bow-wave collar.
      const wayOn = smooth01(clamp01((speedFraction - 0.16) / 0.42))
      if (wayOn > 0.01) {
        const fan = foamGate * wayOn * (0.35 + 0.65 * speedFraction)
        for (const stamp of WAKE_FAN_STAMPS) {
          const lateral = stamp.back * WAKE_FAN_TAN
          for (let side = -1; side <= 1; side += 2) {
            foam.splat(
              this.scratchB.x + axis.x * stamp.back + this.right.x * side * lateral,
              this.scratchB.z + axis.z * stamp.back + this.right.z * side * lateral,
              stamp.radius,
              fan * stamp.gain * 0.35,
              fan * stamp.gain,
            )
          }
        }
        foam.splat(
          this.position.x - axis.x * WAKE_LEAD_REACH,
          this.position.z - axis.z * WAKE_LEAD_REACH,
          0.9,
          fan * 0.5,
          fan * 0.7,
        )
      }
    }
  }

  // ── Chase camera ────────────────────────────────────────────────────────

  private chasePose(outEye: Vector3, outLook: Vector3): void {
    const group = this.model?.group
    const center = group ? group.position : this.position
    const yaw = group ? group.rotation.y : this.yaw
    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    outEye.set(center.x - fx * CHASE_BACK, center.y + CHASE_UP, center.z - fz * CHASE_BACK)
    // Never sink the eye under the ground while skimming seabed or paving.
    const camFloor = seabedOrPavedWalkwayHeight(outEye.x, outEye.z) + 0.7
    if (outEye.y < camFloor) outEye.y = camFloor
    outLook.set(center.x + fx * LOOK_AHEAD, center.y + LOOK_UP, center.z + fz * LOOK_AHEAD)
  }

  private updateCamera(ctx: GameContext, dt: number): void {
    if (this.mode === 'idle') return
    const camera = ctx.camera

    if (this.mode === 'entering') {
      this.blend = Math.min(1, this.blend + dt / BLEND_IN)
      const eased = this.blend * this.blend * (3 - 2 * this.blend)
      this.chasePose(this.cameraPosition, this.cameraLook)
      // Camera convention: Matrix4.lookAt aims −z at the target. A plain
      // Object3D.lookAt aims +z instead, which slewed this blend to face
      // exactly backward before piloting's camera.lookAt "cut" it right.
      this.scratchMatrix.lookAt(this.cameraPosition, this.cameraLook, UP)
      this.scratchQuaternion.setFromRotationMatrix(this.scratchMatrix)
      camera.position.lerpVectors(this.blendFromPosition, this.cameraPosition, eased)
      camera.quaternion.copy(this.blendFromQuaternion).slerp(this.scratchQuaternion, eased)
      if (this.blend >= 1) this.mode = 'piloting'
      return
    }

    if (this.mode === 'piloting') {
      this.chasePose(this.scratch, this.scratchB)
      const posEase = 1 - Math.exp(-dt * CAM_POS_RESPONSE)
      // The eye's height reference is its own: slow vertical follow so wave
      // heave moves the HULL in frame (the look target still tracks fast),
      // blending back to full follow for genuine dives and climbs.
      const heightError = Math.abs(this.scratch.y - this.cameraPosition.y)
      const catchUp = smooth01(
        clamp01(
          (heightError - CAM_HEIGHT_CATCHUP_START) /
            (CAM_HEIGHT_CATCHUP_FULL - CAM_HEIGHT_CATCHUP_START),
        ),
      )
      const heightResponse = CAM_HEIGHT_RESPONSE + (CAM_POS_RESPONSE - CAM_HEIGHT_RESPONSE) * catchUp
      const heightEase = 1 - Math.exp(-dt * heightResponse)
      const lookEase = 1 - Math.exp(-dt * CAM_LOOK_RESPONSE)
      this.cameraPosition.x += (this.scratch.x - this.cameraPosition.x) * posEase
      this.cameraPosition.z += (this.scratch.z - this.cameraPosition.z) * posEase
      this.cameraPosition.y += (this.scratch.y - this.cameraPosition.y) * heightEase
      this.cameraLook.lerp(this.scratchB, lookEase)
      camera.position.copy(this.cameraPosition)
      camera.lookAt(this.cameraLook)
      return
    }

    // exiting
    this.blend = Math.min(1, this.blend + dt / BLEND_OUT)
    const eased = this.blend * this.blend * (3 - 2 * this.blend)
    this.scratch.set(this.exitPoint.x, this.exitPoint.y + 1.7, this.exitPoint.z)
    camera.position.lerpVectors(this.blendFromPosition, this.scratch, eased)
    camera.quaternion.copy(this.blendFromQuaternion)
    if (this.blend >= 1) this.finishExit(ctx)
  }

  dispose(ctx: GameContext): void {
    if (this.humRunning) {
      this.humRunning = false
      ctx.events.emit('vehicle/submarine-running', { running: false, spin: 0 })
    }
    if (this.model) {
      ctx.scene.remove(this.model.group)
      this.model.dispose()
      this.model = null
    }
    if (this.wake) {
      ctx.scene.remove(...this.wake.meshes)
      this.wake.dispose()
      this.wake = null
    }
    if (this.services.interaction) this.services.interaction.exclusive = null
  }
}

const UP = new Vector3(0, 1, 0)

/** Exponential ease toward a target with separate approach/release rates. */
function approach(current: number, target: number, dt: number, gain: number, release: number): number {
  const rate = Math.abs(target) > Math.abs(current) ? gain : release
  return current + (target - current) * (1 - Math.exp(-dt * rate))
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function clampAbs(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value))
}

function smooth01(t: number): number {
  return t * t * (3 - 2 * t)
}
