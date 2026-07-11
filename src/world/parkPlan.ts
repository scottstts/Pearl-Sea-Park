import { terrainHeight } from './terrain'

/**
 * THE master layout (plan §3): every district, path, and ride anchors here.
 * Coordinates in meters; north = −z (toward the drop-off). Nothing else may
 * hardcode park positions.
 */
export const PARK_PLAN = {
  /** Buoy pavilion + descent bell shaft. */
  arrival: { x: 0, z: 320 },
  /** Grand Atrium — the entrance dome. */
  atrium: { x: 0, z: 250, plazaRadius: 21 },
  /** Esplanade boulevard: atrium → hub. */
  esplanade: { x: 0, zFrom: 229, zTo: 121, width: 13 },
  /** Tidal Court — the hub lagoon + colonnade. */
  tidalCourt: { x: 0, z: 78, colonnadeRadius: 40, lagoonRadius: 26 },
  /** The Great Wheel pier (east) — turns in a dredged basin (floor ≈ −40). */
  wheel: { x: 175, z: 40, radius: 20, hubY: -18 },
  /** Carrousel des Abysses — the Midway's southern rotunda. */
  carousel: { x: 100, z: 182, plazaRadius: 12 },
  /** Torrent coaster station (north, near the rim). */
  torrent: { station: { x: 70, z: -165 } },
  /** Menagerie gardens (west): the inverted zoo's three linked courts. */
  menagerie: {
    x: -170,
    z: 45,
    sunGarden: { x: -148, z: 60 },
    jellyCourt: { x: -188, z: 53, radius: 14 },
    turtleLagoon: { x: -168, z: 20, radius: 13 },
  },
  /** Midway hall (south-east of hub). */
  midway: { x: 100, z: 150, width: 42, depth: 20 },
  /** Grotto of Pearls entrance (south-east). */
  grotto: { x: 185, z: 125 },
  /** Observatory dome (west of atrium). */
  observatory: { x: -62, z: 228 },
  /** Café Méduse terrace (between hub and esplanade, east side). */
  cafe: { x: 46, z: 112 },
} as const

/** Ground height at a plan anchor. */
export function anchorGround(anchor: { x: number; z: number }): number {
  return terrainHeight(anchor.x, anchor.z)
}

/**
 * Path segments (from → to, width). Park assembly builds mosaic plates from
 * this list; the flora keep-out reads the same list — one source of truth.
 */
export const PARK_PATHS: { ax: number; az: number; bx: number; bz: number; width: number }[] = [
  { ax: PARK_PLAN.arrival.x, az: PARK_PLAN.arrival.z - 6, bx: PARK_PLAN.atrium.x, bz: PARK_PLAN.atrium.z + 21, width: 5 },
  { ax: PARK_PLAN.tidalCourt.x, az: PARK_PLAN.tidalCourt.z, bx: PARK_PLAN.wheel.x - 27, bz: PARK_PLAN.wheel.z, width: 8 },
  { ax: PARK_PLAN.midway.x, az: PARK_PLAN.midway.z + 12, bx: PARK_PLAN.carousel.x, bz: PARK_PLAN.carousel.z - 13, width: 6 },
  { ax: PARK_PLAN.tidalCourt.x, az: PARK_PLAN.tidalCourt.z, bx: PARK_PLAN.menagerie.x, bz: PARK_PLAN.menagerie.z, width: 8 },
  { ax: PARK_PLAN.tidalCourt.x, az: PARK_PLAN.tidalCourt.z, bx: PARK_PLAN.midway.x - 10, bz: PARK_PLAN.midway.z - 4, width: 7 },
  { ax: PARK_PLAN.midway.x + 16, az: PARK_PLAN.midway.z, bx: PARK_PLAN.grotto.x, bz: PARK_PLAN.grotto.z, width: 6 },
  { ax: PARK_PLAN.tidalCourt.x, az: PARK_PLAN.tidalCourt.z, bx: PARK_PLAN.torrent.station.x, bz: PARK_PLAN.torrent.station.z, width: 7 },
  { ax: PARK_PLAN.atrium.x, az: PARK_PLAN.atrium.z, bx: PARK_PLAN.observatory.x, bz: PARK_PLAN.observatory.z, width: 5 },
  { ax: PARK_PLAN.tidalCourt.x + 18, az: PARK_PLAN.tidalCourt.z + 24, bx: PARK_PLAN.cafe.x, bz: PARK_PLAN.cafe.z, width: 5 },
  { ax: -140, az: -232, bx: PARK_PLAN.menagerie.x, bz: PARK_PLAN.menagerie.z, width: 6 },
]

/** Built/reserved footprints: no flora, no scatter. Radii include margin. */
const KEEPOUT_DISCS: { x: number; z: number; r: number }[] = [
  { x: PARK_PLAN.arrival.x, z: PARK_PLAN.arrival.z, r: 12 },
  { x: PARK_PLAN.atrium.x, z: PARK_PLAN.atrium.z, r: PARK_PLAN.atrium.plazaRadius + 4 },
  { x: PARK_PLAN.tidalCourt.x, z: PARK_PLAN.tidalCourt.z, r: PARK_PLAN.tidalCourt.colonnadeRadius + 11 },
  { x: PARK_PLAN.wheel.x, z: PARK_PLAN.wheel.z, r: 28 },
  { x: PARK_PLAN.carousel.x, z: PARK_PLAN.carousel.z, r: PARK_PLAN.carousel.plazaRadius + 2 },
  { x: PARK_PLAN.torrent.station.x, z: PARK_PLAN.torrent.station.z, r: 14 },
  { x: PARK_PLAN.menagerie.x, z: PARK_PLAN.menagerie.z, r: 16 },
  { x: PARK_PLAN.menagerie.sunGarden.x, z: PARK_PLAN.menagerie.sunGarden.z, r: 11 },
  { x: PARK_PLAN.menagerie.jellyCourt.x, z: PARK_PLAN.menagerie.jellyCourt.z, r: PARK_PLAN.menagerie.jellyCourt.radius + 2 },
  { x: PARK_PLAN.menagerie.turtleLagoon.x, z: PARK_PLAN.menagerie.turtleLagoon.z, r: PARK_PLAN.menagerie.turtleLagoon.radius + 2 },
  { x: PARK_PLAN.grotto.x, z: PARK_PLAN.grotto.z, r: 12 },
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
