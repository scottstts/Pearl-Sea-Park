import { CatmullRomCurve3, Vector2, Vector3 } from 'three'

export const BELL_GLASS_OPENING_LOWER_Y = 1.2
export const BELL_GLASS_OPENING_UPPER_Y = 1.92
export const BELL_CAGE_RIB_RADIUS = 0.03
export const BELL_CAGE_GLASS_CLEARANCE = 0.02
export const BELL_OPENING_RIM_RADIUS = 0.045
export const BELL_OPENING_RIM_OFFSET = BELL_OPENING_RIM_RADIUS * 0.5

/** One authored meridian shared by both glass sections and the brass cage. */
export function createBellShellCurve(): CatmullRomCurve3 {
  return new CatmullRomCurve3([
    new Vector3(1.22, 0.16, 0),
    new Vector3(1.3, 0.7, 0),
    new Vector3(1.26, 1.5, 0),
    new Vector3(1.02, 2.15, 0),
    new Vector3(0.55, 2.52, 0),
    new Vector3(0.12, 2.66, 0),
  ])
}

export function bellProfileTAtY(profile: CatmullRomCurve3, targetY: number): number {
  let low = 0
  let high = 1
  for (let i = 0; i < 24; i++) {
    const middle = (low + high) * 0.5
    if (profile.getPoint(middle).y < targetY) low = middle
    else high = middle
  }
  return (low + high) * 0.5
}

export function offsetBellProfile(
  profile: CatmullRomCurve3,
  t: number,
  offset: number,
  target = new Vector2(),
): Vector2 {
  const point = profile.getPoint(t)
  const tangent = profile.getTangent(t)
  const tangentLength = Math.max(Math.hypot(tangent.x, tangent.y), Number.EPSILON)
  return target.set(
    point.x + (tangent.y / tangentLength) * offset,
    point.y - (tangent.x / tangentLength) * offset,
  )
}

export function sampleBellProfileSection(
  profile: CatmullRomCurve3,
  startT: number,
  endT: number,
  segments: number,
): Vector2[] {
  return Array.from({ length: segments + 1 }, (_, index) => {
    const t = startT + ((endT - startT) * index) / segments
    const point = profile.getPoint(t)
    return new Vector2(point.x, point.y)
  })
}

export function auditBellGlassOpening(): {
  lowerY: number
  upperY: number
  height: number
  lowerRadius: number
  upperRadius: number
  boardingLowerClearance: number
  boardingUpperClearance: number
  glassEdgeCapture: number
  lowerRimRibOverlap: number
  upperRimRibOverlap: number
} {
  const profile = createBellShellCurve()
  const lowerT = bellProfileTAtY(profile, BELL_GLASS_OPENING_LOWER_Y)
  const upperT = bellProfileTAtY(profile, BELL_GLASS_OPENING_UPPER_Y)
  const lower = sampleBellProfileSection(profile, 0, lowerT, 18)
  const upper = sampleBellProfileSection(profile, upperT, 1, 18)
  const lowerEdge = lower.at(-1)
  const upperEdge = upper[0]
  if (!lowerEdge || !upperEdge) throw new Error('Descent Bell glass sections are empty')

  const height = upperEdge.y - lowerEdge.y
  // Original camera blend: the local eye moves linearly from the 1.68 m deck
  // standing height to the 1.45 m seat. The terrace start is slightly lower.
  const boardingLowerClearance = 1.45 - lowerEdge.y
  const boardingUpperClearance = upperEdge.y - 1.68
  const cageOffset = BELL_CAGE_RIB_RADIUS + BELL_CAGE_GLASS_CLEARANCE
  const lowerRib = offsetBellProfile(profile, lowerT, cageOffset)
  const upperRib = offsetBellProfile(profile, upperT, cageOffset)
  const glassEdgeCapture = BELL_OPENING_RIM_RADIUS - BELL_OPENING_RIM_OFFSET
  const collarRibReach = BELL_OPENING_RIM_RADIUS + BELL_CAGE_RIB_RADIUS
  const lowerRimRibOverlap =
    collarRibReach -
    Math.hypot(
      lowerRib.x - (lowerEdge.x + BELL_OPENING_RIM_OFFSET),
      lowerRib.y - lowerEdge.y,
    )
  const upperRimRibOverlap =
    collarRibReach -
    Math.hypot(
      upperRib.x - (upperEdge.x + BELL_OPENING_RIM_OFFSET),
      upperRib.y - upperEdge.y,
    )
  if (
    Math.abs(lowerEdge.y - BELL_GLASS_OPENING_LOWER_Y) > 1e-5 ||
    Math.abs(upperEdge.y - BELL_GLASS_OPENING_UPPER_Y) > 1e-5 ||
    height < 0.7 ||
    boardingLowerClearance < 0.2 ||
    boardingUpperClearance < 0.2
  ) {
    throw new Error('Descent Bell glass belt does not provide the authored camera clearance')
  }
  if (glassEdgeCapture <= 0 || lowerRimRibOverlap <= 0 || upperRimRibOverlap <= 0) {
    throw new Error('Descent Bell opening collars do not capture the glass and cage ribs')
  }
  if (lower.some((point) => point.y > BELL_GLASS_OPENING_LOWER_Y + 1e-5)) {
    throw new Error('Lower Descent Bell glass intrudes into the boarding belt')
  }
  if (upper.some((point) => point.y < BELL_GLASS_OPENING_UPPER_Y - 1e-5)) {
    throw new Error('Upper Descent Bell glass intrudes into the boarding belt')
  }

  return {
    lowerY: lowerEdge.y,
    upperY: upperEdge.y,
    height,
    lowerRadius: lowerEdge.x,
    upperRadius: upperEdge.x,
    boardingLowerClearance,
    boardingUpperClearance,
    glassEdgeCapture,
    lowerRimRibOverlap,
    upperRimRibOverlap,
  }
}
