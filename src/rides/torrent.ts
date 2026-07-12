import {
  BoxGeometry,
  ConeGeometry,
  Curve,
  CylinderGeometry,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
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
import type { DistrictServices } from '../world/districts/atrium'
import { PARK_PLAN } from '../world/parkPlan'
import { terrainHeight } from '../world/terrain'
import {
  STATION_SPEED,
  buildTorrentTrack,
  frameOnTrack,
  inTrackZone,
  trackAccel,
  type TorrentTrack,
  type TrackFrame,
} from './torrentTrack'
import { VehicleSeatRig } from './vehicleSeat'

const CARS = 5
const CAR_GAP = 3.3

/**
 * The Torrent (plan §9.3): launch coaster — station on the north reach,
 * plunge off the shelf edge into open blue void, thread the wreck, helix
 * climb, a +2.6 m surface-breach hump, splash re-entry, brake run. The track
 * authority lives in torrentTrack.ts (audited offline for seabed clearance
 * and seam continuity); the train's speed is integrated from gravity/drag/
 * launch forces along arc length, never keyframed.
 *
 * Ride contract: press E at the platform to board — the camera faces the
 * head of the train and the run starts on its own moments later. The loop
 * closes perfectly back into the station, the train brakes to the platform
 * mark and stops. Press E to step off; nothing relaunches while a guest is
 * still seated.
 */
export class TorrentSystem implements GameSystem {
  readonly id = 'torrent'

  private readonly services: DistrictServices
  private readonly player: PlayerSystem | null
  private rig: VehicleSeatRig | null = null

  private readonly group = new Object3D()
  private track: TorrentTrack | null = null
  private readonly cars: Object3D[] = []

  // Longitudinal state.
  private s = 0
  private v = 0
  private state: 'docked' | 'armed' | 'running' | 'braking' = 'docked'
  private stateTime = 0

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

    const track = buildTorrentTrack()
    this.track = track
    const stationY = track.stationY
    this.s = track.landmarks.stationS
    this.v = 0

    // ── Track geometry: rails, spine, ties, webs, supports ───────────────
    const frameAtS = (s: number) => frameOnTrack(track, s)
    const totalLength = track.length
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
        // Right-handed frame: right = up × tangent.
        const right = new Vector3().crossVectors(frame.up, frame.tangent).normalize()
        return target
          .copy(frame.position)
          .addScaledVector(right, this.offsetX)
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

    // Ties, and web struts tying each tie down to the spine — without them
    // the spine reads as a loose pipe shadowing the rails.
    const tieCount = Math.floor(track.length / 1.6)
    const ties = new InstancedMesh(new BoxGeometry(1.5, 0.07, 0.24), lib.iron, tieCount)
    const webs = new InstancedMesh(new BoxGeometry(0.12, 0.26, 0.16), lib.iron, tieCount)
    const tieMatrix = new Matrix4()
    const basis = new Matrix4()
    const right = new Vector3()
    for (let i = 0; i < tieCount; i++) {
      const frame = frameAtS((i + 0.5) * 1.6)
      right.crossVectors(frame.up, frame.tangent).normalize()
      basis.makeBasis(right, frame.up, frame.tangent)
      tieMatrix.copy(basis).setPosition(
        frame.position.clone().addScaledVector(frame.up, -0.14),
      )
      ties.setMatrixAt(i, tieMatrix)
      tieMatrix.copy(basis).setPosition(
        frame.position.clone().addScaledVector(frame.up, -0.26),
      )
      webs.setMatrixAt(i, tieMatrix)
    }
    ties.instanceMatrix.needsUpdate = true
    ties.castShadow = true
    webs.instanceMatrix.needsUpdate = true
    this.group.add(ties, webs)

    // Supports where the seabed is reachable (none over the abyss void),
    // with flared verdigris feet and a saddle clamp under the spine.
    const footGeometry = new LatheGeometry(
      [
        new Vector2(0.9, 0),
        new Vector2(0.78, 0.18),
        new Vector2(0.45, 0.42),
        new Vector2(0.34, 0.8),
        new Vector2(0.3, 1.0),
      ],
      14,
    )
    const clampGeometry = new BoxGeometry(0.62, 0.3, 0.62)
    for (let s = 0; s < track.length; s += 13) {
      const frame = frameAtS(s)
      const ground = terrainHeight(frame.position.x, frame.position.z)
      const height = frame.position.y - 0.6 - ground
      if (height < 2 || height > 34) continue
      if (inTrackZone(track.length, s, track.landmarks.stationS - 30, track.landmarks.launchEndS)) continue
      const column = new Mesh(new CylinderGeometry(0.22, 0.3, height, 10), lib.iron)
      column.position.set(frame.position.x, ground + height / 2, frame.position.z)
      column.castShadow = true
      const foot = new Mesh(footGeometry, lib.verdigris)
      foot.position.set(frame.position.x, ground, frame.position.z)
      const clamp = new Mesh(clampGeometry, lib.iron)
      clamp.position.set(frame.position.x, ground + height - 0.05, frame.position.z)
      this.group.add(column, foot, clamp)
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
    // Canopy over track AND deck. The west column row stands at st.x − 2.2 —
    // clear across the track envelope (rails ±0.55, car hulls ±0.62); the old
    // row at st.x + 0.4 planted its plinths straight into the rails.
    kit.gableRoof(w, st.x + 1.0, stationY + 3.6, st.z, 9.6, 17, 2.2)
    for (const [cx, cz] of [
      [st.x - 2.2, st.z - 7.6],
      [st.x + 4.2, st.z - 7.6],
      [st.x - 2.2, st.z + 7.6],
      [st.x + 4.2, st.z + 7.6],
    ]) {
      kit.column(w, cx, stationY - 0.5, cz, 4.1, 0.22)
      physics.addStaticBox(cx, stationY + 1.55, cz, 0.28, 2.05, 0.28)
    }
    for (const x of [st.x - 2.2, st.x + 4.2]) {
      kit.cornice(w, x, st.z - 7.6, x, st.z + 7.6, stationY + 3.68)
    }
    for (const z of [st.z - 7.6, st.z + 7.6]) {
      kit.arch(w, st.x - 2.2, z, st.x + 4.2, z, stationY + 3.62, 0.8)
      kit.cornice(w, st.x - 2.2, z, st.x + 4.2, z, stationY + 3.7)
    }

    // ── The wreck: a hull caught on the cliff face, threaded by the track ─
    this.buildWreck(lib, new Vector3(st.x - 19, -62, st.z - 119))

    // No bespoke dressing where the hump pierces the surface (Scott's
    // ruling): the ocean shader already owns that interface for EVERY
    // opaque structure — depth-tested intersection and shading from above,
    // framebuffer-refracted Snell window from below — exactly like the
    // arrival pavilion's piles. Decorative foam quads on top of it read as
    // floating white patches.

    // ── The train: five sculpted brass torpedo cars ──────────────────────
    // Closed-lathe hull with a bow ring and tail cone, a recessed cockpit
    // cavity with coaming (the old open-ended cockpit cylinder showed its
    // culled interior), seat + headrest, side strakes, tail fins around a
    // water-jet nozzle ring. Local +z = direction of travel.
    const hullGeometry = new LatheGeometry(
      [
        new Vector2(0.02, -1.5),
        new Vector2(0.24, -1.38),
        new Vector2(0.44, -1.1),
        new Vector2(0.56, -0.7),
        new Vector2(0.62, -0.15),
        new Vector2(0.6, 0.45),
        new Vector2(0.52, 0.95),
        new Vector2(0.36, 1.3),
        new Vector2(0.14, 1.52),
        new Vector2(0.02, 1.56),
      ],
      20,
    )
    hullGeometry.rotateX(-Math.PI / 2) // profile +y → +z: nose forward
    const cockpitCavity = new SphereGeometry(1, 16, 10)
    const coaming = new TorusGeometry(1, 0.05, 8, 22)
    const screenGeometry = new SphereGeometry(0.4, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.4)
    const screenRim = new TorusGeometry(0.38, 0.025, 8, 28)
    const screenMount = new CylinderGeometry(0.025, 0.035, 0.24, 10)
    const seatGeometry = new BoxGeometry(0.56, 0.14, 0.5)
    const seatBack = new BoxGeometry(0.5, 0.4, 0.12)
    const headrest = new CylinderGeometry(0.09, 0.09, 0.3, 10)
    const barGeometry = new TorusGeometry(0.3, 0.04, 8, 14, Math.PI)
    const strake = new BoxGeometry(0.05, 0.08, 1.7)
    const finGeometry = new ConeGeometry(0.3, 0.6, 8)
    const nozzle = new TorusGeometry(0.24, 0.055, 8, 18)
    const bowRing = new TorusGeometry(0.34, 0.04, 8, 18)
    for (let i = 0; i < CARS; i++) {
      const car = new Object3D()
      const body = new Mesh(hullGeometry, lib.brass)
      const cavity = new Mesh(cockpitCavity, lib.woodDark)
      cavity.scale.set(0.45, 0.22, 0.6)
      cavity.position.set(0, 0.5, -0.05)
      const rim = new Mesh(coaming, lib.brass)
      rim.scale.set(0.46, 0.62, 1)
      rim.rotation.x = Math.PI / 2
      rim.position.set(0, 0.56, -0.05)
      const screen = new Mesh(screenGeometry, lib.glass)
      const screenAssembly = new Object3D()
      screenAssembly.position.set(0, 0.5, 0.62)
      screenAssembly.rotation.x = -0.55
      const screenEdge = new Mesh(screenRim, lib.verdigris)
      screenEdge.rotation.x = Math.PI / 2
      screenEdge.position.y = 0.124
      screenAssembly.add(screen, screenEdge)
      for (const side of [-1, 1]) {
        const mount = new Mesh(screenMount, lib.verdigris)
        mount.position.set(side * 0.31, -0.02, 0)
        mount.rotation.z = side * 0.18
        screenAssembly.add(mount)
      }
      const seat = new Mesh(seatGeometry, lib.woodDark)
      seat.position.set(0, 0.34, -0.12)
      const back = new Mesh(seatBack, lib.woodDark)
      back.position.set(0, 0.52, -0.44)
      back.rotation.x = 0.15
      const rest = new Mesh(headrest, lib.woodDark)
      rest.rotation.z = Math.PI / 2
      rest.position.set(0, 0.78, -0.5)
      const bar = new Mesh(barGeometry, lib.iron)
      bar.position.set(0, 0.56, 0.26)
      bar.rotation.x = Math.PI / 2 + 0.35
      car.add(body, cavity, rim, screenAssembly, seat, back, rest, bar)
      for (const side of [-1, 1]) {
        const sideStrake = new Mesh(strake, lib.iron)
        sideStrake.position.set(side * 0.6, 0.02, -0.1)
        car.add(sideStrake)
        const fin = new Mesh(finGeometry, lib.brass)
        fin.scale.set(0.16, 1, 1)
        fin.position.set(side * 0.42, 0.1, -1.32)
        fin.rotation.z = side * 0.9
        fin.rotation.x = -0.5
        car.add(fin)
      }
      const dorsalFin = new Mesh(finGeometry, lib.brass)
      dorsalFin.scale.set(0.16, 1, 1)
      dorsalFin.position.set(0, 0.42, -1.32)
      dorsalFin.rotation.x = -0.5
      const jet = new Mesh(nozzle, lib.verdigris)
      jet.position.set(0, 0, -1.52)
      const bow = new Mesh(bowRing, lib.verdigris)
      bow.position.set(0, 0, 1.28)
      car.add(dorsalFin, jet, bow)
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
      look: [st.x - 19, -55, st.z - 119],
      note: 'The plunge past the wreck into the void',
    })

    // ── Boarding: E to board (faces the head, run starts on its own),
    //    E to step off when the train docks again ─────────────────────────
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
          // baseYaw π turns the seat camera onto the car's +z — the HEAD of
          // the train and the direction of travel.
          rig.attach(this.cars[0], new Vector3(0, 0.82, -0.12), Math.PI, ctx.camera)
          ctx.events.emit('ticket/punched', { ride: 'torrent' })
          ctx.events.emit('ride/torrent-riding', { riding: true })
          this.state = 'armed'
          this.stateTime = 0
        },
        enabled: () => this.state === 'docked' && !rig.seated,
      })
      interaction.register({
        position: gate,
        radius: 6,
        prompt: 'Step off the Torrent',
        onInteract: () => {
          if (this.state !== 'docked' || !rig.seated) return
          rig.requestExit(exit)
          ctx.events.emit('ride/torrent-riding', { riding: false })
        },
        enabled: () => this.state === 'docked' && rig.seated && this.stateTime > 1,
      })
    }
  }

  private placeTrain(): void {
    if (!this.track) return
    const basis = new Matrix4()
    const right = new Vector3()
    for (let i = 0; i < CARS; i++) {
      const frame = frameOnTrack(this.track, this.s - i * CAR_GAP)
      // Right-handed basis (right, up, tangent): local +z = travel. The old
      // tangent×up "side" made a LEFT-handed basis whose quaternion carried
      // a reflection — cars pointed anywhere but forward.
      right.crossVectors(frame.up, frame.tangent).normalize()
      basis.makeBasis(right, frame.up, frame.tangent)
      this.cars[i].quaternion.setFromRotationMatrix(basis)
      this.cars[i].position.copy(frame.position).addScaledVector(frame.up, 0.42)
    }
  }

  private buildWreck(lib: NonNullable<DistrictServices['materials']['lib']>, at: Vector3): void {
    const wreck = new Object3D()
    // A single broken hull assembly: keel, shaped ribs, attached plank courses,
    // and longitudinal stringers all share the same local bow-to-stern axis.
    const hullLength = 30
    const keel = new Mesh(new CylinderGeometry(0.42, 0.58, hullLength, 12), lib.woodDark)
    keel.rotation.z = Math.PI / 2
    keel.position.y = -4.7
    wreck.add(keel)
    for (let i = 0; i < 10; i++) {
      const t = i / 9 - 0.5
      const radius = 5.8 * (1 - Math.abs(t) * 0.68)
      const rib = new Mesh(new TorusGeometry(radius, 0.25, 8, 26, Math.PI * 1.15), lib.woodDark)
      rib.position.set(t * 27, 0, 0)
      rib.rotation.y = Math.PI / 2
      rib.rotation.x = Math.PI * 0.925
      wreck.add(rib)
    }

    // Longitudinal members bind the ribs into a readable hull silhouette.
    for (const side of [-1, 1]) {
      for (const [y, z] of [[-3.7, 2.5], [-1.7, 4.5]] as const) {
        const stringer = new Mesh(new CylinderGeometry(0.13, 0.17, 27, 8), lib.woodDark)
        stringer.rotation.z = Math.PI / 2
        stringer.position.set(0, y, side * z)
        wreck.add(stringer)
      }
    }

    // Hull planking remains broken enough for the train to thread the wreck,
    // but every surviving board follows a hull course instead of floating.
    const plankLength = 4.1
    for (let course = 0; course < 5; course++) {
      const angle = -1.05 + course * 0.525
      for (let segment = 0; segment < 7; segment++) {
        if ((course * 3 + segment * 5) % 11 < 3) continue
        const x = -12.3 + segment * 4.1
        const taper = 1 - Math.abs(x / 17) * 0.45
        const radius = 5.15 * taper
        const plank = new Mesh(new BoxGeometry(plankLength, 0.16, 0.78), lib.woodDark)
        plank.position.set(x, -Math.cos(angle) * radius, Math.sin(angle) * radius)
        plank.rotation.x = angle
        plank.rotation.z = Math.sin(segment * 2.1 + course) * 0.025
        wreck.add(plank)
      }
    }

    // A snapped, leaning mast with a cross-tree and iron crow's ring.
    const mast = new Mesh(new CylinderGeometry(0.22, 0.32, 17, 10), lib.woodDark)
    mast.position.set(3, 8, -2)
    mast.rotation.z = 0.5
    mast.rotation.x = 0.2
    const crossTree = new Mesh(new CylinderGeometry(0.11, 0.14, 7.5, 8), lib.woodDark)
    crossTree.position.set(6.1, 12.3, -3)
    crossTree.rotation.z = Math.PI / 2 + 0.5
    const ring = new Mesh(new TorusGeometry(0.7, 0.08, 8, 18), lib.iron)
    ring.position.set(7.2, 14.4, -3.4)
    ring.rotation.x = Math.PI / 2
    wreck.add(mast, crossTree, ring)
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
    const track = this.track
    if (!track) return
    const { landmarks } = track

    if (this.state === 'armed' && this.stateTime > 2.4) {
      this.state = 'running'
      this.stateTime = 0
      this.v = STATION_SPEED
    }

    if (this.state === 'running' || this.state === 'braking') {
      const frame: TrackFrame = frameOnTrack(track, this.s)
      // The brake zone ends AT the station mark, so a freshly-launched train
      // still sits inside it — only capture after the lap is truly underway.
      if (
        (this.state === 'braking' || this.stateTime > 10) &&
        inTrackZone(track.length, this.s, landmarks.brakeStartS, landmarks.stationS)
      ) {
        this.state = 'braking'
      }
      const a = trackAccel(
        track.length,
        landmarks,
        this.s,
        this.v,
        frame.tangent.y,
        this.state === 'braking',
      )
      this.v = Math.max(0.5, this.v + a * dt)
      let step = this.v * dt
      // Arrive with an exact landing on the platform mark (the wheel's
      // lesson: never detect-then-ease past a stop). The next run only ever
      // starts from the boarding interaction — never while a guest sits.
      if (this.state === 'braking') {
        const remaining =
          ((landmarks.stationS - this.s) % track.length + track.length) % track.length
        if ((remaining <= step && remaining < 8) || remaining > track.length - 8) {
          step = 0
          this.s = landmarks.stationS
          this.v = 0
          this.state = 'docked'
          this.stateTime = 0
          if (this.rig) this.rig.canExit = true
        }
      }
      this.s = (this.s + step) % track.length
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
