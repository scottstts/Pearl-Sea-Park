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

const CABIN_COUNT = 8
const CRUISE_SPEED = 2.6
const STATION_SPEED = 0.001
const DWELL_SECONDS = 9
// Keep the glide-in window SHORT: the slowdown is global (one cable), so a
// wide window near either station puts the whole line into a long crawl.
const STATION_WINDOW = 6
const CRUISE_Y = -12 // 14 m over the -26 m floor

interface Station {
  name: string
  s: number // arc-length of the dock point
  position: Vector3
  exit: Vector3
  pulsedAtS: number // cable position of this station's last pulse
}

/**
 * The Pearl Line (plan §9.6): a pulse-gondola cable loop over the whole park —
 * 8 brass-and-glass cabins, ~1 km of cable at 14 m, stations at the Atrium
 * and the Wheel Pier. The entire line slows while any cabin traverses a
 * station and halts for boarding; cabins sway on the shared current field.
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
  private ridingCabin = -1
  // Pulse drive: one global dwell — the whole line halts, both platforms load.
  private dwellTimer = 0
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

    // ── The loop ──────────────────────────────────────────────────────────
    // Stations dip the cable to boarding height; everything else cruises.
    // Legs are routed CLEAR of the atrium and observatory domes — the first
    // draft flew straight through the observatory's glass.
    const atriumStation = new Vector3(-34, 0, 210)
    const wheelStation = new Vector3(146, 0, 58)
    const waypoints: Vector3[] = [
      atriumStation.clone(), // 0 — Esplanade West station (y patched below)
      new Vector3(-90, CRUISE_Y, 172),
      new Vector3(-148, CRUISE_Y, 102),
      new Vector3(-122, CRUISE_Y, 8),
      new Vector3(-55, CRUISE_Y, -66),
      new Vector3(35, CRUISE_Y, -82),
      new Vector3(112, CRUISE_Y, -28),
      wheelStation.clone(), // 7 — Wheel Pier station
      new Vector3(170, CRUISE_Y, 140),
      new Vector3(118, CRUISE_Y, 212),
      new Vector3(36, -11.5, 268),
      new Vector3(-30, -11.5, 278),
    ]
    // Cabin origin hangs 3.22 m under the cable; dock with floor at platform.
    const stationCableY = (v: Vector3) => terrainHeight(v.x, v.z) + 0.43 + 3.22
    waypoints[0].y = stationCableY(atriumStation)
    waypoints[7].y = stationCableY(wheelStation)

    const curve = new CatmullRomCurve3(waypoints, true, 'centripetal', 0.6)
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
      return { name, s: findS(new Vector3(v.x, stationCableY(v), v.z)), position: new Vector3(v.x, y, v.z), exit, pulsedAtS: -1000 }
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

      for (const station of this.stations) {
        interaction.register({
          position: station.position.clone().setY(station.position.y + 1.3),
          radius: 5,
          prompt: 'Board the Pearl Line',
          onInteract: () => {
            const cabin = this.dwellingCabinAt(station)
            if (cabin === -1 || rig.seated) return
            this.ridingCabin = cabin
            this.dwellTimer = Math.max(this.dwellTimer, 4) // hold the doors
            rig.attach(this.cabins[cabin], seatEye, Math.PI, ctx.camera)
            ctx.events.emit('ticket/punched', { ride: 'pearl-line' })
            ctx.events.emit('ride/pearl-riding', { riding: true })
          },
          enabled: () => !rig.seated && this.dwellingCabinAt(station) !== -1,
        })
        interaction.register({
          position: station.position.clone().setY(station.position.y + 1.3),
          radius: 14,
          prompt: `Alight at ${station.name}`,
          onInteract: () => {
            if (!rig.seated || this.ridingCabin === -1) return
            rig.requestExit(station.exit)
            ctx.events.emit('ride/pearl-riding', { riding: false })
            this.ridingCabin = -1
          },
          enabled: () =>
            rig.seated &&
            this.ridingCabin !== -1 &&
            this.dwellingCabinAt(station) === this.ridingCabin,
        })
      }
    }
  }

  /** Shortest forward/backward distance between arc positions on the loop. */
  private loopDistance(a: number, b: number): number {
    const raw = Math.abs(((a - b) % this.loopLength + this.loopLength) % this.loopLength)
    return Math.min(raw, this.loopLength - raw)
  }

  private cabinS(index: number): number {
    return (this.cableS + (index * this.loopLength) / CABIN_COUNT) % this.loopLength
  }

  private dwellingCabinAt(station: Station): number {
    if (this.dwellTimer <= 0) return -1
    for (let i = 0; i < CABIN_COUNT; i++) {
      if (this.loopDistance(this.cabinS(i), station.s) < 2.6) return i
    }
    return -1
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
      cabin.position.set(point.x, point.y - 3.22, point.z)
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

    // Pulse drive: slow through station windows; when a cabin centres a
    // platform, halt the WHOLE line once (both platforms load together) and
    // don't pulse again until the cable has advanced well past the spot.
    let target = CRUISE_SPEED
    if (this.dwellTimer > 0) {
      this.dwellTimer -= dt
      target = 0
    } else {
      for (const station of this.stations) {
        let nearest = Infinity
        for (let i = 0; i < CABIN_COUNT; i++) {
          const d = this.loopDistance(this.cabinS(i), station.s)
          nearest = Math.min(nearest, d)
          if (d < STATION_WINDOW) {
            const approach =
              STATION_SPEED + (CRUISE_SPEED - STATION_SPEED) * (d / STATION_WINDOW)
            target = Math.min(target, Math.max(approach, 0.7))
          }
        }
        // Per-station cooldown: a pulse at one platform must never swallow
        // an arrival at the other (near-commensurate spacings do exactly that).
        const advanced =
          ((this.cableS - station.pulsedAtS) % this.loopLength + this.loopLength) % this.loopLength
        if (nearest < 1.4 && advanced > 24) {
          this.dwellTimer = DWELL_SECONDS
          station.pulsedAtS = this.cableS
        }
      }
    }

    // Gentle acceleration toward the target speed.
    this.speed += (target - this.speed) * Math.min(1, dt * 1.6)
    this.cableS = (this.cableS + this.speed * dt) % this.loopLength

    this.placeCabins(ctx.time.elapsed)
    this.rig?.update(ctx.camera, dt)
    if (this.rig && this.ridingCabin !== -1) {
      // Exits are only offered while the cabin is held at a station.
      this.rig.canExit = this.stations.some(
        (st) => this.dwellingCabinAt(st) === this.ridingCabin,
      )
    }
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
    this.cabinFleet?.dispose()
    this.cabinFleet = null
  }
}
