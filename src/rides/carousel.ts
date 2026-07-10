import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  Object3D,
  PointLight,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { ArchKit } from '../archkit/modules'
import { SlotWriter } from '../archkit/writer'
import { registerBookmark } from '../core/debug'
import type { PlayerSystem } from '../player/player'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { DistrictServices } from '../world/districts/atrium'
import { PARK_PLAN } from '../world/parkPlan'
import { terrainHeight } from '../world/terrain'
import { VehicleSeatRig } from './vehicleSeat'

const PERIOD = 26 // seconds per revolution
const RIDE_SECONDS = 34
const STOP_SECONDS = 14
const BOB_AMPLITUDE = 0.22

interface Mount {
  group: Object3D
  figure: Object3D
  rod: Mesh
  rodTopY: number
  figureBaseY: number
  phase: number
  name: string
  interactPosition: Vector3
}

/**
 * Carrousel des Abysses (plan §9.4): two decks, plump nacre-and-brass sea
 * mounts on crank rods that actually connect, mirror core, canopy, bulbs.
 * The platform runs, pauses on a timetable, and guests pick a mount by
 * looking at it. The music-box waltz drifts across the lagoon (audio engine).
 */
export class CarouselSystem implements GameSystem {
  readonly id = 'carousel'

  /** World center — the audio engine aims the waltz here. */
  readonly center = new Vector3()

  private readonly services: DistrictServices
  private readonly player: PlayerSystem | null
  private rig: VehicleSeatRig | null = null

  private readonly group = new Object3D()
  private readonly rotor = new Object3D()
  private readonly mounts: Mount[] = []
  private rotorAngle = 0
  private speed = 0
  private phaseClock = 0
  private stopped = true
  private riding = -1

  constructor(services: DistrictServices, player: PlayerSystem | null) {
    this.services = services
    this.player = player
  }

  init(ctx: GameContext): void {
    const lib = this.services.materials.lib
    if (!lib) throw new Error('CarouselSystem requires materials')
    const { physics } = this.services
    const kit = new ArchKit(lib)
    const w = new SlotWriter()
    const { x: cx, z: cz, plazaRadius } = PARK_PLAN.carousel
    const ground = terrainHeight(cx, cz)
    const plazaY = ground + 0.3
    this.center.set(cx, plazaY + 2, cz)

    // ── Plaza ─────────────────────────────────────────────────────────────
    kit.mosaicPlaza(w, cx, plazaY - 0.1, cz, plazaRadius)
    kit.stepsRing(w, cx, plazaY - 0.24, cz, plazaRadius)
    physics.addStaticCylinder(cx, ground + 0.1, cz, 0.09, plazaRadius + 0.7)
    physics.addStaticCylinder(cx, ground + 0.26, cz, 0.09, plazaRadius + 0.1)
    for (const [dx, dz, lit] of [
      [-plazaRadius + 1.5, -3, true],
      [plazaRadius - 1.5, 3, true],
      [3, plazaRadius - 1.5, false],
      [-3, -plazaRadius + 1.5, false],
    ] as const) {
      const globe = kit.lampPost(w, cx + dx, plazaY, cz + dz)
      physics.addStaticBox(cx + dx, plazaY + 1.7, cz + dz, 0.12, 1.7, 0.12)
      if (lit) {
        const light = new PointLight(0xffd9a0, 5.5, 12, 1.8)
        light.position.set(globe.x, globe.y, globe.z)
        this.group.add(light)
      }
    }

    // ── Static base ───────────────────────────────────────────────────────
    const baseTop = plazaY + 0.42
    const base = new Mesh(new CylinderGeometry(8.05, 8.35, 0.42, 48), lib.marble)
    base.position.set(cx, plazaY + 0.21, cz)
    this.group.add(base)
    physics.addStaticCylinder(cx, plazaY + 0.5, cz, 0.5, 8.1)

    // ── Rotor ─────────────────────────────────────────────────────────────
    const rotor = this.rotor
    rotor.position.set(cx, baseTop, cz)

    const floor = new Mesh(new CylinderGeometry(7.6, 7.6, 0.14, 48), lib.woodDark)
    floor.position.y = 0.07
    const skirt = new Mesh(new CylinderGeometry(7.66, 7.66, 0.55, 48, 1, true), lib.canvasCream)
    skirt.position.y = 0.2
    rotor.add(floor, skirt)

    // Mirror core with brass fluting.
    const mirror = new MeshStandardNodeMaterial()
    mirror.color = new Color(0xf4f6f8)
    mirror.metalness = 1
    mirror.roughness = 0.08
    mirror.envMapIntensity = 1.3
    const core = new Mesh(new CylinderGeometry(1.7, 1.8, 3.7, 32), mirror)
    core.position.y = 2.0
    rotor.add(core)
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2
      const flute = new Mesh(new BoxGeometry(0.09, 3.7, 0.09), lib.brass)
      flute.position.set(Math.sin(angle) * 1.82, 2.0, Math.cos(angle) * 1.82)
      rotor.add(flute)
    }

    // Upper deck ring + rail.
    const upperDeck = new Mesh(
      new LatheGeometry(
        [
          new Vector2(1.95, 0),
          new Vector2(6.35, 0),
          new Vector2(6.35, 0.14),
          new Vector2(1.95, 0.14),
          new Vector2(1.95, 0),
        ],
        48,
      ),
      lib.woodDark,
    )
    upperDeck.position.y = 4.1
    const upperRail = new Mesh(new TorusGeometry(6.3, 0.05, 8, 48), lib.brass)
    upperRail.rotation.x = Math.PI / 2
    upperRail.position.y = 5.0
    rotor.add(upperDeck, upperRail)
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2
      const post = new Mesh(new CylinderGeometry(0.03, 0.03, 0.86, 6), lib.brass)
      post.position.set(Math.sin(angle) * 6.3, 4.62, Math.cos(angle) * 6.3)
      rotor.add(post)
      const strut = new Mesh(new CylinderGeometry(0.06, 0.07, 3.9, 8), lib.brass)
      strut.position.set(Math.sin(angle + 0.1) * 6.9, 2.1, Math.cos(angle + 0.1) * 6.9)
      rotor.add(strut)
    }

    // Canopy + finial.
    const canopy = new Mesh(new ConeGeometry(8.7, 2.6, 48, 1, true), lib.canvasCream)
    canopy.position.y = 7.55
    const canopyRing = new Mesh(new TorusGeometry(8.62, 0.1, 10, 64), lib.brass)
    canopyRing.rotation.x = Math.PI / 2
    canopyRing.position.y = 6.3
    const finial = new Mesh(new SphereGeometry(0.42, 16, 12), lib.brass)
    finial.position.y = 9.05
    rotor.add(canopy, canopyRing, finial)

    // Bulbs: canopy edge + upper-deck edge + core crown.
    const bulbSpecs: [number, number, number][] = []
    for (let i = 0; i < 36; i++) {
      const angle = (i / 36) * Math.PI * 2
      bulbSpecs.push([Math.sin(angle) * 8.55, 6.32, Math.cos(angle) * 8.55])
    }
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 2
      bulbSpecs.push([Math.sin(angle) * 6.42, 4.28, Math.cos(angle) * 6.42])
    }
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2
      bulbSpecs.push([Math.sin(angle) * 1.55, 3.95, Math.cos(angle) * 1.55])
    }
    const bulbs = new InstancedMesh(new SphereGeometry(0.075, 8, 6), lib.lampGlobe, bulbSpecs.length)
    const matrix = new Matrix4()
    bulbSpecs.forEach(([bx, by, bz], i) => {
      matrix.setPosition(bx, by, bz)
      bulbs.setMatrixAt(i, matrix)
    })
    bulbs.instanceMatrix.needsUpdate = true
    rotor.add(bulbs)

    // ── Mounts ────────────────────────────────────────────────────────────
    const materials = mountMaterials(lib)
    const lower = 16
    const upper = 8
    for (let i = 0; i < lower + upper; i++) {
      const isUpper = i >= lower
      const index = isUpper ? i - lower : i
      const count = isUpper ? upper : lower
      const angle = (index / count) * Math.PI * 2 + (isUpper ? Math.PI / upper : 0)
      const radius = isUpper ? 4.9 : index % 2 === 0 ? 6.6 : 5.4
      const deckY = isUpper ? 4.24 : 0.14
      const overheadY = isUpper ? 6.35 : 4.02

      const mountGroup = new Object3D()
      mountGroup.position.set(Math.sin(angle) * radius, deckY, Math.cos(angle) * radius)
      // Face the direction of travel (+z after lookAt).
      const forward = new Vector3(Math.cos(angle), 0, -Math.sin(angle))
      mountGroup.lookAt(mountGroup.position.clone().add(forward))

      const poleHeight = overheadY - deckY
      const pole = new Mesh(new CylinderGeometry(0.045, 0.05, poleHeight, 10), lib.brass)
      pole.position.y = poleHeight / 2
      mountGroup.add(pole)

      const kind = MOUNT_KINDS[i % MOUNT_KINDS.length]
      const figure = buildMount(kind, materials)
      const figureBaseY = 0.62
      figure.position.y = figureBaseY
      mountGroup.add(figure)

      const rodTopY = poleHeight - 0.12
      const rod = new Mesh(new CylinderGeometry(0.026, 0.026, 1, 8), lib.iron)
      mountGroup.add(rod)

      rotor.add(mountGroup)
      this.mounts.push({
        group: mountGroup,
        figure,
        rod,
        rodTopY,
        figureBaseY,
        phase: (i * Math.PI * 2) / 7.3,
        name: kind,
        interactPosition: new Vector3(),
      })
    }

    this.group.add(rotor)
    this.group.add(w.compile())
    this.group.traverse((node) => {
      const mesh = node as Mesh
      if (mesh.isMesh) {
        mesh.castShadow = true
        mesh.receiveShadow = true
      }
    })
    ctx.scene.add(this.group)
    this.updateRotor(0)

    registerBookmark({
      name: 'carousel',
      position: [cx + 15, plazaY + 4.5, cz + 13],
      look: [cx, plazaY + 3, cz],
      note: 'Carrousel des Abysses',
    })

    // ── Boarding: look at a mount while the platform rests ───────────────
    if (this.player && this.services.interaction) {
      const rig = new VehicleSeatRig(this.player)
      this.rig = rig
      const interaction = this.services.interaction
      const exit = new Vector3(cx, plazaY + 0.1, cz - plazaRadius + 2.2)

      this.mounts.forEach((mount, i) => {
        interaction.register({
          position: mount.interactPosition,
          radius: 5.5,
          prompt: `Ride the ${mount.name}`,
          onInteract: () => {
            if (!this.stopped || rig.seated) return
            this.riding = i
            rig.attach(mount.figure, new Vector3(0, 1.28, -0.52), Math.PI, ctx.camera)
            ctx.events.emit('ticket/punched', { ride: 'carousel' })
            ctx.events.emit('ride/carousel-riding', { riding: true })
          },
          enabled: () => this.stopped && !rig.seated,
        })
      })
      interaction.register({
        position: this.center,
        radius: 12,
        prompt: 'Dismount',
        onInteract: () => {
          if (!rig.seated || this.riding === -1) return
          rig.requestExit(exit)
          ctx.events.emit('ride/carousel-riding', { riding: false })
          this.riding = -1
        },
        enabled: () => rig.seated && this.riding !== -1 && this.stopped,
      })
    }
  }

  private updateRotor(elapsed: number): void {
    this.rotor.rotation.y = this.rotorAngle
    for (const mount of this.mounts) {
      const bob =
        BOB_AMPLITUDE * Math.sin(this.rotorAngle * 3.1 + mount.phase) * (this.speed > 0.02 ? 1 : 0.15)
      mount.figure.position.y = mount.figureBaseY + bob
      // Crank rod: from the overhead anchor down to the figure's back.
      const topOfFigure = mount.figure.position.y + 0.95
      const length = Math.max(0.2, mount.rodTopY - topOfFigure)
      mount.rod.scale.y = length
      mount.rod.position.y = topOfFigure + length / 2
      // Interact anchors follow the mounts (world position).
      mount.group.getWorldPosition(mount.interactPosition)
      mount.interactPosition.y += 1.2
    }
    void elapsed
  }

  update(ctx: GameContext, dt: number): void {
    // Timetable: run RIDE_SECONDS, rest STOP_SECONDS, forever.
    this.phaseClock += dt
    const cycle = RIDE_SECONDS + STOP_SECONDS
    const inStop = this.phaseClock % cycle > RIDE_SECONDS
    this.stopped = inStop && this.speed < 0.02
    const target = inStop ? 0 : (Math.PI * 2) / PERIOD
    this.speed += (target - this.speed) * Math.min(1, dt * 0.9)
    this.rotorAngle += this.speed * dt
    this.updateRotor(ctx.time.elapsed)
    this.rig?.update(ctx.camera, dt)
    if (this.rig && this.riding !== -1) this.rig.canExit = this.stopped
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
  }
}

const MOUNT_KINDS = ['seahorse', 'dolphin', 'turtle', 'ray', 'narwhal', 'nautilus chariot'] as const
type MountKind = (typeof MOUNT_KINDS)[number]

interface MountMaterials {
  nacre: MeshStandardNodeMaterial
  coral: MeshStandardNodeMaterial
  teal: MeshStandardNodeMaterial
  brass: MeshStandardNodeMaterial
  wood: MeshStandardNodeMaterial
}

function mountMaterials(lib: {
  nacre: MeshStandardNodeMaterial
  brass: MeshStandardNodeMaterial
  woodDark: MeshStandardNodeMaterial
}): MountMaterials {
  const tint = (hex: number, roughness: number) => {
    const material = new MeshStandardNodeMaterial()
    material.color = new Color(hex)
    material.roughness = roughness
    material.metalness = 0
    return material
  }
  return {
    nacre: lib.nacre,
    coral: tint(0xd96a5f, 0.55),
    teal: tint(0x3f8f86, 0.5),
    brass: lib.brass,
    wood: lib.woodDark,
  }
}

/** Plump, toy-like sea mounts from primitive compositions (plan §2 shape). */
function buildMount(kind: MountKind, m: MountMaterials): Object3D {
  const g = new Object3D()
  const add = (mesh: Mesh, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) => {
    mesh.position.set(x, y, z)
    mesh.scale.set(sx, sy, sz)
    mesh.rotation.x = rx
    mesh.rotation.z = rz
    g.add(mesh)
    return mesh
  }
  const sphere = (mat: MeshStandardNodeMaterial) => new Mesh(new SphereGeometry(1, 18, 14), mat)
  const cone = (mat: MeshStandardNodeMaterial) => new Mesh(new ConeGeometry(1, 1, 14), mat)

  if (kind === 'seahorse') {
    add(sphere(m.nacre), 0, 0.05, 0.02, 0.3, 0.42, 0.26) // belly
    add(sphere(m.nacre), 0, 0.52, 0.14, 0.22, 0.28, 0.2) // chest
    add(sphere(m.nacre), 0, 0.86, 0.2, 0.17, 0.19, 0.17) // head
    add(cone(m.coral), 0, 0.84, 0.44, 0.07, 0.3, 0.07, Math.PI / 2, 0) // snout
    const tail = new Mesh(new TorusGeometry(0.22, 0.08, 8, 18, Math.PI * 1.6), m.nacre)
    add(tail, 0, -0.34, -0.08, 1, 1, 1, 0, Math.PI / 2)
    add(cone(m.coral), 0, 0.62, -0.16, 0.2, 0.34, 0.06, -0.5, 0) // dorsal fin
  } else if (kind === 'dolphin') {
    add(sphere(m.teal), 0, 0.28, 0, 0.3, 0.3, 0.62) // body
    add(sphere(m.nacre), 0, 0.16, 0.1, 0.24, 0.2, 0.5) // belly
    add(cone(m.teal), 0, 0.3, 0.72, 0.14, 0.34, 0.14, Math.PI / 2, 0) // rostrum
    add(cone(m.teal), 0, 0.66, -0.05, 0.16, 0.3, 0.07, -0.4, 0) // dorsal
    add(cone(m.teal), 0.02, 0.3, -0.68, 0.34, 0.2, 0.08, Math.PI / 2, Math.PI / 2) // flukes
  } else if (kind === 'turtle') {
    add(sphere(m.teal), 0, 0.3, 0, 0.44, 0.3, 0.52) // shell
    add(sphere(m.coral), 0, 0.16, 0, 0.4, 0.16, 0.46) // plastron
    add(sphere(m.nacre), 0, 0.34, 0.56, 0.16, 0.15, 0.17) // head
    for (const [fx, fz] of [
      [-0.42, 0.3],
      [0.42, 0.3],
      [-0.4, -0.34],
      [0.4, -0.34],
    ]) {
      add(sphere(m.nacre), fx, 0.16, fz, 0.2, 0.07, 0.3, 0, fx > 0 ? -0.4 : 0.4)
    }
  } else if (kind === 'ray') {
    add(sphere(m.teal), 0, 0.3, 0, 0.34, 0.14, 0.5) // body
    add(cone(m.teal), -0.52, 0.3, -0.02, 0.5, 0.9, 0.08, Math.PI / 2, Math.PI / 2) // wing L
    add(cone(m.teal), 0.52, 0.3, -0.02, 0.5, 0.9, 0.08, Math.PI / 2, -Math.PI / 2) // wing R
    add(sphere(m.nacre), 0, 0.32, 0.4, 0.16, 0.1, 0.16) // head
    add(cone(m.coral), 0, 0.3, -0.62, 0.05, 0.5, 0.05, Math.PI / 2, 0) // tail
  } else if (kind === 'narwhal') {
    add(sphere(m.nacre), 0, 0.3, 0, 0.3, 0.3, 0.6) // body
    add(sphere(m.teal), 0, 0.45, -0.1, 0.26, 0.22, 0.44) // back
    add(cone(m.brass), 0, 0.5, 0.78, 0.05, 0.62, 0.05, Math.PI / 2, 0) // the horn
    add(cone(m.nacre), 0.02, 0.3, -0.66, 0.3, 0.18, 0.07, Math.PI / 2, Math.PI / 2) // flukes
  } else {
    // Nautilus chariot: a shell seat, no saddle.
    const cup = new Mesh(
      new LatheGeometry(
        [
          new Vector2(0.02, 0),
          new Vector2(0.4, 0.04),
          new Vector2(0.52, 0.28),
          new Vector2(0.44, 0.52),
        ],
        20,
      ),
      m.nacre,
    )
    add(cup, 0, 0.1, 0, 1.1, 1, 1.3)
    const swirl = new Mesh(new TorusGeometry(0.3, 0.1, 8, 20, Math.PI * 1.7), m.coral)
    add(swirl, 0, 0.55, -0.5, 1, 1, 1, 0, 0)
    add(new Mesh(new CylinderGeometry(0.34, 0.38, 0.08, 14), m.wood), 0, 0.16, 0.05)
  }

  // Saddle for the animal mounts.
  if (kind !== 'nautilus chariot') {
    const saddle = new Mesh(new CylinderGeometry(0.2, 0.24, 0.08, 12), m.coral)
    saddle.position.set(0, kind === 'ray' ? 0.42 : 0.52, kind === 'seahorse' ? -0.02 : -0.08)
    g.add(saddle)
  }
  return g
}
