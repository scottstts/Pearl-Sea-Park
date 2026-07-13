import {
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  Object3D,
  PointLight,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  atan,
  float,
  mix,
  positionGeometry,
  sin,
  smoothstep,
  step,
  vec2,
  vec3,
} from 'three/tsl'
import { fbm2 } from '../render/tslNoise'
import { ArchKit } from '../archkit/modules'
import { SlotWriter } from '../archkit/writer'
import { registerBookmark } from '../core/debug'
import type { PlayerSystem } from '../player/player'
import { markDynamicShadowCasters } from '../render/layers'
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
const LOWER_MOUNTS = 16

interface Mount {
  group: Object3D
  figure: Object3D
  rod: Mesh
  rodTopY: number
  figureBaseY: number
  phase: number
  name: string
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
  /** Follows the ridden mount so the dismount prompt is always in view. */
  private readonly exitAnchor = new Vector3()
  private rotorAngle = 0
  private speed = 0
  private phaseClock = 0
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
      const globe = this.services.amenities.addLamp(cx + dx, plazaY, cz + dz)
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

    // Rotor-borne surfaces pattern in GEOMETRY space: worldspace fields
    // crawl across a spinning platform. The deck gets painted show rings
    // over its planking; the skirt and canopy get the teal-and-cream
    // circus stripe that makes the ride read from across the lagoon.
    const deckMaterial = new MeshStandardNodeMaterial()
    {
      const radial = positionGeometry.xz.length()
      const grain = fbm2(positionGeometry.xz.mul(vec2(1.1, 5.0)))
      const plank = mix(vec3(0.31, 0.2, 0.115), vec3(0.45, 0.31, 0.18), grain)
      const band = smoothstep(0.14, 0.04, radial.sub(7.05).abs())
      const goldLine = smoothstep(0.05, 0.015, radial.sub(6.62).abs()).max(
        smoothstep(0.05, 0.015, radial.sub(2.05).abs()),
      )
      deckMaterial.colorNode = mix(
        mix(plank, vec3(0.13, 0.35, 0.34), band.mul(0.85)),
        vec3(0.85, 0.68, 0.34),
        goldLine,
      )
      deckMaterial.roughnessNode = mix(float(0.6), float(0.34), goldLine)
      deckMaterial.metalnessNode = goldLine.mul(0.85)
    }
    const stripedMaterial = (stripes: number, warm = false) => {
      const m = new MeshStandardNodeMaterial()
      m.side = DoubleSide
      m.roughness = 0.82
      const angle = atan(positionGeometry.x, positionGeometry.z)
      const stripe = step(0, sin(angle.mul(stripes)))
      const cream = vec3(0.9, 0.86, 0.76)
      const tint = warm ? vec3(0.75, 0.4, 0.3) : vec3(0.16, 0.42, 0.41)
      m.colorNode = mix(cream, tint, stripe.mul(0.88)).add(
        fbm2(positionGeometry.xz.mul(6.0)).mul(0.05),
      )
      return m
    }
    const floor = new Mesh(new CylinderGeometry(7.6, 7.6, 0.14, 48), deckMaterial)
    floor.position.y = 0.07
    const skirt = new Mesh(
      new CylinderGeometry(7.66, 7.66, 0.55, 96, 1, true),
      stripedMaterial(40),
    )
    skirt.position.y = 0.2
    rotor.add(floor, skirt)

    // Mirror core with brass fluting, arched panel frames, and mouldings.
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
      // Arched frame over each mirror panel, flat against the core.
      const panelArch = new Mesh(new TorusGeometry(0.42, 0.035, 8, 18, Math.PI), lib.brass)
      const midAngle = angle + Math.PI / 10
      panelArch.position.set(Math.sin(midAngle) * 1.78, 3.15, Math.cos(midAngle) * 1.78)
      panelArch.rotation.y = midAngle
      rotor.add(panelArch)
    }
    for (const [ringY, ringR] of [
      [0.28, 1.86],
      [3.82, 1.74],
    ] as const) {
      const moulding = new Mesh(new TorusGeometry(ringR, 0.06, 8, 40), lib.brass)
      moulding.rotation.x = Math.PI / 2
      moulding.position.y = ringY
      rotor.add(moulding)
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

    // Canopy: striped ribbed tent cone over a painted rounding-board fascia,
    // a genuinely scalloped hanging valance, and a spire finial — the parts
    // that make a carousel read as a carousel instead of a cone on a drum.
    const canopy = new Mesh(new ConeGeometry(8.7, 2.6, 96, 1, true), stripedMaterial(14))
    canopy.position.y = 7.55
    const canopyRing = new Mesh(new TorusGeometry(8.62, 0.1, 10, 64), lib.brass)
    canopyRing.rotation.x = Math.PI / 2
    canopyRing.position.y = 6.3
    rotor.add(canopy, canopyRing)
    // Rounding board: cream fascia divided into painted panels with gilt
    // rails top and bottom — patterned in geometry space (it spins).
    const boardMaterial = new MeshStandardNodeMaterial()
    {
      const angle = atan(positionGeometry.x, positionGeometry.z)
      const panel = step(0.22, sin(angle.mul(18)).abs())
      const rails = smoothstep(0.035, 0.012, positionGeometry.y.sub(6.31).abs()).max(
        smoothstep(0.035, 0.012, positionGeometry.y.sub(5.8).abs()),
      )
      const cream = vec3(0.9, 0.86, 0.76)
      const panelTeal = vec3(0.14, 0.37, 0.36)
      boardMaterial.colorNode = mix(
        mix(panelTeal, cream, panel),
        vec3(0.85, 0.68, 0.34),
        rails,
      )
      boardMaterial.roughnessNode = mix(float(0.78), float(0.32), rails)
      boardMaterial.metalnessNode = rails.mul(0.9)
    }
    const roundingBoard = new Mesh(
      new LatheGeometry(
        [
          new Vector2(8.42, 5.75),
          new Vector2(8.6, 5.78),
          new Vector2(8.66, 5.9),
          new Vector2(8.66, 6.22),
          new Vector2(8.56, 6.32),
          new Vector2(8.38, 6.35),
          new Vector2(8.36, 6.04),
          new Vector2(8.42, 5.75),
        ],
        64,
      ),
      boardMaterial,
    )
    rotor.add(roundingBoard)
    // Crest scrolls: twelve brass whiplash curls standing on the fascia rim.
    const scrollGeometry = new TorusGeometry(0.15, 0.026, 7, 18, Math.PI * 1.55)
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2
      const scroll = new Mesh(scrollGeometry, lib.brass)
      scroll.position.set(Math.sin(angle) * 8.48, 6.44, Math.cos(angle) * 8.48)
      scroll.rotation.y = angle
      scroll.rotation.z = Math.PI * 0.08
      rotor.add(scroll)
    }
    const ribUp = new Vector3(0, 1, 0)
    const apex = new Vector3(0, 8.78, 0)
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2
      const edge = new Vector3(Math.sin(angle) * 8.6, 6.36, Math.cos(angle) * 8.6)
      const direction = new Vector3().subVectors(apex, edge)
      const rib = new Mesh(new CylinderGeometry(0.035, 0.05, direction.length(), 8), lib.brass)
      rib.position.copy(edge).add(apex).multiplyScalar(0.5)
      rib.quaternion.setFromUnitVectors(ribUp, direction.clone().normalize())
      rotor.add(rib)
    }
    // Hanging valance: one continuous striped skirt whose hem is displaced
    // into 28 true scallops with a slight outward flare — cloth, not a ring
    // of separate cones. (The old 28 squashed pennants read as teeth.)
    {
      const valanceGeometry = new CylinderGeometry(8.6, 8.6, 0.52, 112, 5, true)
      const position = valanceGeometry.getAttribute('position')
      const vertex = new Vector3()
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i)
        const hem = Math.max(0, Math.min(1, (0.26 - vertex.y) / 0.52))
        const angle = Math.atan2(vertex.x, vertex.z)
        const scallop = 0.5 + 0.5 * Math.cos(angle * 28)
        const radial = Math.hypot(vertex.x, vertex.z)
        const flare = 1 + (0.05 * hem * hem) / Math.max(radial, 1)
        position.setX(i, vertex.x * flare)
        position.setZ(i, vertex.z * flare)
        position.setY(i, vertex.y + 0.14 * scallop * hem)
      }
      position.needsUpdate = true
      valanceGeometry.computeVertexNormals()
      const valance = new Mesh(valanceGeometry, stripedMaterial(28, true))
      valance.position.y = 5.52
      rotor.add(valance)
    }
    const finial = new Mesh(
      new LatheGeometry(
        [
          new Vector2(0.3, 0),
          new Vector2(0.36, 0.1),
          new Vector2(0.12, 0.35),
          new Vector2(0.17, 0.6),
          new Vector2(0.02, 0.95),
        ],
        14,
      ),
      lib.brass,
    )
    finial.position.y = 8.72
    const finialPearl = new Mesh(new SphereGeometry(0.16, 14, 10), lib.nacre)
    finialPearl.position.y = 9.72
    rotor.add(finial, finialPearl)

    // Bulbs: rounding-board run + upper-deck edge + core crown.
    const bulbSpecs: [number, number, number][] = []
    for (let i = 0; i < 36; i++) {
      const angle = (i / 36) * Math.PI * 2
      bulbSpecs.push([Math.sin(angle) * 8.74, 6.06, Math.cos(angle) * 8.74])
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
    markDynamicShadowCasters(rotor)
    ctx.scene.add(this.group)
    this.updateRotor()

    registerBookmark({
      name: 'carousel',
      position: [cx + 15, plazaY + 4.5, cz + 13],
      look: [cx, plazaY + 3, cz],
      note: 'Carrousel des Abysses',
    })

    // ── Boarding: hop on ANYWHERE around the platform, spinning or not ────
    // Press E anywhere around the carousel and the nearest lower-deck mount
    // (at that moment) picks you up; press E while riding and you dismount
    // to the nearest plaza point outside the platform. No timetable gating.
    if (this.player && this.services.interaction) {
      const rig = new VehicleSeatRig(this.player)
      this.rig = rig
      const interaction = this.services.interaction
      const player = this.player
      const scratch = new Vector3()

      interaction.register({
        position: this.center,
        radius: plazaRadius + 4.5,
        prompt: 'Ride the carrousel',
        onInteract: () => {
          if (rig.seated) return
          // Nearest lower-deck mount to the guest right now.
          const at = player.position
          let best = -1
          let bestDistance = Infinity
          for (let i = 0; i < LOWER_MOUNTS; i++) {
            this.mounts[i].group.getWorldPosition(scratch)
            const d = scratch.distanceTo(at)
            if (d < bestDistance) {
              bestDistance = d
              best = i
            }
          }
          if (best === -1) return
          this.riding = best
          rig.attach(this.mounts[best].figure, new Vector3(0, 1.28, -0.52), Math.PI, ctx.camera)
          rig.canExit = true
          ctx.events.emit('ticket/punched', { ride: 'carousel' })
          ctx.events.emit('ride/carousel-riding', { riding: true })
        },
        enabled: () => !rig.seated,
      })
      interaction.register({
        position: this.exitAnchor,
        radius: 7,
        prompt: 'Dismount',
        onInteract: () => {
          if (!rig.seated || this.riding === -1) return
          // Drop off at the nearest plaza point: radially out from wherever
          // the mount is when the guest asks.
          this.mounts[this.riding].group.getWorldPosition(scratch)
          const dx = scratch.x - cx
          const dz = scratch.z - cz
          const inv = 1 / Math.max(0.001, Math.hypot(dx, dz))
          const exit = new Vector3(
            cx + dx * inv * (plazaRadius - 2.2),
            plazaY + 0.1,
            cz + dz * inv * (plazaRadius - 2.2),
          )
          rig.requestExit(exit)
          ctx.events.emit('ride/carousel-riding', { riding: false })
          this.riding = -1
        },
        enabled: () => rig.seated && this.riding !== -1,
      })
    }
  }

  private updateRotor(): void {
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
    }
    if (this.riding !== -1) {
      this.mounts[this.riding].group.getWorldPosition(this.exitAnchor)
      this.exitAnchor.y += 1.2
    } else {
      this.exitAnchor.copy(this.center)
    }
  }

  update(ctx: GameContext, dt: number): void {
    // Timetable: run RIDE_SECONDS, rest STOP_SECONDS, forever. Guests can
    // hop on and off regardless — the cycle is ambience, not a gate.
    this.phaseClock += dt
    const cycle = RIDE_SECONDS + STOP_SECONDS
    const inStop = this.phaseClock % cycle > RIDE_SECONDS
    const target = inStop ? 0 : (Math.PI * 2) / PERIOD
    this.speed += (target - this.speed) * Math.min(1, dt * 0.9)
    this.rotorAngle += this.speed * dt
    this.updateRotor()
    this.rig?.update(ctx.camera, dt)
    if (this.rig && this.riding !== -1) this.rig.canExit = true
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
  eye: MeshStandardNodeMaterial
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
    eye: tint(0x14181a, 0.35),
  }
}

/**
 * Bend a geometry's local +Y axis into an arc in the Y-Z plane. Positive
 * curvature leans the top toward +z. This is what turns straight lathe
 * torpedoes into arcing dolphin/narwhal bodies and curling necks — sculpted
 * silhouettes instead of stacked spheres.
 */
function bendArc(geometry: BufferGeometry, curvature: number): BufferGeometry {
  if (Math.abs(curvature) < 1e-6) return geometry
  const R = 1 / curvature
  const position = geometry.getAttribute('position')
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i)
    const z = position.getZ(i)
    const theta = y / R
    position.setY(i, Math.sin(theta) * (R - z))
    position.setZ(i, R - Math.cos(theta) * (R - z))
  }
  position.needsUpdate = true
  geometry.computeVertexNormals()
  return geometry
}

/** Solid-of-revolution torpedo along +Y (tail at 0, nose at the top). */
function torpedo(profile: [number, number][], segments = 20): LatheGeometry {
  return new LatheGeometry(profile.map(([r, y]) => new Vector2(r, y)), segments)
}

/**
 * Brass tack for the animal mounts: two rein lines sagging from the saddle
 * pommel to the creature's bit point, and a brow boss between them. Built
 * ONCE per species and cached — every mount adds a single extra draw, and
 * the reins visually tie saddle to animal (they used to be two unrelated
 * sculpts sharing a pole).
 */
const tackCache = new Map<MountKind, BufferGeometry>()
function tackGeometry(
  kind: MountKind,
  bit: Vector3,
  pommel: Vector3,
): BufferGeometry {
  let cached = tackCache.get(kind)
  if (cached) return cached
  const parts: BufferGeometry[] = []
  for (const side of [-1, 1]) {
    const from = new Vector3(side * 0.05, pommel.y, pommel.z)
    const to = new Vector3(side * 0.055, bit.y, bit.z)
    const mid = from.clone().add(to).multiplyScalar(0.5)
    mid.y -= 0.07
    mid.x += side * 0.05
    const rein = new TubeGeometry(new CatmullRomCurve3([from, mid, to]), 14, 0.011, 5)
    parts.push(rein)
  }
  const boss = new SphereGeometry(0.028, 8, 6)
  boss.translate(0, bit.y + 0.045, bit.z - 0.015)
  parts.push(boss)
  cached = mergeGeometries(parts, false)!
  for (const part of parts) part.dispose()
  tackCache.set(kind, cached)
  return cached
}

/** Tapering limb through spine points — real thickness, never a flat card. */
function limb(
  g: Object3D,
  material: MeshStandardNodeMaterial,
  spine: Vector3[],
  radii: number[],
): void {
  const up = new Vector3(0, 1, 0)
  for (let i = 0; i < spine.length - 1; i++) {
    const a = spine[i]
    const b = spine[i + 1]
    const radius = radii[Math.min(i, radii.length - 1)]
    const direction = new Vector3().subVectors(b, a)
    const segment = new Mesh(
      new CylinderGeometry(radius * 0.78, radius, direction.length(), 8),
      material,
    )
    segment.position.copy(a).add(b).multiplyScalar(0.5)
    segment.quaternion.setFromUnitVectors(up, direction.clone().normalize())
    g.add(segment)
    if (i > 0) {
      const knuckle = new Mesh(new SphereGeometry(radius * 1.05, 8, 6), material)
      knuckle.position.copy(a)
      g.add(knuckle)
    }
  }
}

/**
 * Carved carousel mounts. Bodies are bent closed lathes; fins, flukes, and
 * crests are squashed ellipsoids or limb chains with genuine thickness; each
 * animal wears a crafted saddle (seat, rolled cantle, pommel, skirt, and
 * stirrups on straps). Plump toy silhouettes, sculpted rather than stacked.
 */
function buildMount(kind: MountKind, m: MountMaterials): Object3D {
  const g = new Object3D()
  const add = (mesh: Mesh, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0, ry = 0) => {
    mesh.position.set(x, y, z)
    mesh.scale.set(sx, sy, sz)
    mesh.rotation.set(rx, ry, rz)
    g.add(mesh)
    return mesh
  }
  const sphere = (mat: MeshStandardNodeMaterial, ws = 14, hs = 10) =>
    new Mesh(new SphereGeometry(1, ws, hs), mat)
  const cone = (mat: MeshStandardNodeMaterial) => new Mesh(new ConeGeometry(1, 1, 12), mat)
  const eyes = (x: number, y: number, z: number) => {
    for (const side of [-1, 1]) {
      const eye = new Mesh(new SphereGeometry(0.032, 8, 6), m.eye)
      eye.position.set(side * x, y, z)
      g.add(eye)
    }
  }

  if (kind === 'seahorse') {
    // Chest-and-neck: a bent torpedo arcing forward; belly plump, crown slim.
    const body = new Mesh(
      bendArc(
        torpedo([
          [0.05, 0], [0.2, 0.04], [0.3, 0.22], [0.32, 0.42], [0.26, 0.62],
          [0.17, 0.78], [0.13, 0.92], [0.11, 1.02], [0.02, 1.08],
        ]),
        0.55,
      ),
      m.nacre,
    )
    body.position.set(0, -0.28, -0.12)
    g.add(body)
    // Curled tail: two nested arcs continuing the body base, thinning.
    const tailA = new Mesh(new TorusGeometry(0.24, 0.075, 8, 20, Math.PI * 1.45), m.nacre)
    tailA.position.set(0, -0.36, 0.02)
    tailA.rotation.set(0, Math.PI / 2, Math.PI * 0.62)
    const tailB = new Mesh(new TorusGeometry(0.11, 0.042, 7, 14, Math.PI * 1.5), m.nacre)
    tailB.position.set(0, -0.44, 0.1)
    tailB.rotation.set(0, Math.PI / 2, Math.PI * 0.2)
    g.add(tailA, tailB)
    // Head, bent snout, coronet, and a dorsal fin with thickness.
    add(sphere(m.nacre), 0, 0.86, 0.1, 0.16, 0.17, 0.2)
    const snout = new Mesh(new CylinderGeometry(0.035, 0.06, 0.3, 10), m.nacre)
    snout.position.set(0, 0.8, 0.31)
    snout.rotation.x = Math.PI / 2 - 0.35
    g.add(snout)
    for (let i = 0; i < 3; i++) {
      add(cone(m.coral), (i - 1) * 0.05, 1.04, 0.05 - Math.abs(i - 1) * 0.03, 0.035, 0.12, 0.035, -0.15, (i - 1) * 0.3)
    }
    add(sphere(m.coral), 0, 0.45, -0.28, 0.03, 0.3, 0.13) // dorsal fin blade
    add(sphere(m.coral), -0.14, 0.78, 0.12, 0.026, 0.1, 0.07, 0, 0.5) // pectorals
    add(sphere(m.coral), 0.14, 0.78, 0.12, 0.026, 0.1, 0.07, 0, -0.5)
    eyes(0.12, 0.9, 0.24)
  } else if (kind === 'dolphin') {
    // One arcing body from rostrum to peduncle — a leap frozen mid-flight.
    const body = new Mesh(
      bendArc(
        torpedo([
          [0.03, 0], [0.1, 0.08], [0.2, 0.32], [0.285, 0.62], [0.3, 0.85],
          [0.27, 1.08], [0.19, 1.28], [0.1, 1.4], [0.02, 1.46],
        ]),
        -0.35,
      ),
      m.teal,
    )
    body.rotation.x = Math.PI / 2 + 0.18
    body.position.set(0, 0.34, -0.72)
    g.add(body)
    const rostrum = new Mesh(new CylinderGeometry(0.045, 0.1, 0.3, 10), m.teal)
    rostrum.position.set(0, 0.32, 0.82)
    rostrum.rotation.x = Math.PI / 2 - 0.12
    g.add(rostrum)
    add(sphere(m.nacre), 0, 0.19, 0.18, 0.2, 0.16, 0.48) // pale belly
    const dorsal = new Mesh(bendArc(new ConeGeometry(0.09, 0.34, 10), 1.6), m.teal)
    dorsal.position.set(0, 0.6, -0.12)
    dorsal.rotation.x = -0.25
    g.add(dorsal)
    add(sphere(m.teal), -0.24, 0.22, 0.3, 0.05, 0.03, 0.17, 0, 0.75) // pectorals
    add(sphere(m.teal), 0.24, 0.22, 0.3, 0.05, 0.03, 0.17, 0, -0.75)
    add(sphere(m.teal), -0.16, 0.36, -0.86, 0.16, 0.025, 0.1, 0, 0.25) // flukes
    add(sphere(m.teal), 0.16, 0.36, -0.86, 0.16, 0.025, 0.1, 0, -0.25)
    eyes(0.14, 0.38, 0.6)
  } else if (kind === 'turtle') {
    // Domed shell with scute ridges (stepped lathe rings), closed underside.
    const shell = new Mesh(
      new LatheGeometry(
        [
          new Vector2(0.05, 0.02), new Vector2(0.46, 0.03), new Vector2(0.5, 0.09),
          new Vector2(0.47, 0.14), new Vector2(0.42, 0.2), new Vector2(0.43, 0.24),
          new Vector2(0.33, 0.32), new Vector2(0.34, 0.35), new Vector2(0.2, 0.41),
          new Vector2(0.05, 0.43), new Vector2(0.05, 0.02),
        ],
        22,
      ),
      m.teal,
    )
    shell.position.set(0, 0.18, 0)
    shell.scale.set(0.95, 1, 1.25)
    g.add(shell)
    const plastron = new Mesh(new SphereGeometry(1, 14, 8), m.coral)
    plastron.position.set(0, 0.16, 0)
    plastron.scale.set(0.4, 0.1, 0.5)
    g.add(plastron)
    limb(g, m.nacre, [new Vector3(0, 0.3, 0.5), new Vector3(0, 0.36, 0.66)], [0.09]) // neck
    add(sphere(m.nacre), 0, 0.38, 0.74, 0.15, 0.13, 0.17) // head
    for (const [fx, fz, big, yaw] of [
      [-0.42, 0.3, 1, 0.55], [0.42, 0.3, 1, -0.55],
      [-0.38, -0.36, 0.7, 2.4], [0.38, -0.36, 0.7, -2.4],
    ] as const) {
      const flipper = sphere(m.nacre)
      flipper.position.set(fx, 0.15, fz)
      flipper.scale.set(0.3 * big, 0.05, 0.14 * big)
      flipper.rotation.set(0, yaw, fx > 0 ? -0.18 : 0.18)
      g.add(flipper)
    }
    add(cone(m.nacre), 0, 0.18, -0.62, 0.05, 0.16, 0.05, Math.PI / 2 + 0.3, 0) // tail
    eyes(0.1, 0.44, 0.82)
  } else if (kind === 'ray') {
    // Disc body, drooping wings, cephalic lobes, and a chained whip tail.
    const body = new Mesh(new LatheGeometry(
      [
        new Vector2(0.04, 0), new Vector2(0.3, 0.01), new Vector2(0.38, 0.08),
        new Vector2(0.32, 0.2), new Vector2(0.18, 0.27), new Vector2(0.04, 0.29),
        new Vector2(0.04, 0),
      ],
      20,
    ), m.teal)
    body.position.set(0, 0.18, 0)
    body.scale.set(1, 1, 1.5)
    g.add(body)
    for (const side of [-1, 1]) {
      const wing = sphere(m.teal, 16, 10)
      wing.position.set(side * 0.5, 0.32, -0.04)
      wing.scale.set(0.58, 0.05, 0.4)
      wing.rotation.set(0, side * -0.2, side * -0.3)
      g.add(wing)
      const lobe = new Mesh(new CylinderGeometry(0.035, 0.05, 0.16, 8), m.teal)
      lobe.position.set(side * 0.12, 0.3, 0.56)
      lobe.rotation.x = Math.PI / 2 - 0.3
      g.add(lobe)
    }
    add(sphere(m.nacre), 0, 0.24, 0.3, 0.22, 0.08, 0.26) // pale underside blush
    limb(g, m.teal, [
      new Vector3(0, 0.28, -0.56),
      new Vector3(0, 0.36, -0.82),
      new Vector3(0, 0.5, -1.02),
    ], [0.05, 0.028])
    add(cone(m.coral), 0, 0.56, -1.08, 0.03, 0.12, 0.015, -0.9, 0) // barb
    eyes(0.15, 0.36, 0.42)
  } else if (kind === 'narwhal') {
    const body = new Mesh(
      bendArc(
        torpedo([
          [0.03, 0], [0.12, 0.06], [0.24, 0.3], [0.3, 0.6], [0.29, 0.86],
          [0.24, 1.08], [0.16, 1.26], [0.03, 1.38],
        ]),
        -0.28,
      ),
      m.nacre,
    )
    body.rotation.x = Math.PI / 2 + 0.14
    body.position.set(0, 0.36, -0.68)
    g.add(body)
    add(sphere(m.teal), 0, 0.5, -0.15, 0.24, 0.16, 0.42) // mottled back cape
    add(sphere(m.nacre), 0, 0.42, 0.62, 0.14, 0.13, 0.16) // melon
    // Spiral tusk: cone + shrinking helix wrap, seated in the melon.
    const tusk = new Mesh(new ConeGeometry(0.035, 0.62, 10), m.brass)
    tusk.position.set(0, 0.5, 0.98)
    tusk.rotation.x = Math.PI / 2 - 0.18
    g.add(tusk)
    const helixPoints: Vector3[] = []
    for (let i = 0; i <= 20; i++) {
      const t = i / 20
      const angle = t * Math.PI * 5
      const radius = 0.036 * (1 - t) + 0.004
      helixPoints.push(new Vector3(Math.cos(angle) * radius, -0.31 + 0.62 * t, Math.sin(angle) * radius))
    }
    const wrap = new Mesh(new TubeGeometry(new CatmullRomCurve3(helixPoints), 40, 0.007, 5), m.brass)
    wrap.position.copy(tusk.position)
    wrap.rotation.copy(tusk.rotation)
    g.add(wrap)
    add(sphere(m.nacre), -0.15, 0.34, -0.82, 0.14, 0.022, 0.09, 0, 0.3) // flukes
    add(sphere(m.nacre), 0.15, 0.34, -0.82, 0.14, 0.022, 0.09, 0, -0.3)
    add(sphere(m.nacre), -0.22, 0.28, 0.24, 0.05, 0.025, 0.13, 0, 0.7) // pectorals
    add(sphere(m.nacre), 0.22, 0.28, 0.24, 0.05, 0.025, 0.13, 0, -0.7)
    eyes(0.13, 0.42, 0.5)
  } else if (kind === 'nautilus chariot') {
    // Nautilus chariot: a closed shell cup with an interior you sit inside,
    // a striped double-spiral crest, and a carriage footplate.
    const cup = new Mesh(
      new LatheGeometry(
        [
          new Vector2(0.03, 0), new Vector2(0.42, 0.03), new Vector2(0.55, 0.24),
          new Vector2(0.52, 0.46), new Vector2(0.55, 0.52), new Vector2(0.48, 0.55),
          new Vector2(0.43, 0.44), new Vector2(0.3, 0.28), new Vector2(0.03, 0.24),
          new Vector2(0.03, 0),
        ],
        24,
      ),
      m.nacre,
    )
    cup.position.set(0, 0.1, 0.1)
    cup.scale.set(1.05, 1, 1.3)
    g.add(cup)
    const swirlA = new Mesh(new TorusGeometry(0.32, 0.1, 9, 22, Math.PI * 1.6), m.coral)
    swirlA.position.set(0, 0.62, -0.52)
    swirlA.rotation.z = -Math.PI * 0.5
    const swirlB = new Mesh(new TorusGeometry(0.17, 0.06, 8, 16, Math.PI * 1.5), m.coral)
    swirlB.position.set(0, 0.62, -0.52)
    swirlB.rotation.z = -Math.PI * 0.2
    const core = new Mesh(new SphereGeometry(0.08, 10, 8), m.nacre)
    core.position.set(0, 0.62, -0.52)
    g.add(swirlA, swirlB, core)
    add(new Mesh(new CylinderGeometry(0.34, 0.38, 0.07, 16), m.wood), 0, 0.14, 0.12)
    const footplate = new Mesh(new BoxGeometry(0.5, 0.05, 0.22), m.brass)
    footplate.position.set(0, 0.06, 0.62)
    g.add(footplate)
    const scroll = new Mesh(new TorusGeometry(0.12, 0.035, 8, 14, Math.PI * 1.4), m.brass)
    scroll.position.set(0, 0.2, 0.74)
    scroll.rotation.z = Math.PI * 0.5
    g.add(scroll)
    // Shell fan rising behind the seat (a closed squashed sphere — never a
    // half-primitive with an open cut plane) and two brass grab rails whose
    // arc ends dip into the cup wall.
    const fan = new Mesh(new SphereGeometry(1, 18, 10), m.nacre)
    fan.position.set(0, 0.66, -0.28)
    fan.scale.set(0.5, 0.42, 0.07)
    fan.rotation.x = -0.22
    g.add(fan)
    for (const side of [-1, 1]) {
      const rail = new Mesh(new TorusGeometry(0.2, 0.022, 6, 16, Math.PI * 0.9), m.brass)
      rail.position.set(side * 0.52, 0.42, 0.16)
      rail.rotation.y = Math.PI / 2
      rail.rotation.z = side * 0.15
      g.add(rail)
    }
  }

  // Crafted saddle for the animal mounts: seat, rolled cantle, pommel,
  // skirt, stirrups hanging on straps — and brass reins running from the
  // pommel to each creature's bit point (cached tack, one draw per mount).
  if (kind !== 'nautilus chariot') {
    const saddleY = kind === 'ray' ? 0.4 : kind === 'turtle' ? 0.56 : 0.52
    const saddleZ = kind === 'seahorse' ? -0.04 : -0.08
    const bitPoints: Record<Exclude<MountKind, 'nautilus chariot'>, Vector3> = {
      seahorse: new Vector3(0, 0.79, 0.33),
      dolphin: new Vector3(0, 0.31, 0.76),
      turtle: new Vector3(0, 0.36, 0.7),
      ray: new Vector3(0, 0.3, 0.52),
      narwhal: new Vector3(0, 0.4, 0.58),
    }
    const tack = tackGeometry(
      kind,
      bitPoints[kind],
      new Vector3(0, saddleY + 0.12, saddleZ + 0.25),
    )
    g.add(new Mesh(tack, m.brass))
    const seat = sphere(m.coral)
    seat.position.set(0, saddleY, saddleZ)
    seat.scale.set(0.2, 0.07, 0.3)
    const cantle = new Mesh(new TorusGeometry(0.13, 0.045, 8, 12, Math.PI * 0.9), m.coral)
    cantle.position.set(0, saddleY + 0.05, saddleZ - 0.2)
    cantle.rotation.set(0.35, Math.PI, Math.PI * 0.55)
    const pommel = new Mesh(new SphereGeometry(0.045, 10, 8), m.brass)
    pommel.position.set(0, saddleY + 0.1, saddleZ + 0.24)
    const pommelStem = new Mesh(new CylinderGeometry(0.02, 0.026, 0.1, 8), m.brass)
    pommelStem.position.set(0, saddleY + 0.05, saddleZ + 0.24)
    const skirt = sphere(m.wood)
    skirt.position.set(0, saddleY - 0.03, saddleZ)
    skirt.scale.set(0.24, 0.045, 0.33)
    g.add(seat, cantle, pommel, pommelStem, skirt)
    for (const side of [-1, 1]) {
      const strap = new Mesh(new BoxGeometry(0.03, 0.2, 0.06), m.wood)
      strap.position.set(side * 0.23, saddleY - 0.12, saddleZ)
      strap.rotation.z = side * 0.25
      const stirrup = new Mesh(new TorusGeometry(0.05, 0.014, 6, 12), m.brass)
      stirrup.position.set(side * 0.26, saddleY - 0.24, saddleZ)
      g.add(strap, stirrup)
    }
  }
  return g
}
