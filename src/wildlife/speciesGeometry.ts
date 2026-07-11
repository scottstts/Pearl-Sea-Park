import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  TubeGeometry,
  Vector3,
} from 'three'

export interface GeometryMetrics {
  vertices: number
  triangles: number
}

/**
 * Small semantic mesh writer shared by the wildlife kit. `morphWeight` is an
 * authored animation channel: tail flex, wing lift, bell pulse, or body sway
 * depending on the species. Silhouettes remain explicit rather than being
 * assembled from arbitrary primitives at runtime.
 */
class WildlifeMeshWriter {
  private readonly positions: number[] = []
  private readonly morphWeights: number[] = []
  private readonly indices: number[] = []

  vertex(x: number, y: number, z: number, morphWeight = 0): number {
    const index = this.positions.length / 3
    this.positions.push(x, y, z)
    this.morphWeights.push(morphWeight)
    return index
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c)
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d)
  }

  ellipsoid(
    center: [number, number, number],
    radii: [number, number, number],
    segments = 12,
    rings = 7,
    morph: (x: number, y: number, z: number) => number = () => 0,
  ): void {
    const rows: number[][] = []
    for (let j = 0; j <= rings; j++) {
      const v = j / rings
      const phi = v * Math.PI
      const row: number[] = []
      for (let i = 0; i < segments; i++) {
        const theta = (i / segments) * Math.PI * 2
        const x = center[0] + Math.sin(phi) * Math.cos(theta) * radii[0]
        const y = center[1] + Math.cos(phi) * radii[1]
        const z = center[2] + Math.sin(phi) * Math.sin(theta) * radii[2]
        row.push(this.vertex(x, y, z, morph(x, y, z)))
      }
      rows.push(row)
    }
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < segments; i++) {
        const next = (i + 1) % segments
        this.quad(rows[j][i], rows[j][next], rows[j + 1][next], rows[j + 1][i])
      }
    }
  }

  ringBody(
    rings: readonly { z: number; rx: number; ry: number; morph: number }[],
    segments = 10,
  ): void {
    const rows: number[][] = []
    for (const ring of rings) {
      const row: number[] = []
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2
        row.push(
          this.vertex(
            Math.cos(angle) * ring.rx,
            Math.sin(angle) * ring.ry,
            ring.z,
            ring.morph,
          ),
        )
      }
      rows.push(row)
    }
    for (let r = 0; r < rows.length - 1; r++) {
      for (let i = 0; i < segments; i++) {
        const next = (i + 1) % segments
        this.quad(rows[r][i], rows[r][next], rows[r + 1][next], rows[r + 1][i])
      }
    }
    const nose = this.vertex(0, 0, rings[0].z + 0.06, rings[0].morph)
    const tail = this.vertex(0, 0, rings.at(-1)!.z - 0.04, rings.at(-1)!.morph)
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments
      this.triangle(nose, rows[0][next], rows[0][i])
      this.triangle(tail, rows.at(-1)![i], rows.at(-1)![next])
    }
  }

  appendGeometry(geometry: BufferGeometry, morph: (p: Vector3) => number): void {
    const position = geometry.getAttribute('position')
    const base = this.positions.length / 3
    const point = new Vector3()
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i)
      this.vertex(point.x, point.y, point.z, morph(point))
    }
    const index = geometry.getIndex()
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        this.triangle(base + index.getX(i), base + index.getX(i + 1), base + index.getX(i + 2))
      }
    } else {
      for (let i = 0; i < position.count; i += 3) this.triangle(base + i, base + i + 1, base + i + 2)
    }
  }

  compile(): BufferGeometry {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3))
    geometry.setAttribute(
      'morphWeight',
      new BufferAttribute(new Float32Array(this.morphWeights), 1),
    )
    geometry.setIndex(this.indices)
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  }
}

export function createRayGeometry(manta = false): BufferGeometry {
  const writer = new WildlifeMeshWriter()
  const halfWidth = manta ? 3.4 : 1.25
  const halfLength = manta ? 2.25 : 0.9
  const xSegments = 12
  const zSegments = 7
  const grid: number[][] = []
  for (let zIndex = 0; zIndex <= zSegments; zIndex++) {
    const v = zIndex / zSegments
    const z = (0.5 - v) * halfLength * 2
    const row: number[] = []
    for (let xIndex = 0; xIndex <= xSegments; xIndex++) {
      const u = xIndex / xSegments
      const normalizedX = u * 2 - 1
      const taper = Math.pow(Math.max(0, 1 - Math.abs(z / halfLength) * 0.72), 0.72)
      const x = normalizedX * halfWidth * taper
      const y = (1 - normalizedX * normalizedX) * 0.22 - Math.abs(z) * 0.035
      row.push(writer.vertex(x, y, z, normalizedX))
    }
    grid.push(row)
  }
  for (let z = 0; z < zSegments; z++) {
    for (let x = 0; x < xSegments; x++) {
      writer.quad(grid[z][x], grid[z][x + 1], grid[z + 1][x + 1], grid[z + 1][x])
    }
  }
  writer.ellipsoid([0, 0.16, halfLength * 0.16], [halfWidth * 0.12, 0.22, halfLength * 0.7], 10, 5)
  const tailRoot = writer.vertex(0, 0, -halfLength * 0.88)
  const tailTip = writer.vertex(0, -0.04, -halfLength * (manta ? 2.6 : 2.25), 0.35)
  const tailSide = writer.vertex(0.04, 0.02, -halfLength * 0.96)
  writer.triangle(tailRoot, tailSide, tailTip)
  return writer.compile()
}

export function createTurtleGeometry(): BufferGeometry {
  const writer = new WildlifeMeshWriter()
  writer.ellipsoid([0, 0.05, 0], [0.78, 0.28, 1], 14, 7)
  writer.ellipsoid([0, 0, 0.92], [0.28, 0.24, 0.34], 10, 5)
  for (const side of [-1, 1]) {
    const frontA = writer.vertex(side * 0.48, 0, 0.45, side)
    const frontTip = writer.vertex(side * 1.18, -0.04, 0.74, side)
    const frontB = writer.vertex(side * 0.42, -0.08, 0.03, side)
    const backA = writer.vertex(side * 0.42, -0.05, -0.45, side * 0.7)
    const backTip = writer.vertex(side * 0.88, -0.08, -0.72, side * 0.7)
    const backB = writer.vertex(side * 0.32, -0.1, -0.76, side * 0.7)
    if (side < 0) {
      writer.triangle(frontA, frontB, frontTip)
      writer.triangle(backA, backB, backTip)
    } else {
      writer.triangle(frontA, frontTip, frontB)
      writer.triangle(backA, backTip, backB)
    }
  }
  return writer.compile()
}

export function createJellyGeometry(): BufferGeometry {
  const writer = new WildlifeMeshWriter()
  const profiles = [
    { y: 0.52, radius: 0.04 },
    { y: 0.45, radius: 0.28 },
    { y: 0.26, radius: 0.45 },
    { y: 0.04, radius: 0.5 },
    { y: -0.05, radius: 0.37 },
  ]
  const rows: number[][] = []
  const segments = 12
  for (const profile of profiles) {
    const row: number[] = []
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      row.push(
        writer.vertex(
          Math.cos(angle) * profile.radius,
          profile.y,
          Math.sin(angle) * profile.radius,
          0.45 + profile.radius,
        ),
      )
    }
    rows.push(row)
  }
  for (let r = 0; r < rows.length - 1; r++) {
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments
      writer.quad(rows[r][i], rows[r][next], rows[r + 1][next], rows[r + 1][i])
    }
  }
  for (let strand = 0; strand < 6; strand++) {
    const angle = (strand / 6) * Math.PI * 2
    const x = Math.cos(angle) * 0.25
    const z = Math.sin(angle) * 0.25
    const sideX = -Math.sin(angle) * 0.018
    const sideZ = Math.cos(angle) * 0.018
    const topA = writer.vertex(x - sideX, -0.02, z - sideZ, 0.4)
    const topB = writer.vertex(x + sideX, -0.02, z + sideZ, 0.4)
    const bottomB = writer.vertex(x + sideX * 0.35, -1.12, z + sideZ * 0.35, 1)
    const bottomA = writer.vertex(x - sideX * 0.35, -1.12, z - sideZ * 0.35, 1)
    writer.quad(topA, topB, bottomB, bottomA)
  }
  return writer.compile()
}

export function createSeahorseGeometry(): BufferGeometry {
  const path = new CatmullRomCurve3([
    new Vector3(0, -0.65, -0.08),
    new Vector3(0.1, -0.46, -0.2),
    new Vector3(0.02, -0.16, -0.08),
    new Vector3(-0.05, 0.16, 0.02),
    new Vector3(0.04, 0.45, 0.04),
    new Vector3(0.12, 0.63, 0.14),
  ])
  const tube = new TubeGeometry(path, 28, 0.105, 7, false)
  const writer = new WildlifeMeshWriter()
  writer.appendGeometry(tube, (p) => Math.max(0, Math.min(1, (0.65 - p.y) / 1.3)))
  tube.dispose()
  writer.ellipsoid([0.1, 0.66, 0.15], [0.18, 0.15, 0.22], 10, 5)
  const snoutTop = writer.vertex(0.03, 0.73, 0.26, 0)
  const snoutTip = writer.vertex(-0.02, 0.69, 0.62, 0)
  const snoutBottom = writer.vertex(0.04, 0.64, 0.27, 0)
  writer.triangle(snoutTop, snoutTip, snoutBottom)
  const finRootTop = writer.vertex(0, 0.35, -0.08, 0.2)
  const finTip = writer.vertex(0, 0.23, -0.42, 0.4)
  const finRootBottom = writer.vertex(0, 0.02, -0.12, 0.55)
  writer.triangle(finRootTop, finTip, finRootBottom)
  return writer.compile()
}

export function createWhaleGeometry(): BufferGeometry {
  const writer = new WildlifeMeshWriter()
  writer.ringBody(
    [
      { z: 6.8, rx: 0.18, ry: 0.2, morph: 0 },
      { z: 5.6, rx: 1.25, ry: 1.12, morph: 0 },
      { z: 2.8, rx: 1.75, ry: 1.45, morph: 0.06 },
      { z: -0.8, rx: 1.62, ry: 1.28, morph: 0.24 },
      { z: -4.5, rx: 0.72, ry: 0.62, morph: 0.72 },
      { z: -6.25, rx: 0.24, ry: 0.25, morph: 1 },
    ],
    18,
  )
  for (const side of [-1, 1]) {
    const rootFront = writer.vertex(side * 1.25, -0.22, 1.8, side * 0.2)
    const tip = writer.vertex(side * 4.3, -0.65, -0.2, side * 0.55)
    const rootBack = writer.vertex(side * 1.1, -0.45, -1.55, side * 0.45)
    if (side < 0) writer.triangle(rootFront, rootBack, tip)
    else writer.triangle(rootFront, tip, rootBack)
  }
  const peduncle = writer.vertex(0, 0, -6.15, 1)
  const notch = writer.vertex(0, 0, -6.8, 1)
  for (const side of [-1, 1]) {
    const tip = writer.vertex(side * 3.2, 0.1, -7.35, 1)
    const back = writer.vertex(side * 0.65, -0.02, -7.2, 1)
    if (side < 0) writer.quad(peduncle, notch, tip, back)
    else writer.quad(peduncle, back, tip, notch)
  }
  return writer.compile()
}

export function geometryMetrics(geometry: BufferGeometry): GeometryMetrics {
  const vertices = geometry.getAttribute('position').count
  const triangles = geometry.getIndex()?.count ? geometry.getIndex()!.count / 3 : vertices / 3
  return { vertices, triangles }
}
