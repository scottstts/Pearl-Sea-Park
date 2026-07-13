import {
  BoxGeometry,
  CatmullRomCurve3,
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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
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
import { buildTorrentHullGeometry, torrentHullRadiusAt } from './torrentCarHull'
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

    // ── The train: five japanned hydro-sleds ──────────────────────────────
    // A racing sled in deep torrent-teal lacquer over brass running trim:
    // CatmullRom-smoothed boat-tail hull with a REAL open cockpit well (the
    // hull authority lives in torrentCarHull.ts, audited offline for winding,
    // envelope, openness, and the rider sightline), riveted panel seams
    // radius-keyed to the hull, brass deck spine and rub rails, visible axle
    // bogies riding the rails, a leather cockpit (rolled bolster, bucket
    // squab, headrest roll) behind a framed spray hoop, a nacre-tipped
    // wave-cutter figurehead at the bow, and a verdigris stern cowl with dark
    // nozzle throat and three swept thickness-bearing fins. The rider's tail
    // car carries a small lantern. Local +z = direction of travel; every
    // extreme stays inside the audited envelope (half-width ≤ 0.62,
    // z ∈ [−1.5, 1.62]).
    //
    // The camera rides centimetres from this surface — a coarse lathe would
    // read as flat facets (the descent-bell lesson), so 36 radial segments.
    const hullGeometry = buildTorrentHullGeometry()
    const hullRadiusAt = torrentHullRadiusAt

    // Point-to-point member: the armillary/telescope rule — parts that must
    // visibly connect derive their pose from real endpoints, never from
    // hand-tuned Euler leans.
    const memberGeometry = new CylinderGeometry(1, 1, 1, 12)
    const UP = new Vector3(0, 1, 0)
    const memberBetween = (
      from: Vector3,
      to: Vector3,
      radius: number,
      material: (typeof lib)['brass'],
    ): Mesh => {
      const direction = new Vector3().subVectors(to, from)
      const length = direction.length()
      const member = new Mesh(memberGeometry, material)
      member.scale.set(radius, length, radius)
      member.quaternion.setFromUnitVectors(UP, direction.normalize())
      member.position.copy(from).addScaledVector(direction, 0.5 * length)
      return member
    }

    // Shared geometry (one allocation each, reused by all five cars).
    // Panel seams bound the hull bays (tail cone, engine bay, cockpit bay,
    // bow bay) — never crossing the cockpit opening (z −0.63…+0.53).
    const SEAM_Z = [-1.22, -0.95, 0.62, 0.95]
    const seamGeometries = SEAM_Z.map(
      (z) => new TorusGeometry(hullRadiusAt(z) + 0.006, 0.018, 8, 44),
    )
    const rivetGeometry = new SphereGeometry(0.016, 6, 5)
    const railGeometry = new CylinderGeometry(0.03, 0.03, 2.0, 10)
    railGeometry.rotateX(Math.PI / 2)
    const keelGeometry = new CylinderGeometry(0.045, 0.045, 1.9, 10)
    keelGeometry.rotateX(Math.PI / 2)
    const axleGeometry = new CylinderGeometry(0.035, 0.035, 1.16, 10)
    axleGeometry.rotateZ(Math.PI / 2)
    const wheelGeometry = new CylinderGeometry(0.105, 0.105, 0.07, 20)
    wheelGeometry.rotateZ(Math.PI / 2)
    const hubGeometry = new CylinderGeometry(0.045, 0.05, 0.035, 12)
    hubGeometry.rotateZ(Math.PI / 2)
    // The cockpit is a real open tub, not a capped pod: an inward-wound
    // lathe (descending profile → faces the axis) keeps the interior visible
    // from above with FrontSide materials — the pearl-diver funnel rule.
    const tubGeometry = new LatheGeometry(
      [
        new Vector2(0.44, 0.0),
        new Vector2(0.41, -0.09),
        new Vector2(0.33, -0.19),
        new Vector2(0.20, -0.26),
        new Vector2(0.02, -0.285),
      ],
      28,
    )
    const bolsterGeometry = new TorusGeometry(1, 0.055, 12, 30)
    const bolsterLipGeometry = new TorusGeometry(1, 0.016, 8, 30)
    const squabGeometry = new SphereGeometry(1, 16, 10)
    const backrestGeometry = new SphereGeometry(1, 16, 10)
    const headrestGeometry = new CylinderGeometry(0.06, 0.06, 0.24, 12)
    headrestGeometry.rotateZ(Math.PI / 2)
    const armrestGeometry = new TorusGeometry(0.16, 0.022, 8, 18, Math.PI)
    const barGeometry = new TorusGeometry(0.30, 0.035, 10, 22, Math.PI)
    const knuckleGeometry = new SphereGeometry(0.05, 10, 8)
    const dialBezelGeometry = new TorusGeometry(0.09, 0.014, 8, 20)
    const dialFaceGeometry = new CylinderGeometry(0.08, 0.08, 0.014, 20)
    const screenFrameGeometry = new TorusGeometry(0.31, 0.02, 8, 30)
    const bowCollarGeometry = new TorusGeometry(hullRadiusAt(1.44) + 0.012, 0.028, 8, 24)
    const bladeGeometry = new SphereGeometry(1, 14, 10)
    const pearlGeometry = new SphereGeometry(0.075, 16, 12)
    const cowlGeometry = new TorusGeometry(0.34, 0.075, 10, 26)
    // Venturi nozzle: wide at the hull, narrowing aft — a machined exit,
    // not a spike (a bare cone apex read as a weapon).
    const throatGeometry = new CylinderGeometry(0.115, 0.26, 0.34, 22)
    throatGeometry.rotateX(-Math.PI / 2)
    const finBladeGeometry = new SphereGeometry(1, 14, 10)
    const lanternGlobeGeometry = new SphereGeometry(0.055, 12, 9)
    const lanternRingGeometry = new TorusGeometry(0.065, 0.008, 6, 16)
    // Flank trim, shared by all five cars as two merged geometries (+2
    // draws/car): six brass cooling louvres on the engine bay and a pair of
    // ringed nacre roundels on the bow — coachwork jewellery, all inside
    // the audited half-width (max reach 0.45 < 0.62).
    const trimParts: Array<BoxGeometry | TorusGeometry> = []
    const louvreRadius = hullRadiusAt(-1.08) + 0.008
    for (const side of [-1, 1]) {
      for (const louvreZ of [-1.17, -1.07, -0.97]) {
        const louvre = new BoxGeometry(0.05, 0.018, 0.11)
        louvre.rotateZ(side * -0.7)
        louvre.translate(
          side * Math.sin(0.7) * louvreRadius,
          Math.cos(0.7) * louvreRadius,
          louvreZ,
        )
        trimParts.push(louvre)
      }
      const roundelRing = new TorusGeometry(0.095, 0.012, 6, 20)
      roundelRing.rotateY(Math.PI / 2)
      roundelRing.translate(side * (hullRadiusAt(1.08) + 0.006), 0, 1.08)
      trimParts.push(roundelRing)
    }
    const trimGeometry = mergeGeometries(trimParts, false)!
    for (const part of trimParts) part.dispose()
    const roundelParts: CylinderGeometry[] = []
    for (const side of [-1, 1]) {
      const disc = new CylinderGeometry(0.082, 0.082, 0.014, 20)
      disc.rotateZ(Math.PI / 2)
      disc.translate(side * (hullRadiusAt(1.08) + 0.006), 0, 1.08)
      roundelParts.push(disc)
    }
    const roundelGeometry = mergeGeometries(roundelParts, false)!
    for (const part of roundelParts) part.dispose()

    const tinyParts = new Set<Object3D>()
    for (let i = 0; i < CARS; i++) {
      const car = new Object3D()

      // Hull, keel, deck spine, rub rails, panel seams, rivets.
      const body = new Mesh(hullGeometry, lib.lacquer)
      car.add(body)
      const keel = new Mesh(keelGeometry, lib.brass)
      keel.position.set(0, -0.575, -0.05)
      car.add(keel)
      // The spine roots just past the cockpit opening's bow edge (the well
      // now being genuinely open, a start inside it would read as a bare rod
      // rising out of the seat).
      const spine = memberBetween(
        new Vector3(0, 0.585, 0.56),
        new Vector3(0, 0.295, 1.36),
        0.035,
        lib.brass,
      )
      car.add(spine)
      for (const side of [-1, 1]) {
        const rail = new Mesh(railGeometry, lib.brass)
        rail.position.set(side * 0.585, 0.02, -0.05)
        car.add(rail)
      }
      for (let s = 0; s < SEAM_Z.length; s++) {
        const seam = new Mesh(seamGeometries[s], lib.brass)
        seam.position.z = SEAM_Z[s]
        car.add(seam)
      }
      const trim = new Mesh(trimGeometry, lib.brass)
      car.add(trim)
      tinyParts.add(trim)
      const roundels = new Mesh(roundelGeometry, lib.nacre)
      car.add(roundels)
      tinyParts.add(roundels)
      const rivets = new InstancedMesh(rivetGeometry, lib.brass, SEAM_Z.length * 14)
      const rivetPose = new Matrix4()
      let rivetIndex = 0
      for (let s = 0; s < SEAM_Z.length; s++) {
        const radius = hullRadiusAt(SEAM_Z[s]) + 0.012
        for (let k = 0; k < 14; k++) {
          const angle = ((k + 0.5) / 14) * Math.PI * 2
          rivetPose.makeTranslation(
            Math.cos(angle) * radius,
            Math.sin(angle) * radius,
            SEAM_Z[s] + 0.045,
          )
          rivets.setMatrixAt(rivetIndex++, rivetPose)
        }
      }
      car.add(rivets)
      tinyParts.add(rivets)

      // Running gear: two visible axle bogies riding the rails.
      for (const z of [-0.85, 0.85]) {
        const axle = new Mesh(axleGeometry, lib.iron)
        axle.position.set(0, -0.44, z)
        car.add(axle)
        for (const side of [-1, 1]) {
          const wheel = new Mesh(wheelGeometry, lib.iron)
          wheel.position.set(side * 0.55, -0.44, z)
          car.add(wheel)
          const hub = new Mesh(hubGeometry, lib.brass)
          hub.position.set(side * 0.585, -0.44, z)
          car.add(hub)
          tinyParts.add(hub)
        }
      }

      // Cockpit: open leather-lined tub sunk into the deck, bucket seat
      // genuinely visible inside, rolled bolster riding the hull line.
      const tub = new Mesh(tubGeometry, lib.leather)
      tub.scale.set(1, 1, 1.32)
      tub.position.set(0, 0.60, -0.05)
      car.add(tub)
      const bolster = new Mesh(bolsterGeometry, lib.leather)
      bolster.scale.set(0.46, 0.615, 1)
      bolster.rotation.x = Math.PI / 2
      bolster.position.set(0, 0.60, -0.05)
      car.add(bolster)
      const bolsterLip = new Mesh(bolsterLipGeometry, lib.brass)
      bolsterLip.scale.set(0.495, 0.655, 1)
      bolsterLip.rotation.x = Math.PI / 2
      bolsterLip.position.set(0, 0.635, -0.05)
      car.add(bolsterLip)
      const squab = new Mesh(squabGeometry, lib.leather)
      squab.scale.set(0.27, 0.10, 0.25)
      squab.position.set(0, 0.40, -0.10)
      car.add(squab)
      const backrest = new Mesh(backrestGeometry, lib.leather)
      backrest.scale.set(0.24, 0.21, 0.075)
      backrest.rotation.x = 0.20
      backrest.position.set(0, 0.55, -0.44)
      car.add(backrest)
      const headrest = new Mesh(headrestGeometry, lib.leather)
      headrest.position.set(0, 0.73, -0.50)
      car.add(headrest)
      for (const side of [-1, 1]) {
        const armrest = new Mesh(armrestGeometry, lib.brass)
        armrest.rotation.y = Math.PI / 2
        armrest.rotation.z = side * 0.12
        armrest.position.set(side * 0.33, 0.50, -0.14)
        car.add(armrest)
        tinyParts.add(armrest)
      }
      const bar = new Mesh(barGeometry, lib.brass)
      bar.position.set(0, 0.55, 0.27)
      bar.rotation.x = Math.PI / 2 + 0.35
      car.add(bar)
      for (const side of [-1, 1]) {
        const barKnuckle = new Mesh(knuckleGeometry, lib.brass)
        barKnuckle.scale.setScalar(0.8)
        barKnuckle.position.set(side * 0.30, 0.50, 0.245)
        car.add(barKnuckle)
        tinyParts.add(barKnuckle)
      }
      const dialBezel = new Mesh(dialBezelGeometry, lib.brass)
      const dialFace = new Mesh(dialFaceGeometry, lib.nacre)
      dialFace.rotation.x = Math.PI / 2
      const dial = new Object3D()
      dial.add(dialBezel, dialFace)
      dial.position.set(0, 0.50, 0.44)
      dial.rotation.x = -0.85
      car.add(dial)
      tinyParts.add(dial)

      // Cowl hoop: the open brass ring raked low over the bow deck on its
      // two side mounts — a racing wind hoop. (The glass dome slice and its
      // centre mount strut are gone by ruling: the glass read as nothing
      // underwater and the strut read as a bare rod stuck in the deck.)
      const screenAssembly = new Object3D()
      screenAssembly.position.set(0, 0.545, 0.58)
      screenAssembly.rotation.x = -0.72
      const screenFrame = new Mesh(screenFrameGeometry, lib.brass)
      screenFrame.rotation.x = Math.PI / 2
      screenFrame.position.y = 0.10
      screenAssembly.add(screenFrame)
      for (const side of [-1, 1]) {
        screenAssembly.add(
          memberBetween(
            new Vector3(side * 0.29, 0.085, -0.09),
            new Vector3(side * 0.24, -0.12, 0.0),
            0.018,
            lib.brass,
          ),
        )
      }
      car.add(screenAssembly)

      // Bow: collar, low wave-cutter blade continuing the deck spine, and a
      // half-embedded nacre pearl at the very tip.
      const bowCollar = new Mesh(bowCollarGeometry, lib.verdigris)
      bowCollar.position.z = 1.44
      car.add(bowCollar)
      const blade = new Mesh(bladeGeometry, lib.brass)
      blade.scale.set(0.04, 0.18, 0.40)
      blade.position.set(0, 0.25, 1.18)
      blade.rotation.x = -0.30
      car.add(blade)
      const pearl = new Mesh(pearlGeometry, lib.nacre)
      pearl.position.set(0, 0.02, 1.545)
      car.add(pearl)

      // Stern: verdigris cowl, dark nozzle throat, three swept fins.
      const cowl = new Mesh(cowlGeometry, lib.verdigris)
      cowl.position.z = -1.36
      car.add(cowl)
      const throat = new Mesh(throatGeometry, lib.iron)
      throat.position.z = -1.44
      car.add(throat)
      for (let f = 0; f < 3; f++) {
        const angle = Math.PI / 2 + (f * Math.PI * 2) / 3
        const fin = new Mesh(finBladeGeometry, lib.lacquer)
        fin.scale.set(0.035, 0.16, 0.42)
        fin.position.set(Math.cos(angle) * 0.34, Math.sin(angle) * 0.34, -1.12)
        fin.rotation.z = angle - Math.PI / 2
        fin.rotation.x = -0.55
        car.add(fin)
      }

      // Head car carries a bow lamp; the tail car carries the stern lantern.
      if (i === 0) {
        const headlamp = new Object3D()
        headlamp.position.set(0, 0.34, 1.30)
        headlamp.add(
          memberBetween(new Vector3(0, -0.10, -0.04), new Vector3(0, 0, 0), 0.014, lib.brass),
        )
        const lens = new Mesh(lanternGlobeGeometry, lib.lampGlobe)
        headlamp.add(lens)
        const collarRing = new Mesh(lanternRingGeometry, lib.brass)
        collarRing.rotation.x = Math.PI / 2
        headlamp.add(collarRing)
        car.add(headlamp)
        tinyParts.add(headlamp)
      }
      if (i === CARS - 1) {
        const lantern = new Object3D()
        lantern.position.set(0, 0.52, -1.30)
        lantern.add(
          memberBetween(new Vector3(0, -0.20, 0.12), new Vector3(0, -0.06, 0), 0.014, lib.brass),
        )
        const globe = new Mesh(lanternGlobeGeometry, lib.lampGlobe)
        lantern.add(globe)
        for (const ringY of [-0.03, 0.03]) {
          const ring = new Mesh(lanternRingGeometry, lib.brass)
          ring.position.y = ringY
          lantern.add(ring)
        }
        car.add(lantern)
        tinyParts.add(lantern)
      }

      car.traverse((node) => {
        const mesh = node as Mesh
        if (!mesh.isMesh) return
        let tiny = false
        for (let p: Object3D | null = mesh; p && p !== car; p = p.parent) {
          if (tinyParts.has(p)) tiny = true
        }
        // Tiny fittings and glass never cast; everything else does.
        mesh.castShadow = !tiny && mesh.material !== lib.glass
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

    // Slack rigging still ties the mast to the hull: sagging hemp catenaries
    // from the cross-tree ends and masthead down to surviving rib tops. Each
    // line is one tube over a three-point curve whose midpoint droops.
    const riggingRuns: [Vector3, Vector3][] = [
      [new Vector3(9.2, 10.9, -3.5), new Vector3(11.5, 1.8, 3.4)],
      [new Vector3(9.2, 10.9, -3.5), new Vector3(12.8, 1.2, -4.6)],
      [new Vector3(3.0, 13.4, -3.0), new Vector3(-6.5, 2.2, 4.8)],
      [new Vector3(3.0, 13.4, -3.0), new Vector3(-9.8, 1.6, -4.2)],
    ]
    for (const [from, to] of riggingRuns) {
      const mid = from.clone().add(to).multiplyScalar(0.5)
      mid.y -= from.distanceTo(to) * 0.16 // slack sag
      const line = new Mesh(
        new TubeGeometry(new CatmullRomCurve3([from, mid, to]), 22, 0.045, 6),
        lib.rope,
      )
      wreck.add(line)
    }

    // The ship's anchor, thrown clear in the sinking: shank half-buried,
    // one fluke aloft, stock askew, a rotted hawser trailing to the bow.
    const anchor = new Object3D()
    const shank = new Mesh(new CylinderGeometry(0.16, 0.19, 4.6, 10), lib.iron)
    anchor.add(shank)
    const stock = new Mesh(new CylinderGeometry(0.12, 0.12, 2.6, 8), lib.woodDark)
    stock.rotation.x = Math.PI / 2
    stock.position.y = 1.9
    anchor.add(stock)
    const anchorRing = new Mesh(new TorusGeometry(0.34, 0.07, 8, 18), lib.iron)
    anchorRing.position.y = 2.55
    anchor.add(anchorRing)
    const crown = new Mesh(new TorusGeometry(1.05, 0.15, 9, 20, Math.PI), lib.iron)
    crown.position.y = -2.1
    crown.rotation.z = Math.PI
    anchor.add(crown)
    for (const side of [-1, 1]) {
      const fluke = new Mesh(new ConeGeometry(0.34, 0.9, 8), lib.iron)
      fluke.position.set(side * 1.28, -1.35, 0)
      fluke.rotation.z = side * -0.5
      anchor.add(fluke)
    }
    anchor.position.set(14.5, -6.2, 6.5)
    anchor.rotation.set(0.35, 0.6, 1.18) // toppled onto the crown, one arm up
    wreck.add(anchor)
    const hawserFrom = new Vector3(14.5, -3.9, 6.9)
    const hawserTo = new Vector3(12.6, -3.2, 1.4)
    const hawserMid = hawserFrom.clone().add(hawserTo).multiplyScalar(0.5)
    hawserMid.y -= 1.5
    const hawser = new Mesh(
      new TubeGeometry(new CatmullRomCurve3([hawserFrom, hawserMid, hawserTo]), 18, 0.075, 6),
      lib.rope,
    )
    wreck.add(hawser)

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
