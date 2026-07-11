import { auditNoticeBoardRoof } from '../src/shows/noticeBoardGeometry.ts'
import { auditAmenityGeometry } from '../src/world/parkAmenities.ts'

const amenities = auditAmenityGeometry()
const noticeBoardRoof = auditNoticeBoardRoof()

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
}

console.log(JSON.stringify(report, null, 2))
