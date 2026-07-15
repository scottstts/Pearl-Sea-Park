import { auditNoticeBoardRoof } from '../src/shows/noticeBoardGeometry.ts'
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

const amenities = auditAmenityGeometry()
const noticeBoardRoof = auditNoticeBoardRoof()
const pearlLineCabin = auditPearlLineCabinGeometry()
const facilitySigns = auditFacilitySigns()
const torrentTrack = auditTorrentTrack()
const torrentCarHull = auditTorrentCarHull()
const pearlRoute = auditPearlRoute()
const oceanSkirts = [256, 384, 448].map((segments) => auditOceanSkirtGeometry(segments))
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
  oceanSkirts,
}

console.log(JSON.stringify(report, null, 2))
