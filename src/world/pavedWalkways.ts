import { PAVED_WALKWAYS, type ParkWalkway } from './parkLayout.ts'
import { terrainHeight } from './terrainHeight.ts'

const MAX_SEGMENT_LENGTH = 9
const SEGMENT_OVERLAP = 0.3
const BASE_GROUND_LIFT = 0.02
const PLATE_HALF_HEIGHT = 0.08
const SURFACE_EPSILON = 1e-4

export interface GroundedWalkwaySegment {
  sx: number
  sz: number
  ex: number
  ez: number
  mx: number
  mz: number
  width: number
  halfLength: number
  yaw: number
  baseY: number
  surfaceY: number
}

/**
 * Builds the short, overlapping plates used by both walkway geometry and
 * collision. Each plate takes the highest seabed sample under its span so it
 * never disappears into a local rise.
 */
function buildGroundedWalkwaySegments(walkway: ParkWalkway): GroundedWalkwaySegment[] {
  const { ax, az, bx, bz, width } = walkway
  const dx = bx - ax
  const dz = bz - az
  const length = Math.hypot(dx, dz)
  if (length < 0.01) return []

  const count = Math.max(1, Math.ceil(length / MAX_SEGMENT_LENGTH))
  const pad = SEGMENT_OVERLAP / length
  const segments: GroundedWalkwaySegment[] = []
  for (let i = 0; i < count; i++) {
    const t0 = Math.max(0, i / count - pad)
    const t1 = Math.min(1, (i + 1) / count + pad)
    const sx = ax + dx * t0
    const sz = az + dz * t0
    const ex = ax + dx * t1
    const ez = az + dz * t1
    const mx = (sx + ex) / 2
    const mz = (sz + ez) / 2
    const baseY =
      Math.max(terrainHeight(sx, sz), terrainHeight(mx, mz), terrainHeight(ex, ez)) +
      BASE_GROUND_LIFT
    const halfLength = Math.hypot(ex - sx, ez - sz) / 2
    segments.push({
      sx,
      sz,
      ex,
      ez,
      mx,
      mz,
      width,
      halfLength,
      yaw: Math.atan2(ex - sx, ez - sz),
      baseY,
      surfaceY: baseY + PLATE_HALF_HEIGHT * 2,
    })
  }
  return segments
}

/** Authoritative paved plates shared by rendering, Rapier, and vehicle grounding. */
export const PAVED_WALKWAY_SEGMENTS: readonly GroundedWalkwaySegment[] =
  PAVED_WALKWAYS.flatMap(buildGroundedWalkwaySegments)

/** Top of the highest paved plate containing this world-space point. */
export function pavedWalkwaySurfaceHeight(x: number, z: number): number | null {
  let surfaceY = -Infinity
  for (const segment of PAVED_WALKWAY_SEGMENTS) {
    const dx = segment.ex - segment.sx
    const dz = segment.ez - segment.sz
    const length = segment.halfLength * 2
    const tangentX = dx / length
    const tangentZ = dz / length
    const relativeX = x - segment.sx
    const relativeZ = z - segment.sz
    const along = relativeX * tangentX + relativeZ * tangentZ
    const across = relativeX * -tangentZ + relativeZ * tangentX
    if (
      along >= -SURFACE_EPSILON &&
      along <= length + SURFACE_EPSILON &&
      Math.abs(across) <= segment.width / 2 + SURFACE_EPSILON
    ) {
      surfaceY = Math.max(surfaceY, segment.surfaceY)
    }
  }
  return Number.isFinite(surfaceY) ? surfaceY : null
}

/** Seabed height, raised to the paving top wherever a walkway is present. */
export function seabedOrPavedWalkwayHeight(x: number, z: number): number {
  const seabedY = terrainHeight(x, z)
  const walkwayY = pavedWalkwaySurfaceHeight(x, z)
  return walkwayY === null ? seabedY : Math.max(seabedY, walkwayY)
}
