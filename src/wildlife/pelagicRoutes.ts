import { CatmullRomCurve3, Vector3 } from 'three'
// Leaf import with .ts extension so the offline audit
// (node --experimental-strip-types) samples the exact same curves.
import { terrainHeight } from '../world/terrainHeight.ts'

/**
 * The pelagic patrol rings (Scott's ruling, 2026-07-22, third revision —
 * his drawing): both sharks and the blue whale circle ABOVE THE PARK
 * ITSELF, not over the outside sand — big, overall-circular loops that
 * enclose the guest districts and swing back over the entrance every lap,
 * each ring only slightly different (radius, center, direction, phase).
 *
 * Altitude is what makes over-park rings possible: the animals fly OVER
 * the built skyline (sun-garden dome ~13.8 m, signs ~6.5 m, Pearl pylons
 * and the cable at ~14.6–14.8 m over the plateau), crossing the Pearl
 * corridor ABOVE the cable, while full-height hazards (the breaching
 * Great Wheel, the Descent Bell drop, the Torrent station, Pearl
 * stations, the submarine berth, the Esplanade vault) are dodged
 * horizontally. `pelagicRoutesAudit.ts` enforces all of it: 2D margins
 * for full-height hazards, body-bottom-over-top clearance for everything
 * overflown (species-specific vertical extents — the blue whale counts
 * its ±3.7 m fluke stroke), the terrain band, and the entrance pass.
 *
 * Speeds run at the energetic end of each species' real cruise range so
 * a lap stays in single-digit minutes; with three staggered rings plus
 * the flyover squadron, something big crosses the threshold every couple
 * of minutes.
 *
 * Waypoint y is the LOCAL seabed + the route's cruise clearance.
 * `species` names the GLB cast member (wildlife/faunaAssets.ts); plain
 * string literals keep this module a leaf.
 */
export type PelagicSpecies = 'shark' | 'hammerhead' | 'blueWhale'

export interface PelagicRoute {
  name: string
  species: PelagicSpecies
  /** Closed-loop waypoints, metres, walked in order. */
  points: readonly (readonly [number, number])[]
  /** Cruise height above the local seabed at each waypoint, metres. */
  clearance: number
  /** Cruise speed, m/s. */
  speed: number
  /** Size variation on the species' realistic base scale. */
  scale: number
  /** Loop phase offset so entrance passes stagger across the fleet. */
  phase: number
}

/** The shared "pass by the entrance" contract: every ring must run within
 *  this radius of the arrival threshold on every lap. */
export const PELAGIC_ENTRANCE_PASS = { x: -3, z: 308, radius: 45 } as const

export const REEF_SHARK_ROUTES: readonly PelagicRoute[] = [
  {
    // The reef shark's ring: ~150 m radius on the park's spine,
    // counterclockwise — Menagerie flank, the open mid-park sand, the
    // carousel side, and home over the arrival threshold.
    name: 'shark-park-ring',
    species: 'shark',
    points: [
      [150, 150], [133, 227], [74, 277], [0, 302], [-74, 279], [-134, 227],
      [-146, 150], [-130, 75], [-77, 18], [0, 3], [76, 19], [129, 76],
    ],
    clearance: 17.5,
    speed: 2.0,
    scale: 1,
    phase: 0.12,
  },
  {
    // The hammerhead's ring: slightly tighter, run CLOCKWISE so the two
    // sharks cross the threshold from opposite directions.
    name: 'hammerhead-park-ring',
    species: 'hammerhead',
    points: [
      [142, 158], [122, 90], [74, 37], [4, 22], [-66, 37], [-116, 89],
      [-131, 158], [-118, 228], [-64, 276], [4, 297], [72, 276], [125, 228],
    ],
    clearance: 17.8,
    speed: 1.7,
    scale: 1,
    phase: 0.55,
  },
]

export const BLUE_WHALE_ROUTE: PelagicRoute = {
  // The whale's ring: the widest of the three, gliding right OVER the
  // Sun Garden dome on its western arc and returning across the arrival
  // threshold — a 24 m silhouette overhead roughly every nine minutes.
  name: 'blue-whale-park-ring',
  species: 'blueWhale',
  points: [
    [148, 142], [129, 224], [67, 278], [-12, 303], [-91, 279], [-154, 224],
    [-168, 142], [-151, 62], [-94, 1], [-12, -15], [69, 3], [125, 63],
  ],
  clearance: 20.8,
  speed: 1.8,
  scale: 1,
  phase: 0.3,
}

/** Every audited circuit, in one list (the audit walks exactly these). */
export const PELAGIC_ROUTES: readonly PelagicRoute[] = [
  ...REEF_SHARK_ROUTES,
  BLUE_WHALE_ROUTE,
]

/** Terrain-following closed curve for a route (the single builder shared
 *  by the game and the offline clearance audit). */
export function pelagicRouteCurve(route: PelagicRoute): CatmullRomCurve3 {
  const points = route.points.map(
    ([x, z]) => new Vector3(x, terrainHeight(x, z) + route.clearance, z),
  )
  const curve = new CatmullRomCurve3(points, true, 'centripetal', 0.5)
  // Default 200-division arc-length table is too coarse for laps this
  // long; without this the constant-speed getPointAt visibly surges.
  curve.arcLengthDivisions = 1600
  return curve
}
