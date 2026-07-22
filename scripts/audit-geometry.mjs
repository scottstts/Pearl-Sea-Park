import { auditNoticeBoardRoof } from '../src/shows/noticeBoardGeometry.ts'
import { auditBellGlassOpening } from '../src/rides/descentBellGeometry.ts'
import { auditPearlLineCabinGeometry } from '../src/rides/pearlLineCabin.ts'
import { auditPearlRoute } from '../src/rides/pearlRoute.ts'
import { auditTorrentCarHull } from '../src/rides/torrentCarHull.ts'
import { auditTorrentTrack } from '../src/rides/torrentTrack.ts'
import { auditOceanSkirtGeometry } from '../src/sea/oceanSkirtGeometry.ts'
import { auditFacilitySigns } from '../src/world/facilitySigns.ts'
import {
  auditAmenityGeometry,
  benchFacingDot,
  benchYawToward,
} from '../src/world/parkAmenities.ts'
import { auditFloraGeometry } from '../src/world/floraGeometry.ts'
import { auditPelagicRoutes } from '../src/wildlife/pelagicRoutesAudit.ts'
import { auditFaunaGeometry } from '../src/wildlife/speciesGeometry.ts'
import { auditFaunaAssets } from './audit-fauna-assets.mjs'
import { Rng } from '../src/core/prng.ts'

const amenities = auditAmenityGeometry()
const floraRoot = new Rng(19051906)
const floraGeometry = auditFloraGeometry((label) => floraRoot.fork(label))
const faunaGeometry = auditFaunaGeometry()
const noticeBoardRoof = auditNoticeBoardRoof()
const pearlLineCabin = auditPearlLineCabinGeometry()
const facilitySigns = auditFacilitySigns()
const torrentTrack = auditTorrentTrack()
const torrentCarHull = auditTorrentCarHull()
const pearlRoute = auditPearlRoute()
const pelagicRoutes = auditPelagicRoutes()
const faunaAssets = auditFaunaAssets()
const oceanSkirts = [256, 384, 448].map((segments) => auditOceanSkirtGeometry(segments))
const bellGlassOpening = auditBellGlassOpening()
const benchFacing = [
  { name: 'esplanade-east', at: [5.3, 175], target: [0, 175] },
  { name: 'esplanade-west', at: [-5.3, 175], target: [0, 175] },
  { name: 'atrium-ring', at: [13.5, 250], target: [0, 250] },
  { name: 'observatory-ring', at: [-58, 228], target: [-62, 228] },
].map(({ name, at, target }) => {
  const yaw = benchYawToward(at[0], at[1], target[0], target[1])
  return {
    name,
    yaw,
    targetDot: benchFacingDot(at[0], at[1], yaw, target[0], target[1]),
  }
})

const report = {
  benchBounds: {
    min: amenities.benchBounds.min.toArray(),
    max: amenities.benchBounds.max.toArray(),
  },
  lampBounds: {
    min: amenities.lampBounds.min.toArray(),
    max: amenities.lampBounds.max.toArray(),
  },
  benchSeatRailOverlap: amenities.benchSeatRailOverlap,
  benchBackPostOverlap: amenities.benchBackPostOverlap,
  lampPoleArmGap: amenities.lampPoleArmGap,
  lampArmGlobePenetration: amenities.lampArmGlobePenetration,
  noticeBoardRoof,
  pearlLineCabin: {
    bounds: {
      min: pearlLineCabin.bounds.min.toArray(),
      max: pearlLineCabin.bounds.max.toArray(),
    },
    drawSlots: pearlLineCabin.drawSlots,
    roofJunctionGap: pearlLineCabin.roofJunctionGap,
    clampJunctionGap: pearlLineCabin.clampJunctionGap,
    bodyProfileDistinctXLevels: pearlLineCabin.bodyProfileDistinctXLevels,
  },
  facilitySigns: {
    signCount: facilitySigns.signCount,
    drawSlots: facilitySigns.drawSlots,
    atlasBytes: facilitySigns.atlasBytes,
    frameBounds: {
      min: facilitySigns.frameBounds.min.toArray(),
      max: facilitySigns.frameBounds.max.toArray(),
    },
    minimumFacingDot: facilitySigns.minimumFacingDot,
    minimumPathClearance: facilitySigns.minimumPathClearance,
  },
  benchFacing,
  torrentTrack,
  torrentCarHull,
  pearlRoute,
  pelagicRoutes,
  faunaAssets,
  oceanSkirts,
  bellGlassOpening,
  floraGeometry,
  faunaGeometry,
}

console.log(JSON.stringify(report, null, 2))

const seabedFailures = [
  ...floraGeometry.failures,
  ...faunaGeometry.failures,
  ...pelagicRoutes.failures,
  ...faunaAssets.failures,
]
if (seabedFailures.length > 0) {
  console.error(`flora/fauna geometry audit FAILED:\n- ${seabedFailures.join('\n- ')}`)
  process.exitCode = 1
}
