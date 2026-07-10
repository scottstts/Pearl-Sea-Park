import {
  BoxGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
} from 'three'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { abs, mix, positionGeometry, smoothstep, vec3, vec4 } from 'three/tsl'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'

export type HeldItemKind =
  | 'ticket'
  | 'ring'
  | 'pearl'
  | 'coin'
  | 'food-cone'
  | 'ice-cream'
  | 'plush-kraken'
  | 'penny-book'
  | 'park-model'

const REQUIRED_RIDE_STAMPS = [
  'descent-bell',
  'pearl-line',
  'great-wheel',
  'carousel',
  'torrent',
  'grotto',
] as const

/**
 * First-person prop collection. One object occupies the hand rig at a time;
 * paper hat lives on its own camera child so its brim remains visible while a
 * prize or food is held. The ticket and penny book are the only progress
 * surfaces in the game — still no HUD or inventory panel.
 */
export class HeldItemSystem implements GameSystem {
  readonly id = 'held-items'

  private rig: Group | null = null
  private hat: Group | null = null
  private ticketFace: Group | null = null
  private pennyBook: Group | null = null
  private iceCreamScoop: Mesh | null = null
  private readonly items = new Map<HeldItemKind, Group>()
  private readonly lastCameraQuaternion = new Quaternion()
  private readonly ticketStamps = new Set<string>()
  private readonly pressedPennies = new Set<string>()
  private readonly owned = new Set<HeldItemKind>(['ticket'])
  private swayX = 0
  private swayY = 0
  private rigVisible = true
  private activeKind: HeldItemKind = 'ticket'
  private hatWorn = false
  private ticketComplete = false
  private iceCreamMelt = 0

  init(ctx: GameContext): void {
    ctx.scene.add(ctx.camera)
    const rig = new Group()
    rig.position.set(0.27, -0.22, -0.52)
    ctx.camera.add(rig)
    this.rig = rig

    this.addItem('ticket', this.createTicket())
    this.addItem('ring', this.createRing())
    this.addItem('pearl', this.createPearl())
    this.addItem('coin', this.createCoin())
    this.addItem('food-cone', this.createFoodCone())
    this.addItem('ice-cream', this.createIceCream())
    this.addItem('plush-kraken', this.createPlushKraken())
    this.addItem('penny-book', this.createPennyBook())
    this.addItem('park-model', this.createParkModel())
    this.hold('ticket')

    const hat = this.createPaperHat()
    hat.visible = false
    ctx.camera.add(hat)
    this.hat = hat

    this.lastCameraQuaternion.copy(ctx.camera.quaternion)
    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyT') {
        this.rigVisible = !this.rigVisible
      } else if (event.code === 'Digit1') {
        this.hold('ticket')
      } else if (event.code === 'Digit2' && this.pressedPennies.size > 0) {
        this.hold('penny-book')
      } else if (event.code === 'Digit3' && this.owned.has('park-model')) {
        this.hold('park-model')
      } else if (event.code === 'Digit4' && this.owned.has('plush-kraken')) {
        this.hold('plush-kraken')
      }
    })

    ctx.events.on('ticket/punched', ({ ride }) => {
      if (this.ticketStamps.has(ride)) return
      this.ticketStamps.add(ride)
      this.addTicketStamp(ride)
      if (
        !this.ticketComplete &&
        REQUIRED_RIDE_STAMPS.every((required) => this.ticketStamps.has(required))
      ) {
        this.ticketComplete = true
        ctx.events.emit('ticket/completed', { stamps: REQUIRED_RIDE_STAMPS.length })
      }
    })
  }

  hold(kind: HeldItemKind): void {
    if (['plush-kraken', 'penny-book', 'park-model'].includes(kind)) this.owned.add(kind)
    this.activeKind = kind
    for (const [name, item] of this.items) item.visible = name === kind
  }

  holdIceCream(): void {
    this.iceCreamMelt = 0
    if (this.iceCreamScoop) {
      this.iceCreamScoop.scale.set(1, 1, 1)
      this.iceCreamScoop.position.y = 0.075
    }
    this.hold('ice-cream')
  }

  wearPaperHat(): void {
    this.hatWorn = true
    if (this.hat) this.hat.visible = true
  }

  addPressedPenny(motif: string): void {
    if (this.pressedPennies.has(motif)) return
    this.pressedPennies.add(motif)
    const book = this.pennyBook
    if (!book) return
    const index = this.pressedPennies.size - 1
    const marker = new Mesh(new CylinderGeometry(0.009, 0.009, 0.0018, 20), metal(0xb7672e, 0.56, 0.72))
    marker.rotation.x = Math.PI / 2
    marker.position.set(-0.035 + (index % 4) * 0.023, 0.022 - Math.floor(index / 4) * 0.025, 0.008)
    book.add(marker)
  }

  get stampCount(): number {
    return this.ticketStamps.size
  }

  get pennyCount(): number {
    return this.pressedPennies.size
  }

  get currentItem(): HeldItemKind {
    return this.activeKind
  }

  update(ctx: GameContext, dt: number): void {
    const rig = this.rig
    if (!rig) return
    const current = ctx.camera.quaternion
    const dx = current.x - this.lastCameraQuaternion.x
    const dy = current.y - this.lastCameraQuaternion.y
    this.lastCameraQuaternion.copy(current)
    this.swayX += (-dy * 2.4 - this.swayX) * Math.min(1, dt * 7)
    this.swayY += (dx * 2 - this.swayY) * Math.min(1, dt * 7)
    rig.position.x = 0.27 + this.swayX * 0.15
    rig.position.y = -0.22 + this.swayY * 0.12 + Math.sin(ctx.time.elapsed * 1.1) * 0.0035
    rig.rotation.z = this.swayX * 0.35
    rig.rotation.x = this.swayY * 0.3
    const target = this.rigVisible ? 1 : 0
    const s = rig.scale.x + (target - rig.scale.x) * Math.min(1, dt * 9)
    rig.scale.setScalar(Math.max(0.0001, s))

    if (this.activeKind === 'ice-cream' && this.iceCreamScoop) {
      this.iceCreamMelt = Math.min(1, this.iceCreamMelt + dt / 150)
      const meltScale = 1 - this.iceCreamMelt * 0.72
      this.iceCreamScoop.scale.set(1 + this.iceCreamMelt * 0.08, meltScale, 1 + this.iceCreamMelt * 0.08)
      this.iceCreamScoop.position.y = 0.075 - this.iceCreamMelt * 0.035
    }
    if (this.hat) this.hat.visible = this.hatWorn
  }

  dispose(ctx: GameContext): void {
    if (this.rig) ctx.camera.remove(this.rig)
    if (this.hat) ctx.camera.remove(this.hat)
    for (const root of [this.rig, this.hat]) {
      root?.traverse((object) => {
        if (!(object instanceof Mesh)) return
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        for (const material of materials) material.dispose()
      })
    }
  }

  private addItem(kind: HeldItemKind, item: Group): void {
    item.visible = false
    this.items.set(kind, item)
    this.rig?.add(item)
  }

  private createTicket(): Group {
    const root = new Group()
    const material = new MeshBasicNodeMaterial()
    const uv = positionGeometry.xy
    const edge = smoothstep(0.062, 0.058, abs(uv.x).max(abs(uv.y).mul(1.78)))
    const border = smoothstep(0.052, 0.05, abs(uv.x).max(abs(uv.y).mul(1.78)))
    const gold = vec3(0.85, 0.68, 0.32)
    const card = vec3(0.93, 0.88, 0.78)
    const face = mix(gold, mix(card, gold.mul(0.85), border.sub(edge).abs()), edge)
    material.colorNode = vec4(face, 1)
    const cardMesh = new Mesh(new PlaneGeometry(0.13, 0.073), material)
    root.add(cardMesh)
    root.rotation.set(-0.5, 0.22, 0.12)
    this.ticketFace = root
    return root
  }

  private addTicketStamp(ride: string): void {
    const root = this.ticketFace
    if (!root) return
    const index = this.ticketStamps.size - 1
    const stamp = new Mesh(new CircleGeometry(0.0048, 18), basic(ride === 'atrium' ? 0x9d7a2d : 0x8f2934))
    stamp.position.set(-0.041 + (index % 4) * 0.027, 0.018 - Math.floor(index / 4) * 0.027, 0.001)
    root.add(stamp)
  }

  private createRing(): Group {
    const root = new Group()
    const ring = new Mesh(new TorusGeometry(0.055, 0.006, 10, 32), metal(0xd6a544, 0.24, 0.82))
    ring.rotation.set(0.35, -0.22, 0.18)
    root.add(ring)
    return root
  }

  private createPearl(): Group {
    const root = new Group()
    root.add(new Mesh(new SphereGeometry(0.034, 24, 16), metal(0xf4e9d8, 0.12, 0.18)))
    return root
  }

  private createCoin(): Group {
    const root = new Group()
    const coin = new Mesh(new CylinderGeometry(0.022, 0.022, 0.004, 24), metal(0xd7a33b, 0.28, 0.76))
    coin.rotation.x = Math.PI / 2
    root.add(coin)
    return root
  }

  private createFoodCone(): Group {
    const root = new Group()
    const cone = new Mesh(new ConeGeometry(0.045, 0.13, 20), standard(0xc88c52, 0.86, 0))
    cone.rotation.z = Math.PI
    cone.position.y = -0.035
    root.add(cone)
    for (let i = 0; i < 7; i++) {
      const pellet = new Mesh(new SphereGeometry(0.009, 10, 7), standard(0x76512c, 1, 0))
      pellet.position.set((i % 3 - 1) * 0.017, 0.036 + Math.floor(i / 3) * 0.012, (i % 2 - 0.5) * 0.012)
      root.add(pellet)
    }
    return root
  }

  private createIceCream(): Group {
    const root = new Group()
    const cone = new Mesh(new ConeGeometry(0.045, 0.12, 20), standard(0xd99b61, 0.82, 0))
    cone.rotation.z = Math.PI
    cone.position.y = -0.025
    const scoop = new Mesh(new SphereGeometry(0.056, 24, 16), standard(0xf2b9c6, 0.5, 0))
    scoop.position.y = 0.075
    this.iceCreamScoop = scoop
    root.add(cone, scoop)
    return root
  }

  private createPlushKraken(): Group {
    const root = new Group()
    const fabric = standard(0x8b4777, 0.95, 0)
    const body = new Mesh(new SphereGeometry(0.055, 20, 14), fabric)
    body.scale.set(1, 0.9, 0.8)
    root.add(body)
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2
      const tentacle = new Mesh(new TorusGeometry(0.035, 0.008, 7, 16, Math.PI * 0.8), fabric)
      tentacle.rotation.set(Math.PI / 2, angle, angle)
      tentacle.position.set(Math.cos(angle) * 0.025, -0.045, Math.sin(angle) * 0.025)
      root.add(tentacle)
    }
    root.rotation.set(-0.2, 0.2, 0.08)
    return root
  }

  private createPennyBook(): Group {
    const root = new Group()
    const cover = new Mesh(new BoxGeometry(0.105, 0.075, 0.012), standard(0x4e1830, 0.92, 0))
    const page = new Mesh(new BoxGeometry(0.096, 0.068, 0.013), standard(0xe6d4b5, 0.9, 0))
    page.position.z = 0.002
    root.add(cover, page)
    root.rotation.set(-0.48, 0.18, 0.1)
    this.pennyBook = root
    return root
  }

  private createParkModel(): Group {
    const root = new Group()
    const base = new Mesh(new CylinderGeometry(0.07, 0.075, 0.012, 32), metal(0xb78c3d, 0.4, 0.55))
    const dome = new Mesh(new SphereGeometry(0.024, 16, 9, 0, Math.PI * 2, 0, Math.PI / 2), standard(0x7caeb5, 0.18, 0.15))
    dome.position.set(0, 0.007, 0.012)
    const wheel = new Mesh(new TorusGeometry(0.026, 0.0025, 6, 20), metal(0xd4a548, 0.25, 0.8))
    wheel.position.set(0.035, 0.025, -0.012)
    root.add(base, dome, wheel)
    root.rotation.set(-0.38, 0.24, 0.08)
    return root
  }

  private createPaperHat(): Group {
    const root = new Group()
    const paper = standard(0xe8d7ac, 0.9, 0)
    const brim = new Mesh(new TorusGeometry(0.3, 0.018, 8, 48, Math.PI), paper)
    brim.rotation.z = Math.PI
    brim.scale.y = 0.32
    root.add(brim)
    root.position.set(0, 0.23, -0.28)
    return root
  }
}

function standard(color: number, roughness: number, metalness: number): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial()
  material.color = new Color(color)
  material.roughness = roughness
  material.metalness = metalness
  return material
}

function metal(color: number, roughness: number, metalness: number): MeshStandardNodeMaterial {
  return standard(color, roughness, metalness)
}

function basic(color: number): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial()
  material.color = new Color(color)
  return material
}
