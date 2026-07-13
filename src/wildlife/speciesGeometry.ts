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
  // The wing disc: denser grid, swept-back tips, and a camber that rolls
  // slightly downward past three-quarter span so the resting pose already
  // reads as a glide instead of a flat kite. morphWeight stays ±normalizedX
  // (the wing-lift channel the material animates).
  const xSegments = 16
  const zSegments = 9
  const grid: number[][] = []
  for (let zIndex = 0; zIndex <= zSegments; zIndex++) {
    const v = zIndex / zSegments
    const z = (0.5 - v) * halfLength * 2
    const row: number[] = []
    for (let xIndex = 0; xIndex <= xSegments; xIndex++) {
      const u = xIndex / xSegments
      const normalizedX = u * 2 - 1
      const span = Math.abs(normalizedX)
      const taper = Math.pow(Math.max(0, 1 - Math.abs(z / halfLength) * 0.72), 0.72)
      const x = normalizedX * halfWidth * taper
      // Sweep: the outer wing trails backward like a real myliobatid fin.
      const sweep = -Math.pow(span, 1.7) * halfLength * 0.34
      const camber = (1 - normalizedX * normalizedX) * 0.22
      const droop = -Math.pow(Math.max(0, span - 0.72) / 0.28, 1.6) * 0.16
      const y = camber + droop - Math.abs(z) * 0.035
      row.push(writer.vertex(x, y, z * (1 - span * 0.18) + sweep, normalizedX))
    }
    grid.push(row)
  }
  for (let z = 0; z < zSegments; z++) {
    for (let x = 0; x < xSegments; x++) {
      writer.quad(grid[z][x], grid[z][x + 1], grid[z + 1][x + 1], grid[z + 1][x])
    }
  }
  writer.ellipsoid([0, 0.16, halfLength * 0.16], [halfWidth * 0.12, 0.22, halfLength * 0.7], 10, 5)
  // Eye bumps riding the head swell.
  for (const side of [-1, 1]) {
    writer.ellipsoid(
      [side * halfWidth * 0.1, 0.3, halfLength * 0.42],
      [halfWidth * 0.022, 0.045, halfLength * 0.05],
      6,
      4,
    )
  }
  if (manta) {
    // Cephalic lobes: the manta's unrolled feeding horns, real thickness.
    for (const side of [-1, 1]) {
      const lobe = new CylinderGeometry(0.09, 0.16, 0.85, 7)
      lobe.rotateX(Math.PI / 2 - 0.34)
      lobe.rotateY(side * 0.22)
      lobe.translate(side * halfWidth * 0.115, -0.02, halfLength * 0.92)
      writer.appendGeometry(lobe, () => 0)
      lobe.dispose()
    }
  }
  // Whip tail: a genuine tapering tube that carries the swim wave outward
  // (the old tail was one flat triangle — cardboard from every side view).
  const tailRings = 7
  const tailStart = -halfLength * 0.86
  const tailEnd = -halfLength * (manta ? 2.6 : 2.3)
  const tailRows: number[][] = []
  for (let ring = 0; ring <= tailRings; ring++) {
    const t = ring / tailRings
    const z = tailStart + (tailEnd - tailStart) * t
    const radius = 0.055 * (1 - t) + 0.008
    const row: number[] = []
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2
      row.push(
        writer.vertex(
          Math.cos(angle) * radius,
          Math.sin(angle) * radius * 0.8 - t * 0.05,
          z,
          0.25 + t * 0.6,
        ),
      )
    }
    tailRows.push(row)
  }
  for (let ring = 0; ring < tailRings; ring++) {
    for (let i = 0; i < 6; i++) {
      const next = (i + 1) % 6
      writer.quad(
        tailRows[ring][i],
        tailRows[ring][next],
        tailRows[ring + 1][next],
        tailRows[ring + 1][i],
      )
    }
  }
  const tailTip = writer.vertex(0, -0.05 - 0.05, tailEnd - 0.05, 0.9)
  for (let i = 0; i < 6; i++) {
    const next = (i + 1) % 6
    writer.triangle(tailTip, tailRows[tailRings][i], tailRows[tailRings][next])
  }
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
  // Bell: outer dome sweeping over the rim INTO an inner subumbrella
  // surface, so the medusa has real rim thickness and a visible underside
  // vault instead of an open-backed shell. A gentle 8-lobe scallop rides
  // the rim rows (moon jellies flare in lobes, not a clean circle).
  const segments = 16
  const outer = [
    { y: 0.54, radius: 0.03 },
    { y: 0.5, radius: 0.2 },
    { y: 0.4, radius: 0.36 },
    { y: 0.24, radius: 0.46 },
    { y: 0.06, radius: 0.5 },
    { y: -0.06, radius: 0.46 },
  ]
  const inner = [
    { y: -0.03, radius: 0.4 },
    { y: 0.08, radius: 0.28 },
    { y: 0.13, radius: 0.12 },
  ]
  const rows: number[][] = []
  const ringAt = (profile: { y: number; radius: number }, scallop: number) => {
    const row: number[] = []
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      const lobe = 1 + scallop * Math.cos(angle * 8)
      row.push(
        writer.vertex(
          Math.cos(angle) * profile.radius * lobe,
          profile.y + scallop * 0.5 * Math.sin(angle * 8) * profile.radius,
          Math.sin(angle) * profile.radius * lobe,
          0.45 + profile.radius,
        ),
      )
    }
    return row
  }
  for (let p = 0; p < outer.length; p++) {
    rows.push(ringAt(outer[p], p >= 4 ? 0.045 : 0))
  }
  for (const profile of inner) rows.push(ringAt(profile, 0.045))
  for (let r = 0; r < rows.length - 1; r++) {
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments
      writer.quad(rows[r][i], rows[r][next], rows[r + 1][next], rows[r + 1][i])
    }
  }
  // Trailing tentacle fringe: twelve fine strands hanging off the rim
  // underside, kinked mid-way so the billow lag reads as drift, plus four
  // ruffled oral arms falling from the manubrium at the bell's core.
  for (let strand = 0; strand < 12; strand++) {
    const angle = ((strand + 0.5) / 12) * Math.PI * 2
    const x = Math.cos(angle) * 0.41
    const z = Math.sin(angle) * 0.41
    const sideX = -Math.sin(angle) * 0.012
    const sideZ = Math.cos(angle) * 0.012
    const kinkX = Math.cos(angle + 0.35) * 0.05
    const kinkZ = Math.sin(angle + 0.35) * 0.05
    const top = [
      writer.vertex(x - sideX, -0.04, z - sideZ, 0.35),
      writer.vertex(x + sideX, -0.04, z + sideZ, 0.35),
    ]
    const mid = [
      writer.vertex(x - sideX * 0.7 + kinkX, -0.62, z - sideZ * 0.7 + kinkZ, 0.7),
      writer.vertex(x + sideX * 0.7 + kinkX, -0.62, z + sideZ * 0.7 + kinkZ, 0.7),
    ]
    const bottom = [
      writer.vertex(x - sideX * 0.3 - kinkX * 0.6, -1.18, z - sideZ * 0.3 - kinkZ * 0.6, 1),
      writer.vertex(x + sideX * 0.3 - kinkX * 0.6, -1.18, z + sideZ * 0.3 - kinkZ * 0.6, 1),
    ]
    writer.quad(top[0], top[1], mid[1], mid[0])
    writer.quad(mid[0], mid[1], bottom[1], bottom[0])
  }
  for (let arm = 0; arm < 4; arm++) {
    const angle = (arm / 4) * Math.PI * 2 + Math.PI / 4
    const dirX = Math.cos(angle)
    const dirZ = Math.sin(angle)
    const sideX = -dirZ
    const sideZ = dirX
    // Each arm: a ribbon of 4 rows whose edges ruffle outward as it falls.
    const armRows: number[][] = []
    const drops = [0.1, -0.28, -0.62, -0.92]
    const reach = [0.05, 0.13, 0.17, 0.1]
    const ruffle = [0.03, 0.075, 0.1, 0.06]
    for (let row = 0; row < 4; row++) {
      const cx = dirX * reach[row]
      const cz = dirZ * reach[row]
      const wobble = row % 2 === 0 ? 1 : -1
      armRows.push([
        writer.vertex(
          cx - sideX * ruffle[row] + dirX * 0.02 * wobble,
          drops[row],
          cz - sideZ * ruffle[row] + dirZ * 0.02 * wobble,
          0.35 + row * 0.2,
        ),
        writer.vertex(
          cx + sideX * ruffle[row] - dirX * 0.02 * wobble,
          drops[row] + 0.03,
          cz + sideZ * ruffle[row] - dirZ * 0.02 * wobble,
          0.35 + row * 0.2,
        ),
      ])
    }
    for (let row = 0; row < 3; row++) {
      writer.quad(armRows[row][0], armRows[row][1], armRows[row + 1][1], armRows[row + 1][0])
    }
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
    // Bony ring segmentation: a seahorse is plated, not smooth — ~13 ridge
    // rings ripple the radius profile, fading out where the tail thins to a
    // needle so the curl stays clean.
    const plate = 1 + 0.055 * Math.sin(t * Math.PI * 26) * Math.min(1, radiusAt(t) / 0.06)
    const radius = radiusAt(t) * plate
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
  // Body: two extra rings smooth the melon→shoulder swell and the caudal
  // taper; the ventral rings drop slightly (throat pouch) so the silhouette
  // reads humpback rather than torpedo.
  writer.ringBody(
    [
      { z: 6.8, rx: 0.18, ry: 0.2, morph: 0 },
      { z: 5.9, rx: 0.95, ry: 0.85, morph: 0 },
      { z: 4.6, rx: 1.5, ry: 1.32, morph: 0.02 },
      { z: 2.8, rx: 1.75, ry: 1.48, morph: 0.06 },
      { z: 0.8, rx: 1.72, ry: 1.4, morph: 0.14 },
      { z: -0.8, rx: 1.62, ry: 1.28, morph: 0.24 },
      { z: -2.8, rx: 1.18, ry: 0.98, morph: 0.46 },
      { z: -4.5, rx: 0.72, ry: 0.62, morph: 0.72 },
      { z: -6.25, rx: 0.24, ry: 0.25, morph: 1 },
    ],
    18,
  )
  // Throat pouch: a soft ventral swell under the jaw (the pleated chin).
  writer.ellipsoid([0, -0.95, 3.9], [1.15, 0.75, 2.2], 12, 6, () => 0.03)
  // Long humpback pectorals: real thickness, swept back and down, with a
  // knobbed leading edge — one third of the body, the humpback signature.
  // The flap channel rises toward the tip so the swim wave rolls them.
  for (const side of [-1, 1]) {
    const fin = new SphereGeometry(1, 12, 7)
    fin.scale(2.35, 0.14, 0.6)
    fin.rotateY(side * 0.55)
    fin.rotateZ(side * -0.22)
    fin.translate(side * 3.0, -0.85, 0.9)
    writer.appendGeometry(fin, (p) => side * Math.min(0.6, Math.max(0, (Math.abs(p.x) - 1.4) / 5)))
    fin.dispose()
    const knuckles = new SphereGeometry(1, 8, 5)
    knuckles.scale(0.9, 0.11, 0.24)
    knuckles.rotateY(side * 0.55)
    knuckles.rotateZ(side * -0.22)
    knuckles.translate(side * 4.35, -1.12, 1.32)
    writer.appendGeometry(knuckles, (p) => side * Math.min(0.6, Math.max(0, (Math.abs(p.x) - 1.4) / 5)))
    knuckles.dispose()
  }
  // Stubby dorsal fin on its hump.
  const dorsal = new SphereGeometry(1, 9, 6)
  dorsal.scale(0.14, 0.5, 0.85)
  dorsal.rotateX(-0.35)
  dorsal.translate(0, 1.12, -2.6)
  writer.appendGeometry(dorsal, () => 0.4)
  dorsal.dispose()
  // Flukes: two broad thick lobes sweeping back from the peduncle; their
  // overlap at the root forms the trailing notch. Full tail-beat weight.
  for (const side of [-1, 1]) {
    const fluke = new SphereGeometry(1, 12, 6)
    fluke.scale(1.95, 0.11, 0.78)
    fluke.rotateY(side * 0.4)
    fluke.translate(side * 1.7, 0.06, -6.95)
    writer.appendGeometry(fluke, () => 1)
    fluke.dispose()
  }
  return writer.compile()
}

export function geometryMetrics(geometry: BufferGeometry): GeometryMetrics {
  const vertices = geometry.getAttribute('position').count
  const triangles = geometry.getIndex()?.count ? geometry.getIndex()!.count / 3 : vertices / 3
  return { vertices, triangles }
}
