import { terrainHeight } from './terrain'
import { MIDWAY_APRON, PARK_PATHS, PARK_PLAN } from './parkLayout'
export {
  FACILITY_ENTRANCE_SIGNS,
  MIDWAY_APRON,
  PARK_PATHS,
  PARK_PLAN,
  PAVED_WALKWAYS,
} from './parkLayout'
export type { FacilityEntranceSign, ParkWalkway } from './parkLayout'

/** Ground height at a plan anchor. */
export function anchorGround(anchor: { x: number; z: number }): number {
  return terrainHeight(anchor.x, anchor.z)
}

/** Built/reserved footprints: no flora, no scatter. Radii include margin.
 *  Exported (readonly) so the seabed verge sampler can plant garden rings
 *  JUST outside the real reserved edges instead of hardcoding copies. */
export const KEEPOUT_DISCS: readonly { x: number; z: number; r: number }[] = [
  { x: PARK_PLAN.arrival.x, z: PARK_PLAN.arrival.z, r: 12 },
  { x: PARK_PLAN.atrium.x, z: PARK_PLAN.atrium.z, r: PARK_PLAN.atrium.plazaRadius + 4 },
  { x: PARK_PLAN.tidalCourt.x, z: PARK_PLAN.tidalCourt.z, r: PARK_PLAN.tidalCourt.colonnadeRadius + 11 },
  { x: PARK_PLAN.wheel.x, z: PARK_PLAN.wheel.z, r: 28 },
  { x: PARK_PLAN.carousel.x, z: PARK_PLAN.carousel.z, r: PARK_PLAN.carousel.plazaRadius + 2 },
  { x: PARK_PLAN.torrent.station.x, z: PARK_PLAN.torrent.station.z, r: 14 },
  { x: MIDWAY_APRON.x, z: MIDWAY_APRON.z, r: MIDWAY_APRON.radius + 2 },
  { x: PARK_PLAN.menagerie.x, z: PARK_PLAN.menagerie.z, r: 16 },
  { x: PARK_PLAN.menagerie.sunGarden.x, z: PARK_PLAN.menagerie.sunGarden.z, r: 11 },
  { x: PARK_PLAN.menagerie.jellyCourt.x, z: PARK_PLAN.menagerie.jellyCourt.z, r: PARK_PLAN.menagerie.jellyCourt.radius + 2 },
  { x: PARK_PLAN.menagerie.turtleLagoon.x, z: PARK_PLAN.menagerie.turtleLagoon.z, r: PARK_PLAN.menagerie.turtleLagoon.radius + 2 },
  { x: PARK_PLAN.observatory.x, z: PARK_PLAN.observatory.z, r: 12.5 },
  { x: PARK_PLAN.cafe.x, z: PARK_PLAN.cafe.z, r: 11 },
  // Pearl Line stations (rides/pearlLine.ts docks).
  { x: -34, z: 210, r: 9.5 },
  { x: 146, z: 58, r: 9.5 },
]

const KEEPOUT_CAPSULES: { ax: number; az: number; bx: number; bz: number; r: number }[] = [
  // Esplanade boulevard (with colonnade + lamp aprons).
  { ax: PARK_PLAN.esplanade.x, az: PARK_PLAN.esplanade.zFrom, bx: PARK_PLAN.esplanade.x, bz: PARK_PLAN.esplanade.zTo, r: PARK_PLAN.esplanade.width / 2 + 4 },
  // Midway hall (rect ≈ capsule along its length).
  { ax: PARK_PLAN.midway.x - PARK_PLAN.midway.width / 2, az: PARK_PLAN.midway.z, bx: PARK_PLAN.midway.x + PARK_PLAN.midway.width / 2, bz: PARK_PLAN.midway.z, r: PARK_PLAN.midway.depth / 2 + 3 },
  // Leviathan Overlook terrace at the rim.
  { ax: -170, az: -234, bx: -110, bz: -234, r: 7 },
  ...PARK_PATHS.map((p) => ({ ax: p.ax, az: p.az, bx: p.bx, bz: p.bz, r: p.width / 2 + 1.5 })),
]

/** True when (x, z) lies inside any built footprint (+extra margin, meters). */
export function inParkFootprint(x: number, z: number, margin = 0): boolean {
  return parkFootprintSignedDistance(x, z) < margin
}

/**
 * Signed distance to the coarse park collision plan (negative = inside).
 * The same signed field is the authoritative keep-out for deterministic
 * scatter and any future district-scale navigation.
 */
export function parkFootprintSignedDistance(x: number, z: number): number {
  let distance = Infinity
  for (const d of KEEPOUT_DISCS) {
    const dx = x - d.x
    const dz = z - d.z
    distance = Math.min(distance, Math.hypot(dx, dz) - d.r)
  }
  for (const c of KEEPOUT_CAPSULES) {
    const abx = c.bx - c.ax
    const abz = c.bz - c.az
    const lengthSq = abx * abx + abz * abz
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - c.ax) * abx + (z - c.az) * abz) / lengthSq))
    const dx = x - (c.ax + abx * t)
    const dz = z - (c.az + abz * t)
    distance = Math.min(distance, Math.hypot(dx, dz) - c.r)
  }
  return distance
}
