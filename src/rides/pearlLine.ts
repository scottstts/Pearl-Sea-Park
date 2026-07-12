import {
  BoxGeometry,
  CatmullRomCurve3,
  Mesh,
  Object3D,
  PointLight,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three'
import { ArchKit } from '../archkit/modules'
import { SlotWriter } from '../archkit/writer'
import { registerBookmark } from '../core/debug'
import type { PlayerSystem } from '../player/player'
import { markDynamicShadowCasters } from '../render/layers'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { currentFlowCpu } from '../sea/current'
import type { DistrictServices } from '../world/districts/atrium'
import { inParkFootprint } from '../world/parkPlan'
import { terrainHeight } from '../world/terrain'
import { VehicleSeatRig } from './vehicleSeat'
import { PearlLineCabinFleet } from './pearlLineCabin'
import {
  PEARL_HANG,
  PEARL_STATION_ANCHORS,
  createPearlRouteCurve,
  pearlStationCableY,
} from './pearlRoute'

const CABIN_COUNT = 8
const CRUISE_SPEED = 7.8 // 2× the previous 3.9, per Scott's ride pass

interface Station {
  name: string
  s: number // arc-length of the dock point
  position: Vector3
  exit: Vector3
}

type LineState =
  | 'cruising' // constant loop, nobody waiting
  | 'arriving' // guest waiting on a platform — glide the next cabin in
  | 'boarding' // cabin held at the platform while the guest decides
  | 'riding' // guest aboard — non-stop to the other station
  | 'unloading' // held at the destination until the guest steps off

/**
 * The Pearl Line (plan §9.6): a cable-gondola loop over the whole park —
 * 8 open brass cabins, ~1 km of cable at 14 m, stations at the Atrium and
 * the Wheel Pier. The route lives in pearlRoute.ts (offline-audited against
 * every dome, the wheel envelope, and the seabed).
 *
 * Ride contract: the cars never stop on their own. A guest standing on
 * either platform makes the NEXT arriving cabin stop there (walking away
 * releases it); board with E — the camera faces the direction of travel —
 * and the line runs non-stop to the other station and holds. E steps off;
 * nothing moves again until the guest is off and clear.
 */
export class PearlLineSystem implements GameSystem {
  readonly id = 'pearl-line'

  private readonly services: DistrictServices
  private readonly player: PlayerSystem | null
  private rig: VehicleSeatRig | null = null

  private readonly group = new Object3D()
  private curve: CatmullRomCurve3 | null = null
  private loopLength = 0
  private cableS = 0
  private speed = CRUISE_SPEED
  private readonly cabins: Object3D[] = []
  private cabinFleet: PearlLineCabinFleet | null = null
  private readonly cabinTilt: { roll: number; pitch: number }[] = []
  private stations: Station[] = []
  private state: LineState = 'cruising'
  private waitStation = -1 // stations[] index the guest is waiting at
  private destStation = -1 // stations[] index the ride is bound for
  private dockedCabin = -1
  private ridingCabin = -1
  private readonly scratchA = new Vector3()
  private readonly scratchB = new Vector3()

  constructor(services: DistrictServices, player: PlayerSystem | null) {
    this.services = services
    this.player = player
  }

  init(ctx: GameContext): void {
    const lib = this.services.materials.lib
    if (!lib) throw new Error('PearlLineSystem requires materials')
    const { physics } = this.services
    const kit = new ArchKit(lib)

    // ── The loop (authored + audited in pearlRoute.ts) ───────────────────
    const atriumStation = PEARL_STATION_ANCHORS.atrium.clone()
    const wheelStation = PEARL_STATION_ANCHORS.wheel.clone()
    const curve = createPearlRouteCurve()
    this.curve = curve
    this.loopLength = curve.getLength()

    // Arc-length of each station dock (find u nearest the waypoint).
    const findS = (target: Vector3) => {
      let bestU = 0
      let bestD = Infinity
      for (let i = 0; i <= 2000; i++) {
        const u = i / 2000
        const p = curve.getPointAt(u, this.scratchA)
        const d = p.distanceToSquared(target)
        if (d < bestD) {
          bestD = d
          bestU = u
        }
      }
      return bestU * this.loopLength
    }

    // ── Station terraces ──────────────────────────────────────────────────
    const w = new SlotWriter()
    const buildStation = (v: Vector3, name: string) => {
      const ground = terrainHeight(v.x, v.z)
      const y = ground + 0.4
      kit.mosaicPlaza(w, v.x, y - 0.1, v.z, 6.5)
      kit.stepsRing(w, v.x, y - 0.24, v.z, 6.5)
      kit.stepsRing(w, v.x, y - 0.38, v.z, 7.15)
      // Collider staircase — a single tall cylinder defeats the autostep.
      physics.addStaticCylinder(v.x, ground + 0.08, v.z, 0.08, 7.85)
      physics.addStaticCylinder(v.x, ground + 0.22, v.z, 0.08, 7.2)
      physics.addStaticCylinder(v.x, ground + 0.34, v.z, 0.09, 6.55)
      for (const [dx, dz] of [
        [-5, -3.4],
        [5, 3.4],
      ]) {
        const globe = this.services.amenities.addLamp(v.x + dx, y, v.z + dz)
        physics.addStaticBox(v.x + dx, y + 1.7, v.z + dz, 0.12, 1.7, 0.12)
        const light = new PointLight(0xffd9a0, 5.5, 12, 1.8)
        light.position.set(globe.x, globe.y, globe.z)
        this.group.add(light)
      }
      // A compact glass-and-brass station house. Four posts and two arches
      // carry the canopy; it reads as infrastructure without enclosing the
      // open-water boarding platform.
      const stationCorners = [
        [-3.8, -2.3], [3.8, -2.3], [-3.8, 2.3], [3.8, 2.3],
      ] as const
      for (const [dx, dz] of stationCorners) {
        kit.column(w, v.x + dx, y, v.z + dz, 4.4, 0.2)
        physics.addStaticBox(v.x + dx, y + 2.2, v.z + dz, 0.26, 2.2, 0.26)
      }
      for (const dz of [-2.3, 2.3]) {
        kit.arch(w, v.x - 3.8, v.z + dz, v.x + 3.8, v.z + dz, y + 4.4, 0.9)
        kit.cornice(w, v.x - 3.8, v.z + dz, v.x + 3.8, v.z + dz, y + 4.48)
      }
      kit.gableRoof(w, v.x, y + 4.55, v.z, 8.8, 5.6, 1.25)
      const exit = new Vector3(v.x, y + 0.1, v.z + 3.6)
      return {
        name,
        s: findS(new Vector3(v.x, pearlStationCableY(v), v.z)),
        position: new Vector3(v.x, y, v.z),
        exit,
      }
    }
    this.stations = [
      buildStation(atriumStation, 'Esplanade West'),
      buildStation(wheelStation, 'Wheel Pier'),
    ]

    // ── Cable ─────────────────────────────────────────────────────────────
    const cableMesh = new Mesh(new TubeGeometry(curve, 480, 0.045, 6, true), lib.iron)
    cableMesh.castShadow = false
    this.group.add(cableMesh)

    // ── Pylons (skip near stations) ──────────────────────────────────────
    const pylonEvery = 60
    const pylonCount = Math.floor(this.loopLength / pylonEvery)
    for (let i = 0; i < pylonCount; i++) {
      const s = i * pylonEvery
      if (this.stations.some((st) => this.loopDistance(s, st.s) < 34)) continue
      const u = (s % this.loopLength) / this.loopLength
      const point = curve.getPointAt(u, this.scratchA)
      // Tower stands BESIDE the line — cabins hang 3 m under the cable and
      // would carve straight through an on-axis column.
      const tangent = curve.getTangentAt(u, this.scratchB)
      const planar = Math.hypot(tangent.x, tangent.z) || 1
      const offX = (tangent.z / planar) * 2.0
      const offZ = (-tangent.x / planar) * 2.0
      const px = point.x + offX
      const pz = point.z + offZ
      if (inParkFootprint(px, pz, 1.5)) continue // never on a path or plaza
      const ground = terrainHeight(px, pz)
      const height = point.y - 0.35 - ground
      if (height < 3) continue
      kit.column(w, px, ground, pz, height, 0.26)
      physics.addStaticBox(px, ground + height / 2, pz, 0.34, height / 2, 0.34)
      // Bracket arm from the tower head out to the sheave under the cable.
      const arm = new Mesh(new BoxGeometry(2.3, 0.14, 0.2), lib.iron)
      arm.position.set(point.x + offX / 2, point.y - 0.42, point.z + offZ / 2)
      arm.rotation.y = Math.atan2(-offZ, offX)
      const sheave = new Mesh(new TorusGeometry(0.3, 0.055, 8, 22), lib.brass)
      sheave.position.set(point.x, point.y - 0.18, point.z)
      this.group.add(arm, sheave)
    }

    // ── Cabins ────────────────────────────────────────────────────────────
    const cabinFleet = new PearlLineCabinFleet(lib, CABIN_COUNT)
    this.cabinFleet = cabinFleet
    markDynamicShadowCasters(cabinFleet.group)
    this.group.add(cabinFleet.group)
    for (let i = 0; i < CABIN_COUNT; i++) {
      // Transform/seat anchor. Visible geometry is the shared instanced fleet.
      const cabin = new Object3D()
      this.group.add(cabin)
      this.cabins.push(cabin)
      this.cabinTilt.push({ roll: 0, pitch: 0 })
    }

    this.group.add(w.compile())
    ctx.scene.add(this.group)
    this.placeCabins(0)

    registerBookmark({
      name: 'pearline',
      position: [atriumStation.x + 10, -18, atriumStation.z + 16],
      look: [atriumStation.x, -21, atriumStation.z],
      note: 'Pearl Line — Esplanade West station',
    })

    // ── Boarding ──────────────────────────────────────────────────────────
    if (this.player && this.services.interaction) {
      const rig = new VehicleSeatRig(this.player)
      this.rig = rig
      const interaction = this.services.interaction
      const seatEye = new Vector3(0, 1.35, -0.35)

      this.stations.forEach((station, index) => {
        interaction.register({
          position: station.position.clone().setY(station.position.y + 1.3),
          radius: 5,
          prompt: 'Board the Pearl Line',
          onInteract: () => {
            if (this.state !== 'boarding' || this.waitStation !== index) return
            if (this.dockedCabin === -1 || rig.seated) return
            this.ridingCabin = this.dockedCabin
            this.destStation = 1 - index // the OTHER station, non-stop
            this.state = 'riding'
            // baseYaw π puts the seat camera on the cabin's +z — the
            // direction of travel.
            rig.attach(this.cabins[this.ridingCabin], seatEye, Math.PI, ctx.camera)
            rig.canExit = false
            ctx.events.emit('ticket/punched', { ride: 'pearl-line' })
            ctx.events.emit('ride/pearl-riding', { riding: true })
          },
          enabled: () =>
            !rig.seated &&
            this.state === 'boarding' &&
            this.waitStation === index &&
            this.dockedCabin !== -1,
        })
        interaction.register({
          position: station.position.clone().setY(station.position.y + 1.3),
          radius: 14,
          prompt: `Alight at ${station.name}`,
          onInteract: () => {
            if (!rig.seated || this.state !== 'unloading' || this.destStation !== index) return
            rig.requestExit(station.exit)
            ctx.events.emit('ride/pearl-riding', { riding: false })
            // The guest lands ON the platform: the cabin keeps waiting for
            // them (boarding state) and releases once they walk clear.
            this.ridingCabin = -1
            this.waitStation = index
            this.destStation = -1
            this.state = 'boarding'
          },
          enabled: () => rig.seated && this.state === 'unloading' && this.destStation === index,
        })
      })
    }
  }

  /** Cable distance still to advance before `to` reaches `target`. */
  private forwardDistance(from: number, target: number): number {
    return (((target - from) % this.loopLength) + this.loopLength) % this.loopLength
  }

  /** Shortest forward/backward distance between arc positions on the loop. */
  private loopDistance(a: number, b: number): number {
    const forward = this.forwardDistance(a, b)
    return Math.min(forward, this.loopLength - forward)
  }

  private cabinS(index: number): number {
    return (this.cableS + (index * this.loopLength) / CABIN_COUNT) % this.loopLength
  }

  /** The cabin with the least cable left to travel to the station. */
  private nextArrival(station: Station): { index: number; ahead: number } {
    let best = -1
    let bestAhead = Infinity
    for (let i = 0; i < CABIN_COUNT; i++) {
      const ahead = this.forwardDistance(this.cabinS(i), station.s)
      if (ahead < bestAhead) {
        bestAhead = ahead
        best = i
      }
    }
    return { index: best, ahead: bestAhead }
  }

  /** True while the guest stands on the given station platform. */
  private playerAt(station: Station): boolean {
    if (!this.player) return false
    const p = this.player.position
    return (
      Math.hypot(p.x - station.position.x, p.z - station.position.z) < 6.5 &&
      Math.abs(p.y - station.position.y) < 3.5
    )
  }

  private placeCabins(elapsed: number): void {
    const curve = this.curve
    if (!curve) return
    for (let i = 0; i < CABIN_COUNT; i++) {
      const cabin = this.cabins[i]
      const s = this.cabinS(i)
      const u = s / this.loopLength
      const point = curve.getPointAt(u, this.scratchA)
      const tangent = curve.getTangentAt(u, this.scratchB)
      cabin.position.set(point.x, point.y - PEARL_HANG, point.z)
      const yaw = Math.atan2(tangent.x, tangent.z)
      // Sway: current field + a slow breathing roll, stronger between stations.
      const tilt = this.cabinTilt[i]
      const flow = currentFlowCpu(point.x, point.z, elapsed)
      const targetRoll = flow.x * 0.05 + Math.sin(elapsed * 0.53 + i * 1.7) * 0.022
      const targetPitch = flow.z * 0.04 + Math.sin(elapsed * 0.41 + i * 2.3) * 0.016
      tilt.roll += (targetRoll - tilt.roll) * 0.03
      tilt.pitch += (targetPitch - tilt.pitch) * 0.03
      cabin.rotation.set(tilt.pitch, yaw, tilt.roll, 'YXZ')
      cabin.updateMatrix()
      this.cabinFleet?.setMatrixAt(i, cabin.matrix)
    }
    this.cabinFleet?.commit()
  }

  update(ctx: GameContext, dt: number): void {
    if (!this.curve) return
    const rig = this.rig

    let target = CRUISE_SPEED
    switch (this.state) {
      case 'cruising': {
        target = CRUISE_SPEED
        if (rig && !rig.seated) {
          const waiting = this.stations.findIndex((station) => this.playerAt(station))
          if (waiting !== -1) {
            this.state = 'arriving'
            this.waitStation = waiting
          }
        }
        break
      }
      case 'arriving': {
        // Glide the next cabin into the guest's platform; release if they go.
        const station = this.stations[this.waitStation]
        if (!station || !this.playerAt(station)) {
          this.state = 'cruising'
          this.waitStation = -1
          break
        }
        const arrival = this.nextArrival(station)
        target = Math.min(CRUISE_SPEED, Math.max(0.12, arrival.ahead * 0.8))
        if (arrival.ahead < 0.05) {
          this.state = 'boarding'
          this.dockedCabin = arrival.index
        }
        break
      }
      case 'boarding': {
        target = 0
        const station = this.stations[this.waitStation]
        if (!station || (rig && !rig.seated && !this.playerAt(station))) {
          this.state = 'cruising'
          this.waitStation = -1
          this.dockedCabin = -1
        }
        break
      }
      case 'riding': {
        // Non-stop to the destination; ease in over the last metres only.
        const station = this.stations[this.destStation]
        if (!station) {
          this.state = 'cruising'
          break
        }
        const remaining = this.forwardDistance(this.cabinS(this.ridingCabin), station.s)
        target = remaining < 14 ? Math.max(0.12, remaining * 0.8) : CRUISE_SPEED
        if (remaining < 0.05) {
          this.state = 'unloading'
          this.dockedCabin = this.ridingCabin
          if (rig) rig.canExit = true
        }
        break
      }
      case 'unloading': {
        target = 0
        break
      }
    }

    // Gentle acceleration toward the target speed; a held line is truly held.
    this.speed += (target - this.speed) * Math.min(1, dt * 1.6)
    if ((this.state === 'boarding' || this.state === 'unloading') && this.speed < 0.005) {
      this.speed = 0
    }
    this.cableS = (this.cableS + this.speed * dt) % this.loopLength

    this.placeCabins(ctx.time.elapsed)
    rig?.update(ctx.camera, dt)
    if (rig && this.ridingCabin !== -1) {
      rig.canExit = this.state === 'unloading'
    }
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
    this.cabinFleet?.dispose()
    this.cabinFleet = null
  }
}
