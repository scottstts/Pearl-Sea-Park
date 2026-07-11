import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  Object3D,
  PlaneGeometry,
  PointLight,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { float, mix, normalize, positionLocal, positionWorld, smoothstep, uv, vec2, vec3 } from 'three/tsl'
import { ArchKit } from '../../archkit/modules'
import { SlotWriter } from '../../archkit/writer'
import { registerBookmark } from '../../core/debug'
import { fbm2 as fbmCpu } from '../../core/noise2'
import type { PlayerSystem } from '../../player/player'
import type { GameContext } from '../../runtime/context'
import type { GameSystem } from '../../runtime/system'
import { fbm2 as fbmTsl } from '../../render/tslNoise'
import type { SeaMediumSystem } from '../../sea/medium'
import type { DistrictServices } from '../../world/districts/atrium'
import { terrainHeight } from '../../world/terrain'
import { VehicleSeatRig } from '../vehicleSeat'
import { CHANNEL_HEAVE_SCALE, ChannelSim } from './channelSim'

const WATER_LEVEL = -27.7
const BOATS = 3
// 110.5 m loop / 0.44 m·s⁻¹ + the dock pulse and rapids surge = ~4 minutes.
const CRUISE = 0.44
const DWELL = 10

/**
 * Grotto of Pearls (plan §9.5): a shell boat glides from a skylit gorge dock
 * into caverns beneath the reef — bioluminescent gardens, the shell-organ,
 * the pearl treasury glowing like a galaxy, one gentle rapids drop. The
 * channel is the game's one real liquid (bounded heightfield sim); the park's
 * darkness contrast lives here (cave meshes live on light-layer 1, unlit by
 * the sun).
 */
export class GrottoSystem implements GameSystem {
  readonly id = 'grotto'

  private readonly services: DistrictServices
  private readonly player: PlayerSystem | null
  private readonly medium: SeaMediumSystem
  private rig: VehicleSeatRig | null = null

  private readonly group = new Object3D()
  private sim: ChannelSim | null = null
  private curve: CatmullRomCurve3 | null = null
  private loopLength = 0
  private readonly boats: Object3D[] = []
  private boatS: number[] = []
  private speed = CRUISE
  private dwellTimer = 0
  private pulsedAtS = -100
  private ridingBoat = -1
  private dockS = 0
  private rapidsS = 0
  private wakeClock = 0
  private dripClock = 3
  private dripSequence = 0
  private treasuryGroup: Object3D | null = null
  private organRotor: Object3D | null = null
  private readonly organPipes: { mesh: Object3D; baseY: number; phase: number }[] = []
  private previousInterior = 0
  private debugCanvas: HTMLCanvasElement | null = null

  constructor(services: DistrictServices, player: PlayerSystem | null, medium: SeaMediumSystem) {
    this.services = services
    this.player = player
    this.medium = medium
  }

  init(ctx: GameContext): void {
    const lib = this.services.materials.lib
    if (!lib) throw new Error('GrottoSystem requires materials')
    const { physics } = this.services
    const kit = new ArchKit(lib)
    const w = new SlotWriter()
    ctx.camera.layers.enable(1)
    if (ctx.flags.debug) this.debugCanvas = ctx.renderer.domElement

    // ── The canal loop (closed) ───────────────────────────────────────────
    const pts: Vector3[] = [
      new Vector3(197, WATER_LEVEL, 110), // 0 dock (in the gorge pool)
      new Vector3(203, WATER_LEVEL, 105), // 1 the mouth
      new Vector3(212, WATER_LEVEL, 113), // 2 gardens chamber
      new Vector3(222, WATER_LEVEL, 108),
      new Vector3(226, WATER_LEVEL, 96), // 4 organ hall
      new Vector3(222, WATER_LEVEL, 84),
      new Vector3(210, WATER_LEVEL, 78), // 6 treasury
      new Vector3(200, WATER_LEVEL, 84), // 7 rapids (the gentle drop)
      new Vector3(196, WATER_LEVEL, 96),
    ]
    const curve = new CatmullRomCurve3(pts, true, 'centripetal', 0.5)
    this.curve = curve
    this.loopLength = curve.getLength()
    const nearestS = (p: Vector3) => {
      let best = 0
      let bestD = Infinity
      for (let i = 0; i < 800; i++) {
        const q = curve.getPointAt(i / 800, new Vector3())
        const d = q.distanceToSquared(p)
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      return (best / 800) * this.loopLength
    }
    this.dockS = nearestS(pts[0])
    this.rapidsS = nearestS(pts[7])
    this.boatS = Array.from({ length: BOATS }, (_, i) => (this.dockS + (i * this.loopLength) / BOATS) % this.loopLength)

    // Chambers: center s, water radius, cave radius, ceiling clearance.
    const chambers = [
      { at: nearestS(pts[2]), water: 6, cave: 9.5, head: 5 },
      { at: nearestS(pts[4]), water: 5.5, cave: 8.5, head: 4.6 },
      { at: nearestS(pts[6]), water: 7, cave: 11, head: 5.6 },
    ]
    const loopDist = (a: number, b: number) => {
      const raw = Math.abs(((a - b) % this.loopLength + this.loopLength) % this.loopLength)
      return Math.min(raw, this.loopLength - raw)
    }
    const chamberBoost = (s: number) => {
      let boost = 0
      for (const c of chambers) {
        const d = loopDist(s, c.at)
        boost = Math.max(boost, Math.exp(-(d * d) / (2 * 6.5 * 6.5)))
      }
      return boost
    }

    // ── The water sim + surface ───────────────────────────────────────────
    const bounds = { minX: 183, minZ: 66, width: 60, depth: 60 }
    let cachedX = Infinity
    let cachedZ = Infinity
    let cachedField = { distance: Infinity, s: 0 }
    const canalFieldAt = (x: number, z: number) => {
      if (x === cachedX && z === cachedZ) return cachedField
      let bestDistance = Infinity
      let bestS = 0
      for (let i = 0; i < 400; i++) {
        const q = curve.getPointAt(i / 400, new Vector3())
        const s = (i / 400) * this.loopLength
        const distance = Math.hypot(x - q.x, z - q.z) - 2.6 - chamberBoost(s) * 3.6
        if (distance < bestDistance) {
          bestDistance = distance
          bestS = s
        }
      }
      cachedX = x
      cachedZ = z
      cachedField = { distance: bestDistance, s: bestS }
      return cachedField
    }
    const simSize = ctx.quality.tier === 0 ? 128 : 256
    const sim = new ChannelSim(
      ctx.renderer,
      simSize,
      bounds,
      (x, z) => {
        const d = canalFieldAt(x, z).distance
        return d < -0.3 ? 1 : d < 0.3 ? (0.3 - d) / 0.6 : 0
      },
      (x, z) => this.channelDrop(canalFieldAt(x, z).s),
    )
    this.sim = sim

    const waterSegments = [112, 156, 180][ctx.quality.tier] ?? 156
    const waterGeometry = new PlaneGeometry(bounds.width, bounds.depth, waterSegments, waterSegments)
    waterGeometry.rotateX(-Math.PI / 2)
    const water = new MeshStandardNodeMaterial()
    water.roughness = 0.06
    water.metalness = 0
    water.envMapIntensity = 0.28
    water.transparent = true
    water.depthWrite = false
    water.alphaTest = 0.04
    water.side = DoubleSide

    // PlaneGeometry's V axis runs opposite world +Z after rotateX(-PI/2).
    const surfaceUv = vec2(uv().x, float(1).sub(uv().y))
    const sampleSurface = (offsetX: number, offsetZ: number) =>
      sim.baseHeightNode
        .sample(surfaceUv.add(vec2(offsetX, offsetZ)))
        .r.add(sim.heightNode.sample(surfaceUv.add(vec2(offsetX, offsetZ))).r.mul(CHANNEL_HEAVE_SCALE))
    const state = sim.heightNode.sample(surfaceUv)
    const surfaceHeight = sampleSurface(0, 0)
    const texel = 1 / sim.size
    const hX = sampleSurface(texel, 0).sub(sampleSurface(-texel, 0))
    const hZ = sampleSurface(0, texel).sub(sampleSurface(0, -texel))
    const gradientScale = sim.size / (bounds.width * 2)
    const waterNormal = normalize(vec3(hX.mul(-gradientScale), 1, hZ.mul(-gradientScale)))
    const maskSample = sim.maskNode.sample(surfaceUv).r
    water.positionNode = positionLocal.add(vec3(0, surfaceHeight, 0))
    water.normalNode = waterNormal
    water.opacityNode = maskSample.mul(0.94)
    water.emissiveNode = vec3(0.006, 0.026, 0.032).mul(maskSample)
    switch (ctx.flags.pass) {
      case 'grotto-height':
        water.colorNode = mix(vec3(0.02, 0.08, 0.18), vec3(1.2, 0.24, 0.04), smoothstep(-0.9, 0.25, surfaceHeight))
        break
      case 'grotto-velocity':
        water.colorNode = vec3(state.g.abs().mul(8))
        break
      case 'grotto-normal':
        water.colorNode = waterNormal.mul(0.5).add(0.5)
        break
      case 'grotto-mask':
        water.colorNode = vec3(maskSample)
        break
      default:
        water.colorNode = vec3(0.012, 0.07, 0.085)
    }
    const waterMesh = new Mesh(waterGeometry, water)
    waterMesh.position.set(bounds.minX + bounds.width / 2, WATER_LEVEL, bounds.minZ + bounds.depth / 2)
    waterMesh.layers.enable(1)
    waterMesh.renderOrder = 3
    this.group.add(waterMesh)

    // ── Cave shell ────────────────────────────────────────────────────────
    this.buildCave(curve, chamberBoost)

    // ── Dock: deck, lamps, gate ───────────────────────────────────────────
    const dockDeckY = -26.4
    const deck = new Mesh(new BoxGeometry(7, 0.3, 3.2), lib.mosaic)
    deck.position.set(193.4, dockDeckY, 112.4)
    deck.rotation.y = 0.5
    this.group.add(deck)
    physics.addStaticBox(193.4, dockDeckY, 112.4, 3.5, 0.15, 1.6, 0.5)
    const deckYaw = 0.5
    const deckPoint = (localX: number, localZ: number) => new Vector3(
      193.4 + localX * Math.cos(deckYaw) + localZ * Math.sin(deckYaw),
      dockDeckY + 0.15,
      112.4 - localX * Math.sin(deckYaw) + localZ * Math.cos(deckYaw),
    )
    for (const sideZ of [-1.48, 1.48]) {
      const a = deckPoint(-3.42, sideZ)
      const b = deckPoint(3.05, sideZ)
      kit.balustrade(w, a.x, a.z, b.x, b.z, a.y)
      const center = a.clone().add(b).multiplyScalar(0.5)
      physics.addStaticBox(center.x, a.y + 0.42, center.z, a.distanceTo(b) / 2, 0.42, 0.08, deckYaw)
    }
    this.buildEntrance(kit, w, physics)
    for (const [lx, lz] of [
      [190.5, 114.8],
      [196.2, 110.6],
    ]) {
      const globe = this.services.amenities.addLamp(lx, dockDeckY + 0.15, lz)
      physics.addStaticBox(lx, dockDeckY + 1.85, lz, 0.12, 1.7, 0.12)
      const light = new PointLight(0xffd9a0, 4.5, 11, 1.8)
      light.position.set(globe.x, globe.y, globe.z)
      light.layers.enable(1)
      this.group.add(light)
    }

    // ── Scenes ────────────────────────────────────────────────────────────
    this.buildGardens(curve, chambers[0].at)
    this.buildOrgan(curve, chambers[1].at, lib)
    this.buildTreasury(curve, chambers[2].at)

    // ── Boats ─────────────────────────────────────────────────────────────
    const hullGeometry = new LatheGeometry(
      [
        new Vector2(0.02, 0),
        new Vector2(0.55, 0.1),
        new Vector2(0.78, 0.34),
        new Vector2(0.72, 0.6),
      ],
      18,
    )
    hullGeometry.scale(1, 1, 1.85)
    for (let i = 0; i < BOATS; i++) {
      const boat = new Object3D()
      const hull = new Mesh(hullGeometry, lib.nacre)
      const trim = new Mesh(new CylinderGeometry(0.06, 0.06, 1.15, 8), lib.brass)
      trim.rotation.x = Math.PI / 2
      trim.position.set(0, 0.6, 0)
      const benchA = new Mesh(new BoxGeometry(1.05, 0.1, 0.34), lib.woodDark)
      benchA.position.set(0, 0.34, -0.28)
      const benchB = benchA.clone()
      benchB.position.z = 0.42
      const lanternPost = new Mesh(new CylinderGeometry(0.03, 0.04, 0.7, 8), lib.iron)
      lanternPost.position.set(0, 0.9, 1.18)
      const lantern = new Mesh(new SphereGeometry(0.11, 10, 8), lib.lampGlobe)
      lantern.position.set(0, 1.3, 1.18)
      const lightSource = new PointLight(0xffe2b0, 1.6, 7.5, 1.7)
      lightSource.position.set(0, 1.35, 1.2)
      lightSource.layers.enable(1)
      boat.add(hull, trim, benchA, benchB, lanternPost, lantern, lightSource)
      boat.traverse((n) => {
        n.layers.enable(1)
      })
      this.group.add(boat)
      this.boats.push(boat)
    }

    this.group.add(w.compile())
    this.group.traverse((n) => {
      const mesh = n as Mesh
      if (mesh.isMesh) mesh.receiveShadow = true
    })
    ctx.scene.add(this.group)
    this.placeBoats(0)

    registerBookmark({
      name: 'grotto',
      position: [188.5, -24.1, 119.5],
      look: [199.5, -27.25, 108],
      note: 'The gorge dock — boats slip into the dark',
    })
    registerBookmark({
      name: 'treasury',
      position: [216, -25.6, 82.5],
      look: [209.8, -24.8, 72.8],
      note: 'The pearl treasury — a galaxy under the reef',
    })
    registerBookmark({
      name: 'grotto-water',
      position: [204.5, -25.4, 111.5],
      look: [199.7, -28.2, 107.4],
      note: 'Near-water validation — wake, bank mask, and simulated normals',
    })
    registerBookmark({
      name: 'grotto-far',
      position: [171.5, -23.1, 136.5],
      look: [190.5, -25.6, 118],
      note: 'The reef massif and stained-glass gorge entrance from the midway path',
    })
    registerBookmark({
      name: 'grotto-garden',
      position: [206.5, -26.65, 107.5],
      look: [213.5, -27.35, 114],
      note: 'The first bioluminescent garden from a shell boat',
    })
    registerBookmark({
      name: 'grotto-organ',
      position: [219.5, -26.55, 101.5],
      look: [227, -26.4, 95.5],
      note: 'The breathing shell-organ and flywheel',
    })

    // ── Boarding ──────────────────────────────────────────────────────────
    if (this.player && this.services.interaction) {
      const rig = new VehicleSeatRig(this.player)
      this.rig = rig
      const interaction = this.services.interaction
      const gate = new Vector3(195.4, -25.4, 111.4)
      const exit = new Vector3(193.4, -26.2, 112.4)
      interaction.register({
        position: gate,
        radius: 4.2,
        prompt: 'Board a shell boat',
        onInteract: () => {
          const boat = this.dockedBoat()
          if (boat === -1 || rig.seated) return
          this.ridingBoat = boat
          this.dwellTimer = Math.max(this.dwellTimer, 4)
          rig.attach(this.boats[boat], new Vector3(0, 1.05, -0.28), Math.PI, ctx.camera)
          ctx.events.emit('ticket/punched', { ride: 'grotto' })
          ctx.events.emit('ride/grotto-riding', { riding: true })
        },
        enabled: () => !rig.seated && this.dockedBoat() !== -1,
      })
      interaction.register({
        position: gate,
        radius: 7,
        prompt: 'Step ashore',
        onInteract: () => {
          if (!rig.seated || this.ridingBoat === -1) return
          rig.requestExit(exit)
          ctx.events.emit('ride/grotto-riding', { riding: false })
          this.ridingBoat = -1
        },
        enabled: () => rig.seated && this.ridingBoat !== -1 && this.dockedBoat() === this.ridingBoat,
      })
    }
  }

  /** Water profile: a 0.85 m chute, short run-out, then a hidden recovery. */
  private channelDrop(s: number): number {
    const afterDrop = ((s - this.rapidsS) % this.loopLength + this.loopLength) % this.loopLength
    if (afterDrop < 5) return -0.85 * smoothstepJs(0, 5, afterDrop)
    if (afterDrop < 12) return -0.85
    if (afterDrop < 24) return -0.85 * (1 - smoothstepJs(12, 24, afterDrop))
    return 0
  }

  private loopDistance(a: number, b: number): number {
    const raw = Math.abs(((a - b) % this.loopLength + this.loopLength) % this.loopLength)
    return Math.min(raw, this.loopLength - raw)
  }

  private crossedForward(from: number, to: number, marker: number): boolean {
    const travelled = ((to - from) % this.loopLength + this.loopLength) % this.loopLength
    const markerDistance = ((marker - from) % this.loopLength + this.loopLength) % this.loopLength
    return markerDistance > 0 && markerDistance <= travelled
  }

  /** Belle Époque threshold between the midway path and the reef gorge. */
  private buildEntrance(
    kit: ArchKit,
    w: SlotWriter,
    physics: DistrictServices['physics'],
  ): void {
    const center = new Vector3(187.6, 0, 121.9)
    const floor = terrainHeight(center.x, center.z) + 0.15
    const gorgeDirection = new Vector3(12, 0, -14).normalize()
    const across = new Vector3(-gorgeDirection.z, 0, gorgeDirection.x)
    const left = center.clone().addScaledVector(across, -3.25)
    const right = center.clone().addScaledVector(across, 3.25)

    kit.column(w, left.x, floor, left.z, 4.7, 0.3)
    kit.column(w, right.x, floor, right.z, 4.7, 0.3)
    kit.arch(w, left.x, left.z, right.x, right.z, floor + 4.72, 1.65)
    kit.cornice(w, left.x, left.z, right.x, right.z, floor + 4.82)
    kit.urn(w, left.x - across.x * 0.75, floor, left.z - across.z * 0.75, 0.9)
    kit.urn(w, right.x + across.x * 0.75, floor, right.z + across.z * 0.75, 0.9)
    physics.addStaticBox(left.x, floor + 2.35, left.z, 0.42, 2.35, 0.42)
    physics.addStaticBox(right.x, floor + 2.35, right.z, 0.42, 2.35, 0.42)

    // A jewel-like fanlight: the portal stays physically open below it.
    const stainedGlass = new MeshStandardNodeMaterial()
    stainedGlass.transparent = true
    stainedGlass.depthWrite = false
    stainedGlass.side = DoubleSide
    stainedGlass.opacity = 0.38
    stainedGlass.roughness = 0.12
    stainedGlass.metalness = 0
    stainedGlass.colorNode = mix(
      vec3(0.12, 0.75, 0.68),
      vec3(0.72, 0.25, 0.82),
      smoothstep(-1.0, 1.0, positionLocal.x),
    )
    stainedGlass.emissiveNode = vec3(0.025, 0.12, 0.11)
    const fanlight = new Mesh(new CircleGeometry(2.55, 36, 0, Math.PI), stainedGlass)
    fanlight.position.set(center.x, floor + 4.55, center.z)
    fanlight.rotation.y = Math.atan2(gorgeDirection.x, gorgeDirection.z)
    this.group.add(fanlight)

    // A restrained colored pool just inside the fanlight stands in for the
    // transmitted stained-glass wash without adding a fake sun projector.
    const innerGlow = new PointLight(0x62d9c5, 1.7, 9, 1.8)
    innerGlow.position.copy(center).addScaledVector(gorgeDirection, 2.2)
    innerGlow.position.y = floor + 2.5
    innerGlow.layers.enable(1)
    this.group.add(innerGlow)
  }

  // ── Cave tunnel mesh ─────────────────────────────────────────────────────
  private buildCave(curve: CatmullRomCurve3, chamberBoost: (s: number) => number): void {
    const RINGS = 150
    const SEGMENTS = 16
    const positions: number[] = []
    const indices: number[] = []
    const scratch = new Vector3()
    const tangent = new Vector3()
    const side = new Vector3()
    const up = new Vector3(0, 1, 0)
    for (let r = 0; r <= RINGS; r++) {
      const u = (r % RINGS) / RINGS
      const center = curve.getPointAt(u, scratch.clone())
      curve.getTangentAt(u, tangent)
      side.crossVectors(tangent, up).normalize()
      const s = u * this.loopLength
      const boost = chamberBoost(s)
      const width = 4.4 + boost * 6.2
      const headroom = 3.0 + boost * 2.8
      for (let k = 0; k < SEGMENTS; k++) {
        const a = (k / SEGMENTS) * Math.PI * 2
        const noise = (fbmCpu(center.x * 0.24 + k * 0.61, center.z * 0.24 + r * 0.37, 3, 91) - 0.5) * 1.5
        const radial = Math.cos(a)
        const vertical = Math.sin(a)
        const rx = (width + noise) * radial
        const ry = vertical >= 0 ? (headroom + noise * 0.7) * vertical : 1.6 * vertical
        positions.push(center.x + side.x * rx, WATER_LEVEL + 0.35 + ry, center.z + side.z * rx)
      }
    }
    for (let r = 0; r < RINGS; r++) {
      const s0 = (r / RINGS) * this.loopLength
      const s1 = ((r + 1) / RINGS) * this.loopLength
      // The reef terrain owns the open gorge. Start the zero-thickness cave
      // shell only after the first bend, where the terrain hides its cut; any
      // partial cross-section is visible from above as disconnected sheets.
      const dockDistance = Math.min(this.loopDistance(s0, this.dockS), this.loopDistance(s1, this.dockS))
      if (dockDistance < 18) continue
      for (let k = 0; k < SEGMENTS; k++) {
        const a = r * SEGMENTS + k
        const b = r * SEGMENTS + ((k + 1) % SEGMENTS)
        const c = (r + 1) * SEGMENTS + k
        const d = (r + 1) * SEGMENTS + ((k + 1) % SEGMENTS)
        indices.push(a, c, b, b, c, d)
      }
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    const rock = new MeshStandardNodeMaterial()
    const rockField = fbmTsl(positionWorld.xz.mul(0.34).add(positionWorld.y.mul(0.21)))
    rock.colorNode = mix(vec3(0.055, 0.075, 0.073), vec3(0.16, 0.2, 0.18), rockField)
    rock.roughnessNode = rockField.mul(0.08).add(0.88)
    rock.metalness = 0
    rock.envMapIntensity = 0
    rock.emissiveNode = mix(vec3(0.018, 0.028, 0.029), vec3(0.04, 0.065, 0.058), rockField)
    rock.side = BackSide
    const cave = new Mesh(geometry, rock)
    cave.layers.set(1)
    cave.receiveShadow = false
    this.group.add(cave)

    // Darkness cards conceal the zero-thickness shell starts and give the
    // open gorge two readable, deep cave mouths. They have no collider: the
    // shell boats pass through the black threshold in one unbroken shot.
    const portalMaterial = new MeshBasicNodeMaterial()
    portalMaterial.colorNode = vec3(0.0015, 0.004, 0.006)
    for (const s of [
      (this.dockS + 18) % this.loopLength,
      (this.dockS - 18 + this.loopLength) % this.loopLength,
    ]) {
      const u = s / this.loopLength
      const center = curve.getPointAt(u, new Vector3())
      const tangent = curve.getTangentAt(u, new Vector3()).normalize()
      const portal = new Mesh(new CircleGeometry(1, 40), portalMaterial)
      portal.position.set(center.x, WATER_LEVEL + 0.4, center.z)
      portal.scale.set(4.1, 3.0, 1)
      // Front face looks back toward the approaching boat; after crossing,
      // back-face culling reveals the lit chamber instead of a black disc.
      portal.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), tangent.negate())
      portal.layers.set(1)
      this.group.add(portal)
    }
  }

  // ── Scenes ───────────────────────────────────────────────────────────────
  private buildGardens(curve: CatmullRomCurve3, at: number): void {
    const center = curve.getPointAt(at / this.loopLength, new Vector3())
    const kinds = [
      { color: 0x5fffd9, count: 260, scale: [0.12, 0.4] as const },
      { color: 0xb491ff, count: 180, scale: [0.1, 0.32] as const },
      { color: 0x69d2ff, count: 200, scale: [0.09, 0.26] as const },
    ]
    const matrix = new Matrix4()
    const quaternion = new Quaternion()
    const position = new Vector3()
    const scale = new Vector3()
    for (const kind of kinds) {
      const color = new Color(kind.color)
      const stalkMaterial = new MeshStandardNodeMaterial()
      stalkMaterial.colorNode = vec3(color.r * 0.24, color.g * 0.24, color.b * 0.24)
      stalkMaterial.emissiveNode = vec3(color.r * 0.1, color.g * 0.1, color.b * 0.1)
      stalkMaterial.roughness = 0.72
      const glowMaterial = new MeshBasicNodeMaterial()
      glowMaterial.colorNode = vec3(color.r * 1.2, color.g * 1.2, color.b * 1.2)
      const stalks = new InstancedMesh(new ConeGeometry(0.18, 1, 7), stalkMaterial, kind.count)
      const tips = new InstancedMesh(new SphereGeometry(1, 16, 10), glowMaterial, kind.count)
      const petals = new InstancedMesh(new TorusGeometry(1, 0.14, 8, 20), glowMaterial, kind.count)
      const petalQuaternion = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2)
      for (let i = 0; i < kind.count; i++) {
        const angle = (i * 2.399963) % (Math.PI * 2)
        const radius = 4.0 + deterministicUnit(i * 7 + kind.count) * 4.8
        const x = center.x + Math.cos(angle) * radius
        const z = center.z + Math.sin(angle) * radius
        const sizeMix = deterministicUnit(i * 7 + kind.count + 1)
        const width = kind.scale[0] + sizeMix * (kind.scale[1] - kind.scale[0])
        const height = 0.38 + deterministicUnit(i * 7 + kind.count + 2) * 1.45
        const floor = WATER_LEVEL - 1.18
        position.set(x, floor + height / 2, z)
        scale.set(width, height, width)
        quaternion.setFromAxisAngle(
          new Vector3(Math.sin(angle), 0, Math.cos(angle)),
          (deterministicUnit(i * 7 + kind.count + 3) - 0.5) * 0.24,
        )
        matrix.compose(position, quaternion, scale)
        stalks.setMatrixAt(i, matrix)
        const tipSize = 0.035 + width * 0.18
        matrix.makeScale(tipSize, tipSize * 0.72, tipSize)
        matrix.setPosition(x, floor + height, z)
        tips.setMatrixAt(i, matrix)
        position.set(x, floor + height - tipSize * 0.1, z)
        scale.set(tipSize * 1.25, tipSize * 1.25, tipSize * 1.25)
        matrix.compose(position, petalQuaternion, scale)
        petals.setMatrixAt(i, matrix)
      }
      stalks.instanceMatrix.needsUpdate = true
      tips.instanceMatrix.needsUpdate = true
      petals.instanceMatrix.needsUpdate = true
      stalks.layers.set(1)
      tips.layers.set(1)
      petals.layers.set(1)
      this.group.add(stalks, tips, petals)
    }
    const glow = new PointLight(0x59e6c4, 2.6, 16, 1.6)
    glow.position.set(center.x, WATER_LEVEL + 2.4, center.z)
    glow.layers.set(1)
    this.group.add(glow)
  }

  private buildOrgan(
    curve: CatmullRomCurve3,
    at: number,
    lib: NonNullable<DistrictServices['materials']['lib']>,
  ): void {
    const center = curve.getPointAt(at / this.loopLength, new Vector3())
    const organ = new Object3D()

    const dais = new Mesh(new CylinderGeometry(3.7, 4.15, 0.48, 36), lib.marble)
    dais.position.set(0, WATER_LEVEL - 0.18, 0.15)
    organ.add(dais)

    // Scallop backplate and brass fan ribs establish the silhouette before
    // the moving pipework; it remains readable in the no-post baseline.
    const shell = new Mesh(new CircleGeometry(3.05, 42, 0, Math.PI), lib.nacre)
    shell.position.set(0, WATER_LEVEL + 0.5, -0.52)
    organ.add(shell)
    const yAxis = new Vector3(0, 1, 0)
    for (let i = 0; i < 7; i++) {
      const angle = 0.16 + (i / 6) * (Math.PI - 0.32)
      const start = new Vector3(0, WATER_LEVEL + 0.52, -0.44)
      const end = new Vector3(Math.cos(angle) * 2.78, WATER_LEVEL + 0.52 + Math.sin(angle) * 2.78, -0.44)
      const direction = end.clone().sub(start)
      const rib = new Mesh(new CylinderGeometry(0.035, 0.055, direction.length(), 8), lib.brass)
      rib.position.copy(start).add(end).multiplyScalar(0.5)
      rib.quaternion.setFromUnitVectors(yAxis, direction.normalize())
      organ.add(rib)
    }

    for (let i = 0; i < 9; i++) {
      const t = i / 8 - 0.5
      const height = 1.4 + Math.cos(t * Math.PI) * 1.9
      const pipeAssembly = new Object3D()
      const radius = 0.13 + Math.abs(t) * 0.09
      const pipe = new Mesh(new CylinderGeometry(radius * 0.72, radius, height, 12), lib.nacre)
      pipe.position.y = height / 2
      const cap = new Mesh(new SphereGeometry(radius * 0.74, 12, 8), lib.nacre)
      cap.position.y = height
      const collar = new Mesh(new TorusGeometry(radius * 0.86, 0.025, 7, 16), lib.brass)
      collar.rotation.x = Math.PI / 2
      collar.position.y = 0.2
      pipeAssembly.add(pipe, cap, collar)
      pipeAssembly.position.set(t * 3.7, WATER_LEVEL + 0.43, 0)
      pipeAssembly.rotation.z = t * 0.24
      organ.add(pipeAssembly)
      this.organPipes.push({ mesh: pipeAssembly, baseY: pipeAssembly.position.y, phase: i * 0.82 })
    }
    const base = new Mesh(new BoxGeometry(4.8, 0.58, 1.55), lib.woodDark)
    base.position.y = WATER_LEVEL + 0.35
    organ.add(base)
    for (let i = 0; i < 13; i++) {
      const key = new Mesh(new BoxGeometry(0.25, 0.1, i % 2 === 0 ? 0.62 : 0.48), i % 2 === 0 ? lib.marble : lib.brass)
      key.position.set((i - 6) * 0.31, WATER_LEVEL + 0.7, 0.86)
      organ.add(key)
    }
    const rotor = new Object3D()
    const flywheel = new Mesh(new TorusGeometry(0.72, 0.08, 8, 28), lib.brass)
    const axle = new Mesh(new CylinderGeometry(0.08, 0.08, 1.7, 10), lib.iron)
    axle.rotation.z = Math.PI / 2
    rotor.add(flywheel, axle)
    rotor.position.set(0, WATER_LEVEL + 1.05, 0.76)
    organ.add(rotor)
    this.organRotor = rotor
    organ.position.set(center.x + 4.4, 0, center.z - 1)
    organ.rotation.y = -1.1
    organ.traverse((n) => n.layers.set(1))
    this.group.add(organ)
    const amber = new PointLight(0xffc890, 2.2, 13, 1.7)
    amber.position.set(center.x + 3, WATER_LEVEL + 2.6, center.z)
    amber.layers.set(1)
    this.group.add(amber)
  }

  private buildTreasury(curve: CatmullRomCurve3, at: number): void {
    const center = curve.getPointAt(at / this.loopLength, new Vector3())
    const tangent = curve.getTangentAt(at / this.loopLength, new Vector3()).normalize()
    const chamberSide = new Vector3().crossVectors(tangent, new Vector3(0, 1, 0)).normalize()
    const galaxyCenter = center.clone().addScaledVector(chamberSide, 4.8)
    const COUNT = 2400
    // The galaxy must remain legible without bloom: most pearls are lit
    // nacre below the bloom threshold; one central pearl owns the hero glow.
    const material = new MeshStandardNodeMaterial()
    material.colorNode = vec3(0.78, 0.72, 0.62)
    material.emissiveNode = vec3(0.055, 0.05, 0.04)
    material.roughness = 0.24
    material.metalness = 0.08
    const pearls = new InstancedMesh(new SphereGeometry(1, 8, 6), material, COUNT)
    const matrix = new Matrix4()
    for (let i = 0; i < COUNT; i++) {
      const arm = i % 3
      const t = (Math.floor(i / 3) / Math.ceil(COUNT / 3)) ** 0.72
      const angleJitter = (deterministicUnit(i * 5 + 11) - 0.5) * (0.18 + t * 0.42)
      const angle = arm * ((Math.PI * 2) / 3) + t * 5.2 + angleJitter
      const radius = 0.38 + t * 5.1 + (deterministicUnit(i * 5 + 12) - 0.5) * 0.32
      const x = Math.cos(angle) * radius
      const y = 2.8 + Math.sin(angle) * radius * 0.56 + (deterministicUnit(i * 5 + 13) - 0.5) * 0.25
      const z = (deterministicUnit(i * 5 + 14) - 0.5) * (0.22 + t * 0.62)
      const sizeMix = deterministicUnit(i * 5 + 15)
      const s = 0.012 + sizeMix ** 4 * 0.12
      matrix.makeScale(s, s, s)
      matrix.setPosition(x, y, z)
      pearls.setMatrixAt(i, matrix)
      pearls.setColorAt(i, new Color(sizeMix > 0.72 ? 0xffe1b8 : 0xc7e4e3))
    }
    pearls.instanceMatrix.needsUpdate = true
    if (pearls.instanceColor) pearls.instanceColor.needsUpdate = true
    pearls.layers.set(1)
    const treasuryGroup = new Object3D()
    treasuryGroup.add(pearls)
    const heroMaterial = new MeshStandardNodeMaterial()
    heroMaterial.colorNode = vec3(0.96, 0.88, 0.72)
    heroMaterial.emissiveNode = vec3(1.1, 0.82, 0.48)
    heroMaterial.roughness = 0.16
    const heroPearl = new Mesh(new SphereGeometry(0.78, 28, 18), heroMaterial)
    heroPearl.position.set(0, 2.75, 0)
    treasuryGroup.add(heroPearl)
    treasuryGroup.position.set(galaxyCenter.x, WATER_LEVEL, galaxyCenter.z)
    this.treasuryGroup = treasuryGroup
    this.group.add(treasuryGroup)
    for (const [dx, dz, c] of [
      [-2, 0, 0xfff1cf],
      [3, -2, 0xd8ecff],
    ] as const) {
      const light = new PointLight(c, 3.2, 18, 1.7)
      light.position.set(galaxyCenter.x + dx, WATER_LEVEL + 3.4, galaxyCenter.z + dz)
      light.layers.set(1)
      this.group.add(light)
    }
  }

  // ── Ride logic ───────────────────────────────────────────────────────────
  private dockedBoat(): number {
    if (this.dwellTimer <= 0) return -1
    for (let i = 0; i < BOATS; i++) {
      const raw = Math.abs(((this.boatS[i] - this.dockS) % this.loopLength + this.loopLength) % this.loopLength)
      if (Math.min(raw, this.loopLength - raw) < 1.4) return i
    }
    return -1
  }

  private placeBoats(elapsed: number): void {
    const curve = this.curve
    const sim = this.sim
    if (!curve || !sim) return
    const basis = new Matrix4()
    const side = new Vector3()
    const up = new Vector3(0, 1, 0)
    for (let i = 0; i < BOATS; i++) {
      const u = (this.boatS[i] % this.loopLength) / this.loopLength
      const p = curve.getPointAt(u, new Vector3())
      const tangent = curve.getTangentAt(u, new Vector3()).normalize()
      side.crossVectors(tangent, up).normalize()
      basis.makeBasis(side, up, tangent)
      const boat = this.boats[i]
      boat.quaternion.setFromRotationMatrix(basis)

      // Four samples from the CPU mirror of the actual heightfield provide
      // heave, pitch, and roll. There is no decorative sine bobbing here.
      const bow = p.clone().addScaledVector(tangent, 1.05)
      const stern = p.clone().addScaledVector(tangent, -1.05)
      const right = p.clone().addScaledVector(side, 0.56)
      const left = p.clone().addScaledVector(side, -0.56)
      const surfaceAt = (sample: Vector3) => WATER_LEVEL + sim.sampleSurfaceOffset(sample.x, sample.z)
      const bowY = surfaceAt(bow)
      const sternY = surfaceAt(stern)
      const rightY = surfaceAt(right)
      const leftY = surfaceAt(left)
      const centerY = (bowY + sternY + rightY + leftY) * 0.25
      const pitch = -Math.atan2(bowY - sternY, 2.1)
      const roll = Math.atan2(rightY - leftY, 1.12)
      boat.position.set(p.x, centerY - 0.18, p.z)
      boat.rotateX(pitch)
      boat.rotateZ(roll)
    }
    void elapsed
  }

  update(ctx: GameContext, dt: number): void {
    const sim = this.sim
    if (!sim || !this.curve) return

    // Pulse-dock drive (same family as the other rides).
    let target = CRUISE
    if (this.dwellTimer > 0) {
      this.dwellTimer -= dt
      target = 0
    } else {
      let nearest = Infinity
      for (let i = 0; i < BOATS; i++) {
        const raw = Math.abs(((this.boatS[i] - this.dockS) % this.loopLength + this.loopLength) % this.loopLength)
        nearest = Math.min(nearest, Math.min(raw, this.loopLength - raw))
      }
      if (nearest < 4) target = Math.max(0.16, nearest * 0.2)
      const advanced = ((this.boatS[0] - this.pulsedAtS) % this.loopLength + this.loopLength) % this.loopLength
      if (nearest < 0.5 && advanced > 6) {
        this.dwellTimer = DWELL
        this.pulsedAtS = this.boatS[0]
      }
    }
    this.speed += (target - this.speed) * Math.min(1, dt * 2)
    for (let i = 0; i < BOATS; i++) {
      // Rapids: the current quickens through the drop.
      const rapids = Math.abs(((this.boatS[i] - this.rapidsS) % this.loopLength + this.loopLength) % this.loopLength)
      const rapidDistance = Math.min(rapids, this.loopLength - rapids)
      const surge = Math.exp(-(rapidDistance ** 2) / 30) * 0.9
      const previous = this.boatS[i]
      const next = (previous + (this.speed + surge * this.speed * 1.6) * dt) % this.loopLength
      this.boatS[i] = next
      if (this.crossedForward(previous, next, this.rapidsS)) {
        const splash = this.curve.getPointAt(this.rapidsS / this.loopLength, new Vector3())
        sim.addImpulse(splash.x, splash.z, 1.15, 0.22)
      }
    }
    this.placeBoats(ctx.time.elapsed)

    // Bow wakes.
    this.wakeClock -= dt
    if (this.wakeClock <= 0 && this.speed > 0.05) {
      this.wakeClock = 0.33
      for (let i = 0; i < BOATS; i++) {
        const boat = this.boats[i]
        const bow = new Vector3(0, 0, 1.25).applyQuaternion(boat.quaternion).add(boat.position)
        sim.addImpulse(bow.x, bow.z, 0.55, 0.026 + this.speed * 0.03)
      }
    }
    // Cave drips ring the surface.
    this.dripClock -= dt
    if (this.dripClock <= 0) {
      const sequence = this.dripSequence++
      this.dripClock = 2 + deterministicUnit(sequence * 3 + 1) * 3.5
      const u = deterministicUnit(sequence * 3 + 2)
      const p = this.curve.getPointAt(u, new Vector3())
      const offsetX = (deterministicUnit(sequence * 3 + 3) - 0.5) * 1.6
      const offsetZ = (deterministicUnit(sequence * 3 + 4) - 0.5) * 1.6
      sim.addImpulse(p.x + offsetX, p.z + offsetZ, 0.28, 0.07)
      ctx.events.emit('grotto/drip', {})
    }
    sim.update(dt)
    this.placeBoats(ctx.time.elapsed)

    // The galaxy turns.
    if (this.treasuryGroup) this.treasuryGroup.rotation.z += dt * 0.018
    if (this.organRotor) this.organRotor.rotation.z += dt * 0.9
    for (const pipe of this.organPipes) {
      const breath = Math.sin(ctx.time.elapsed * 1.65 + pipe.phase)
      pipe.mesh.position.y = pipe.baseY + breath * 0.035
      pipe.mesh.scale.y = 1 + breath * 0.018
    }

    // Interior darkness follows the camera into the caverns.
    const cam = ctx.camera.position
    let nearestCanal = Infinity
    for (let i = 0; i < 40; i++) {
      const q = this.curve.getPointAt(i / 40, new Vector3())
      nearestCanal = Math.min(nearestCanal, Math.hypot(cam.x - q.x, cam.z - q.z))
    }
    const nearDock = Math.hypot(cam.x - 197, cam.z - 110)
    const inside = cam.y < -24 && nearestCanal < 14 && nearDock > 7
    const factor = inside ? Math.min(1, (14 - nearestCanal) / 6) * Math.min(1, (nearDock - 7) / 5) : 0
    this.medium.setInterior(factor)
    if (Math.abs(factor - this.previousInterior) > 0.015 || (factor === 0 && this.previousInterior !== 0)) {
      this.previousInterior = factor
      ctx.events.emit('audio/grotto-interior', { amount: factor })
    }

    this.rig?.update(ctx.camera, dt)
    if (this.rig && this.ridingBoat !== -1) {
      this.rig.canExit = this.dockedBoat() === this.ridingBoat
    }
    if (this.debugCanvas && ctx.time.frame % 30 === 0) {
      this.debugCanvas.dataset.grottoState = JSON.stringify(this.debugSnapshot())
    }
  }

  dispose(ctx: GameContext): void {
    this.medium.setInterior(0)
    ctx.events.emit('audio/grotto-interior', { amount: 0 })
    if (this.ridingBoat !== -1) ctx.events.emit('ride/grotto-riding', { riding: false })
    this.sim?.dispose()
    if (this.debugCanvas) delete this.debugCanvas.dataset.grottoState
    ctx.scene.remove(this.group)
  }

  debugSnapshot(): {
    loopLength: number
    boatS: number[]
    speed: number
    dwellTimer: number
    water: ReturnType<ChannelSim['debugSnapshot']> | null
  } {
    return {
      loopLength: this.loopLength,
      boatS: [...this.boatS],
      speed: this.speed,
      dwellTimer: this.dwellTimer,
      water: this.sim?.debugSnapshot() ?? null,
    }
  }
}

function smoothstepJs(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function deterministicUnit(value: number): number {
  let h = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
