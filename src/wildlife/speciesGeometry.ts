import {
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  SphereGeometry,
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

  /** Swept tube with parallel-transported frames; closed at both ends
   *  (fan cap at start, cone tip at the end) so limbs read solid. */
  tube(
    points: readonly Vector3[],
    sides: number,
    radiusAt: (t: number) => number,
    morphAt: (t: number) => number = () => 0,
    tipLength = 0.01,
  ): void {
    const count = points.length
    const tangent = new Vector3()
    const u = new Vector3()
    const v = new Vector3()
    const probe = new Vector3()
    const rings: number[][] = []
    for (let i = 0; i < count; i++) {
      tangent.subVectors(points[Math.min(count - 1, i + 1)], points[Math.max(0, i - 1)])
      if (tangent.lengthSq() < 1e-10) tangent.set(0, 1, 0)
      tangent.normalize()
      if (i === 0) {
        probe.set(0, 1, 0)
        if (Math.abs(tangent.dot(probe)) > 0.94) probe.set(1, 0, 0)
        u.crossVectors(probe, tangent).normalize()
      } else {
        u.addScaledVector(tangent, -u.dot(tangent))
        if (u.lengthSq() < 1e-8) {
          probe.set(0, 1, 0)
          if (Math.abs(tangent.dot(probe)) > 0.94) probe.set(1, 0, 0)
          u.crossVectors(probe, tangent)
        }
        u.normalize()
      }
      v.crossVectors(u, tangent)
      const t = count === 1 ? 0 : i / (count - 1)
      const radius = radiusAt(t)
      const morph = morphAt(t)
      const ring: number[] = []
      for (let s = 0; s < sides; s++) {
        const angle = (s / sides) * Math.PI * 2
        const cosA = Math.cos(angle)
        const sinA = Math.sin(angle)
        ring.push(
          this.vertex(
            points[i].x + (u.x * cosA + v.x * sinA) * radius,
            points[i].y + (u.y * cosA + v.y * sinA) * radius,
            points[i].z + (u.z * cosA + v.z * sinA) * radius,
            morph,
          ),
        )
      }
      rings.push(ring)
    }
    for (let i = 0; i < count - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const next = (s + 1) % sides
        this.quad(rings[i][s], rings[i + 1][s], rings[i + 1][next], rings[i][next])
      }
    }
    const startCap = this.vertex(points[0].x, points[0].y, points[0].z, morphAt(0))
    for (let s = 0; s < sides; s++) {
      const next = (s + 1) % sides
      this.triangle(startCap, rings[0][s], rings[0][next])
    }
    const last = points[count - 1]
    tangent.subVectors(last, points[Math.max(0, count - 2)])
    if (tangent.lengthSq() < 1e-10) tangent.set(0, 1, 0)
    tangent.normalize()
    const tip = this.vertex(
      last.x + tangent.x * tipLength,
      last.y + tangent.y * tipLength,
      last.z + tangent.z * tipLength,
      morphAt(1),
    )
    const lastRing = rings[count - 1]
    for (let s = 0; s < sides; s++) {
      const next = (s + 1) % sides
      this.triangle(tip, lastRing[next], lastRing[s])
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

/**
 * Garden eel: a slender S-curved column rising from the sand, head bead at
 * the top. morphWeight = height fraction — the material sways the column
 * and, via cameraPosition, sinks the whole colony shyly into the sand when
 * a guest walks close.
 */
export function createGardenEelGeometry(): BufferGeometry {
  const writer = new WildlifeMeshWriter()
  const points: Vector3[] = []
  const SAMPLES = 6
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES
    points.push(
      new Vector3(
        Math.sin(t * Math.PI * 1.7) * 0.035 * t,
        t * 0.52,
        Math.sin(t * Math.PI * 1.2 + 0.8) * 0.03 * t,
      ),
    )
  }
  writer.tube(points, 5, (t) => 0.017 - t * 0.005, (t) => t, 0.004)
  // Head bead + snout nub lean into the current.
  writer.ellipsoid([points[SAMPLES].x, 0.53, points[SAMPLES].z], [0.019, 0.024, 0.021], 6, 4, () => 1)
  writer.ellipsoid([points[SAMPLES].x, 0.535, points[SAMPLES].z + 0.02], [0.009, 0.009, 0.014], 4, 3, () => 1)
  return writer.compile()
}

/** Scallop hinge line in geometry space (the material rotates the upper
 *  valve about this local X-axis for the gape/snap cycle). */
export const SCALLOP_HINGE = { y: 0.012, z: -0.085 }

/**
 * Snapping scallop: two ribbed valves with REAL thickness (outer shell,
 * pale inner nacre sheet, closed rim) meeting at a back hinge. morphWeight
 * is 1 on every upper-valve vertex and 0 on the lower — the material's
 * hinge rotation needs no falloff because hinge-line vertices have zero
 * lever arm by construction.
 */
export function createScallopGeometry(): BufferGeometry {
  const writer = new WildlifeMeshWriter()
  const COLUMNS = 9
  const ROWS = [0, 0.42, 0.75, 1]
  const buildValve = (upper: boolean): void => {
    const morph = upper ? 1 : 0
    const sign = upper ? 1 : -1
    const outer: number[][] = []
    const inner: number[][] = []
    for (let r = 0; r < ROWS.length; r++) {
      const f = ROWS[r]
      const outerRow: number[] = []
      const innerRow: number[] = []
      for (let c = 0; c <= COLUMNS; c++) {
        const spread = ((c / COLUMNS) * 2 - 1) * 1.35 // fan angle ±77°
        const rib = 1 + 0.05 * Math.cos(spread * 6.5)
        const reach = 0.105 * rib * f
        const x = Math.sin(spread) * reach
        const z = SCALLOP_HINGE.z + Math.cos(spread) * reach
        // Dome peaks mid-fan and RETURNS to hinge level at the growing
        // edge, so the two rims all but meet when the shell rests closed.
        const dome = sign * (0.008 + 0.042 * Math.sin(f * Math.PI))
        const ribHeight = sign * 0.0055 * Math.cos(spread * 6.5) * f
        const y = SCALLOP_HINGE.y + dome + ribHeight
        outerRow.push(writer.vertex(x, y, z, morph))
        innerRow.push(writer.vertex(x * 0.94, y - sign * 0.0045, SCALLOP_HINGE.z + (z - SCALLOP_HINGE.z) * 0.94, morph))
      }
      outer.push(outerRow)
      inner.push(innerRow)
    }
    for (let r = 0; r < ROWS.length - 1; r++) {
      for (let c = 0; c < COLUMNS; c++) {
        if (upper) {
          writer.quad(outer[r][c], outer[r + 1][c], outer[r + 1][c + 1], outer[r][c + 1])
          writer.quad(inner[r][c], inner[r][c + 1], inner[r + 1][c + 1], inner[r + 1][c])
        } else {
          writer.quad(outer[r][c], outer[r][c + 1], outer[r + 1][c + 1], outer[r + 1][c])
          writer.quad(inner[r][c], inner[r + 1][c], inner[r + 1][c + 1], inner[r][c + 1])
        }
      }
    }
    // Rim wall between the sheets along the growing edge and the two
    // straight sides back to the hinge — the valve is a closed solid.
    const last = ROWS.length - 1
    for (let c = 0; c < COLUMNS; c++) {
      if (upper) writer.quad(outer[last][c], inner[last][c], inner[last][c + 1], outer[last][c + 1])
      else writer.quad(outer[last][c], outer[last][c + 1], inner[last][c + 1], inner[last][c])
    }
    for (const edge of [0, COLUMNS]) {
      for (let r = 0; r < ROWS.length - 1; r++) {
        if ((edge === 0) === upper) {
          writer.quad(outer[r][edge], outer[r + 1][edge], inner[r + 1][edge], inner[r][edge])
        } else {
          writer.quad(outer[r][edge], inner[r][edge], inner[r + 1][edge], outer[r + 1][edge])
        }
      }
    }
  }
  buildValve(false)
  buildValve(true)
  // Hinge knuckle bridges the valves at the back.
  writer.ellipsoid([0, SCALLOP_HINGE.y, SCALLOP_HINGE.z - 0.004], [0.052, 0.016, 0.02], 6, 3, () => 0)
  return writer.compile()
}

export function geometryMetrics(geometry: BufferGeometry): GeometryMetrics {
  const vertices = geometry.getAttribute('position').count
  const triangles = geometry.getIndex()?.count ? geometry.getIndex()!.count / 3 : vertices / 3
  return { vertices, triangles }
}

export interface FaunaGeometryAudit {
  archetypes: Record<string, GeometryMetrics & { minY: number; maxY: number }>
  failures: string[]
}

/** Numeric self-check for `npm run audit:geometry` over the REMAINING
 *  procedural fauna (the moving animals are GLB-loaded now and audited
 *  separately by scripts/audit-fauna-assets.mjs): budgets, finiteness,
 *  morph ranges, and ground contact. */
export function auditFaunaGeometry(): FaunaGeometryAudit {
  const failures: string[] = []
  const archetypes: FaunaGeometryAudit['archetypes'] = {}
  const cases: { name: string; build: () => BufferGeometry; maxTriangles: number }[] = [
    { name: 'turtle', build: () => createTurtleGeometry(), maxTriangles: 1500 },
    { name: 'jelly', build: () => createJellyGeometry(), maxTriangles: 500 },
    { name: 'sun-butterfly', build: () => createSunButterflyGeometry(), maxTriangles: 500 },
    { name: 'humpback', build: () => createWhaleGeometry(), maxTriangles: 2200 },
    { name: 'garden-eel', build: () => createGardenEelGeometry(), maxTriangles: 160 },
    { name: 'scallop', build: () => createScallopGeometry(), maxTriangles: 400 },
  ]
  for (const testCase of cases) {
    const geometry = testCase.build()
    const metrics = geometryMetrics(geometry)
    geometry.computeBoundingBox()
    const box = geometry.boundingBox!
    archetypes[testCase.name] = { ...metrics, minY: box.min.y, maxY: box.max.y }
    if (metrics.triangles === 0) failures.push(`${testCase.name}: empty geometry`)
    if (metrics.triangles > testCase.maxTriangles) {
      failures.push(`${testCase.name}: ${metrics.triangles} triangles exceeds budget ${testCase.maxTriangles}`)
    }
    const position = geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      if (
        !Number.isFinite(position.getX(i)) ||
        !Number.isFinite(position.getY(i)) ||
        !Number.isFinite(position.getZ(i))
      ) {
        failures.push(`${testCase.name}: non-finite vertex ${i}`)
        break
      }
    }
    const morph = geometry.getAttribute('morphWeight')
    for (let i = 0; i < morph.count; i++) {
      const value = morph.getX(i)
      if (value < -1.001 || value > 1.001) {
        failures.push(`${testCase.name}: morphWeight ${value.toFixed(3)} out of range at ${i}`)
        break
      }
    }
    geometry.dispose()
  }
  // Eels rise straight from the ground plane.
  const eel = createGardenEelGeometry()
  eel.computeBoundingBox()
  if (eel.boundingBox!.min.y < -0.03 || eel.boundingBox!.max.y < 0.4) {
    failures.push(
      `garden-eel: column spans y ${eel.boundingBox!.min.y.toFixed(3)}..${eel.boundingBox!.max.y.toFixed(3)}`,
    )
  }
  eel.dispose()
  return { archetypes, failures }
}
