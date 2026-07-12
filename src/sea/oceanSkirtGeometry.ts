import { BufferAttribute, BufferGeometry } from 'three'

export const OCEAN_INNER_HALF_SIZE = 350
export const OCEAN_SKIRT_HOLE_HALF_SIZE = 348
export const OCEAN_SKIRT_OUTER_HALF_SIZE = 3_200

interface QuadBounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

const SKIRT_QUADS: readonly QuadBounds[] = [
  {
    minX: -OCEAN_SKIRT_OUTER_HALF_SIZE,
    maxX: -OCEAN_SKIRT_HOLE_HALF_SIZE,
    minZ: -OCEAN_SKIRT_OUTER_HALF_SIZE,
    maxZ: OCEAN_SKIRT_OUTER_HALF_SIZE,
  },
  {
    minX: OCEAN_SKIRT_HOLE_HALF_SIZE,
    maxX: OCEAN_SKIRT_OUTER_HALF_SIZE,
    minZ: -OCEAN_SKIRT_OUTER_HALF_SIZE,
    maxZ: OCEAN_SKIRT_OUTER_HALF_SIZE,
  },
  {
    minX: -OCEAN_SKIRT_HOLE_HALF_SIZE,
    maxX: OCEAN_SKIRT_HOLE_HALF_SIZE,
    minZ: -OCEAN_SKIRT_OUTER_HALF_SIZE,
    maxZ: -OCEAN_SKIRT_HOLE_HALF_SIZE,
  },
  {
    minX: -OCEAN_SKIRT_HOLE_HALF_SIZE,
    maxX: OCEAN_SKIRT_HOLE_HALF_SIZE,
    minZ: OCEAN_SKIRT_HOLE_HALF_SIZE,
    maxZ: OCEAN_SKIRT_OUTER_HALF_SIZE,
  },
]

/**
 * Exact square ring for the flat far ocean.
 *
 * The former coarse PlaneGeometry triangle filter put the effective hole edge
 * at the first 133 m grid line outside the requested boundary. Those diagonal
 * triangles intruded about 81 m beneath the still-displaced inner ocean; wave
 * troughs crossed the skirt and drew animated contour/barcode bands. Four
 * explicit rectangles keep the only overlap to the intended 2 m, where the
 * inner surface is already mathematically flat.
 */
export function createOceanSkirtGeometry(): BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []

  for (const quad of SKIRT_QUADS) {
    const first = positions.length / 3
    // Counter-clockwise as seen from +Y, yielding an upward normal.
    positions.push(
      quad.minX, 0, quad.minZ,
      quad.minX, 0, quad.maxZ,
      quad.maxX, 0, quad.maxZ,
      quad.maxX, 0, quad.minZ,
    )
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3)
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

export function auditOceanSkirtGeometry(): {
  quads: number
  triangles: number
  intendedOverlapMeters: number
  minimumHoleHalfSize: number
  maximumOuterHalfSize: number
  minimumTriangleNormalY: number
} {
  const geometry = createOceanSkirtGeometry()
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  if (!index || position.count % 4 !== 0) throw new Error('Ocean skirt topology is not quads')

  const holeEdges: number[] = []
  let maximumOuterHalfSize = 0
  for (let first = 0; first < position.count; first += 4) {
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (let vertex = first; vertex < first + 4; vertex++) {
      const x = position.getX(vertex)
      const z = position.getZ(vertex)
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
      maximumOuterHalfSize = Math.max(maximumOuterHalfSize, Math.abs(x), Math.abs(z))
    }
    if (maxX <= 0) holeEdges.push(-maxX)
    else if (minX >= 0) holeEdges.push(minX)
    else if (maxZ <= 0) holeEdges.push(-maxZ)
    else if (minZ >= 0) holeEdges.push(minZ)
    else throw new Error('Ocean skirt quad crosses through the central hole')
  }

  let minimumTriangleNormalY = Infinity
  for (let offset = 0; offset < index.count; offset += 3) {
    const a = index.getX(offset)
    const b = index.getX(offset + 1)
    const c = index.getX(offset + 2)
    const ux = position.getX(b) - position.getX(a)
    const uz = position.getZ(b) - position.getZ(a)
    const vx = position.getX(c) - position.getX(a)
    const vz = position.getZ(c) - position.getZ(a)
    minimumTriangleNormalY = Math.min(minimumTriangleNormalY, uz * vx - ux * vz)
  }

  const minimumHoleHalfSize = Math.min(...holeEdges)
  const intendedOverlapMeters = OCEAN_INNER_HALF_SIZE - minimumHoleHalfSize
  if (minimumHoleHalfSize !== OCEAN_SKIRT_HOLE_HALF_SIZE) {
    throw new Error(`Ocean skirt intrudes inside its exact hole: ${minimumHoleHalfSize} m`)
  }
  if (intendedOverlapMeters < 0 || intendedOverlapMeters > 2) {
    throw new Error(`Ocean skirt overlap is unsafe: ${intendedOverlapMeters} m`)
  }
  if (minimumTriangleNormalY <= 0) {
    throw new Error(`Ocean skirt has downward or degenerate triangles: ${minimumTriangleNormalY}`)
  }
  geometry.dispose()
  return {
    quads: position.count / 4,
    triangles: index.count / 3,
    intendedOverlapMeters,
    minimumHoleHalfSize,
    maximumOuterHalfSize,
    minimumTriangleNormalY,
  }
}
