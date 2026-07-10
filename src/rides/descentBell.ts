import {
  BoxGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  LatheGeometry,
  Mesh,
  Object3D,
  PointLight,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { ArchKit } from '../archkit/modules'
import { SlotWriter } from '../archkit/writer'
import { registerBookmark } from '../core/debug'
import type { PlayerSystem } from '../player/player'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { ARRIVAL_POSITION, CABLE_TOP_Y, DECK_TOP_Y } from '../world/arrival'
import type { DistrictServices } from '../world/districts/atrium'
import { terrainHeight } from '../world/terrain'
import { VehicleSeatRig } from './vehicleSeat'

const DESCENT_SECONDS = 40
const DOCK_DELAY = 2.4

type BellState = 'docked-top' | 'descending' | 'docked-bottom' | 'ascending'

/**
 * The Descent Bell (plan §9.1): a brass-and-glass diving bell on a cable from
 * the buoy pavilion. The game opens inside it — sky and real ocean from
 * above, the waterline crossing, the park revealed in god rays — one unbroken
 * interactive shot. Re-ridable from the terrace and the pavilion forever.
 */
export class DescentBellSystem implements GameSystem {
  readonly id = 'descent-bell'

  private readonly services: DistrictServices
  private readonly player: PlayerSystem | null
  private rig: VehicleSeatRig | null = null

  private readonly group = new Object3D()
  private readonly car = new Object3D()
  private cable: Mesh | null = null

  private state: BellState = 'docked-top'
  private stateTime = 0
  private travel = 0 // 0 = top dock, 1 = terrace
  private pendingRun: 'descend' | 'ascend' | null = null
  private topY = 0
  private bottomY = 0
  private cableTopY = 0
  private terraceY = 0

  constructor(services: DistrictServices, player: PlayerSystem | null) {
    this.services = services
    this.player = player
  }

  init(ctx: GameContext): void {
    const lib = this.services.materials.lib
    if (!lib) throw new Error('DescentBellSystem requires materials')
    const { physics } = this.services
    const kit = new ArchKit(lib)
    const { x, z } = ARRIVAL_POSITION

    this.terraceY = terrainHeight(x, z) + 0.12
    this.topY = 2.62 // car floor rests level with the station deck
    this.bottomY = this.terraceY + 0.06
    this.cableTopY = CABLE_TOP_Y // the station headframe's sheave

    // ── Arrival Terrace: where the bell lands on the seabed ──────────────
    const w = new SlotWriter()
    kit.mosaicPlaza(w, x, this.terraceY - 0.1, z, 6)
    kit.stepsRing(w, x, this.terraceY - 0.2, z, 6)
    physics.addStaticCylinder(x, this.terraceY - 0.01, z, 0.16, 6.55)
    const lamp = (lx: number, lz: number) => {
      const globe = kit.lampPost(w, lx, this.terraceY, lz)
      physics.addStaticBox(lx, this.terraceY + 1.7, lz, 0.12, 1.7, 0.12)
      const light = new PointLight(0xffd9a0, 5.5, 12, 1.8)
      light.position.set(globe.x, globe.y, globe.z)
      this.group.add(light)
    }
    lamp(x - 4.6, z - 3.4)
    lamp(x + 4.6, z - 3.4)
    // Landing ring the bell settles into.
    const pad = new Mesh(new TorusGeometry(1.45, 0.09, 10, 48), lib.brass)
    pad.rotation.x = Math.PI / 2
    pad.position.set(x, this.terraceY + 0.03, z)
    this.group.add(pad)

    // (The headframe, sheave, and winch live in ArrivalSystem — the station
    // owns the architecture; the bell owns the car, cable, and drive.)

    // ── The bell car ──────────────────────────────────────────────────────
    // The glass is mirror-smooth: a coarse faceted profile paints sharp
    // full-screen reflection bands for the guest seated INSIDE it (each flat
    // lathe segment carries one env-reflection tone). Sample a smooth curve
    // through the same envelope so the sheen grades continuously.
    const shellProfile = new CatmullRomCurve3([
      new Vector3(1.22, 0.16, 0),
      new Vector3(1.3, 0.7, 0),
      new Vector3(1.26, 1.5, 0),
      new Vector3(1.02, 2.15, 0),
      new Vector3(0.55, 2.52, 0),
      new Vector3(0.12, 2.66, 0),
    ])
      .getPoints(26)
      .map((p) => new Vector2(p.x, p.y))
    const shell = new Mesh(new LatheGeometry(shellProfile, 48), lib.glass)
    const floor = new Mesh(new CylinderGeometry(1.22, 1.28, 0.1, 32), lib.brass)
    floor.position.y = 0.1
    const bottomRing = new Mesh(new TorusGeometry(1.26, 0.07, 10, 40), lib.brass)
    bottomRing.rotation.x = Math.PI / 2
    bottomRing.position.y = 0.18
    const midRing = new Mesh(new TorusGeometry(1.29, 0.05, 8, 40), lib.brass)
    midRing.rotation.x = Math.PI / 2
    midRing.position.y = 1.1
    const crown = new Mesh(new CylinderGeometry(0.16, 0.3, 0.35, 14), lib.brass)
    crown.position.y = 2.78
    const hook = new Mesh(new TorusGeometry(0.12, 0.035, 8, 18), lib.brass)
    hook.position.y = 3.02
    this.car.add(shell, floor, bottomRing, midRing, crown, hook)
    // Four external cage ribs hugging the glass from the bottom ring to the
    // crown: three struts each, knuckled with sphere joints, seated on the
    // ring and reaching the crown base. (The old single tilted staves had
    // their lean phases transposed and floated free of everything.)
    const ribGeometry = new CylinderGeometry(1, 1, 1, 10)
    const ribUp = new Vector3(0, 1, 0)
    const ribProfile: Array<[number, number]> = [
      [1.28, 0.24],
      [1.325, 1.45],
      [1.05, 2.2],
      [0.45, 2.6],
    ]
    const ribRadii = [0.042, 0.038, 0.032]
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4
      const points = ribProfile.map(
        ([r, y]) => new Vector3(Math.sin(angle) * r, y, Math.cos(angle) * r),
      )
      for (let s = 0; s < 3; s++) {
        const direction = new Vector3().subVectors(points[s + 1], points[s])
        const length = direction.length()
        const rib = new Mesh(ribGeometry, lib.brass)
        rib.position.copy(points[s]).add(points[s + 1]).multiplyScalar(0.5)
        rib.quaternion.setFromUnitVectors(ribUp, direction.normalize())
        rib.scale.set(ribRadii[s], length, ribRadii[s])
        this.car.add(rib)
      }
      for (const knuckle of [points[1], points[2]]) {
        const joint = new Mesh(new SphereGeometry(0.052, 10, 8), lib.brass)
        joint.position.copy(knuckle)
        this.car.add(joint)
      }
    }
    // Interior banquette (door gap faces the park, −z): a sculpted curved
    // seat — dished top, raked backrest with a rolled edge, finished end
    // panels, brass end posts and feet — revolved as a partial lathe. (The
    // old torus arc read as a raw half-tube with open ends.)
    const benchProfile = [
      [0.66, 0.3],
      [0.64, 0.38],
      [0.68, 0.47],
      [0.76, 0.52],
      [0.9, 0.535],
      [1.02, 0.52],
      [1.08, 0.55],
      [1.12, 0.68],
      [1.145, 0.8],
      [1.12, 0.84],
      [1.08, 0.8],
      [1.065, 0.62],
      [1.05, 0.42],
      [1.03, 0.3],
    ].map(([r, y]) => new Vector2(r, y))
    const bench = new Mesh(
      new LatheGeometry(benchProfile, 48, Math.PI * 1.25, Math.PI * 1.5),
      lib.woodDark,
    )
    this.car.add(bench)
    for (const phi of [Math.PI * 1.25, Math.PI * 2.75]) {
      const dirX = Math.sin(phi)
      const dirZ = Math.cos(phi)
      const panel = new Mesh(new BoxGeometry(0.05, 0.56, 0.49), lib.woodDark)
      panel.position.set(dirX * 0.885, 0.53, dirZ * 0.885)
      panel.rotation.y = phi
      const post = new Mesh(new CylinderGeometry(0.042, 0.05, 0.52, 12), lib.brass)
      post.position.set(dirX * 0.7, 0.42, dirZ * 0.7)
      const ball = new Mesh(new SphereGeometry(0.055, 12, 9), lib.brass)
      ball.position.set(dirX * 0.7, 0.71, dirZ * 0.7)
      this.car.add(panel, post, ball)
    }
    for (let leg = 0; leg < 5; leg++) {
      const phi = Math.PI * (1.35 + (1.3 * leg) / 4)
      const foot = new Mesh(new CylinderGeometry(0.032, 0.04, 0.16, 10), lib.brass)
      foot.position.set(Math.sin(phi) * 0.85, 0.23, Math.cos(phi) * 0.85)
      this.car.add(foot)
    }
    const bellLightMesh = new Mesh(new CylinderGeometry(0.09, 0.12, 0.1, 10), lib.lampGlobe)
    bellLightMesh.position.y = 2.45
    this.car.add(bellLightMesh)
    const bellLight = new PointLight(0xffd9a0, 2.6, 6, 1.6)
    bellLight.position.y = 2.2
    this.car.add(bellLight)

    this.car.position.set(x, this.topY, z)
    this.group.add(this.car)

    // Cable — rescaled every frame between winch and crown hook.
    const cable = new Mesh(new CylinderGeometry(0.028, 0.028, 1, 8), lib.iron)
    this.cable = cable
    this.group.add(cable)

    this.group.add(w.compile())
    this.group.traverse((node) => {
      if ((node as Mesh).isMesh && (node as Mesh).material !== lib.glass) {
        node.castShadow = true
        node.receiveShadow = true
      }
    })
    ctx.scene.add(this.group)
    this.updateCable()

    registerBookmark({
      name: 'bell',
      position: [x + 6.5, 4.6, z + 7.5],
      look: [x, 2.9, z],
      note: 'The Descent Bell at the buoy pavilion',
    })

    // ── Boarding, prompts, and the opening sequence ───────────────────────
    if (this.player && this.services.interaction) {
      const rig = new VehicleSeatRig(this.player)
      this.rig = rig
      const interaction = this.services.interaction
      const seatEye = new Vector3(0, 1.45, 0.32)
      const terraceExit = new Vector3(x, this.terraceY + 0.1, z - 2.4)
      const deckExit = new Vector3(x, DECK_TOP_Y, z - 2.9)

      // Ride up from the terrace.
      interaction.register({
        position: new Vector3(x, this.terraceY + 1.2, z),
        radius: 3.4,
        prompt: 'Ride the Descent Bell to the surface',
        onInteract: () => {
          if (this.state !== 'docked-bottom' || rig.seated) return
          rig.attach(this.car, seatEye, 0, ctx.camera)
          ctx.events.emit('ticket/punched', { ride: 'descent-bell' })
          this.pendingRun = 'ascend'
          this.stateTime = 0
        },
        enabled: () => this.state === 'docked-bottom' && !rig.seated,
      })
      // Ride down from the station deck (also the opening move: the guest
      // spawns a step away and boards whenever they choose).
      interaction.register({
        position: new Vector3(x, 3.6, z),
        radius: 3.9,
        prompt: 'Descend into the park',
        onInteract: () => {
          if (this.state !== 'docked-top' || rig.seated) return
          rig.attach(this.car, seatEye, 0, ctx.camera)
          ctx.events.emit('ticket/punched', { ride: 'descent-bell' })
          this.pendingRun = 'descend'
          this.stateTime = 0
        },
        enabled: () => this.state === 'docked-top' && !rig.seated,
      })
      // Step out — the prompt appears only while docked with a guest aboard.
      interaction.register({
        position: new Vector3(x, this.terraceY + 1.4, z),
        radius: 3,
        prompt: 'Step ashore',
        onInteract: () => rig.requestExit(terraceExit),
        enabled: () => rig.seated && rig.canExit && this.state === 'docked-bottom',
      })
      interaction.register({
        position: new Vector3(x, 3.9, z),
        radius: 3,
        prompt: 'Step onto the pavilion',
        onInteract: () => rig.requestExit(deckExit),
        enabled: () => rig.seated && rig.canExit && this.state === 'docked-top',
      })

      // The opening: the visit begins standing on the station deck, free to
      // linger over the waves. Nothing moves until the guest walks to the
      // bell and presses E ("Descend into the park") — no auto-descent.
      if (!ctx.flags.view) {
        this.player.placeAt(x, DECK_TOP_Y, z + 3.4, 0)
      }
    }
  }

  private setState(ctx: GameContext, state: BellState): void {
    this.state = state
    this.stateTime = 0
    ctx.events.emit('ride/bell-state', { state })
  }

  private updateCable(): void {
    if (!this.cable) return
    const { x, z } = ARRIVAL_POSITION
    const top = this.cableTopY
    const hookY = this.car.position.y + 3.0
    const length = Math.max(0.2, top - hookY)
    this.cable.scale.y = length
    this.cable.position.set(x, hookY + length / 2, z)
  }

  update(ctx: GameContext, dt: number): void {
    this.stateTime += dt
    const rig = this.rig

    // Departure delay after boarding/entering.
    if (this.pendingRun && this.stateTime > DOCK_DELAY) {
      if (this.pendingRun === 'descend' && this.state === 'docked-top') {
        this.setState(ctx, 'descending')
      } else if (this.pendingRun === 'ascend' && this.state === 'docked-bottom') {
        this.setState(ctx, 'ascending')
      }
      this.pendingRun = null
      if (rig) rig.canExit = false
    }

    if (this.state === 'descending' || this.state === 'ascending') {
      const direction = this.state === 'descending' ? 1 : -1
      this.travel = Math.min(1, Math.max(0, this.travel + (direction * dt) / DESCENT_SECONDS))
      const t = this.travel
      const eased = t * t * (3 - 2 * t)
      this.car.position.y = this.topY + (this.bottomY - this.topY) * eased
      this.updateCable()
      if (direction === 1 && t >= 1) {
        this.setState(ctx, 'docked-bottom')
        if (rig) rig.canExit = true
      } else if (direction === -1 && t <= 0) {
        this.setState(ctx, 'docked-top')
        if (rig) rig.canExit = true
      }
    } else if (rig && rig.seated && this.pendingRun === null && this.stateTime > DOCK_DELAY) {
      rig.canExit = true
    }

    rig?.update(ctx.camera, dt)
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
  }
}
