import { BufferAttribute, BufferGeometry, CatmullRomCurve3, Vector2, Vector3 } from 'three'

/** Audited rider eye shared by the hull sightline check and live seat rig. */
export const TORRENT_SEAT_EYE = { x: 0, y: 0.9, z: -0.12 } as const

/**
 * The Torrent sled hull authority (leaf module — imports only three, so the
 * offline geometry audit can build and interrogate the exact game mesh).
 *
 * The hull is a solid of revolution around +z with a REAL cockpit opening:
 * an elliptical well cut from the top skin, rimmed by a flared collar wall
 * rising from the cut edge to just under the leather coaming.
 *
 * A plain LatheGeometry cannot express this: a full revolve roofs the cockpit
 * with its own top arc (the seat tub sat buried inside the closed volume —
 * the "covered seat" defect), and a phiStart/phiLength sector would slot the
 * hull nose-to-tail instead of opening one bay. So the hull is built ring by
 * ring: profile stations become circles whose arc SKIPS the opening where the
 * plan ellipse crosses them, the two arc endpoints landing exactly on the
 * ellipse — an analytic rim curve, not a triangle staircase.
 *
 * Coordinates are final car-local space: profile y is the z-station ascending
 * tail → nose (+z = direction of travel), profile x the radius. Building
 * directly in this frame also retires a latent mirror: the old
 * `rotateX(-PI/2)` sent profile +y to −z, flipping the hull against every
 * hullRadiusAt()-keyed fitting (bow collar, seams, louvres, rivets) and
 * floating the "half-embedded" bow pearl off the tip.
 */

const HULL_CONTROLS = [
  new Vector3(0.03, -1.48, 0),
  new Vector3(0.30, -1.34, 0),
  new Vector3(0.46, -1.12, 0),
  new Vector3(0.55, -0.82, 0),
  new Vector3(0.60, -0.42, 0),
  new Vector3(0.62, -0.02, 0),
  new Vector3(0.60, 0.38, 0),
  new Vector3(0.55, 0.72, 0),
  new Vector3(0.46, 1.02, 0),
  new Vector3(0.34, 1.24, 0),
  new Vector3(0.20, 1.42, 0),
  new Vector3(0.08, 1.54, 0),
  new Vector3(0.02, 1.58, 0),
]

/** CatmullRom-smoothed boat-tail profile; x = radius, y = z-station. */
export const TORRENT_HULL_PROFILE: readonly Vector2[] = new CatmullRomCurve3(HULL_CONTROLS)
  .getPoints(44)
  .map((p) => new Vector2(Math.min(0.62, Math.max(0.02, p.x)), p.y))

/** Hull skin radius at a car-local z (piecewise-linear over the profile). */
export function torrentHullRadiusAt(z: number): number {
  const points = TORRENT_HULL_PROFILE
  if (z <= points[0].y) return points[0].x
  for (let k = 1; k < points.length; k++) {
    if (z <= points[k].y) {
      const t = (z - points[k - 1].y) / (points[k].y - points[k - 1].y || 1e-6)
      return points[k - 1].x + (points[k].x - points[k - 1].x) * t
    }
  }
  return points[points.length - 1].x
}

export interface CockpitOpening {
  /** Plan-ellipse center along z (car-local). */
  centerZ: number
  /** Plan-ellipse half-length along z. */
  halfLength: number
  /** Plan-ellipse half-width along x. */
  halfWidth: number
  /** Collar rim ring: height and plan half-extents. The collar leans outward
   * so its top edge tucks under the coaming torus OUTSIDE the tub wall —
   * hidden from both sides, no see-through gap from any angle. */
  collarTopY: number
  collarHalfWidth: number
  collarHalfLength: number
}

/**
 * The opening sits inside the seam-guarded cockpit bay (z −0.63…+0.53) and
 * inside the coaming footprint: cut rim (0.40 × 0.56) on the skin, collar top
 * (0.45 × 0.595 at y 0.588) tucked under the coaming torus (0.46 × 0.615 at
 * y 0.60) and outside the tub mouth (0.44 × 0.58 at y 0.60).
 */
export const TORRENT_COCKPIT_OPENING: CockpitOpening = {
  centerZ: -0.05,
  halfLength: 0.56,
  halfWidth: 0.4,
  collarTopY: 0.588,
  collarHalfWidth: 0.45,
  collarHalfLength: 0.595,
}

export function buildTorrentHullGeometry(
  radialSegments = 36,
  profile: readonly Vector2[] = TORRENT_HULL_PROFILE,
  opening: CockpitOpening = TORRENT_COCKPIT_OPENING,
): BufferGeometry {
  const rings = profile.length
  const columns = radialSegments + 1
  const { centerZ, halfLength, halfWidth } = opening

  // Per-ring radius slope for exact lathe normals (central differences).
  const slope = (index: number): number => {
    const lo = Math.max(0, index - 1)
    const hi = Math.min(rings - 1, index + 1)
    const dz = profile[hi].y - profile[lo].y
    return dz !== 0 ? (profile[hi].x - profile[lo].x) / dz : 0
  }

  // Opening half-angle around the top (θ = π/2) per ring; 0 = full circle.
  const openHalfAngle = (index: number): number => {
    const z = profile[index].y
    const u = (z - centerZ) / halfLength
    if (Math.abs(u) >= 1) return 0
    const planHalfWidth = halfWidth * Math.sqrt(1 - u * u)
    if (planHalfWidth < 1e-4) return 0
    return Math.asin(Math.min(0.999, planHalfWidth / profile[index].x))
  }

  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  // ── Hull skin: one arc of `columns` vertices per profile ring ───────────
  for (let i = 0; i < rings; i++) {
    const radius = profile[i].x
    const z = profile[i].y
    const alpha = openHalfAngle(i)
    const thetaStart = Math.PI / 2 + alpha
    const arc = Math.PI * 2 - alpha * 2
    const radiusSlope = slope(i)
    for (let k = 0; k <= radialSegments; k++) {
      const theta = thetaStart + (arc * k) / radialSegments
      const cos = Math.cos(theta)
      const sin = Math.sin(theta)
      positions.push(radius * cos, radius * sin, z)
      const inverse = 1 / Math.hypot(cos, sin, radiusSlope)
      normals.push(cos * inverse, sin * inverse, -radiusSlope * inverse)
      uvs.push(k / radialSegments, i / (rings - 1))
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let k = 0; k < radialSegments; k++) {
      const a = i * columns + k
      const b = a + 1
      const c = a + columns
      const d = c + 1
      indices.push(a, b, d, a, d, c)
    }
  }

  // ── Collar: rim (on the skin's cut edge) up to the flared top ring ──────
  // Rim loop order: left boundary tail→nose, right boundary nose→tail. Each
  // ring's vertex k=0 sits at θ = π/2 + α (x = −planHalfWidth), k = N at
  // θ = π/2 − α (x = +planHalfWidth) — both exactly on the plan ellipse.
  const openRingIndices: number[] = []
  for (let i = 0; i < rings; i++) if (openHalfAngle(i) > 0) openRingIndices.push(i)

  if (openRingIndices.length >= 2) {
    const loop: number[] = [
      ...openRingIndices.map((i) => i * columns),
      ...[...openRingIndices].reverse().map((i) => i * columns + radialSegments),
    ]
    const collarStart = positions.length / 3
    const loopLength = loop.length
    for (const source of loop) {
      const x = positions[source * 3]
      const y = positions[source * 3 + 1]
      const z = positions[source * 3 + 2]
      const topX = (x / halfWidth) * opening.collarHalfWidth
      const topZ = centerZ + ((z - centerZ) / halfLength) * opening.collarHalfLength
      // Outward plan normal of the collar wall (ellipse gradient, horizontal).
      const gradX = x / (opening.collarHalfWidth * opening.collarHalfWidth)
      const gradZ = (z - centerZ) / (opening.collarHalfLength * opening.collarHalfLength)
      const inverse = 1 / Math.max(1e-6, Math.hypot(gradX, gradZ))
      positions.push(x, y, z, topX, opening.collarTopY, topZ)
      normals.push(
        gradX * inverse, 0, gradZ * inverse,
        gradX * inverse, 0, gradZ * inverse,
      )
      uvs.push(0, 0, 0, 1)
    }
    for (let j = 0; j < loopLength; j++) {
      const next = (j + 1) % loopLength
      const rimA = collarStart + j * 2
      const topA = rimA + 1
      const rimB = collarStart + next * 2
      const topB = rimB + 1
      indices.push(rimA, rimB, topB, rimA, topB, topA)
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
  geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1))
  return geometry
}

export interface TorrentCarHullAudit {
  triangles: number
  flippedWindings: number
  degenerateTriangles: number
  maxAbsX: number
  maxY: number
  zRange: [number, number]
  /** Probes inside the well finding skin above the tub, or outside finding none. */
  opennessFailures: number
  /** Hull triangles blocking the seated eye's view of the squab. */
  eyeToSeatOcclusions: number
  seatEye: [number, number, number]
  /** Worst collar-top offset from the coaming torus centerline (fraction). */
  collarTuckWorst: number
}

/** Offline proof that the cockpit is genuinely open and the mesh is sound. */
export function auditTorrentCarHull(): TorrentCarHullAudit {
  const geometry = buildTorrentHullGeometry()
  const pos = geometry.getAttribute('position')
  const nor = geometry.getAttribute('normal')
  const index = geometry.getIndex()!
  const opening = TORRENT_COCKPIT_OPENING

  const pA = new Vector3()
  const pB = new Vector3()
  const pC = new Vector3()
  const e1 = new Vector3()
  const e2 = new Vector3()
  const faceNormal = new Vector3()
  const vertexNormal = new Vector3()
  const scratch = new Vector3()

  let flippedWindings = 0
  let degenerateTriangles = 0
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t)
    const b = index.getX(t + 1)
    const c = index.getX(t + 2)
    pA.fromBufferAttribute(pos, a)
    pB.fromBufferAttribute(pos, b)
    pC.fromBufferAttribute(pos, c)
    faceNormal.crossVectors(e1.subVectors(pB, pA), e2.subVectors(pC, pA))
    if (faceNormal.lengthSq() < 1e-14) {
      degenerateTriangles++
      continue
    }
    vertexNormal.set(0, 0, 0)
    vertexNormal.add(scratch.fromBufferAttribute(nor, a))
    vertexNormal.add(scratch.fromBufferAttribute(nor, b))
    vertexNormal.add(scratch.fromBufferAttribute(nor, c))
    if (faceNormal.dot(vertexNormal) <= 0) flippedWindings++
  }

  let maxAbsX = 0
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < pos.count; i++) {
    maxAbsX = Math.max(maxAbsX, Math.abs(pos.getX(i)))
    maxY = Math.max(maxY, pos.getY(i))
    minZ = Math.min(minZ, pos.getZ(i))
    maxZ = Math.max(maxZ, pos.getZ(i))
  }

  const rayHits = (origin: Vector3, direction: Vector3, tMin: number, tMax: number): number => {
    let hits = 0
    const edge1 = new Vector3()
    const edge2 = new Vector3()
    const h = new Vector3()
    const s = new Vector3()
    const q = new Vector3()
    for (let t = 0; t < index.count; t += 3) {
      pA.fromBufferAttribute(pos, index.getX(t))
      pB.fromBufferAttribute(pos, index.getX(t + 1))
      pC.fromBufferAttribute(pos, index.getX(t + 2))
      edge1.subVectors(pB, pA)
      edge2.subVectors(pC, pA)
      h.crossVectors(direction, edge2)
      const det = edge1.dot(h)
      if (Math.abs(det) < 1e-12) continue
      const inv = 1 / det
      s.subVectors(origin, pA)
      const u = s.dot(h) * inv
      if (u < 0 || u > 1) continue
      q.crossVectors(s, edge1)
      const v = direction.dot(q) * inv
      if (v < 0 || u + v > 1) continue
      const tHit = edge2.dot(q) * inv
      if (tHit >= tMin && tHit <= tMax) hits++
    }
    return hits
  }

  // Openness: downward probes stop above the tub line (y 0.30), so a hit
  // means skin still roofs the well. Outside probes must find skin.
  const down = new Vector3(0, -1, 0)
  let opennessFailures = 0
  const insideProbes = [
    [0, -0.05], [0.28, -0.05], [-0.28, -0.05], [0, -0.5], [0, 0.4], [0.2, -0.35],
  ] as const
  for (const [x, z] of insideProbes) {
    if (rayHits(new Vector3(x, 2, z), down, 0, 2 - 0.3) > 0) opennessFailures++
  }
  const outsideProbes = [[0.5, -0.05], [-0.5, -0.05], [0, -0.75], [0, 0.7]] as const
  for (const [x, z] of outsideProbes) {
    if (rayHits(new Vector3(x, 2, z), down, 0, 4) === 0) opennessFailures++
  }

  const eye = new Vector3(TORRENT_SEAT_EYE.x, TORRENT_SEAT_EYE.y, TORRENT_SEAT_EYE.z)
  const squab = new Vector3(0, 0.45, -0.1)
  const toSquab = squab.clone().sub(eye)
  const eyeToSeatOcclusions = rayHits(eye, toSquab.clone().normalize(), 0, toSquab.length())

  let collarTuckWorst = 0
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getY(i) - opening.collarTopY) > 1e-6) continue
    const x = pos.getX(i)
    const z = pos.getZ(i) - opening.centerZ
    const radial = Math.hypot(x / 0.46, z / 0.615) // 1 = coaming tube centerline
    collarTuckWorst = Math.max(collarTuckWorst, Math.abs(radial - 1))
  }

  geometry.dispose()
  return {
    triangles: index.count / 3,
    flippedWindings,
    degenerateTriangles,
    maxAbsX,
    maxY,
    zRange: [minZ, maxZ],
    opennessFailures,
    eyeToSeatOcclusions,
    seatEye: [TORRENT_SEAT_EYE.x, TORRENT_SEAT_EYE.y, TORRENT_SEAT_EYE.z],
    collarTuckWorst,
  }
}
