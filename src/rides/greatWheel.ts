import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { ArchKit } from '../archkit/modules'
import { SlotWriter } from '../archkit/writer'
import { registerBookmark } from '../core/debug'
import type { PlayerSystem } from '../player/player'
import { markDynamicShadowCasters } from '../render/layers'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { currentFlowCpu } from '../sea/current'
import type { DistrictServices } from '../world/districts/atrium'
import { PARK_PLAN } from '../world/parkPlan'
import { terrainHeight } from '../world/terrain'
import { VehicleSeatRig } from './vehicleSeat'

const GONDOLAS = 12
const PERIOD = 92 // seconds per revolution at cruise
const RADIUS = PARK_PLAN.wheel.radius

type WheelState =
  | 'cruising' // constant spin, nobody waiting
  | 'arriving' // guest at the pier head — glide the next gondola into the dock
  | 'boarding' // stopped at the dock, waiting for the guest to step in (or leave)
  | 'riding' // guest aboard — one full revolution at cruise speed
  | 'unloading' // back at the dock, stopped until the guest steps off
  | 'clearing' // guest off but still on the pier head — hold until they clear

/**
 * The Great Wheel (plan §9.2): a 40 m wheel turning in a dredged basin —
 * open-air nautilus gondolas on pendulum pivots, full bulb rigging, and the
 * crest breaching the surface every revolution: seconds of sky, then blue
 * again — the ocean shader owns the pierce interface itself.
 *
 * Ride contract: the wheel spins CONSTANTLY. It only decelerates when a
 * guest stands at the pier head, stopping the next gondola at the dock. If
 * they walk away it resumes; if they board, it runs exactly one revolution
 * and stops for them to step off, and only spins again once they leave the
 * boarding area.
 */
export class GreatWheelSystem implements GameSystem {
  readonly id = 'great-wheel'

  private readonly services: DistrictServices
  private readonly player: PlayerSystem | null
  private rig: VehicleSeatRig | null = null

  private readonly group = new Object3D()
  private readonly rotor = new Object3D()
  private readonly hub = new Vector3(PARK_PLAN.wheel.x, PARK_PLAN.wheel.hubY, PARK_PLAN.wheel.z)
  private readonly cars: Object3D[] = []
  private readonly pivots: Object3D[] = []
  private readonly swing: { angle: number; velocity: number }[] = []

  private state: WheelState = 'cruising'
  private rotorAngle = 0
  private speed = 0
  private ridingCar = -1
  private dockedIndex = -1
  private rideStartAngle = 0
  /** Rotor angle that puts gondola 0 at the boarding dock. */
  private boardingAngle = 0
  private boardingZone = new Vector3()

  constructor(services: DistrictServices, player: PlayerSystem | null) {
    this.services = services
    this.player = player
  }

  init(ctx: GameContext): void {
    const lib = this.services.materials.lib
    if (!lib) throw new Error('GreatWheelSystem requires materials')
    const { physics } = this.services
    const kit = new ArchKit(lib)
    const w = new SlotWriter()
    const { x: hx, z: hz } = PARK_PLAN.wheel
    const hy = PARK_PLAN.wheel.hubY

    // ── Static structure: legs, axle, pier ────────────────────────────────
    for (const sideZ of [-1, 1]) {
      for (const sideX of [-1, 1]) {
        const footX = hx + sideX * 11
        const footZ = hz + sideZ * 4.6
        const footY = terrainHeight(footX, footZ)
        const leg = new Mesh(new CylinderGeometry(0.5, 0.75, 1, 14), lib.iron)
        const top = new Vector3(hx + sideX * 1.1, hy, hz + sideZ * 2.5)
        const foot = new Vector3(footX, footY, footZ)
        const mid = foot.clone().add(top).multiplyScalar(0.5)
        const length = foot.distanceTo(top)
        leg.scale.y = length
        leg.position.copy(mid)
        leg.lookAt(top)
        leg.rotateX(Math.PI / 2)
        this.group.add(leg)
        // Footing collar so the leg reads planted, not stabbed into sand.
        const collar = new Mesh(new CylinderGeometry(1.05, 1.35, 0.6, 14), lib.verdigris)
        collar.position.set(footX, footY + 0.25, footZ)
        this.group.add(collar)
        // The legs rake inward toward the submerged hub; a guest reaching the
        // basin floor meets their splayed feet. A vertical pier over the lowest
        // few metres blocks that without chasing the tilt up into the machine.
        physics.addStaticCylinder(footX, footY + 2.5, footZ, 2.5, 0.85)
      }
      // Bracing beam between the leg pair.
      const brace = new Mesh(new CylinderGeometry(0.22, 0.22, 15, 10), lib.iron)
      brace.rotation.z = Math.PI / 2
      brace.position.set(hx, hy - 12, hz + sideZ * 3.6)
      this.group.add(brace)
    }
    const axle = new Mesh(new CylinderGeometry(0.55, 0.55, 7, 16), lib.brass)
    axle.rotation.x = Math.PI / 2
    axle.position.set(hx, hy, hz)
    this.group.add(axle)

    // The pier: boardwalk from the basin rim toward the wheel. It ends at
    // hx − 21.4 — outside the rotor's sweep envelope (rim reaches hx − 20.32,
    // docked gondola hulls to ≈ hx − 21.0). The old deck ran to hx − 17.8 and
    // the rim carved straight through its end.
    const pierEnd = hx - 21.4
    const pierY = terrainHeight(hx - 27, hz) + 0.15
    kit.mosaicPath(w, hx - 27.5, hz, pierEnd, hz, pierY, 4.2)
    physics.addStaticBox((hx - 27.5 + pierEnd) / 2, pierY + 0.08, hz, (27.5 - 21.4) / 2, 0.08, 2.1)
    kit.balustrade(w, hx - 27.5, hz - 2.05, pierEnd, hz - 2.05, pierY + 0.05)
    kit.balustrade(w, hx - 27.5, hz + 2.05, pierEnd, hz + 2.05, pierY + 0.05)
    // End rails leave a central boarding gap facing the docked gondola.
    kit.balustrade(w, pierEnd, hz - 2.05, pierEnd, hz - 0.85, pierY + 0.05)
    kit.balustrade(w, pierEnd, hz + 0.85, pierEnd, hz + 2.05, pierY + 0.05)
    physics.addStaticBox(pierEnd, pierY + 0.55, hz - 1.45, 0.08, 0.5, 0.6)
    physics.addStaticBox(pierEnd, pierY + 0.55, hz + 1.45, 0.08, 0.5, 0.6)
    for (const dz of [-2.4, 2.4]) {
      const globe = this.services.amenities.addLamp(hx - 26.5, pierY, hz + dz)
      physics.addStaticBox(hx - 26.5, pierY + 1.7, hz + dz, 0.12, 1.7, 0.12)
      void globe
    }
    // Pier gateway on the deck (was inside the wheel envelope at hx − 18.4).
    for (const dz of [-2.05, 2.05]) {
      kit.column(w, hx - 23.2, pierY, hz + dz, 4.2, 0.22)
      physics.addStaticBox(hx - 23.2, pierY + 2.1, hz + dz, 0.28, 2.1, 0.28)
    }
    kit.arch(w, hx - 23.2, hz - 2.05, hx - 23.2, hz + 2.05, pierY + 4.22, 0.9)
    kit.cornice(w, hx - 23.2, hz - 2.05, hx - 23.2, hz + 2.05, pierY + 4.3)

    // ── Rotor: rims, spokes, lattice, hub, gondola pivots ─────────────────
    const rotor = this.rotor
    rotor.position.copy(this.hub)
    for (const sideZ of [-1.35, 1.35]) {
      const rimOuter = new Mesh(new TorusGeometry(RADIUS, 0.32, 10, 96), lib.iron)
      rimOuter.position.z = sideZ
      const rimInner = new Mesh(new TorusGeometry(RADIUS - 1.1, 0.14, 8, 96), lib.brass)
      rimInner.position.z = sideZ
      rotor.add(rimOuter, rimInner)
      for (let i = 0; i < 16; i++) {
        const angle = (i / 16) * Math.PI * 2
        const spoke = new Mesh(new CylinderGeometry(0.09, 0.13, RADIUS - 0.4, 8), lib.iron)
        spoke.position.set(
          Math.sin(angle) * (RADIUS / 2),
          Math.cos(angle) * (RADIUS / 2),
          sideZ,
        )
        spoke.rotation.z = -angle
        rotor.add(spoke)
      }
    }
    // Cross-lattice between the rim pair: a zigzag of thin struts so the two
    // wheels read as one braced machine instead of parallel hoops. Nodes sit
    // every 15° so they land exactly on the gondola pivot angles at the rims
    // (bracing visibly into the pivot bosses) and the struts cross the
    // gondola plane (z = 0) a full 7.5° ≈ 2.6 m from every pivot. The
    // previous 11.25° lattice crossed that plane 0.65 m from half the
    // pivots — centimetres from a rider's camera hanging under the axle —
    // and no phase shift could widen it.
    const latticeProto = new CylinderGeometry(0.065, 0.065, 1, 8)
    const upAxis = new Vector3(0, 1, 0)
    const latticeNode = (j: number) => {
      const angle = (j / 24) * Math.PI * 2
      return new Vector3(
        Math.sin(angle) * RADIUS,
        Math.cos(angle) * RADIUS,
        j % 2 === 0 ? 1.35 : -1.35,
      )
    }
    for (let j = 0; j < 24; j++) {
      const from = latticeNode(j)
      const to = latticeNode((j + 1) % 24)
      const direction = new Vector3().subVectors(to, from)
      const strut = new Mesh(latticeProto, lib.iron)
      strut.position.copy(from).add(to).multiplyScalar(0.5)
      strut.quaternion.setFromUnitVectors(upAxis, direction.clone().normalize())
      strut.scale.set(1, direction.length(), 1)
      rotor.add(strut)
    }
    const drum = new Mesh(new CylinderGeometry(2.1, 2.1, 3.4, 24), lib.verdigris)
    drum.rotation.x = Math.PI / 2
    rotor.add(drum)
    // Hub caps: rosette lathes closing the drum ends over the axle.
    const capGeometry = new LatheGeometry(
      [
        new Vector2(0.6, 0),
        new Vector2(2.08, 0),
        new Vector2(2.1, 0.12),
        new Vector2(1.5, 0.3),
        new Vector2(0.9, 0.42),
        new Vector2(0.62, 0.55),
        new Vector2(0.6, 0),
      ],
      24,
    )
    for (const side of [-1, 1]) {
      const cap = new Mesh(capGeometry, lib.brass)
      cap.rotation.x = side * -Math.PI / 2
      cap.position.z = side * 1.7
      rotor.add(cap)
    }

    // Bulbs along both rims (instanced, warm emissive).
    const bulbCount = 48 * 2
    const bulbs = new InstancedMesh(new SphereGeometry(0.11, 8, 6), lib.lampGlobe, bulbCount)
    const matrix = new Matrix4()
    let b = 0
    for (const sideZ of [-1.75, 1.75]) {
      for (let i = 0; i < 48; i++) {
        const angle = (i / 48) * Math.PI * 2
        matrix.setPosition(Math.sin(angle) * RADIUS, Math.cos(angle) * RADIUS, sideZ)
        bulbs.setMatrixAt(b++, matrix)
      }
    }
    bulbs.instanceMatrix.needsUpdate = true
    rotor.add(bulbs)

    // ── Gondolas: open-air nautilus boats on pendulum pivots ──────────────
    // No glass, no roof — the hull rim sits at chest height so a seated
    // guest looks out freely in every direction. The hull is a closed
    // clockwise lathe with a real interior; the entry gap (bench break +
    // gate posts) faces the pier when docked (local −x — cars never yaw,
    // they cancel rotor spin).
    const hullGeometry = new LatheGeometry(
      [
        new Vector2(0.03, 0),
        new Vector2(0.72, 0.04),
        new Vector2(1.02, 0.3),
        new Vector2(1.14, 0.62),
        new Vector2(1.1, 0.95),
        new Vector2(1.02, 1.16),
        new Vector2(1.05, 1.24),
        new Vector2(0.98, 1.28),
        new Vector2(0.9, 1.2),
        new Vector2(0.86, 0.9),
        new Vector2(0.72, 0.55),
        new Vector2(0.4, 0.42),
        new Vector2(0.03, 0.4),
        new Vector2(0.03, 0),
      ],
      30,
    )
    // Ring bench with its opening toward local −x; finished ends.
    const benchGeometry = new LatheGeometry(
      [
        new Vector2(0.5, 0.18),
        new Vector2(0.78, 0.18),
        new Vector2(0.82, 0.3),
        new Vector2(0.8, 0.4),
        new Vector2(0.84, 0.42),
        new Vector2(0.88, 0.62),
        new Vector2(0.84, 0.66),
        new Vector2(0.8, 0.44),
        new Vector2(0.52, 0.42),
        new Vector2(0.5, 0.18),
      ],
      30,
      Math.PI * 1.25,
      Math.PI * 1.5,
    )
    const benchPanel = new BoxGeometry(0.05, 0.44, 0.3)
    const keelGeometry = new ConeGeometry(0.26, 0.5, 12)
    const armProto = new CylinderGeometry(0.05, 0.065, 1, 10)
    const gatePost = new CylinderGeometry(0.028, 0.034, 0.36, 8)
    const gateBall = new SphereGeometry(0.045, 8, 6)
    const axleTube = new CylinderGeometry(0.06, 0.06, 2.7, 10)
    for (let i = 0; i < GONDOLAS; i++) {
      const angle = (i / GONDOLAS) * Math.PI * 2
      const pivot = new Object3D()
      pivot.position.set(Math.sin(angle) * RADIUS, Math.cos(angle) * RADIUS, 0)
      // Pivot axle spanning the rim pair — the cars visibly hang from it.
      const pivotAxle = new Mesh(axleTube, lib.brass)
      pivotAxle.rotation.x = Math.PI / 2
      pivot.add(pivotAxle)

      const car = new Object3D()
      const hull = new Mesh(hullGeometry, lib.nacre)
      hull.position.y = -2.02
      const bench = new Mesh(benchGeometry, lib.woodDark)
      bench.position.y = -1.62
      const keel = new Mesh(keelGeometry, lib.verdigris)
      keel.rotation.x = Math.PI
      keel.position.y = -2.2
      car.add(hull, bench, keel)
      // Bench end panels close the partial lathe's open cross-sections.
      for (const phi of [Math.PI * 1.25, Math.PI * 2.75]) {
        const panel = new Mesh(benchPanel, lib.woodDark)
        panel.position.set(Math.sin(phi) * 0.69, -1.2, Math.cos(phi) * 0.69)
        panel.rotation.y = phi
        car.add(panel)
        const post = new Mesh(gatePost, lib.brass)
        post.position.set(Math.sin(phi) * 1.0, -0.58, Math.cos(phi) * 1.0)
        const ball = new Mesh(gateBall, lib.brass)
        ball.position.set(Math.sin(phi) * 1.0, -0.38, Math.cos(phi) * 1.0)
        car.add(post, ball)
      }
      // Suspension arms: pivot axle DOWN INTO the hull shoulder at ±z. The
      // rim lip sits at (radius 1.0, y −0.78); the shoulder wall at y −1.05
      // is at radius ≈0.86. Landing the knuckle at (0.82, −1.05) sinks it
      // just inside that wall so the arm plainly plugs into the body instead
      // of perching a knuckle on the rim edge.
      for (const side of [-1, 1]) {
        const from = new Vector3(0, 0, side * 0.35)
        const to = new Vector3(0, -1.05, side * 0.82)
        const direction = new Vector3().subVectors(to, from)
        const arm = new Mesh(armProto, lib.brass)
        arm.position.copy(from).add(to).multiplyScalar(0.5)
        arm.quaternion.setFromUnitVectors(upAxis, direction.clone().normalize())
        arm.scale.set(1, direction.length(), 1)
        const knuckle = new Mesh(gateBall, lib.brass)
        knuckle.position.copy(to)
        car.add(arm, knuckle)
      }
      pivot.add(car)
      rotor.add(pivot)
      this.pivots.push(pivot)
      this.cars.push(car)
      this.swing.push({ angle: 0, velocity: 0 })
    }
    this.group.add(rotor)

    // Boarding geometry: the docked gondola floor rides level with the deck.
    const dockY = pierY + 1.75
    const cosDock = Math.min(1, Math.max(-1, (dockY - hy) / RADIUS))
    // West side of the wheel: local x = sin(a) < 0 branch.
    this.boardingAngle = -Math.acos(cosDock)
    this.rotorAngle = this.boardingAngle
    this.boardingZone.set(pierEnd - 1.2, pierY + 1, hz)

    // No bespoke dressing where the rim breaches the surface (Scott's
    // ruling): the ocean shader owns that interface for EVERY opaque
    // structure — depth-tested intersection and shading from above,
    // framebuffer-refracted Snell window from below — exactly like the
    // arrival pavilion's piles. Decorative foam quads read as floating
    // white patches.

    this.group.add(w.compile())
    this.group.traverse((node) => {
      const mesh = node as Mesh
      if (mesh.isMesh && mesh.material !== lib.glass) {
        mesh.castShadow = true
        mesh.receiveShadow = true
      }
    })
    markDynamicShadowCasters(this.rotor)
    ctx.scene.add(this.group)
    this.updateRotor()

    registerBookmark({
      name: 'wheel',
      position: [hx - 26, pierY + 2.2, hz + 13],
      look: [hx, hy + 6, hz],
      note: 'The Great Wheel from the pier',
    })
    registerBookmark({
      name: 'breach',
      position: [hx - 3, 1.4, hz + 9],
      look: [hx + 2, 3.5, hz - 24],
      note: 'The crest breaching the Silver Ceiling',
    })

    // ── Boarding ──────────────────────────────────────────────────────────
    if (this.player && this.services.interaction) {
      const rig = new VehicleSeatRig(this.player)
      this.rig = rig
      const interaction = this.services.interaction
      const gate = new Vector3(pierEnd - 0.6, pierY + 1.2, hz)
      const exit = new Vector3(pierEnd - 2.2, pierY + 0.1, hz)
      // Seated on the ring bench (seat top at car-local −1.20): eye 0.72 m
      // above the seat, 0.26 m above the hull rim, and 0.42 m clear of the
      // pivot axle overhead. The old (0, −0.1, 0) hung the camera 4 cm off
      // the axle tube — the near plane sliced the "attachment bar" all ride.
      const seatEye = new Vector3(0, -0.48, 0)

      interaction.register({
        position: gate,
        radius: 4.2,
        prompt: 'Board the Great Wheel',
        onInteract: () => {
          if (this.state !== 'boarding' || this.dockedIndex === -1 || rig.seated) return
          this.ridingCar = this.dockedIndex
          this.rideStartAngle = this.rotorAngle
          this.state = 'riding'
          rig.attach(this.cars[this.ridingCar], seatEye, Math.PI / 2, ctx.camera)
          rig.canExit = false
          ctx.events.emit('ticket/punched', { ride: 'great-wheel' })
          ctx.events.emit('ride/wheel-riding', { riding: true })
        },
        enabled: () => this.state === 'boarding' && this.dockedIndex !== -1 && !rig.seated,
      })
      interaction.register({
        position: gate,
        radius: 8,
        prompt: 'Step off the wheel',
        onInteract: () => {
          if (!rig.seated || this.state !== 'unloading') return
          rig.requestExit(exit)
          ctx.events.emit('ride/wheel-riding', { riding: false })
          this.ridingCar = -1
          this.state = 'clearing'
        },
        enabled: () => rig.seated && this.state === 'unloading',
      })
    }
  }

  /** True while the guest stands at the pier-head boarding area. */
  private playerAtDock(): boolean {
    if (!this.player) return false
    const p = this.player.position
    const dx = p.x - this.boardingZone.x
    const dz = p.z - this.boardingZone.z
    return Math.hypot(dx, dz) < 4.5 && Math.abs(p.y - this.boardingZone.y) < 4
  }

  private gondolaAngle(i: number): number {
    return this.rotorAngle + (i / GONDOLAS) * Math.PI * 2
  }

  /** The gondola nearest the dock, and how far it still has to travel. */
  private nextArrival(): { index: number; ahead: number } {
    let best = -1
    let bestAhead = Infinity
    for (let i = 0; i < GONDOLAS; i++) {
      // Distance the rotor must still advance to put gondola i at the dock
      // (rotor angle increases over time).
      const remaining = positiveAngle(this.boardingAngle - this.gondolaAngle(i))
      if (remaining < bestAhead) {
        bestAhead = remaining
        best = i
      }
    }
    return { index: best, ahead: bestAhead }
  }

  private updateRotor(): void {
    this.rotor.rotation.z = -this.rotorAngle
    for (let i = 0; i < GONDOLAS; i++) {
      // Cars cancel the rotor spin and add their pendulum swing.
      this.cars[i].rotation.z = this.rotorAngle + this.swing[i].angle
    }
  }

  update(ctx: GameContext, dt: number): void {
    const cruise = (Math.PI * 2) / PERIOD
    const rig = this.rig
    let target = cruise

    switch (this.state) {
      case 'cruising': {
        target = cruise
        if (this.playerAtDock() && rig && !rig.seated) this.state = 'arriving'
        break
      }
      case 'arriving': {
        // Glide the next gondola into the dock; abort if the guest leaves.
        // Gain 0.3 stays overdamped against the 1.4/s speed easing (no
        // sawing around the dock); the floor keeps the last stretch from
        // crawling. The integration step below lands the angle exactly.
        if (!this.playerAtDock()) {
          this.state = 'cruising'
          break
        }
        target = Math.min(cruise, Math.max(0.03, this.nextArrival().ahead * 0.3))
        break
      }
      case 'boarding': {
        target = 0
        if (!this.playerAtDock()) {
          this.state = 'cruising'
          this.dockedIndex = -1
        }
        break
      }
      case 'riding': {
        // One full revolution at constant cruise — no mid stops, no finish
        // surge. (A previous decel zone here missed its cruise clamp and
        // lurched to ~10× cruise on final approach, then the easing drifted
        // the gondola past the dock.) The integration step below stops the
        // rotor exactly on the boarding angle.
        target = cruise
        break
      }
      case 'unloading': {
        target = 0
        break
      }
      case 'clearing': {
        // Hold still until the guest steps clear of the boarding area.
        target = 0
        if (!this.playerAtDock()) this.state = 'cruising'
        break
      }
    }

    this.speed += (target - this.speed) * Math.min(1, dt * 1.4)
    // Integrate with exact landings: both stops (docking the next gondola
    // for a waiting guest, and finishing the revolution) clamp the step so
    // the rotor halts precisely on the target angle with speed hard-zeroed.
    // The old detect-then-ease stop kept ~0.05 rad/s at detection and its
    // exponential settle carried the gondola ~0.7 m up the rim past the dock.
    let step = this.speed * dt
    if (this.state === 'arriving') {
      const arrival = this.nextArrival()
      if (step >= arrival.ahead) {
        step = arrival.ahead
        this.speed = 0
        this.state = 'boarding'
        this.dockedIndex = arrival.index
      }
    } else if (this.state === 'riding') {
      const remaining = Math.max(0, this.rideStartAngle + Math.PI * 2 - this.rotorAngle)
      if (step >= remaining) {
        step = remaining
        this.speed = 0
        this.state = 'unloading'
        if (rig) rig.canExit = true
      }
    }
    this.rotorAngle += step

    // Pendulum gondolas: tangential drive + gravity + current.
    for (let i = 0; i < GONDOLAS; i++) {
      const s = this.swing[i]
      const pivotWorldX = this.hub.x + Math.sin(this.gondolaAngle(i)) * RADIUS
      const pivotWorldY = this.hub.y + Math.cos(this.gondolaAngle(i)) * RADIUS
      const flow = currentFlowCpu(pivotWorldX, this.hub.z, ctx.time.elapsed)
      const drive = pivotWorldY > 0 ? flow.x * 0.004 : flow.x * 0.012 // air vs water push
      const accel = -(9.81 / 1.9) * Math.sin(s.angle) - s.velocity * 0.55 + drive
      s.velocity += accel * dt
      s.angle += s.velocity * dt
    }
    this.updateRotor()

    rig?.update(ctx.camera, dt)
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
  }
}

/** Wrap an angle difference into [0, 2π): how far the rotor must advance. */
function positiveAngle(delta: number): number {
  const tau = Math.PI * 2
  return ((delta % tau) + tau) % tau
}
