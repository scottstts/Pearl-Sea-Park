import { Vector3 } from 'three'
// Audit-only module: imported by scripts/audit-geometry.mjs, never by the
// game. Every import below is audit-loadable (pure consts or leaf math).
import { createPearlRouteCurve, PEARL_HANG } from '../rides/pearlRoute.ts'
import { buildTorrentTrack } from '../rides/torrentTrack.ts'
import { FACILITY_ENTRANCE_SIGNS, MIDWAY_APRON, PARK_PLAN } from '../world/parkLayout.ts'
import { terrainHeight } from '../world/terrainHeight.ts'
import {
  PELAGIC_ENTRANCE_PASS,
  PELAGIC_ROUTES,
  pelagicRouteCurve,
  type PelagicSpecies,
} from './pelagicRoutes.ts'

/**
 * Clearance audit for the over-park pelagic rings. The animals circle
 * ABOVE the guest districts (Scott's drawing, 2026-07-22), so the audit
 * is height-aware in both directions:
 *
 * - FULL-HEIGHT hazards (the breaching Great Wheel, the Descent Bell
 *   drop shaft, the Torrent station, both Pearl stations, the submarine
 *   berth, the Esplanade vault and Midway hall) keep a pure 2D keepout —
 *   rings must dodge them horizontally at any altitude.
 * - TOPPED hazards (plazas, courts, domes, signs, Pearl pylons) may be
 *   OVERFLOWN: inside their footprint the animal's BODY BOTTOM (path y
 *   minus the species' downward extent — the blue whale counts its
 *   ±3.7 m fluke stroke) must clear the structure top by OVERFLY_GAP.
 * - The Pearl cable is crossable on either side: cabins sweep below it
 *   (down to dock height near stations), hardware rises just above it —
 *   a crossing is legal when the animal stays 1.5 m clear ABOVE the
 *   cable top or BELOW the cabin sweep.
 *
 * Hazard radii mirror world/parkPlan.ts KEEPOUT_DISCS (that module's
 * import chain is not audit-loadable — the torrentTrack anchor-literal
 * precedent), derived from the same PARK_PLAN anchors so moved
 * facilities stay covered.
 */

const DISC_MARGIN = 3
const SIGN_HORIZONTAL = 8
const SIGN_TOP = 6.5 // sign frames stand ~5–6.5 m tall
const PYLON_HORIZONTAL = 5 // column r 0.26 + bracket arm reach + margin
const TORRENT_CLEARANCE = 12 // 3D metres from track spline to route spline
const CABLE_HORIZONTAL = 6
const CABLE_VERTICAL_GAP = 1.5 // above cable top OR below cabin sweep
const OVERFLY_GAP = 1.2 // body bottom over structure top
const CLEARANCE_BAND = 1.9 // allowed dune drift below/above the cruise height
const SAMPLE_SPACING = 1.25 // metres between route samples

/** Highest point of each species above its spline origin — dorsal apex
 *  or, for the blue whale, the upstroke of its fluke sweep (from the
 *  rig's animated pose box at true scale). Ducks the cabin sweep. */
const SPECIES_TOP_EXTENT: Record<PelagicSpecies, number> = {
  shark: 1.0,
  hammerhead: 1.1,
  blueWhale: 3.7,
}

/** Lowest point below the spline origin — belly or fluke downstroke.
 *  This is what must clear every structure the ring overflies. */
const SPECIES_BOTTOM_EXTENT: Record<PelagicSpecies, number> = {
  shark: 0.6,
  hammerhead: 0.7,
  blueWhale: 3.7,
}

interface HazardDisc {
  name: string
  x: number
  z: number
  r: number
  /** Structure top above LOCAL terrain; undefined = full-height blocker. */
  height?: number
}

const HAZARD_DISCS: readonly HazardDisc[] = [
  // Full-height blockers — dodge horizontally at any altitude.
  { name: 'arrival-bell', x: PARK_PLAN.arrival.x, z: PARK_PLAN.arrival.z, r: 12 },
  { name: 'great-wheel', x: PARK_PLAN.wheel.x, z: PARK_PLAN.wheel.z, r: 28 },
  { name: 'torrent-station', x: PARK_PLAN.torrent.station.x, z: PARK_PLAN.torrent.station.z, r: 14 },
  { name: 'pearl-station-atrium', x: -34, z: 210, r: 9.5 },
  { name: 'pearl-station-wheel', x: 146, z: 58, r: 9.5 },
  { name: 'submarine-berth', x: 9, z: 311, r: 6 },
  // Overflyable structures with measured/conservative tops.
  { name: 'atrium', x: PARK_PLAN.atrium.x, z: PARK_PLAN.atrium.z, r: PARK_PLAN.atrium.plazaRadius + 4, height: 16 },
  { name: 'tidal-court', x: PARK_PLAN.tidalCourt.x, z: PARK_PLAN.tidalCourt.z, r: PARK_PLAN.tidalCourt.colonnadeRadius + 11, height: 18 },
  { name: 'carousel', x: PARK_PLAN.carousel.x, z: PARK_PLAN.carousel.z, r: PARK_PLAN.carousel.plazaRadius + 2, height: 15 },
  { name: 'midway-apron', x: MIDWAY_APRON.x, z: MIDWAY_APRON.z, r: MIDWAY_APRON.radius + 2, height: 12 },
  { name: 'menagerie', x: PARK_PLAN.menagerie.x, z: PARK_PLAN.menagerie.z, r: 16, height: 8 },
  // Sun dome top is exact: base +0.08, dome center +5.15, radius 8.5.
  { name: 'sun-garden', x: PARK_PLAN.menagerie.sunGarden.x, z: PARK_PLAN.menagerie.sunGarden.z, r: 11, height: 13.8 },
  { name: 'jelly-court', x: PARK_PLAN.menagerie.jellyCourt.x, z: PARK_PLAN.menagerie.jellyCourt.z, r: PARK_PLAN.menagerie.jellyCourt.radius + 2, height: 8 },
  { name: 'turtle-lagoon', x: PARK_PLAN.menagerie.turtleLagoon.x, z: PARK_PLAN.menagerie.turtleLagoon.z, r: PARK_PLAN.menagerie.turtleLagoon.radius + 2, height: 4 },
  { name: 'observatory', x: PARK_PLAN.observatory.x, z: PARK_PLAN.observatory.z, r: 12.5, height: 15 },
  { name: 'cafe', x: PARK_PLAN.cafe.x, z: PARK_PLAN.cafe.z, r: 11, height: 12 },
]

interface HazardCapsule {
  name: string
  ax: number
  az: number
  bx: number
  bz: number
  r: number
}

/** Full-height corridors (the vault and hall heights are unmeasured, so
 *  the rings simply never enter them horizontally). */
const HAZARD_CAPSULES: readonly HazardCapsule[] = [
  {
    name: 'esplanade',
    ax: PARK_PLAN.esplanade.x, az: PARK_PLAN.esplanade.zFrom,
    bx: PARK_PLAN.esplanade.x, bz: PARK_PLAN.esplanade.zTo,
    r: PARK_PLAN.esplanade.width / 2 + 4,
  },
  {
    name: 'midway-hall',
    ax: PARK_PLAN.midway.x - PARK_PLAN.midway.width / 2, az: PARK_PLAN.midway.z,
    bx: PARK_PLAN.midway.x + PARK_PLAN.midway.width / 2, bz: PARK_PLAN.midway.z,
    r: PARK_PLAN.midway.depth / 2 + 3,
  },
  { name: 'overlook-terrace', ax: -170, az: -234, bx: -110, bz: -234, r: 7 },
]

function capsuleDistance(c: HazardCapsule, x: number, z: number): number {
  const abx = c.bx - c.ax
  const abz = c.bz - c.az
  const lengthSq = abx * abx + abz * abz
  const t = lengthSq === 0
    ? 0
    : Math.max(0, Math.min(1, ((x - c.ax) * abx + (z - c.az) * abz) / lengthSq))
  return Math.hypot(x - (c.ax + abx * t), z - (c.az + abz * t)) - c.r
}

/** Conservative pylon candidates: every 60 m mark along the Pearl loop
 *  with the game's 2 m side offset, INCLUDING the ones the game skips
 *  near stations or on paved ground — clearing the superset clears the
 *  built subset. Each carries its local cable height: pylons stop at the
 *  cable, so rings may overfly them. */
function pearlPylonCandidates(): { x: number; z: number; topY: number }[] {
  const curve = createPearlRouteCurve()
  const loop = curve.getLength()
  const point = new Vector3()
  const tangent = new Vector3()
  const candidates: { x: number; z: number; topY: number }[] = []
  for (let s = 0; s < loop; s += 60) {
    const u = s / loop
    curve.getPointAt(u, point)
    curve.getTangentAt(u, tangent)
    const planar = Math.hypot(tangent.x, tangent.z) || 1
    candidates.push({
      x: point.x + (tangent.z / planar) * 2,
      z: point.z - (tangent.x / planar) * 2,
      topY: point.y + 0.8,
    })
  }
  return candidates
}

export interface PelagicRouteReport {
  name: string
  lengthMeters: number
  lapMinutes: number
  minTerrainClearance: number
  maxTerrainClearance: number
  /** Horizontal margin to FULL-HEIGHT discs only. */
  minDiscMargin: number
  nearestDisc: string
  minCapsuleMargin: number
  nearestCapsule: string
  /** Worst body-bottom-over-top gap among overflown structures (discs,
   *  signs, pylons); null when the ring never enters any footprint. */
  minOverflyGap: number | null
  tightestOverfly: string
  minSignDistance: number
  minPylonDistance: number
  minTorrentDistance: number
  /** Worst vertical clearance against the Pearl cable/cabin band while
   *  horizontally near it; null when never near. */
  minCabinGap: number | null
  entrancePassDistance: number
}

export interface PelagicRoutesAudit {
  routes: PelagicRouteReport[]
  failures: string[]
}

/** Pearl cable sampled as vertical envelopes: hardware just above the
 *  cable point, the hanging cabin sweep below it. */
function pearlCableEnvelopes(): { x: number; z: number; yTop: number; yBottom: number }[] {
  const curve = createPearlRouteCurve()
  const length = curve.getLength()
  const point = new Vector3()
  const envelopes: { x: number; z: number; yTop: number; yBottom: number }[] = []
  const count = Math.ceil(length / 2)
  for (let i = 0; i < count; i++) {
    curve.getPointAt(i / count, point)
    envelopes.push({
      x: point.x,
      z: point.z,
      yTop: point.y + 0.6,
      yBottom: point.y - PEARL_HANG - 1.4,
    })
  }
  return envelopes
}

export function auditPelagicRoutes(): PelagicRoutesAudit {
  const failures: string[] = []
  const reports: PelagicRouteReport[] = []
  const pylons = pearlPylonCandidates()
  const cable = pearlCableEnvelopes()
  const torrent = buildTorrentTrack()
  const torrentPoints = torrent.frames
    .filter((_, index) => index % 8 === 0)
    .map((frame) => frame.position)
  const sample = new Vector3()

  for (const route of PELAGIC_ROUTES) {
    const curve = pelagicRouteCurve(route)
    const length = curve.getLength()
    const samples = Math.ceil(length / SAMPLE_SPACING)
    const topExtent = SPECIES_TOP_EXTENT[route.species] * route.scale
    const bottomExtent = SPECIES_BOTTOM_EXTENT[route.species] * route.scale
    let minClearance = Infinity
    let maxClearance = -Infinity
    let minDiscMargin = Infinity
    let nearestDisc = ''
    let minCapsuleMargin = Infinity
    let nearestCapsule = ''
    let minOverfly = Infinity
    let tightestOverfly = ''
    let minSign = Infinity
    let minPylon = Infinity
    let minTorrent = Infinity
    let minCableGap = Infinity
    let nearestCable = { x: 0, z: 0 }
    let entrance = Infinity

    const overfly = (name: string, topAbsolute: number, bodyBottom: number): void => {
      const gap = bodyBottom - topAbsolute
      if (gap < minOverfly) {
        minOverfly = gap
        tightestOverfly = name
      }
      if (gap < OVERFLY_GAP) {
        failures.push(
          `${route.name}: overflies '${name}' with ${gap.toFixed(2)} m body clearance (need ${OVERFLY_GAP})`,
        )
      }
    }

    for (let i = 0; i < samples; i++) {
      curve.getPointAt(i / samples, sample)
      const bodyBottom = sample.y - bottomExtent
      const clearance = sample.y - terrainHeight(sample.x, sample.z)
      minClearance = Math.min(minClearance, clearance)
      maxClearance = Math.max(maxClearance, clearance)
      for (const disc of HAZARD_DISCS) {
        const margin = Math.hypot(sample.x - disc.x, sample.z - disc.z) - disc.r
        if (disc.height === undefined) {
          if (margin < minDiscMargin) {
            minDiscMargin = margin
            nearestDisc = disc.name
          }
        } else if (margin < DISC_MARGIN) {
          overfly(disc.name, terrainHeight(disc.x, disc.z) + disc.height, bodyBottom)
        }
      }
      for (const capsule of HAZARD_CAPSULES) {
        const margin = capsuleDistance(capsule, sample.x, sample.z)
        if (margin < minCapsuleMargin) {
          minCapsuleMargin = margin
          nearestCapsule = capsule.name
        }
      }
      for (const sign of FACILITY_ENTRANCE_SIGNS) {
        const distance = Math.hypot(sample.x - sign.x, sample.z - sign.z)
        minSign = Math.min(minSign, distance)
        if (distance < SIGN_HORIZONTAL) {
          overfly(`sign@(${sign.x.toFixed(0)},${sign.z.toFixed(0)})`, terrainHeight(sign.x, sign.z) + SIGN_TOP, bodyBottom)
        }
      }
      for (const pylon of pylons) {
        const distance = Math.hypot(sample.x - pylon.x, sample.z - pylon.z)
        minPylon = Math.min(minPylon, distance)
        if (distance < PYLON_HORIZONTAL) {
          overfly(`pylon@(${pylon.x.toFixed(0)},${pylon.z.toFixed(0)})`, pylon.topY, bodyBottom)
        }
      }
      for (const point of torrentPoints) {
        minTorrent = Math.min(minTorrent, sample.distanceTo(point))
      }
      for (const envelope of cable) {
        const horizontal = Math.hypot(sample.x - envelope.x, sample.z - envelope.z)
        if (horizontal >= CABLE_HORIZONTAL) continue
        // Legal on either side of the band: above the cable hardware or
        // below the cabin sweep.
        const aboveGap = bodyBottom - envelope.yTop
        const belowGap = envelope.yBottom - (sample.y + topExtent)
        const gap = Math.max(aboveGap, belowGap)
        if (gap < minCableGap) {
          minCableGap = gap
          nearestCable = envelope
        }
      }
      entrance = Math.min(
        entrance,
        Math.hypot(sample.x - PELAGIC_ENTRANCE_PASS.x, sample.z - PELAGIC_ENTRANCE_PASS.z),
      )
    }
    reports.push({
      name: route.name,
      lengthMeters: Math.round(length),
      lapMinutes: Math.round((length / route.speed / 60) * 10) / 10,
      minTerrainClearance: Math.round(minClearance * 100) / 100,
      maxTerrainClearance: Math.round(maxClearance * 100) / 100,
      minDiscMargin: Math.round(minDiscMargin * 10) / 10,
      nearestDisc,
      minCapsuleMargin: Math.round(minCapsuleMargin * 10) / 10,
      nearestCapsule,
      minOverflyGap: minOverfly === Infinity ? null : Math.round(minOverfly * 100) / 100,
      tightestOverfly,
      minSignDistance: Math.round(minSign * 10) / 10,
      minPylonDistance: Math.round(minPylon * 10) / 10,
      minTorrentDistance: Math.round(minTorrent * 10) / 10,
      minCabinGap: minCableGap === Infinity ? null : Math.round(minCableGap * 100) / 100,
      entrancePassDistance: Math.round(entrance * 10) / 10,
    })
    if (minClearance < route.clearance - CLEARANCE_BAND) {
      failures.push(
        `${route.name}: terrain clearance drops to ${minClearance.toFixed(2)} m (cruise ${route.clearance})`,
      )
    }
    if (maxClearance > route.clearance + CLEARANCE_BAND + 1.2) {
      failures.push(
        `${route.name}: terrain clearance peaks at ${maxClearance.toFixed(2)} m (cruise ${route.clearance})`,
      )
    }
    if (minDiscMargin < DISC_MARGIN) {
      failures.push(
        `${route.name}: only ${minDiscMargin.toFixed(1)} m from full-height '${nearestDisc}' (need ${DISC_MARGIN})`,
      )
    }
    if (minCapsuleMargin < DISC_MARGIN) {
      failures.push(
        `${route.name}: only ${minCapsuleMargin.toFixed(1)} m from '${nearestCapsule}' (need ${DISC_MARGIN})`,
      )
    }
    if (minTorrent < TORRENT_CLEARANCE) {
      failures.push(
        `${route.name}: passes ${minTorrent.toFixed(1)} m from the Torrent track (need ${TORRENT_CLEARANCE})`,
      )
    }
    if (minCableGap < CABLE_VERTICAL_GAP) {
      failures.push(
        `${route.name}: crosses the Pearl cable band near (${nearestCable.x.toFixed(0)}, ${nearestCable.z.toFixed(0)}) with ${minCableGap.toFixed(2)} m vertical clearance (need ${CABLE_VERTICAL_GAP})`,
      )
    }
    if (entrance > PELAGIC_ENTRANCE_PASS.radius) {
      failures.push(
        `${route.name}: never nears the entrance (closest ${entrance.toFixed(0)} m, contract ${PELAGIC_ENTRANCE_PASS.radius})`,
      )
    }
  }
  return { routes: reports, failures }
}
