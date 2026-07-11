import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import type { HeldItemSystem } from '../player/heldItems'
import { SlotWriter } from '../archkit/writer'
import type { GameContext } from '../runtime/context'
import type { DistrictServices } from '../world/districts/atrium'
import { PARK_PLAN } from '../world/parkPlan'
import { terrainHeight } from '../world/terrain'
import type { ArmThrow, DynamicProp } from './types'
import { syncDynamicProp } from './types'
import { emitCounterJoinery } from './fixtureDetails'

interface PennyPress {
  motif: string
  crank: Group
  coin: Mesh
  active: boolean
  collected: boolean
  progress: number
  coinDrop: number
}

interface Pellet extends DynamicProp {
  fed: boolean
}

const PRESS_SITES = [
  { motif: 'Descent Bell', x: -8, z: 306 },
  { motif: 'Grand Atrium', x: 16, z: 253 },
  { motif: 'Tidal Court', x: -35, z: 108 },
  { motif: 'Great Wheel', x: 145, z: 58 },
  { motif: 'Carrousel', x: 116, z: 194 },
  { motif: 'Menagerie', x: -145, z: 43 },
  { motif: 'Grotto Pearl', x: 170, z: 132 },
  { motif: 'Leviathan', x: -110, z: -230 },
] as const

/** Park-wide tactile details: feeding, presses, prizes, sweets, pocket model. */
export class SmallWonders {
  readonly group = new Object3D()

  private readonly services: DistrictServices
  private readonly held: HeldItemSystem | null
  private readonly armThrow: ArmThrow
  private readonly presses: PennyPress[] = []
  private readonly pellets: Pellet[] = []
  private hatAvailable = false
  private plushAvailable = false
  private hatTaken = false
  private plushTaken = false
  private hatDisplay: Object3D | null = null
  private plushDisplay: Object3D | null = null
  private modelTaken = false
  private readonly fixtureWriter = new SlotWriter(72)

  constructor(services: DistrictServices, held: HeldItemSystem | null, armThrow: ArmThrow) {
    this.services = services
    this.held = held
    this.armThrow = armThrow
  }

  init(ctx: GameContext): void {
    const lib = this.services.materials.lib
    if (!lib) throw new Error('SmallWonders requires materials')
    this.buildPennyPresses(ctx)
    this.buildFeedingStation(ctx)
    this.buildSweetsKiosk(ctx)
    this.buildPrizeCounter(ctx)
    this.buildPocketModel(ctx)
    this.group.add(this.fixtureWriter.compile())
    ctx.events.on('games/prize-earned', ({ prize }) => {
      if (prize === 'paper-hat') {
        this.hatAvailable = true
        if (this.hatDisplay) this.hatDisplay.visible = true
      } else {
        this.plushAvailable = true
        if (this.plushDisplay) this.plushDisplay.visible = true
      }
    })
    ctx.scene.add(this.group)
  }

  private buildPennyPresses(ctx: GameContext): void {
    const lib = this.services.materials.lib!
    const { physics, interaction } = this.services
    for (const site of PRESS_SITES) {
      const y = terrainHeight(site.x, site.z)
      const root = new Group()
      root.position.set(site.x, y, site.z)
      const cabinet = new Mesh(new BoxGeometry(0.74, 1.25, 0.58), lib.verdigris)
      cabinet.position.y = 0.625
      const face = new Mesh(new CylinderGeometry(0.22, 0.22, 0.08, 28), lib.brass)
      face.rotation.x = Math.PI / 2
      face.position.set(0, 0.82, 0.33)
      const rollers = new Group()
      for (const x of [-0.16, 0.16]) {
        const roller = new Mesh(new CylinderGeometry(0.08, 0.08, 0.4, 16), lib.iron)
        roller.rotation.z = Math.PI / 2
        roller.position.set(x, 0.52, 0.34)
        rollers.add(roller)
      }
      const crank = new Group()
      crank.position.set(0.43, 0.7, 0)
      const axle = new Mesh(new CylinderGeometry(0.035, 0.035, 0.3, 10), lib.brass)
      axle.rotation.z = Math.PI / 2
      const arm = new Mesh(new BoxGeometry(0.04, 0.42, 0.04), lib.brass)
      arm.position.y = -0.19
      const knob = new Mesh(new SphereGeometry(0.065, 14, 9), lib.woodDark)
      knob.position.y = -0.4
      crank.add(axle, arm, knob)
      const coin = new Mesh(new CylinderGeometry(0.105, 0.105, 0.025, 24), lib.brass)
      coin.rotation.x = Math.PI / 2
      coin.position.set(0, 0.36, 0.36)
      coin.visible = false
      root.add(cabinet, face, rollers, crank, coin)
      this.group.add(root)
      physics.addStaticBox(site.x, y + 0.625, site.z, 0.37, 0.625, 0.29)

      const press: PennyPress = {
        motif: site.motif,
        crank,
        coin,
        active: false,
        collected: false,
        progress: 0,
        coinDrop: 0,
      }
      this.presses.push(press)
      interaction?.register({
        position: new Vector3(site.x, y + 0.85, site.z + 0.55),
        radius: 2.2,
        prompt: `Press the ${site.motif} penny`,
        enabled: () => !press.collected && !press.active,
        onInteract: () => {
          press.active = true
          press.progress = 0
        },
      })
    }
    void ctx
  }

  private buildFeedingStation(ctx: GameContext): void {
    const lib = this.services.materials.lib!
    const { physics, interaction } = this.services
    const lagoon = PARK_PLAN.menagerie.turtleLagoon
    const x = lagoon.x + 1.5
    const z = lagoon.z + lagoon.radius + 3
    const y = terrainHeight(x, z)
    const stand = new Mesh(new CylinderGeometry(0.28, 0.4, 1.15, 20), lib.verdigris)
    stand.position.set(x, y + 0.58, z)
    const hopper = new Mesh(new ConeGeometry(0.42, 0.62, 24), lib.brass)
    hopper.rotation.x = Math.PI
    hopper.position.set(x, y + 1.35, z)
    this.group.add(stand, hopper)
    physics.addStaticCylinder(x, y + 0.58, z, 0.58, 0.4)
    interaction?.register({
      position: new Vector3(x, y + 1.1, z),
      radius: 2.5,
      prompt: 'Take a cone of turtle food',
      onInteract: () =>
        this.armThrow({
          kind: 'food-cone',
          remaining: 8,
          spawn: (origin, direction) => this.throwPellet(origin, direction),
        }),
    })
    void ctx
  }

  private throwPellet(origin: Vector3, direction: Vector3): void {
    const { world, rapier } = this.services.physics
    const lib = this.services.materials.lib
    if (!world || !rapier || !lib) return
    const body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(origin.x, origin.y, origin.z)
        .setLinvel(direction.x * 6, direction.y * 6, direction.z * 6)
        .setCcdEnabled(true),
    )
    world.createCollider(
      rapier.ColliderDesc.ball(0.035).setDensity(0.55).setRestitution(0.15).setFriction(0.7),
      body,
    )
    const mesh = new Mesh(new SphereGeometry(0.035, 10, 7), lib.woodDark)
    this.group.add(mesh)
    this.pellets.push({ body, mesh, age: 0, scored: false, fed: false })
  }

  private buildSweetsKiosk(ctx: GameContext): void {
    const lib = this.services.materials.lib!
    const { physics, interaction } = this.services
    const x = 124
    const z = 164
    const y = terrainHeight(x, z)
    const counter = new Mesh(new BoxGeometry(3.4, 1.05, 1.5), lib.canvasCream)
    counter.position.set(x, y + 0.53, z)
    const canopy = new Mesh(new ConeGeometry(2.3, 0.9, 8), lib.nacre)
    canopy.position.set(x, y + 3.1, z)
    const post = new Mesh(new CylinderGeometry(0.08, 0.08, 2.4, 12), lib.brass)
    post.position.set(x, y + 1.9, z)
    this.group.add(counter, canopy, post)
    emitCounterJoinery(this.fixtureWriter, lib, x, y, z, 3.4, 1.5)
    physics.addStaticBox(x, y + 0.53, z, 1.7, 0.53, 0.75)
    interaction?.register({
      position: new Vector3(x, y + 1, z + 1.1),
      radius: 2.7,
      prompt: 'Take a strawberry ice cream',
      onInteract: () => this.held?.holdIceCream(),
    })
    void ctx
  }

  private buildPrizeCounter(ctx: GameContext): void {
    const lib = this.services.materials.lib!
    const { physics, interaction } = this.services
    const x = 78
    const z = 164
    const y = terrainHeight(x, z)
    const counter = new Mesh(new BoxGeometry(4.4, 1.1, 1.4), lib.woodDark)
    counter.position.set(x, y + 0.55, z)
    this.group.add(counter)
    emitCounterJoinery(this.fixtureWriter, lib, x, y, z, 4.4, 1.4)
    physics.addStaticBox(x, y + 0.55, z, 2.2, 0.55, 0.7)

    const hat = new Group()
    const crown = new Mesh(new ConeGeometry(0.34, 0.6, 32, 1, true), lib.canvasCream)
    crown.position.y = 0.36
    const brim = new Mesh(new TorusGeometry(0.38, 0.04, 8, 32), lib.brass)
    brim.rotation.x = Math.PI / 2
    hat.add(crown, brim)
    hat.position.set(x - 0.9, y + 1.18, z)
    hat.visible = false
    this.hatDisplay = hat

    const plush = new Group()
    const body = new Mesh(new SphereGeometry(0.34, 18, 12), lib.nacre)
    body.scale.set(1, 0.9, 0.8)
    plush.add(body)
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2
      const arm = new Mesh(new TorusGeometry(0.2, 0.045, 7, 16, Math.PI * 0.8), lib.nacre)
      arm.rotation.set(Math.PI / 2, angle, angle)
      arm.position.set(Math.cos(angle) * 0.12, -0.24, Math.sin(angle) * 0.12)
      plush.add(arm)
    }
    plush.position.set(x + 0.9, y + 1.45, z)
    plush.visible = false
    this.plushDisplay = plush
    this.group.add(hat, plush)

    interaction?.register({
      position: new Vector3(x - 0.9, y + 1.3, z + 0.9),
      radius: 2.4,
      prompt: 'Wear your paper hat',
      enabled: () => this.hatAvailable && !this.hatTaken,
      onInteract: () => {
        this.hatTaken = true
        hat.visible = false
        this.held?.wearPaperHat()
      },
    })
    interaction?.register({
      position: new Vector3(x + 0.9, y + 1.3, z + 0.9),
      radius: 2.4,
      prompt: 'Take the tiny plush kraken',
      enabled: () => this.plushAvailable && !this.plushTaken,
      onInteract: () => {
        this.plushTaken = true
        plush.visible = false
        this.held?.hold('plush-kraken')
      },
    })
    void ctx
  }

  private buildPocketModel(ctx: GameContext): void {
    const lib = this.services.materials.lib!
    const { physics, interaction } = this.services
    const x = 8
    const z = 258
    const y = terrainHeight(x, z) + 0.18
    const pedestal = new Mesh(new CylinderGeometry(0.55, 0.7, 1.05, 24), lib.marble)
    pedestal.position.set(x, y + 0.52, z)
    const model = new Group()
    const base = new Mesh(new CylinderGeometry(0.34, 0.38, 0.06, 28), lib.brass)
    const dome = new Mesh(new SphereGeometry(0.12, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), lib.glass)
    dome.position.set(0, 0.04, 0.06)
    const wheel = new Mesh(new TorusGeometry(0.13, 0.012, 6, 20), lib.brass)
    wheel.position.set(0.17, 0.14, -0.05)
    model.add(base, dome, wheel)
    model.position.set(x, y + 1.1, z)
    this.group.add(pedestal, model)
    physics.addStaticCylinder(x, y + 0.52, z, 0.52, 0.7)
    interaction?.register({
      position: new Vector3(x, y + 1.1, z),
      radius: 2.2,
      prompt: 'Take the pocket park model',
      enabled: () => !this.modelTaken,
      onInteract: () => {
        this.modelTaken = true
        model.visible = false
        this.held?.hold('park-model')
      },
    })
    void ctx
  }

  fixedUpdate(ctx: GameContext, dt: number): void {
    const lagoon = PARK_PLAN.menagerie.turtleLagoon
    const waterY = terrainHeight(lagoon.x, lagoon.z) + 0.75
    for (let i = this.pellets.length - 1; i >= 0; i--) {
      const pellet = this.pellets[i]
      pellet.age += dt
      const p = pellet.body.translation()
      if (!pellet.fed && Math.hypot(p.x - lagoon.x, p.z - lagoon.z) < lagoon.radius && p.y < waterY + 0.8) {
        pellet.fed = true
        ctx.events.emit('wildlife/turtle-attractor', { x: p.x, y: waterY, z: p.z, strength: 1 })
      }
      if (pellet.age > 18) {
        this.services.physics.world?.removeRigidBody(pellet.body)
        this.group.remove(pellet.mesh)
        this.pellets.splice(i, 1)
      }
    }
  }

  update(ctx: GameContext, dt: number): void {
    for (const pellet of this.pellets) syncDynamicProp(pellet)
    for (const press of this.presses) {
      if (press.active) {
        press.progress = Math.min(1, press.progress + dt / 1.45)
        const eased = press.progress * press.progress * (3 - 2 * press.progress)
        press.crank.rotation.z = eased * Math.PI * 4
        if (press.progress >= 1) {
          press.active = false
          press.collected = true
          press.coin.visible = true
          press.coinDrop = 0.001
          this.held?.addPressedPenny(press.motif)
          this.held?.hold('penny-book')
          ctx.events.emit('games/penny-pressed', { motif: press.motif })
        }
      }
      if (press.coinDrop > 0) {
        press.coinDrop = Math.min(1, press.coinDrop + dt * 2.2)
        press.coin.position.y = 0.36 - press.coinDrop * 0.27
      }
    }
  }

  dispose(ctx: GameContext): void {
    for (const pellet of this.pellets) this.services.physics.world?.removeRigidBody(pellet.body)
    ctx.scene.remove(this.group)
  }

  debugSnapshot(): {
    presses: number
    pennies: number
    pellets: number
    fedPellets: number
    hatAvailable: boolean
    plushAvailable: boolean
  } {
    return {
      presses: this.presses.length,
      pennies: this.presses.filter((press) => press.collected).length,
      pellets: this.pellets.length,
      fedPellets: this.pellets.filter((pellet) => pellet.fed).length,
      hatAvailable: this.hatAvailable,
      plushAvailable: this.plushAvailable,
    }
  }
}
