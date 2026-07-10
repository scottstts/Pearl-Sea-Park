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
  /** The Great Wheel pier (east). */
  wheel: { x: 175, z: 40, radius: 20, hubHeight: 14 },
  /** Torrent coaster station (north, near the rim). */
  torrent: { station: { x: 70, z: -165 } },
  /** Menagerie gardens (west). */
  menagerie: { x: -170, z: 45 },
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
  { ax: PARK_PLAN.tidalCourt.x, az: PARK_PLAN.tidalCourt.z, bx: PARK_PLAN.wheel.x - 22, bz: PARK_PLAN.wheel.z, width: 8 },
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
  { x: PARK_PLAN.wheel.x, z: PARK_PLAN.wheel.z, r: 26 },
  { x: PARK_PLAN.torrent.station.x, z: PARK_PLAN.torrent.station.z, r: 14 },
  { x: PARK_PLAN.menagerie.x, z: PARK_PLAN.menagerie.z, r: 16 },
  { x: PARK_PLAN.grotto.x, z: PARK_PLAN.grotto.z, r: 12 },
  { x: PARK_PLAN.observatory.x, z: PARK_PLAN.observatory.z, r: 12.5 },
  { x: PARK_PLAN.cafe.x, z: PARK_PLAN.cafe.z, r: 11 },
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
  for (const d of KEEPOUT_DISCS) {
    const dx = x - d.x
    const dz = z - d.z
    const r = d.r + margin
    if (dx * dx + dz * dz < r * r) return true
  }
  for (const c of KEEPOUT_CAPSULES) {
    const abx = c.bx - c.ax
    const abz = c.bz - c.az
    const lengthSq = abx * abx + abz * abz
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - c.ax) * abx + (z - c.az) * abz) / lengthSq))
    const dx = x - (c.ax + abx * t)
    const dz = z - (c.az + abz * t)
    const r = c.r + margin
    if (dx * dx + dz * dz < r * r) return true
  }
  return false
}
