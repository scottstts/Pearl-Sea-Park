import {
  BoxGeometry,
  CatmullRomCurve3,
  Curve,
  CylinderGeometry,
  DoubleSide,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { positionWorld, uniform, vec2, vec3 } from 'three/tsl'
import { ArchKit } from '../archkit/modules'
import { SlotWriter } from '../archkit/writer'
import { registerBookmark } from '../core/debug'
import type { PlayerSystem } from '../player/player'
import { markDynamicShadowCasters } from '../render/layers'
import { fbm2 } from '../render/tslNoise'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { DistrictServices } from '../world/districts/atrium'
import { PARK_PLAN } from '../world/parkPlan'
import { terrainHeight } from '../world/terrain'
import { VehicleSeatRig } from './vehicleSeat'

const CARS = 5
const CAR_GAP = 3.3
const SAMPLES = 2400
const GRAVITY = 9.81
const DRAG = 0.0014 // quadratic drag — The Pearl's charmed water runs thin
const ROLLING = 0.12
const LAUNCH_ACCEL = 7.2
const BOOST_ACCEL = 6.0
const SURGE_ACCEL = 3.4 // water-jet surge that carries the train up the helix
const STATION_SPEED = 1.1

interface Frame {
  position: Vector3
  tangent: Vector3
  up: Vector3
  s: number
}

/**
 * The Torrent (plan §9.3): launch coaster — station on the north reach,
 * plunge off the shelf edge into open blue void, thread the wreck, helix
 * climb, a +3 m surface-breach hump, splash re-entry, brake run. Track is an
 * authored closed spline with solved banking; the train's speed is integrated
 * from gravity/drag/launch forces along arc length, never keyframed.
 */
export class TorrentSystem implements GameSystem {
  readonly id = 'torrent'

  private readonly services: DistrictServices
  private readonly player: PlayerSystem | null
  private rig: VehicleSeatRig | null = null

  private readonly group = new Object3D()
  private frames: Frame[] = []
  private trackLength = 0
  private readonly cars: Object3D[] = []

  // Longitudinal state.
  private s = 0
  private v = 0
  private state: 'docked' | 'armed' | 'running' | 'braking' = 'docked'
  private stateTime = 0

  // Zone arc-positions (computed from the layout).
  private stationS = 0
  private launchEndS = 0
  private boostStartS = 0
  private boostEndS = 0
  private brakeStartS = 0
  private surgeStartS = 0
  private surgeEndS = 0

  private splashTime: ReturnType<typeof uniform> | null = null

  constructor(services: DistrictServices, player: PlayerSystem | null) {
    this.services = services
    this.player = player
  }

  init(ctx: GameContext): void {
    const lib = this.services.materials.lib
    if (!lib) throw new Error('TorrentSystem requires materials')
    const { physics } = this.services
    const kit = new ArchKit(lib)
    const w = new SlotWriter()
    const st = PARK_PLAN.torrent.station

    // ── The layout ────────────────────────────────────────────────────────
    const stationY = terrainHeight(st.x, st.z) + 1.1
    const points: Vector3[] = []
    const P = (x: number, y: number, z: number) => points.push(new Vector3(x, y, z))
    // Station straight (southbound approach joins here), launch runway north.
    P(st.x, stationY, st.z + 24) // 0 loop seam, south of station
    P(st.x, stationY, st.z) // 1 station platform
    P(st.x, stationY - 0.4, st.z - 26) // 2 launch begins
    P(st.x, stationY - 1.2, st.z - 58) // 3 launch ends
    P(st.x - 2, -27.5, st.z - 83) // 4 over the rim lip
    // The plunge and the wreck thread-through on the cliff face.
    P(st.x - 10, -38, st.z - 102)
    P(st.x - 18, -47, st.z - 112) // 6 wreck bow gap
    P(st.x - 30, -54, st.z - 122)
    // Open void sweep.
    P(st.x - 52, -60, st.z - 132)
    P(st.x - 78, -62, st.z - 128)
    P(st.x - 96, -60, st.z - 110)
    // Helix climb (generated).
    const helixStartIndex = points.length
    const helixCenter = new Vector2(st.x - 96, st.z - 78)
    const helixRadius = 15.5
    const helixTurns = 1.75
    const helixPoints = 14
    for (let i = 0; i <= helixPoints; i++) {
      const t = i / helixPoints
      const angle = -Math.PI / 2 + t * helixTurns * Math.PI * 2
      const y = -56 + t * 36 // climb to -20
      P(
        helixCenter.x + Math.cos(angle) * helixRadius,
        y,
        helixCenter.y + Math.sin(angle) * helixRadius,
      )
    }
    const helixEndIndex = points.length - 1
    // Unwind the helix: keep following its exit tangent while leveling off,
    // else the spline overshoots 16 m down into the void and the train
    // stalls on honest physics. Two easing points, then the shelf return.
    P(st.x - 112.5, -19.6, st.z - 96)
    P(st.x - 104, -18.9, st.z - 112)
    P(st.x - 86, -17.4, st.z - 116)
    // Back over the shelf, dip, torrent booster, the breach hump.
    P(st.x - 62, -14.5, st.z - 52)
    P(st.x - 44, -18, st.z - 26)
    P(st.x - 30, -22.5, st.z - 6) // 前 booster dip
    P(st.x - 16, -22.5, st.z + 8) // booster (jet) straight
    P(st.x - 2, -14, st.z + 16)
    P(st.x + 8, 2.6, st.z + 18) // hump apex — two metres of sky
    P(st.x + 18, -12, st.z + 14)
    P(st.x + 26, -20.5, st.z + 4) // splash re-entry
    P(st.x + 26, -22.6, st.z - 14) // brake run
    P(st.x + 18, -23.2, st.z - 6)
    P(st.x + 8, stationY - 0.15, st.z + 14) // curve home
    const curve = new CatmullRomCurve3(points, true, 'centripetal', 0.5)

    // ── Frames: arc-length samples + parallel-transport up + banking ─────
    const positions: Vector3[] = []
    const tangents: Vector3[] = []
    for (let i = 0; i < SAMPLES; i++) {
      const u = i / SAMPLES
      positions.push(curve.getPointAt(u, new Vector3()))
      tangents.push(curve.getTangentAt(u, new Vector3()).normalize())
    }
    this.trackLength = curve.getLength()
    const ds = this.trackLength / SAMPLES

    // Zone anchors from layout landmarks.
    const nearestS = (target: Vector3) => {
      let best = 0
      let bestD = Infinity
      for (let i = 0; i < SAMPLES; i++) {
        const d = positions[i].distanceToSquared(target)
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      return best * ds
    }
    this.stationS = nearestS(points[1])
    this.launchEndS = nearestS(points[3])
    this.boostStartS = nearestS(points[points.length - 8])
    this.boostEndS = nearestS(points[points.length - 7])
    this.surgeStartS = nearestS(points[helixStartIndex])
    this.surgeEndS = nearestS(points[helixEndIndex])
    this.brakeStartS = nearestS(points[points.length - 3])
    this.s = this.stationS
    this.v = 0

    // Design-pass speed profile (same integrator as runtime) for banking.
    const speeds = new Float32Array(SAMPLES)
    {
      let s = this.stationS
      let v = STATION_SPEED
      const dt = 1 / 90
      for (let iter = 0; iter < 90 * 240; iter++) {
        const i = Math.floor(s / ds) % SAMPLES
        speeds[i] = Math.max(speeds[i], v)
        const slope = tangents[i].y
        let a = -GRAVITY * slope - DRAG * v * Math.abs(v) - ROLLING * Math.sign(v)
        if (this.inZone(s, this.stationS, this.launchEndS)) a += LAUNCH_ACCEL
        if (this.inZone(s, this.boostStartS, this.boostEndS)) a += BOOST_ACCEL
        if (this.inZone(s, this.surgeStartS, this.surgeEndS)) a += SURGE_ACCEL
        if (iter > 900 && this.inZone(s, this.brakeStartS, this.stationS)) a = Math.min(a, (2.2 - v) * 2)
        v = Math.max(0.6, v + a * dt)
        s = (s + v * dt) % this.trackLength
        if (iter > 90 * 30 && Math.abs(s - this.stationS) < 1) break
      }
      // Fill unvisited samples (station shadow) with a crawl speed.
      for (let i = 0; i < SAMPLES; i++) if (speeds[i] === 0) speeds[i] = 2
    }

    // Parallel transport + solved banking.
    const ups: Vector3[] = []
    let up = new Vector3(0, 1, 0)
    const scratch = new Vector3()
    for (let i = 0; i < SAMPLES; i++) {
      const t = tangents[i]
      up = up.clone().sub(scratch.copy(t).multiplyScalar(up.dot(t))).normalize()
      ups.push(up)
    }
    // Signed horizontal curvature → bank angle; smooth over a window.
    const bank = new Float32Array(SAMPLES)
    for (let i = 0; i < SAMPLES; i++) {
      const prev = tangents[(i - 1 + SAMPLES) % SAMPLES]
      const next = tangents[(i + 1) % SAMPLES]
      const turn = prev.x * next.z - prev.z * next.x // sign of horizontal turn
      const angleChange = prev.angleTo(next)
      const kappa = angleChange / (2 * ds)
      const vDesign = speeds[i]
      bank[i] = Math.max(-1.05, Math.min(1.05, Math.atan((vDesign * vDesign * kappa) / GRAVITY))) *
        Math.sign(-turn)
    }
    const smoothBank = new Float32Array(SAMPLES)
    const WINDOW = 26
    for (let i = 0; i < SAMPLES; i++) {
      let sum = 0
      for (let k = -WINDOW; k <= WINDOW; k++) sum += bank[(i + k + SAMPLES) % SAMPLES]
      smoothBank[i] = sum / (WINDOW * 2 + 1)
    }
    const frames: Frame[] = []
    const q = new Quaternion()
    for (let i = 0; i < SAMPLES; i++) {
      const banked = ups[i]
        .clone()
        .applyQuaternion(q.setFromAxisAngle(tangents[i], smoothBank[i]))
        .normalize()
      frames.push({ position: positions[i], tangent: tangents[i], up: banked, s: i * ds })
    }
    this.frames = frames

    // ── Track geometry: rails, spine, ties, supports ─────────────────────
    const frameAtS = (s: number) => this.frameAt(s)
    const totalLength = this.trackLength
    class RailCurve extends Curve<Vector3> {
      private readonly offsetX: number
      private readonly offsetY: number
      constructor(offsetX: number, offsetY: number) {
        super()
        this.offsetX = offsetX
        this.offsetY = offsetY
      }
      override getPoint(u: number, target = new Vector3()): Vector3 {
        const frame = frameAtS(u * totalLength)
        const side = new Vector3().crossVectors(frame.tangent, frame.up).normalize()
        return target
          .copy(frame.position)
          .addScaledVector(side, this.offsetX)
          .addScaledVector(frame.up, this.offsetY)
      }
    }
    for (const side of [-0.55, 0.55]) {
      const rail = new Mesh(new TubeGeometry(new RailCurve(side, 0), 1600, 0.085, 7, true), lib.brass)
      rail.castShadow = true
      this.group.add(rail)
    }
    const spine = new Mesh(new TubeGeometry(new RailCurve(0, -0.34), 1200, 0.17, 8, true), lib.iron)
    spine.castShadow = true
    this.group.add(spine)

    // Ties.
    const tieCount = Math.floor(this.trackLength / 1.6)
    const ties = new InstancedMesh(new BoxGeometry(1.5, 0.07, 0.24), lib.iron, tieCount)
    const tieMatrix = new Matrix4()
    const basis = new Matrix4()
    for (let i = 0; i < tieCount; i++) {
      const frame = this.frameAt((i + 0.5) * 1.6)
      const side = new Vector3().crossVectors(frame.tangent, frame.up).normalize()
      basis.makeBasis(side, frame.up, frame.tangent)
      tieMatrix.copy(basis).setPosition(
        frame.position.clone().addScaledVector(frame.up, -0.14),
      )
      ties.setMatrixAt(i, tieMatrix)
    }
    ties.instanceMatrix.needsUpdate = true
    ties.castShadow = true
    this.group.add(ties)

    // Supports where the seabed is reachable (none over the abyss void).
    for (let s = 0; s < this.trackLength; s += 13) {
      const frame = this.frameAt(s)
      const ground = terrainHeight(frame.position.x, frame.position.z)
      const height = frame.position.y - 0.6 - ground
      if (height < 2 || height > 34) continue
      if (this.inZone(s, this.stationS - 30, this.launchEndS)) continue // station has its own
      const column = new Mesh(new CylinderGeometry(0.22, 0.3, height, 10), lib.iron)
      column.position.set(frame.position.x, ground + height / 2, frame.position.z)
      column.castShadow = true
      this.group.add(column)
      // A guest crossing the basin floor should meet these piers, not pass
      // through them. Radius 0.34 hugs the 0.3 m base; the full height is a
      // thin pillar so the airborne remainder is harmless.
      physics.addStaticCylinder(frame.position.x, ground + height / 2, frame.position.z, height / 2, 0.34)
    }

    // ── Station ───────────────────────────────────────────────────────────
    kit.mosaicPlaza(w, st.x + 5.2, stationY - 1.2, st.z, 7)
    kit.stepsRing(w, st.x + 5.2, stationY - 1.34, st.z, 7)
    physics.addStaticCylinder(st.x + 5.2, stationY - 1.15, st.z, 0.1, 7.55)
    physics.addStaticCylinder(st.x + 5.2, stationY - 1.0, st.z, 0.1, 6.9)
    // Boarding deck beside the rails.
    const deck = new Mesh(new BoxGeometry(3.6, 0.24, 16), lib.marble)
    deck.position.set(st.x + 2.5, stationY - 0.62, st.z)
    deck.receiveShadow = true
    this.group.add(deck)
    physics.addStaticBox(st.x + 2.5, stationY - 0.62, st.z, 1.8, 0.12, 8)
    for (const dz of [-6.5, 6.5]) {
      const globe = this.services.amenities.addLamp(st.x + 4.4, stationY - 0.5, st.z + dz)
      void globe
      physics.addStaticBox(st.x + 4.4, stationY + 1.2, st.z + dz, 0.12, 1.7, 0.12)
    }
    kit.gableRoof(w, st.x + 2.2, stationY + 3.6, st.z, 7.5, 17, 2.2)
    for (const [cx, cz] of [
      [st.x + 0.4, st.z - 7.6],
      [st.x + 4.2, st.z - 7.6],
      [st.x + 0.4, st.z + 7.6],
      [st.x + 4.2, st.z + 7.6],
    ]) {
      kit.column(w, cx, stationY - 0.5, cz, 4.1, 0.22)
      physics.addStaticBox(cx, stationY + 1.55, cz, 0.28, 2.05, 0.28)
    }
    for (const x of [st.x + 0.4, st.x + 4.2]) {
      kit.cornice(w, x, st.z - 7.6, x, st.z + 7.6, stationY + 3.68)
    }
    for (const z of [st.z - 7.6, st.z + 7.6]) {
      kit.arch(w, st.x + 0.4, z, st.x + 4.2, z, stationY + 3.62, 0.8)
      kit.cornice(w, st.x + 0.4, z, st.x + 4.2, z, stationY + 3.7)
    }

    // ── The wreck: a hull caught on the cliff face, threaded by the track ─
    this.buildWreck(lib, new Vector3(st.x - 18, -50, st.z - 112))

    // ── Splash + breach foam at the hump's two pierce points ─────────────
    const splashTime = uniform(0)
    this.splashTime = splashTime
    const foamMaterial = new MeshBasicNodeMaterial()
    foamMaterial.transparent = true
    foamMaterial.depthWrite = false
    foamMaterial.side = DoubleSide
    const foamUv = positionWorld.xz.mul(0.5)
    const churn = fbm2(foamUv.add(vec2(splashTime.mul(0.4), splashTime.mul(-0.3))))
      .mul(fbm2(foamUv.mul(2.1).add(vec2(0, splashTime.mul(0.33)))))
      .mul(2.4)
    foamMaterial.colorNode = vec3(1.3, 1.38, 1.4)
    foamMaterial.opacityNode = churn.clamp(0, 1).mul(0.8)
    // Find where the hump crosses y = 0 (two points).
    const crossings: Vector3[] = []
    for (let i = 1; i < SAMPLES; i++) {
      const a = positions[i - 1]
      const b = positions[i]
      if ((a.y < 0 && b.y >= 0) || (a.y >= 0 && b.y < 0)) {
        const t = a.y / (a.y - b.y)
        crossings.push(a.clone().lerp(b, t))
      }
    }
    for (const crossing of crossings) {
      const foam = new Mesh(new PlaneGeometry(7, 5.5), foamMaterial)
      foam.rotation.x = -Math.PI / 2
      foam.position.set(crossing.x, 0.07, crossing.z)
      foam.renderOrder = 5
      this.group.add(foam)
    }

    // ── The train: five articulated brass torpedo cars ────────────────────
    const bodyGeometry = new LatheGeometry(
      [
        new Vector2(0.02, -1.45),
        new Vector2(0.42, -1.15),
        new Vector2(0.6, -0.4),
        new Vector2(0.6, 0.75),
        new Vector2(0.42, 1.25),
        new Vector2(0.05, 1.5),
      ],
      18,
    )
    bodyGeometry.rotateX(Math.PI / 2) // torpedo along +z
    const cockpitGeometry = new CylinderGeometry(0.44, 0.5, 0.5, 14, 1, true)
    const screenGeometry = new SphereGeometry(0.46, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2)
    const seatGeometry = new BoxGeometry(0.62, 0.16, 0.5)
    const barGeometry = new TorusGeometry(0.34, 0.045, 8, 14, Math.PI)
    for (let i = 0; i < CARS; i++) {
      const car = new Object3D()
      const body = new Mesh(bodyGeometry, lib.brass)
      const cockpit = new Mesh(cockpitGeometry, lib.woodDark)
      cockpit.position.set(0, 0.42, 0.1)
      const screen = new Mesh(screenGeometry, lib.glass)
      screen.position.set(0, 0.5, 0.85)
      screen.rotation.x = -0.7
      const seat = new Mesh(seatGeometry, lib.woodDark)
      seat.position.set(0, 0.28, -0.1)
      const bar = new Mesh(barGeometry, lib.iron)
      bar.position.set(0, 0.62, 0.28)
      bar.rotation.x = Math.PI / 2 + 0.35
      car.add(body, cockpit, screen, seat, bar)
      car.traverse((node) => {
        const mesh = node as Mesh
        if (mesh.isMesh && mesh.material !== lib.glass) mesh.castShadow = true
      })
      markDynamicShadowCasters(car)
      this.group.add(car)
      this.cars.push(car)
    }

    this.group.add(w.compile())
    ctx.scene.add(this.group)
    this.placeTrain()

    registerBookmark({
      name: 'torrent',
      position: [st.x + 12, stationY + 3, st.z + 16],
      look: [st.x, stationY, st.z - 30],
      note: 'The Torrent station and launch runway',
    })
    registerBookmark({
      name: 'dive',
      position: [st.x + 14, -30, st.z - 96],
      look: [st.x - 18, -50, st.z - 112],
      note: 'The plunge past the wreck into the void',
    })

    // ── Boarding & restraint flow ─────────────────────────────────────────
    if (this.player && this.services.interaction) {
      const rig = new VehicleSeatRig(this.player)
      this.rig = rig
      const interaction = this.services.interaction
      const gate = new Vector3(st.x + 1.4, stationY + 0.7, st.z)
      const exit = new Vector3(st.x + 2.6, stationY - 0.5, st.z + 2)

      interaction.register({
        position: gate,
        radius: 4.5,
        prompt: 'Board the Torrent',
        onInteract: () => {
          if (this.state !== 'docked' || rig.seated) return
          rig.attach(this.cars[0], new Vector3(0, 0.78, -0.12), Math.PI, ctx.camera)
          ctx.events.emit('ticket/punched', { ride: 'torrent' })
        },
        enabled: () => this.state === 'docked' && !rig.seated,
      })
      interaction.register({
        position: gate,
        radius: 6,
        prompt: 'Lower the lap bar',
        onInteract: () => {
          if (this.state !== 'docked' || !rig.seated) return
          this.state = 'armed'
          this.stateTime = 0
          ctx.events.emit('ride/torrent-riding', { riding: true })
        },
        enabled: () => this.state === 'docked' && rig.seated,
      })
      interaction.register({
        position: gate,
        radius: 6,
        prompt: 'Raise the bar and step out',
        onInteract: () => {
          if (this.state !== 'docked' || !rig.seated) return
          rig.requestExit(exit)
          ctx.events.emit('ride/torrent-riding', { riding: false })
        },
        enabled: () => this.state === 'docked' && rig.seated && this.stateTime > 1,
      })
    }
  }

  private inZone(s: number, from: number, to: number): boolean {
    const L = this.trackLength || 1
    const rel = ((s - from) % L + L) % L
    const span = ((to - from) % L + L) % L
    return rel <= span
  }

  private frameAt(s: number): Frame {
    const L = this.trackLength
    const wrapped = ((s % L) + L) % L
    const f = (wrapped / L) * SAMPLES
    const i = Math.floor(f) % SAMPLES
    const j = (i + 1) % SAMPLES
    const t = f - Math.floor(f)
    const a = this.frames[i]
    const b = this.frames[j]
    return {
      position: a.position.clone().lerp(b.position, t),
      tangent: a.tangent.clone().lerp(b.tangent, t).normalize(),
      up: a.up.clone().lerp(b.up, t).normalize(),
      s: wrapped,
    }
  }

  private placeTrain(): void {
    const basis = new Matrix4()
    for (let i = 0; i < CARS; i++) {
      const frame = this.frameAt(this.s - i * CAR_GAP)
      const side = new Vector3().crossVectors(frame.tangent, frame.up).normalize()
      basis.makeBasis(side, frame.up, frame.tangent)
      this.cars[i].quaternion.setFromRotationMatrix(basis)
      this.cars[i].position.copy(frame.position).addScaledVector(frame.up, 0.42)
    }
  }

  private buildWreck(lib: NonNullable<DistrictServices['materials']['lib']>, at: Vector3): void {
    const wreck = new Object3D()
    // Keel + ribs: an open hull the track threads through.
    const keel = new Mesh(new CylinderGeometry(0.5, 0.5, 30, 10), lib.woodDark)
    keel.rotation.z = Math.PI / 2
    keel.rotation.y = 0.5
    wreck.add(keel)
    for (let i = 0; i < 9; i++) {
      const t = i / 8 - 0.5
      const radius = 6.2 * (1 - Math.abs(t) * 0.75)
      const rib = new Mesh(new TorusGeometry(radius, 0.28, 8, 22, Math.PI * 1.15), lib.woodDark)
      rib.position.set(Math.cos(0.5) * t * 28, radius * 0.15, -Math.sin(0.5) * t * 28)
      rib.rotation.y = 0.5 + Math.PI / 2
      rib.rotation.z = Math.PI * 0.92
      wreck.add(rib)
    }
    // A leaning mast with a crow's ring.
    const mast = new Mesh(new CylinderGeometry(0.22, 0.32, 17, 10), lib.woodDark)
    mast.position.set(3, 8, -2)
    mast.rotation.z = 0.5
    mast.rotation.x = 0.2
    const ring = new Mesh(new TorusGeometry(0.7, 0.08, 8, 18), lib.iron)
    ring.position.set(7.2, 14.4, -3.4)
    ring.rotation.x = Math.PI / 2
    wreck.add(mast, ring)
    // Scattered hull planks.
    for (let i = 0; i < 12; i++) {
      const plank = new Mesh(new BoxGeometry(2.6, 0.12, 0.5), lib.woodDark)
      plank.position.set(
        (Math.sin(i * 3.7) * 9) | 0,
        -2.2 + Math.sin(i * 1.3) * 1.2,
        (Math.cos(i * 2.9) * 8) | 0,
      )
      plank.rotation.set(Math.sin(i) * 0.5, i * 0.7, Math.cos(i * 1.7) * 0.4)
      wreck.add(plank)
    }
    wreck.position.copy(at)
    wreck.rotation.y = -0.25
    wreck.traverse((node) => {
      const mesh = node as Mesh
      if (mesh.isMesh) {
        mesh.castShadow = true
        mesh.receiveShadow = true
      }
    })
    this.group.add(wreck)
  }

  update(ctx: GameContext, dt: number): void {
    this.stateTime += dt
    if (this.splashTime) this.splashTime.value = ctx.time.elapsed

    if (this.state === 'armed' && this.stateTime > 2.2) {
      this.state = 'running'
      this.stateTime = 0
      this.v = STATION_SPEED
    }

    if (this.state === 'running' || this.state === 'braking') {
      const frame = this.frameAt(this.s)
      let a = -GRAVITY * frame.tangent.y - DRAG * this.v * Math.abs(this.v) - ROLLING
      if (this.inZone(this.s, this.stationS, this.launchEndS)) a += LAUNCH_ACCEL
      if (this.inZone(this.s, this.boostStartS, this.boostEndS)) a += BOOST_ACCEL
      if (this.inZone(this.s, this.surgeStartS, this.surgeEndS)) a += SURGE_ACCEL
      // The brake zone ends AT the station mark, so a freshly-launched train
      // still sits inside it — only capture after the lap is truly underway.
      if (
        (this.state === 'braking' || this.stateTime > 10) &&
        this.inZone(this.s, this.brakeStartS, this.stationS)
      ) {
        this.state = 'braking'
        a = Math.min(a, (2.2 - this.v) * 2.4)
      }
      this.v = Math.max(0.5, this.v + a * dt)
      this.s = (this.s + this.v * dt) % this.trackLength
      // Arrive: creep to the platform mark and dock.
      if (this.state === 'braking') {
        const remaining = ((this.stationS - this.s) % this.trackLength + this.trackLength) % this.trackLength
        if (remaining < 0.6 || remaining > this.trackLength - 8) {
          this.s = this.stationS
          this.v = 0
          this.state = 'docked'
          this.stateTime = 0
          if (this.rig) this.rig.canExit = true
        }
      }
      this.placeTrain()
    }

    if (this.rig) {
      if (this.state !== 'docked') this.rig.canExit = false
      this.rig.update(ctx.camera, dt)
    }
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
  }
}
