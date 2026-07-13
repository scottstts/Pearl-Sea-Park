import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { HeldItemSystem } from '../player/heldItems'
import { SlotWriter } from '../archkit/writer'
import type { GameContext } from '../runtime/context'
import type { DistrictServices } from '../world/districts/atrium'
import { terrainHeight } from '../world/terrain'
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

const PRESS_SITES = [
  { motif: 'Descent Bell', x: -8, z: 306 },
  { motif: 'Grand Atrium', x: 16, z: 253 },
  { motif: 'Tidal Court', x: -35, z: 108 },
  { motif: 'Great Wheel', x: 140.5, z: 60.5 },
  { motif: 'Carrousel', x: 116, z: 194 },
  { motif: 'Menagerie', x: -145, z: 43 },
  // (Relocated from the removed Grotto of Pearls to the Sun Garden's door.)
  { motif: 'Sun Garden', x: -138, z: 66 },
  { motif: 'Leviathan', x: -110, z: -230 },
] as const

/** Park-wide tactile details: feeding, presses, prizes, sweets, pocket model. */
export class SmallWonders {
  readonly group = new Object3D()

  private readonly services: DistrictServices
  private readonly held: HeldItemSystem | null
  private readonly presses: PennyPress[] = []
  private hatAvailable = false
  private plushAvailable = false
  private hatTaken = false
  private plushTaken = false
  private hatDisplay: Object3D | null = null
  private plushDisplay: Object3D | null = null
  private modelTaken = false
  private readonly fixtureWriter = new SlotWriter(72)

  constructor(services: DistrictServices, held: HeldItemSystem | null) {
    this.services = services
    this.held = held
  }

  init(ctx: GameContext): void {
    const lib = this.services.materials.lib
    if (!lib) throw new Error('SmallWonders requires materials')
    this.buildPennyPresses(ctx)
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
      // Arched pediment, motif plaque, and corner pilasters: eight of these
      // stand across the park, so the cabinet earns real joinery. The barrel
      // top is a FULL squashed cylinder half-sunk into the cabinet — a half
      // cylinder leaves its cut plane open and reads see-through from below.
      const pediment = new Mesh(new CylinderGeometry(0.37, 0.37, 0.56, 20), lib.verdigris)
      pediment.rotation.x = Math.PI / 2
      pediment.scale.y = 0.55
      pediment.position.set(0, 1.25, 0)
      const pedimentTrim = new Mesh(new TorusGeometry(0.37, 0.02, 6, 22, Math.PI), lib.brass)
      pedimentTrim.scale.y = 0.55
      pedimentTrim.position.set(0, 1.25, 0.29)
      const plaque = new Mesh(new CylinderGeometry(0.13, 0.13, 0.03, 4), lib.nacre)
      plaque.rotation.x = Math.PI / 2
      plaque.rotation.y = Math.PI / 4
      plaque.position.set(0, 1.32, 0.3)
      root.add(pediment, pedimentTrim, plaque)
      for (const px of [-0.34, 0.34]) {
        const pilaster = new Mesh(new BoxGeometry(0.06, 1.25, 0.06), lib.brass)
        pilaster.position.set(px, 0.625, 0.27)
        root.add(pilaster)
      }
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

  private buildSweetsKiosk(ctx: GameContext): void {
    const lib = this.services.materials.lib!
    const { physics, interaction } = this.services
    const x = 124
    const z = 164
    const y = terrainHeight(x, z)
    const counter = new Mesh(new BoxGeometry(3.4, 1.05, 1.5), lib.canvasCream)
    counter.position.set(x, y + 0.53, z)
    // Parasol canopy with a genuinely scalloped hem (displaced cone rim),
    // pearl finial, and pole collar — a sweets stand, not a tent stake.
    const canopyGeometry = new ConeGeometry(2.3, 0.9, 48, 3, true)
    {
      const position = canopyGeometry.getAttribute('position')
      const vertex = new Vector3()
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i)
        const hem = Math.max(0, Math.min(1, (0.45 - vertex.y) / 0.9))
        const angle = Math.atan2(vertex.x, vertex.z)
        position.setY(i, vertex.y + 0.12 * (0.5 + 0.5 * Math.cos(angle * 12)) * hem * hem)
      }
      position.needsUpdate = true
      canopyGeometry.computeVertexNormals()
    }
    const canopy = new Mesh(canopyGeometry, lib.nacre)
    canopy.position.set(x, y + 3.1, z)
    const finial = new Mesh(new SphereGeometry(0.11, 12, 9), lib.nacre)
    finial.position.set(x, y + 3.62, z)
    const post = new Mesh(new CylinderGeometry(0.08, 0.08, 2.4, 12), lib.brass)
    post.position.set(x, y + 1.9, z)
    const postCollar = new Mesh(new TorusGeometry(0.11, 0.025, 6, 14), lib.brass)
    postCollar.rotation.x = Math.PI / 2
    postCollar.position.set(x, y + 1.12, z)
    this.group.add(counter, canopy, finial, post, postCollar)
    // Two glass cloches on the counter with the goods on display: a trio of
    // strawberry scoops on wafer cones, and a ring of nacre bonbons.
    const scoopMaterial = new MeshStandardNodeMaterial()
    scoopMaterial.color = new Color(0xdf8b9b)
    scoopMaterial.roughness = 0.55
    for (const side of [-1, 1]) {
      const clocheBase = new Mesh(new CylinderGeometry(0.3, 0.33, 0.05, 20), lib.brass)
      clocheBase.position.set(x + side * 0.9, y + 1.08, z + 0.15)
      const cloche = new Mesh(
        new SphereGeometry(0.3, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2),
        lib.glass,
      )
      cloche.position.set(x + side * 0.9, y + 1.1, z + 0.15)
      const clocheKnob = new Mesh(new SphereGeometry(0.035, 8, 6), lib.brass)
      clocheKnob.position.set(x + side * 0.9, y + 1.41, z + 0.15)
      this.group.add(clocheBase, cloche, clocheKnob)
      if (side < 0) {
        for (let i = 0; i < 3; i++) {
          const angle = (i / 3) * Math.PI * 2
          const cx = x + side * 0.9 + Math.sin(angle) * 0.12
          const cz = z + 0.15 + Math.cos(angle) * 0.12
          const cone = new Mesh(new ConeGeometry(0.045, 0.15, 8), lib.canvasCream)
          cone.rotation.x = Math.PI
          cone.position.set(cx, y + 1.18, cz)
          const scoop = new Mesh(new SphereGeometry(0.052, 10, 8), scoopMaterial)
          scoop.position.set(cx, y + 1.27, cz)
          this.group.add(cone, scoop)
        }
      } else {
        for (let i = 0; i < 5; i++) {
          const angle = (i / 5) * Math.PI * 2
          const bonbon = new Mesh(new SphereGeometry(0.045, 10, 8), lib.nacre)
          bonbon.position.set(
            x + side * 0.9 + Math.sin(angle) * 0.13,
            y + 1.13,
            z + 0.15 + Math.cos(angle) * 0.13,
          )
          this.group.add(bonbon)
        }
        const crown = new Mesh(new SphereGeometry(0.05, 10, 8), scoopMaterial)
        crown.position.set(x + side * 0.9, y + 1.19, z + 0.15)
        this.group.add(crown)
      }
    }
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
    // Prize backwall: posts, two display shelves, and standing stock — a
    // bowl of pearls and wrapped sweet boxes — so the counter reads stocked
    // even before any prize is won.
    for (const px of [-2.05, 2.05]) {
      const post = new Mesh(new CylinderGeometry(0.05, 0.06, 2.2, 10), lib.brass)
      post.position.set(x + px, y + 1.1, z - 0.62)
      this.group.add(post)
    }
    for (const shelfY of [1.5, 2.05]) {
      const shelf = new Mesh(new BoxGeometry(4.25, 0.055, 0.42), lib.woodDark)
      shelf.position.set(x, y + shelfY, z - 0.6)
      this.group.add(shelf)
    }
    const bowl = new Mesh(
      new LatheGeometry(
        [
          new Vector2(0.05, 0),
          new Vector2(0.16, 0.01),
          new Vector2(0.24, 0.09),
          new Vector2(0.25, 0.15),
          new Vector2(0.21, 0.14),
          new Vector2(0.12, 0.06),
          new Vector2(0.05, 0.05),
        ],
        18,
      ),
      lib.brass,
    )
    bowl.position.set(x - 1.3, y + 1.53, z - 0.6)
    this.group.add(bowl)
    for (let i = 0; i < 4; i++) {
      const pearl = new Mesh(new SphereGeometry(0.055, 10, 8), lib.nacre)
      const angle = (i / 4) * Math.PI * 2
      pearl.position.set(
        x - 1.3 + Math.sin(angle) * 0.09,
        y + 1.63,
        z - 0.6 + Math.cos(angle) * 0.09,
      )
      this.group.add(pearl)
    }
    for (const [bx, boxY, s] of [
      [0.4, 2.08, 0.85],
      [1.35, 1.53, 1.0],
      [1.62, 1.53, 0.7],
    ] as const) {
      const box = new Mesh(new BoxGeometry(0.26 * s, 0.18 * s, 0.2 * s), lib.canvasCream)
      box.position.set(x + bx, y + boxY + 0.09 * s, z - 0.6)
      box.rotation.y = bx * 1.3
      const ribbon = new Mesh(new BoxGeometry(0.045 * s, 0.19 * s, 0.21 * s), lib.verdigris)
      ribbon.position.copy(box.position)
      ribbon.rotation.y = box.rotation.y
      this.group.add(box, ribbon)
    }

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

  update(ctx: GameContext, dt: number): void {
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
    ctx.scene.remove(this.group)
  }

  debugSnapshot(): {
    presses: number
    pennies: number
    hatAvailable: boolean
    plushAvailable: boolean
  } {
    return {
      presses: this.presses.length,
      pennies: this.presses.filter((press) => press.collected).length,
      hatAvailable: this.hatAvailable,
      plushAvailable: this.plushAvailable,
    }
  }
}
