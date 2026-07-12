import { CatmullRomCurve3, Vector3 } from 'three'
// Leaf import (.ts) so the offline geometry audit can load this module.
import { terrainHeight } from '../world/terrainHeight.ts'

/**
 * The Pearl Line's route authority — pure math so the same authored loop
 * drives the ride system AND the offline clearance audit. The audit sweeps
 * the cabin envelope (hanging 3.34 m under the cable, ±1.0 m wide) along
 * the whole loop against every tall park structure and the seabed; Scott's
 * walkthrough caught the cable carving the Sun Garden dome, so this is now
 * a boot-checkable contract, not a geometry review.
 */

export const PEARL_CRUISE_Y = -12 // cable height over the -26 m floor
/** Cabin origin hangs this far under the cable. */
export const PEARL_HANG = 3.22
/** Cabin envelope relative to the cable point. */
const CABIN_DROP = PEARL_HANG + 0.12 // to the underframe
const CABIN_HALF_WIDTH = 1.0

export const PEARL_STATION_ANCHORS = {
  atrium: new Vector3(-34, 0, 210),
  wheel: new Vector3(146, 0, 58),
} as const

/** Cable height that docks a cabin floor at platform height. */
export function pearlStationCableY(v: Vector3): number {
  return terrainHeight(v.x, v.z) + 0.43 + PEARL_HANG
}

export function createPearlRouteCurve(): CatmullRomCurve3 {
  const atrium = PEARL_STATION_ANCHORS.atrium.clone()
  const wheel = PEARL_STATION_ANCHORS.wheel.clone()
  atrium.y = pearlStationCableY(atrium)
  wheel.y = pearlStationCableY(wheel)
  const waypoints: Vector3[] = [
    atrium, // 0 — Esplanade West station
    new Vector3(-90, PEARL_CRUISE_Y, 172),
    // The west leg swings WIDE of the Sun Garden dome (center −148,60,
    // r 8.5 breaking ~13 m above the floor) and rides higher — the original
    // (−148, −12, 102) → (−122, −12, 8) leg dragged cabins through the
    // dome's crown glass.
    new Vector3(-166, -10.5, 96),
    new Vector3(-136, -10.5, -2),
    new Vector3(-55, PEARL_CRUISE_Y, -66),
    new Vector3(35, PEARL_CRUISE_Y, -82),
    new Vector3(112, PEARL_CRUISE_Y, -28),
    wheel, // 7 — Wheel Pier station
    new Vector3(170, PEARL_CRUISE_Y, 140),
    new Vector3(118, PEARL_CRUISE_Y, 212),
    new Vector3(36, -11.5, 268),
    new Vector3(-30, -11.5, 278),
  ]
  return new CatmullRomCurve3(waypoints, true, 'centripetal', 0.6)
}

interface DomeObstacle {
  name: string
  x: number
  z: number
  baseY: number
  radius: number
  radiusY: number
}

/** The park's tall glass — analytic ellipsoid crowns for the sweep test. */
function domeObstacles(): DomeObstacle[] {
  const dome = (name: string, x: number, z: number, baseLift: number, radius: number) => ({
    name,
    x,
    z,
    baseY: terrainHeight(x, z) + baseLift,
    radius: radius * 0.995,
    radiusY: radius * 0.815,
  })
  return [
    // baseLift = plaza offset + dome base height from each build site.
    dome('atrium-dome', 0, 250, 0.1 + 9.6, 17.9),
    dome('sun-garden-dome', -148, 60, 0.08 + 5.15, 8.5),
    dome('observatory-dome', -62, 228, 0.1 + 5.1, 8.7),
    dome('cafe-dome', 46, 112, 0.1 + 4.7, 7.6),
  ]
}

export interface PearlRouteAudit {
  loopMeters: number
  minTerrainClearance: number
  minApproachClearance: number
  minDomeClearance: number
  closestDome: string
  wheelClearance: number
  midwayRoofClearance: number
}

export function auditPearlRoute(): PearlRouteAudit {
  const curve = createPearlRouteCurve()
  const length = curve.getLength()
  const domes = domeObstacles()
  const stations = [PEARL_STATION_ANCHORS.atrium, PEARL_STATION_ANCHORS.wheel]
  const point = new Vector3()
  const SAMPLES = 2400

  let minTerrain = Infinity
  let minApproach = Infinity
  let minDome = Infinity
  let closestDome = 'none'
  let wheelClearance = Infinity
  let midwayRoofClearance = Infinity

  for (let i = 0; i < SAMPLES; i++) {
    curve.getPointAt(i / SAMPLES, point)
    const cabinBottom = point.y - CABIN_DROP
    // Station approaches deliberately glide low into the dock; they get a
    // ground-hug budget instead of the open-route clearance requirement.
    const stationDistance = Math.min(
      ...stations.map((s) => Math.hypot(point.x - s.x, point.z - s.z)),
    )
    const clearance = cabinBottom - terrainHeight(point.x, point.z)
    if (stationDistance >= 26) minTerrain = Math.min(minTerrain, clearance)
    else minApproach = Math.min(minApproach, clearance)
    // Dome crowns: normalized ellipsoid distance for the cabin box corners
    // approximated by its worst point (closest lateral offset, lowest y).
    for (const dome of domes) {
      const dx = Math.hypot(point.x - dome.x, point.z - dome.z)
      const lateral = Math.max(0, dx - CABIN_HALF_WIDTH)
      for (const y of [cabinBottom, point.y]) {
        const dy = y - dome.baseY
        if (dy < 0) continue // below the dome's equator plane — walls, not crown
        const normalized = Math.hypot(lateral / dome.radius, dy / dome.radiusY)
        const clearance = (normalized - 1) * Math.min(dome.radius, dome.radiusY)
        if (clearance < minDome) {
          minDome = clearance
          closestDome = dome.name
        }
      }
    }
    // The Great Wheel: rotor disc (x-y circle at z 40, half-depth ~3.2) plus
    // gondola sweep — keep the whole cabin box out of a 23.5 m envelope.
    if (Math.abs(point.z - 40) < 4.4) {
      const d = Math.hypot(point.x - 175, point.y + 18) - 23.5
      wheelClearance = Math.min(wheelClearance, d)
    }
    // Midway hall gable (44 × 22 footprint, ridge ≈ ground + 9.5).
    if (Math.abs(point.x - 100) < 23 && Math.abs(point.z - 150) < 12) {
      const ridgeTop = terrainHeight(100, 150) + 0.1 + 6 + 3.4
      midwayRoofClearance = Math.min(midwayRoofClearance, cabinBottom - ridgeTop)
    }
  }

  if (minTerrain < 1.2) {
    throw new Error(`Pearl Line cabins graze the seabed (${minTerrain.toFixed(2)} m)`)
  }
  if (minApproach < 0.25) {
    throw new Error(`Pearl Line station glide digs into the platform ground (${minApproach.toFixed(2)} m)`)
  }
  if (minDome < 0.8) {
    throw new Error(`Pearl Line route violates ${closestDome} (${minDome.toFixed(2)} m)`)
  }
  if (wheelClearance < 1.5) {
    throw new Error(`Pearl Line route enters the Great Wheel envelope (${wheelClearance.toFixed(2)} m)`)
  }
  if (midwayRoofClearance < 1.2) {
    throw new Error(`Pearl Line cabins clip the Midway roof (${midwayRoofClearance.toFixed(2)} m)`)
  }
  return {
    loopMeters: length,
    minTerrainClearance: minTerrain,
    minApproachClearance: minApproach,
    minDomeClearance: minDome,
    closestDome,
    wheelClearance,
    midwayRoofClearance,
  }
}
