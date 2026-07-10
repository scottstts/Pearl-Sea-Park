import {
  CylinderGeometry,
  LatheGeometry,
  Mesh,
  Object3D,
  PointLight,
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
import { ARRIVAL_POSITION } from '../world/arrival'
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
    this.topY = 2.62 // car floor rests level with the pavilion deck
    this.bottomY = this.terraceY + 0.06
    this.cableTopY = 7.75

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

    // ── Winch over the pavilion shaft mouth ───────────────────────────────
    const frame = new Object3D()
    for (const side of [-1, 1]) {
      const leg = new Mesh(new CylinderGeometry(0.09, 0.12, 4.6, 12), lib.iron)
      leg.position.set(x + side * 1.9, 4.85, z)
      leg.rotation.z = side * 0.38
      frame.add(leg)
    }
    const crossbeam = new Mesh(new CylinderGeometry(0.09, 0.09, 2.6, 12), lib.iron)
    crossbeam.rotation.z = Math.PI / 2
    crossbeam.position.set(x, 6.95, z)
    frame.add(crossbeam)
    const sheave = new Mesh(new TorusGeometry(0.5, 0.09, 10, 30), lib.brass)
    sheave.position.set(x, 6.95, z)
    frame.add(sheave)
    this.group.add(frame)

    // ── The bell car ──────────────────────────────────────────────────────
    const shell = new Mesh(
      new LatheGeometry(
        [
          new Vector2(1.22, 0.16),
          new Vector2(1.3, 0.7),
          new Vector2(1.26, 1.5),
          new Vector2(1.02, 2.15),
          new Vector2(0.55, 2.52),
          new Vector2(0.12, 2.66),
        ],
        40,
      ),
      lib.glass,
    )
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
    // Four brass staves from bottom ring toward the crown.
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4
      const stave = new Mesh(new CylinderGeometry(0.035, 0.045, 2.3, 8), lib.brass)
      stave.position.set(Math.sin(angle) * 1.06, 1.32, Math.cos(angle) * 1.06)
      stave.rotation.z = Math.cos(angle) * 0.14
      stave.rotation.x = -Math.sin(angle) * 0.14
      this.car.add(stave)
    }
    // Interior bench ring (door gap faces the park, -z).
    const bench = new Mesh(new TorusGeometry(0.86, 0.14, 8, 30, Math.PI * 1.4), lib.woodDark)
    bench.rotation.x = Math.PI / 2
    bench.rotation.z = Math.PI * 0.3
    bench.position.y = 0.52
    this.car.add(bench)
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
      const deckExit = new Vector3(x, 2.62, z - 2.6)

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
      // Ride down from the pavilion deck.
      interaction.register({
        position: new Vector3(x, 3.6, z),
        radius: 3.2,
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

      // The opening: the visit begins seated in the bell above the sea.
      if (!ctx.flags.view) {
        this.player.controlEnabled = false
        this.player.placeAt(terraceExit.x, terraceExit.y, terraceExit.z, 0)
        rig.attachImmediate(this.car, seatEye, 0)
        ctx.events.on('park/entered', () => {
          if (this.state === 'docked-top' && rig.seated) {
            this.pendingRun = 'descend'
            this.stateTime = 0
          }
        })
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
