import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  ConeGeometry,
  CylinderGeometry,
  SphereGeometry,
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
  // Carapace with scute ledges: a ring body whose radii step instead of
  // sweeping smoothly, giving the shell its plated silhouette; a flatter
  // plastron closes the underside. (The old turtle was two ellipsoids with
  // single-triangle flippers — cardboard from below.)
  writer.ringBody(
    [
      { z: 0.95, rx: 0.16, ry: 0.08, morph: 0 },
      { z: 0.74, rx: 0.5, ry: 0.2, morph: 0 },
      { z: 0.66, rx: 0.56, ry: 0.26, morph: 0 },
      { z: 0.34, rx: 0.68, ry: 0.3, morph: 0 },
      { z: 0.28, rx: 0.72, ry: 0.34, morph: 0 },
      { z: -0.06, rx: 0.75, ry: 0.35, morph: 0 },
      { z: -0.14, rx: 0.72, ry: 0.31, morph: 0 },
      { z: -0.48, rx: 0.62, ry: 0.27, morph: 0 },
      { z: -0.56, rx: 0.55, ry: 0.22, morph: 0 },
      { z: -0.82, rx: 0.3, ry: 0.12, morph: 0 },
      { z: -0.96, rx: 0.1, ry: 0.05, morph: 0 },
    ],
    14,
  )
  writer.ellipsoid([0, -0.12, 0.05], [0.58, 0.14, 0.85], 12, 5)
  // Keel ridge beads along the spine.
  for (let i = 0; i < 5; i++) {
    const z = 0.55 - i * 0.3
    writer.ellipsoid([0, 0.32 - Math.abs(z) * 0.12, z], [0.09, 0.05, 0.14], 6, 3)
  }
  // Neck and beaked head.
  const neck = new CylinderGeometry(0.13, 0.17, 0.42, 8)
  neck.rotateX(Math.PI / 2 - 0.25)
  neck.translate(0, 0.02, 1.05)
  writer.appendGeometry(neck, () => 0)
  neck.dispose()
  writer.ellipsoid([0, 0.1, 1.3], [0.19, 0.17, 0.24], 9, 5)
  const beak = new ConeGeometry(0.1, 0.16, 8)
  beak.rotateX(Math.PI / 2)
  beak.translate(0, 0.05, 1.55)
  writer.appendGeometry(beak, () => 0)
  beak.dispose()
  // Flippers: swept, tapered paddles with real thickness. Sphere geometry
  // scaled/rotated/translated then appended, with the flap channel rising
  // toward the tip (same morph convention the material animates).
  for (const side of [-1, 1]) {
    const front = new SphereGeometry(1, 10, 6)
    front.scale(0.52, 0.055, 0.2)
    front.rotateY(side * 0.55)
    front.translate(side * 0.92, -0.05, 0.42)
    writer.appendGeometry(front, (p) => side * Math.min(1, Math.abs(p.x) / 1.3))
    front.dispose()
    const back = new SphereGeometry(1, 9, 5)
    back.scale(0.32, 0.05, 0.16)
    back.rotateY(side * 2.35)
    back.translate(side * 0.62, -0.08, -0.68)
    writer.appendGeometry(back, (p) => side * 0.6 * Math.min(1, Math.abs(p.x) / 0.85))
    back.dispose()
  }
  // Tail nub.
  writer.ellipsoid([0, -0.04, -1.0], [0.07, 0.05, 0.14], 6, 3)
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
  // Spine runs crown → arched neck → plump belly → a tail that genuinely
  // CURLS forward under the body. The body is a unit tube post-scaled to a
  // per-ring radius profile (tube winding stays trustworthy; hand-built
  // rings on a curved frame are easy to get inside-out).
  const path = new CatmullRomCurve3([
    new Vector3(0.08, 0.6, 0.1),
    new Vector3(-0.02, 0.44, 0.0),
    new Vector3(-0.06, 0.18, -0.03),
    new Vector3(0.0, -0.12, -0.02),
    new Vector3(0.05, -0.4, -0.1),
    new Vector3(0.0, -0.62, -0.26),
    new Vector3(-0.02, -0.64, -0.44),
    new Vector3(0.0, -0.5, -0.52),
    new Vector3(0.02, -0.44, -0.42),
  ])
  const TUBULAR = 30
  const RADIAL = 7
  const smooth01 = (t: number) => t * t * (3 - 2 * t)
  const radiusAt = (t: number) => {
    if (t < 0.32) return 0.055 + 0.07 * smooth01(t / 0.32)
    if (t < 0.5) return 0.125 - 0.012 * smooth01((t - 0.32) / 0.18)
    return 0.014 + 0.099 * Math.pow(1 - (t - 0.5) / 0.5, 1.4)
  }
  const tube = new TubeGeometry(path, TUBULAR, 1, RADIAL, false)
  const position = tube.getAttribute('position')
  const ringVertices = RADIAL + 1
  const spinePoint = new Vector3()
  const vertex = new Vector3()
  for (let j = 0; j <= TUBULAR; j++) {
    const t = j / TUBULAR
    path.getPointAt(t, spinePoint)
    const radius = radiusAt(t)
    for (let i = 0; i < ringVertices; i++) {
      const index = j * ringVertices + i
      vertex.fromBufferAttribute(position, index).sub(spinePoint).multiplyScalar(radius).add(spinePoint)
      position.setXYZ(index, vertex.x, vertex.y, vertex.z)
    }
  }
  tube.computeVertexNormals()
  const writer = new WildlifeMeshWriter()
  writer.appendGeometry(tube, (p) => Math.max(0, Math.min(1, (0.5 - p.y) / 1.1)))
  tube.dispose()
  // Tail-tip bead closes the open tube end inside the curl.
  writer.ellipsoid([0.02, -0.44, -0.42], [0.02, 0.02, 0.02], 5, 3, () => 1)

  // Head, tapered tube snout, coronet, and fins with actual thickness (the
  // old snout and dorsal fin were single flat triangles — cardboard cutouts
  // from the side they culled on).
  writer.ellipsoid([0.08, 0.66, 0.14], [0.13, 0.12, 0.17], 10, 6)
  const snout = new CylinderGeometry(0.022, 0.05, 0.3, 7)
  snout.rotateX(Math.PI / 2 - 0.32)
  snout.translate(0.06, 0.6, 0.32)
  writer.appendGeometry(snout, () => 0)
  snout.dispose()
  const coronet = new ConeGeometry(0.05, 0.11, 5)
  coronet.translate(0.08, 0.8, 0.1)
  writer.appendGeometry(coronet, () => 0)
  coronet.dispose()
  writer.ellipsoid([-0.05, 0.16, -0.17], [0.015, 0.2, 0.08], 6, 4, () => 0.35)
  writer.ellipsoid([0.21, 0.6, 0.16], [0.04, 0.08, 0.025], 6, 4, () => 0.1)
  writer.ellipsoid([-0.05, 0.6, 0.16], [0.04, 0.08, 0.025], 6, 4, () => 0.1)
  return writer.compile()
}

/**
 * A sea butterfly (pteropod) for the Sun Garden: plump body, two broad
 * wing lobes with real thickness, tiny tail streamer and antennae knobs.
 * morphWeight is the flutter channel — 0 on the body, rising toward the
 * wing tips so a vertical sine in the material reads as wingbeats.
 */
export function createSunButterflyGeometry(): BufferGeometry {
  const writer = new WildlifeMeshWriter()
  writer.ellipsoid([0, 0, 0], [0.035, 0.04, 0.11], 8, 5)
  writer.ellipsoid([0, 0.015, 0.115], [0.028, 0.028, 0.035], 6, 4)
  for (const side of [-1, 1]) {
    // Forewing and hindwing lobes, root overlapping the body.
    writer.ellipsoid(
      [side * 0.105, 0.01, 0.025],
      [0.105, 0.009, 0.06],
      8,
      4,
      (x) => Math.min(1, Math.abs(x) / 0.19),
    )
    writer.ellipsoid(
      [side * 0.07, 0.005, -0.065],
      [0.07, 0.008, 0.042],
      7,
      4,
      (x) => Math.min(1, Math.abs(x) / 0.13),
    )
    // Antenna knob.
    writer.ellipsoid([side * 0.02, 0.035, 0.15], [0.008, 0.008, 0.008], 4, 3)
  }
  // Tail streamer with thickness.
  writer.ellipsoid([0, 0, -0.14], [0.012, 0.008, 0.05], 5, 3, () => 0.3)
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
