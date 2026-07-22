import { BufferAttribute, BufferGeometry, Vector2, Vector3 } from 'three'
import { fbm2 as fbmCpu } from '../core/noise2.ts'
import type { Rng } from '../core/prng.ts'

/**
 * Sculpted flora & reef mesh builders (leaf module — only three + core
 * leaves, so `npm run audit:geometry` can build and measure every archetype
 * offline). All meshes are authored through one writer with four channels:
 *
 *   position    — the sculpt itself
 *   animWeight  — 0..1 sway/animation weight (0 = rooted/rigid)
 *   animPhase   — per-part phase so fronds/tentacles/spines desynchronize
 *   tint        — an authored color field (species-specific semantic:
 *                 ridge/valley, branch order, strata band, blade tone…)
 *
 * Doctrine (standing rulings): organic shapes carry real thickness — no
 * flat cards, no half-primitives, no open lathe ribbons; hollow mouths are
 * closed clockwise loops; displacement recomputes normals; determinism
 * comes from the rng argument alone.
 */

export interface FloraGeometryMetrics {
  vertices: number
  triangles: number
  min: [number, number, number]
  max: [number, number, number]
}

interface TubeOptions {
  sides: number
  radiusAt: (t: number) => number
  weightAt?: (t: number) => number
  phase?: number
  tintAt?: (t: number) => number
  capStart?: boolean
  /** Cone tip pulled this far past the last ring (0 = open end). */
  tipLength?: number
}

class FloraMeshWriter {
  private readonly positions: number[] = []
  private readonly weights: number[] = []
  private readonly phases: number[] = []
  private readonly tints: number[] = []
  private readonly indices: number[] = []

  vertex(x: number, y: number, z: number, weight = 0, phase = 0, tint = 0.5): number {
    const index = this.positions.length / 3
    this.positions.push(x, y, z)
    this.weights.push(weight)
    this.phases.push(phase)
    this.tints.push(tint)
    return index
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c)
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d)
  }

  /**
   * Swept tube along a polyline with parallel-transported frames.
   * Ring quads face outward; optional fan cap at the start and cone tip at
   * the end keep every tube a closed solid.
   */
  tube(points: readonly Vector3[], options: TubeOptions): void {
    const { sides } = options
    const count = points.length
    const tangent = new Vector3()
    const u = new Vector3()
    const v = new Vector3()
    const probe = new Vector3()
    const rings: number[][] = []

    for (let i = 0; i < count; i++) {
      const previous = points[Math.max(0, i - 1)]
      const next = points[Math.min(count - 1, i + 1)]
      tangent.subVectors(next, previous)
      if (tangent.lengthSq() < 1e-10) tangent.set(0, 1, 0)
      tangent.normalize()
      if (i === 0) {
        probe.set(0, 1, 0)
        if (Math.abs(tangent.dot(probe)) > 0.94) probe.set(1, 0, 0)
        u.crossVectors(probe, tangent).normalize()
      } else {
        // Parallel transport: remove the new tangent component, renormalize.
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
      const radius = options.radiusAt(t)
      const weight = options.weightAt ? options.weightAt(t) : 0
      const tint = options.tintAt ? options.tintAt(t) : 0.5
      const ring: number[] = []
      for (let s = 0; s < sides; s++) {
        const angle = (s / sides) * Math.PI * 2
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        ring.push(
          this.vertex(
            points[i].x + (u.x * cos + v.x * sin) * radius,
            points[i].y + (u.y * cos + v.y * sin) * radius,
            points[i].z + (u.z * cos + v.z * sin) * radius,
            weight,
            options.phase ?? 0,
            tint,
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

    if (options.capStart) {
      const start = points[0]
      const cap = this.vertex(
        start.x, start.y, start.z,
        options.weightAt ? options.weightAt(0) : 0,
        options.phase ?? 0,
        options.tintAt ? options.tintAt(0) : 0.5,
      )
      for (let s = 0; s < sides; s++) {
        const next = (s + 1) % sides
        this.triangle(cap, rings[0][s], rings[0][next])
      }
    }
    if (options.tipLength !== undefined && options.tipLength >= 0) {
      const last = points[count - 1]
      const beforeLast = points[Math.max(0, count - 2)]
      tangent.subVectors(last, beforeLast)
      if (tangent.lengthSq() < 1e-10) tangent.set(0, 1, 0)
      tangent.normalize()
      const tip = this.vertex(
        last.x + tangent.x * options.tipLength,
        last.y + tangent.y * options.tipLength,
        last.z + tangent.z * options.tipLength,
        options.weightAt ? options.weightAt(1) : 0,
        options.phase ?? 0,
        options.tintAt ? options.tintAt(1) : 0.5,
      )
      const ring = rings[count - 1]
      for (let s = 0; s < sides; s++) {
        const next = (s + 1) % sides
        this.triangle(tip, ring[next], ring[s])
      }
    }
  }

  /** Axis-aligned ellipsoid (small knobs, bladders, bumps). */
  ellipsoid(
    center: readonly [number, number, number],
    radii: readonly [number, number, number],
    segments = 8,
    rings = 5,
    weight = 0,
    phase = 0,
    tint = 0.5,
  ): void {
    const rows: number[][] = []
    for (let j = 0; j <= rings; j++) {
      const phi = (j / rings) * Math.PI
      const row: number[] = []
      for (let i = 0; i < segments; i++) {
        const theta = (i / segments) * Math.PI * 2
        row.push(
          this.vertex(
            center[0] + Math.sin(phi) * Math.cos(theta) * radii[0],
            center[1] + Math.cos(phi) * radii[1],
            center[2] + Math.sin(phi) * Math.sin(theta) * radii[2],
            weight,
            phase,
            tint,
          ),
        )
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

  /**
   * Solid of revolution around +Y. Ascending-y profile segments face
   * outward (the standing lathe-winding rule); callers close their loops.
   */
  lathe(
    profile: readonly Vector2[],
    segments: number,
    options?: {
      weightAt?: (index: number, point: Vector2) => number
      tintAt?: (index: number, point: Vector2) => number
      phase?: number
      radialJitter?: (angleIndex: number, index: number) => number
    },
  ): void {
    const rows: number[][] = []
    for (let j = 0; j < profile.length; j++) {
      const point = profile[j]
      const weight = options?.weightAt ? options.weightAt(j, point) : 0
      const tint = options?.tintAt ? options.tintAt(j, point) : 0.5
      const row: number[] = []
      for (let s = 0; s < segments; s++) {
        const angle = (s / segments) * Math.PI * 2
        const jitter = options?.radialJitter ? options.radialJitter(s, j) : 0
        const radius = Math.max(0, point.x + jitter)
        row.push(
          this.vertex(
            Math.cos(angle) * radius,
            point.y,
            Math.sin(angle) * radius,
            weight,
            options?.phase ?? 0,
            tint,
          ),
        )
      }
      rows.push(row)
    }
    for (let j = 0; j < profile.length - 1; j++) {
      for (let s = 0; s < segments; s++) {
        const next = (s + 1) % segments
        this.quad(rows[j][s], rows[j + 1][s], rows[j + 1][next], rows[j][next])
      }
    }
  }

  compile(): BufferGeometry {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3))
    geometry.setAttribute('animWeight', new BufferAttribute(new Float32Array(this.weights), 1))
    geometry.setAttribute('animPhase', new BufferAttribute(new Float32Array(this.phases), 1))
    geometry.setAttribute('tint', new BufferAttribute(new Float32Array(this.tints), 1))
    geometry.setIndex(this.indices)
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  }
}

// ── Strap kelp ───────────────────────────────────────────────────────────

/**
 * Strap kelp (Laminaria-like): from a holdfast mound, a handful of LONG
 * leathery ribbon blades rise steeply, bow over, and stream sideways —
 * ruffled margins, a gas bladder at each base, no trunk and no leaves.
 * Unmistakably marine (the previous stipe-with-blades kelp read as a
 * garden sapling and was retired on Scott's call, 2026-07-22).
 * animWeight = fraction along each strap (the shader streams tips with
 * the current); tint: 0 holdfast, ~0.4→0.85 along the strap, 1 ruffled
 * edges, 0.9 bladders.
 */
export function createStrapKelpGeometry(rng: Rng): BufferGeometry {
  const writer = new FloraMeshWriter()
  writer.ellipsoid([0, 0.02, 0], [0.24, 0.11, 0.24], 8, 3, 0, 0, 0)
  const straps = rng.int(4, 6)
  for (let s = 0; s < straps; s++) {
    const yaw = (s / straps) * Math.PI * 2 + rng.range(-0.5, 0.5)
    const out = new Vector3(Math.cos(yaw), 0, Math.sin(yaw))
    const side = new Vector3(-out.z, 0, out.x)
    const length = rng.range(6.2, 8.8)
    const fullWidth = rng.range(0.3, 0.48)
    const phase = rng.range(0, Math.PI * 2)
    const ruffleSeed = rng.range(0, Math.PI * 2)
    const lateralSeed = rng.range(0, Math.PI * 2)
    const lateralAmp = rng.range(0.15, 0.55)
    const ROWS = 9
    const rows: number[][] = []
    for (let r = 0; r <= ROWS; r++) {
      const t = r / ROWS
      // Rise steeply, bow over, stream outward — the strap-kelp arc.
      const horizontal = length * (0.12 * t + 0.5 * t * t)
      const vertical = length * (0.8 * t - 0.42 * t * t)
      const lateral = Math.sin(t * Math.PI * 1.3 + lateralSeed) * lateralAmp * t
      const cx = out.x * horizontal + side.x * lateral
      const cz = out.z * horizontal + side.z * lateral
      const width = fullWidth * (0.3 + 1.3 * t * (1 - t) + 0.18 * (1 - t))
      const ruffle = Math.sin(t * 16 + ruffleSeed) * 0.1 * fullWidth * Math.min(1, t * 3)
      const camber = 0.06 * fullWidth
      const tintMid = 0.4 + 0.45 * t
      rows.push([
        writer.vertex(
          cx - side.x * width + out.x * ruffle * 0.6,
          vertical + ruffle,
          cz - side.z * width + out.z * ruffle * 0.6,
          t, phase, Math.min(1, tintMid + 0.3),
        ),
        writer.vertex(cx, vertical + camber, cz, t, phase, tintMid),
        writer.vertex(
          cx + side.x * width - out.x * ruffle * 0.6,
          vertical - ruffle,
          cz + side.z * width - out.z * ruffle * 0.6,
          t, phase, Math.min(1, tintMid + 0.3),
        ),
      ])
    }
    for (let r = 0; r < ROWS; r++) {
      writer.quad(rows[r][0], rows[r][1], rows[r + 1][1], rows[r + 1][0])
      writer.quad(rows[r][1], rows[r][2], rows[r + 1][2], rows[r + 1][1])
    }
    // Pneumatocyst at the strap base.
    const bulbT = 0.09
    const bulbX = out.x * length * (0.12 * bulbT + 0.5 * bulbT * bulbT)
    const bulbY = length * (0.8 * bulbT - 0.42 * bulbT * bulbT)
    writer.ellipsoid(
      [bulbX, bulbY + 0.05, out.z * length * (0.12 * bulbT + 0.5 * bulbT * bulbT)],
      [0.055, 0.08, 0.055],
      5, 3, 0.12, phase, 0.9,
    )
  }
  return writer.compile()
}

// ── Algae turf ───────────────────────────────────────────────────────────

export type AlgaeKind = 'rockweed' | 'codium' | 'plume'

/**
 * Low domed algae clumps — the coastal turf from Scott's references,
 * replacing the retired lawn-grass seagrass (it read terrestrial):
 *
 * 'rockweed' — broad leathery Fucus fronds, serrated lobed edges, many
 *              forked, splayed into a golden-olive dome.
 * 'codium'   — a bush of green tubular fingers leaning apart, some
 *              Y-forked, spaghetti-like.
 * 'plume'    — feathery red/purple arcs with notched margins.
 *
 * animWeight rises along each frond/finger (gentle leathery rock, not
 * grass whip); animPhase separates them; tint is the per-frond tone the
 * palettes ride.
 */
export function createAlgaeTuftGeometry(rng: Rng, kind: AlgaeKind): BufferGeometry {
  const writer = new FloraMeshWriter()

  const ribbon = (
    yaw: number,
    lean: number,
    _length: number,
    halfWidth: number,
    rows: number,
    tone: number,
    phase: number,
    serration: number,
    riseShape: (t: number) => { reach: number; rise: number },
    baseX = 0,
    baseZ = 0,
    baseY = 0,
    weightBase = 0.15,
  ): { x: number; y: number; z: number; endYaw: number } => {
    const out = new Vector2(Math.cos(yaw), Math.sin(yaw))
    const side = new Vector2(-out.y, out.x)
    const seed = rng.range(0, Math.PI * 2)
    const built: number[][] = []
    let tipX = baseX
    let tipZ = baseZ
    let tipY = baseY
    for (let r = 0; r <= rows; r++) {
      const t = r / rows
      const { reach, rise } = riseShape(t)
      const x = baseX + out.x * reach * Math.sin(lean)
      const z = baseZ + out.y * reach * Math.sin(lean)
      const y = baseY + rise * Math.cos(lean * 0.55)
      tipX = x
      tipZ = z
      tipY = y
      const lobe = Math.sin(t * 6 + seed) * halfWidth * 0.3
      const teeth = Math.sin(t * 24 + seed * 2) * halfWidth * serration
      const width = halfWidth * (0.4 + 1.5 * t * (1 - t) + 0.2 * (1 - t)) + lobe
      const camber = halfWidth * 0.35
      const weight = Math.min(1, weightBase + t * (1 - weightBase))
      built.push([
        writer.vertex(x - side.x * width - out.x * teeth, y + teeth * 0.6, z - side.y * width - out.y * teeth, weight, phase, tone),
        writer.vertex(x, y + camber, z, weight, phase, Math.min(1, tone + 0.12)),
        writer.vertex(x + side.x * width + out.x * teeth, y - teeth * 0.6, z + side.y * width + out.y * teeth, weight, phase, tone),
      ])
    }
    for (let r = 0; r < rows; r++) {
      writer.quad(built[r][0], built[r][1], built[r + 1][1], built[r + 1][0])
      writer.quad(built[r][1], built[r][2], built[r + 1][2], built[r + 1][1])
    }
    return { x: tipX, y: tipY, z: tipZ, endYaw: yaw }
  }

  if (kind === 'rockweed') {
    const fronds = rng.int(9, 12)
    for (let f = 0; f < fronds; f++) {
      const yaw = (f / fronds) * Math.PI * 2 + rng.range(-0.4, 0.4)
      const lean = rng.range(0.5, 1.2)
      const length = rng.range(0.24, 0.42)
      const tone = rng.range(0.25, 1)
      const phase = rng.range(0, Math.PI * 2)
      const tip = ribbon(
        yaw, lean, length, rng.range(0.05, 0.075), 4, tone, phase, 0.22,
        (t) => ({ reach: length * t * (1 + 0.35 * t), rise: length * t * (1 - 0.34 * t * t) }),
      )
      // Dichotomous fork: two short diverging tip blades (the Fucus
      // signature) on most fronds.
      if (rng.next() < 0.6) {
        for (const branch of [-1, 1]) {
          ribbon(
            yaw + branch * rng.range(0.25, 0.5), lean + 0.25,
            length * 0.5, 0.04, 2, Math.min(1, tone + 0.15), phase, 0.26,
            (t) => ({ reach: length * 0.5 * t * 1.2, rise: length * 0.5 * t * 0.5 }),
            tip.x, tip.z, tip.y, 0.6,
          )
        }
      }
    }
  } else if (kind === 'codium') {
    const fingers = rng.int(12, 15)
    for (let f = 0; f < fingers; f++) {
      const yaw = (f / fingers) * Math.PI * 2 + rng.range(-0.5, 0.5)
      const out = new Vector2(Math.cos(yaw), Math.sin(yaw))
      const lean = rng.range(0.15, 1.25)
      const length = rng.range(0.15, 0.3)
      const tone = rng.range(0.3, 0.75)
      const phase = rng.range(0, Math.PI * 2)
      const baseR = rng.range(0.015, 0.055)
      const droop = rng.range(0.2, 0.6)
      const points: Vector3[] = []
      for (let i = 0; i <= 2; i++) {
        const t = i / 2
        const reach = Math.sin(lean) * length * t * (1 + droop * t)
        points.push(
          new Vector3(
            out.x * (baseR + reach),
            0.02 + Math.cos(lean * 0.7) * length * t * (1 - droop * 0.55 * t * t),
            out.y * (baseR + reach),
          ),
        )
      }
      writer.tube(points, {
        sides: 3,
        radiusAt: (t) => 0.021 - t * 0.005,
        weightAt: (t) => 0.1 + t * 0.7,
        tintAt: (t) => Math.min(1, tone + t * 0.35),
        phase,
        capStart: true,
        tipLength: 0.018,
      })
      // Y-fork on some fingers.
      if (rng.next() < 0.4) {
        const mid = points[1]
        const forkYaw = yaw + rng.range(-0.7, 0.7)
        writer.tube(
          [
            mid,
            new Vector3(
              mid.x + Math.cos(forkYaw) * length * 0.4,
              mid.y + length * 0.28,
              mid.z + Math.sin(forkYaw) * length * 0.4,
            ),
          ],
          {
            sides: 3,
            radiusAt: (t) => 0.017 - t * 0.004,
            weightAt: (t) => 0.45 + t * 0.4,
            tintAt: (t) => Math.min(1, tone + 0.2 + t * 0.2),
            phase,
            tipLength: 0.016,
          },
        )
      }
    }
  } else {
    const plumes = rng.int(6, 8)
    for (let p = 0; p < plumes; p++) {
      const yaw = (p / plumes) * Math.PI * 2 + rng.range(-0.5, 0.5)
      const lean = rng.range(0.3, 0.9)
      const length = rng.range(0.2, 0.36)
      const tone = rng.range(0.25, 1)
      const phase = rng.range(0, Math.PI * 2)
      // Fern-arc: rises then nods over; heavy serration = feathery read.
      ribbon(
        yaw, lean, length, rng.range(0.028, 0.042), 5, tone, phase, 0.55,
        (t) => ({ reach: length * (0.25 * t + 0.75 * t * t), rise: length * (1.15 * t - 0.72 * t * t) }),
      )
    }
    // A soft mossy heart where the plumes meet.
    writer.ellipsoid([0, 0.035, 0], [0.055, 0.045, 0.055], 6, 3, 0.1, 0, 0.2)
  }
  return writer.compile()
}

// ── Reef corals ──────────────────────────────────────────────────────────

/**
 * Brain coral: a sand-seated dome carved by genuine meander ridges —
 * contour bands of one warped field displace along the normal, and the
 * SAME field is baked into tint (1 = ridge crest, 0 = valley floor) so the
 * material's light/dark follows the exact carved cause.
 */
export function createBrainCoralGeometry(rng: Rng): BufferGeometry {
  const writer = new FloraMeshWriter()
  const seedA = rng.range(0, 100)
  const seedB = rng.range(0, 100)
  const SEGMENTS = 24
  const RINGS = 13
  const rows: number[][] = []
  for (let j = 0; j <= RINGS; j++) {
    // Dome sweep: pole to 0.66π (past the equator), then a buried skirt.
    const phi = (j / RINGS) * Math.PI * 0.66
    const row: number[] = []
    for (let i = 0; i < SEGMENTS; i++) {
      const theta = (i / SEGMENTS) * Math.PI * 2
      const nx = Math.sin(phi) * Math.cos(theta)
      const ny = Math.cos(phi)
      const nz = Math.sin(phi) * Math.sin(theta)
      // Warped meander field, world-continuous (no polar seam): the warp is
      // strong enough that contour bands wander like real meanders.
      const warp = fbmCpu(nx * 1.6 + seedA, nz * 1.6 + ny * 1.1 - seedA, 3, 17) * 2.6
      const field = fbmCpu(nx * 2.1 + warp + seedB, nz * 2.1 + ny * 1.3 + warp * 0.7 - seedB, 3, 29)
      const ridge = Math.pow(0.5 + 0.5 * Math.cos(field * 19.0), 0.7)
      const lump = (fbmCpu(nx * 0.9 + seedB, nz * 0.9 + seedA, 3, 41) - 0.5) * 0.16
      const radius = 1 + lump + (ridge - 0.42) * 0.085
      row.push(
        writer.vertex(nx * radius, ny * radius * 0.66, nz * radius, 0, 0, ridge),
      )
    }
    rows.push(row)
  }
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < SEGMENTS; i++) {
      const next = (i + 1) % SEGMENTS
      writer.quad(rows[j][i], rows[j][next], rows[j + 1][next], rows[j + 1][i])
    }
  }
  // Buried base ring → center fan closes the solid under the sand line.
  const bottomY = Math.cos(Math.PI * 0.66) * 0.66 - 0.08
  const center = writer.vertex(0, bottomY, 0, 0, 0, 0.4)
  const lastRow = rows[RINGS]
  for (let i = 0; i < SEGMENTS; i++) {
    const next = (i + 1) % SEGMENTS
    writer.triangle(center, lastRow[i], lastRow[next])
  }
  return writer.compile()
}

/**
 * Staghorn colony: queue-grown antler branches (the vegetation-skill growth
 * model, not scattered cylinders) — trunks fork with upward tropism into
 * knob-tipped twigs. tint = branch order (0 base → 1 axial tips).
 */
export function createStaghornColonyGeometry(rng: Rng): BufferGeometry {
  const writer = new FloraMeshWriter()
  interface BranchJob {
    origin: Vector3
    direction: Vector3
    length: number
    radius: number
    order: number
  }
  const up = new Vector3(0, 1, 0)
  const queue: BranchJob[] = []
  const trunks = rng.int(3, 4)
  for (let i = 0; i < trunks; i++) {
    const yaw = (i / trunks) * Math.PI * 2 + rng.range(-0.5, 0.5)
    const tilt = rng.range(0.2, 0.55)
    queue.push({
      origin: new Vector3(Math.cos(yaw) * 0.12, 0, Math.sin(yaw) * 0.12),
      direction: new Vector3(
        Math.sin(tilt) * Math.cos(yaw), Math.cos(tilt), Math.sin(tilt) * Math.sin(yaw),
      ).normalize(),
      length: rng.range(0.5, 0.68),
      radius: rng.range(0.05, 0.062),
      order: 0,
    })
  }

  const scratch = new Vector3()
  let emitted = 0
  while (queue.length > 0 && emitted < 46) {
    const job = queue.shift()!
    emitted++
    // Bowed segment: three points, mid pushed along a jittered normal.
    const end = job.origin.clone().addScaledVector(job.direction, job.length)
    const bow = scratch
      .set(rng.range(-1, 1), rng.range(-0.3, 0.7), rng.range(-1, 1))
      .normalize()
      .multiplyScalar(job.length * rng.range(0.04, 0.1))
    const mid = job.origin.clone().addScaledVector(job.direction, job.length * 0.5).add(bow)
    const terminal = job.order >= 2
    const tint = job.order / 2
    writer.tube([job.origin, mid, end], {
      sides: job.order === 0 ? 5 : 4,
      radiusAt: (t) => job.radius * (1 - t * 0.38) * (terminal && t > 0.8 ? 1.35 : 1),
      tintAt: (t) => Math.min(1, tint + (terminal ? t * 0.5 : 0)),
      capStart: job.order === 0,
      tipLength: terminal ? job.radius * 1.6 : 0.01,
    })
    if (terminal) continue
    const children = job.order === 0 ? 3 : rng.int(1, 2)
    for (let c = 0; c < children; c++) {
      const t = c === 0 ? 1 : rng.range(0.55, 0.9)
      const at = job.origin.clone().addScaledVector(job.direction, job.length * t)
      const spreadYaw = rng.range(0, Math.PI * 2)
      const spread = rng.range(0.4, 0.85)
      const direction = job.direction
        .clone()
        .applyAxisAngle(
          new Vector3(Math.cos(spreadYaw), 0, Math.sin(spreadYaw)).cross(job.direction).normalize(),
          spread,
        )
        .add(up.clone().multiplyScalar(0.34))
        .normalize()
      queue.push({
        origin: at,
        direction,
        length: job.length * rng.range(0.62, 0.78),
        radius: job.radius * 0.62,
        order: job.order + 1,
      })
    }
  }
  return writer.compile()
}

/**
 * Table coral: a broad wavy-rimmed plate with true thickness (top sheet,
 * underside sheet, rim wall) on a flared trunk with buttress roots.
 * tint = radial fraction (0 core → 1 growing rim).
 */
export function createTableCoralGeometry(rng: Rng): BufferGeometry {
  const writer = new FloraMeshWriter()
  const SPOKES = 20
  const RINGS = 5
  const seed = rng.range(0, Math.PI * 2)
  const seed2 = rng.range(0, Math.PI * 2)
  const plateY = 0.52
  const thickness = 0.055
  const rimAt = (theta: number): number =>
    1 + 0.1 * Math.sin(theta * 3 + seed) + 0.06 * Math.sin(theta * 7 + seed2)

  const top: number[][] = []
  const bottom: number[][] = []
  for (let j = 0; j <= RINGS; j++) {
    const rFraction = j / RINGS
    const topRow: number[] = []
    const bottomRow: number[] = []
    for (let i = 0; i < SPOKES; i++) {
      const theta = (i / SPOKES) * Math.PI * 2
      const rim = rimAt(theta)
      const radius = rFraction * rim
      const dome = 0.07 * (1 - rFraction * rFraction)
      const ripple = 0.014 * Math.sin(rFraction * 19 + seed) * rFraction
      const droop = -0.09 * Math.pow(rFraction, 3)
      const x = Math.cos(theta) * radius
      const z = Math.sin(theta) * radius
      const y = plateY + dome + ripple + droop
      topRow.push(writer.vertex(x, y, z, 0, 0, rFraction))
      bottomRow.push(
        writer.vertex(x * 0.985, y - thickness * (0.6 + 0.4 * (1 - rFraction)), z * 0.985, 0, 0, rFraction * 0.5),
      )
    }
    top.push(topRow)
    bottom.push(bottomRow)
  }
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < SPOKES; i++) {
      const next = (i + 1) % SPOKES
      // Top faces up (outward = +y): sweep radially outward, CCW theta.
      writer.quad(top[j][i], top[j + 1][i], top[j + 1][next], top[j][next])
      // Underside faces down: reversed winding.
      writer.quad(bottom[j][i], bottom[j][next], bottom[j + 1][next], bottom[j + 1][i])
    }
  }
  for (let i = 0; i < SPOKES; i++) {
    const next = (i + 1) % SPOKES
    writer.quad(top[RINGS][i], bottom[RINGS][i], bottom[RINGS][next], top[RINGS][next])
  }

  // Trunk + three buttress ribs down to the sand.
  const trunkTop = new Vector3(0, plateY - thickness, 0)
  writer.tube([new Vector3(0, -0.06, 0), new Vector3(0.02, plateY * 0.5, 0.01), trunkTop], {
    sides: 6,
    radiusAt: (t) => 0.16 - t * 0.05,
    tintAt: () => 0.1,
    capStart: true,
    tipLength: 0.02,
  })
  for (let b = 0; b < 3; b++) {
    const yaw = (b / 3) * Math.PI * 2 + seed
    writer.tube(
      [
        new Vector3(Math.cos(yaw) * 0.3, -0.05, Math.sin(yaw) * 0.3),
        new Vector3(Math.cos(yaw) * 0.14, 0.16, Math.sin(yaw) * 0.14),
      ],
      { sides: 4, radiusAt: (t) => 0.05 - t * 0.02, tintAt: () => 0.08, capStart: true, tipLength: 0.01 },
    )
  }
  return writer.compile()
}

// ── Rocks ────────────────────────────────────────────────────────────────

/**
 * Sedimentary boulder: fbm-displaced mass with QUANTIZED bedding planes —
 * y snaps partway to strata bands, carving real ledges, and tint carries
 * the band so color follows the geology. Bottom squashed for seating.
 */
export function createBoulderGeometry(rng: Rng): BufferGeometry {
  const writer = new FloraMeshWriter()
  const seedA = rng.range(0, 100)
  const seedB = rng.range(0, 100)
  const bands = rng.range(3.2, 4.6)
  const bandStrength = rng.range(0.3, 0.5)
  const radiusY = rng.range(0.7, 0.95)
  const radiusZ = rng.range(0.78, 1.12)
  const SEGMENTS = 16
  const RINGS = 11
  const rows: number[][] = []
  for (let j = 0; j <= RINGS; j++) {
    const phi = (j / RINGS) * Math.PI
    const row: number[] = []
    for (let i = 0; i < SEGMENTS; i++) {
      const theta = (i / SEGMENTS) * Math.PI * 2
      const nx = Math.sin(phi) * Math.cos(theta)
      const ny = Math.cos(phi)
      const nz = Math.sin(phi) * Math.sin(theta)
      const bulge = 1 + (fbmCpu(nx * 1.5 + seedA, (nz + ny * 0.8) * 1.5 + seedB, 4, 7) - 0.5) * 0.52
      let x = nx * bulge
      let y = ny * radiusY * bulge
      let z = nz * radiusZ * bulge
      // Bedding planes: pull y toward the nearest stratum boundary.
      const band = Math.round(y * bands) / bands
      y += (band - y) * bandStrength
      // Flatten the buried underside.
      if (y < -radiusY * 0.62) {
        const squash = (y + radiusY * 0.62) * 0.7
        y = -radiusY * 0.62 + squash * 0.25
        x *= 1.06
        z *= 1.06
      }
      const bandIndex = Math.round(y * bands)
      const bandTone =
        0.5 + 0.3 * ((bandIndex % 2 + 2) % 2) - 0.25 * (((bandIndex + 1) % 3 + 3) % 3 === 0 ? 1 : 0)
      const speck = fbmCpu(nx * 4 + seedB, nz * 4 + seedA, 3, 13)
      row.push(writer.vertex(x, y, z, 0, 0, Math.min(1, Math.max(0, bandTone + (speck - 0.5) * 0.3))))
    }
    rows.push(row)
  }
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < SEGMENTS; i++) {
      const next = (i + 1) % SEGMENTS
      writer.quad(rows[j][i], rows[j][next], rows[j + 1][next], rows[j + 1][i])
    }
  }
  return writer.compile()
}

/** A tall strata pinnacle — landmark spires for the far reef bands. */
export function createPinnacleGeometry(rng: Rng): BufferGeometry {
  const writer = new FloraMeshWriter()
  const seed = rng.range(0, 100)
  const height = rng.range(2.6, 3.4)
  // Closed loop: buried center → base rim → shelved spire → apex point.
  const profile: Vector2[] = [new Vector2(0.001, -0.12)]
  const STEPS = 12
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS
    const shelf = 0.14 * Math.pow(0.5 + 0.5 * Math.sin(t * 19 + seed), 2.2)
    const radius = (1.05 - Math.pow(t, 0.72) * 0.95 + shelf) * rng.range(0.94, 1.06)
    profile.push(new Vector2(Math.max(0.05, radius), t * height))
  }
  profile.push(new Vector2(0.001, height + 0.16))
  writer.lathe(profile, 12, {
    tintAt: (index) => 0.35 + 0.4 * (((index % 3) + 3) % 3 === 0 ? 1 : 0) + 0.06 * index / STEPS,
    radialJitter: (angleIndex, index) =>
      index === 0 ? 0 : (fbmCpu(angleIndex * 0.9 + seed, index * 0.8 - seed, 3, 19) - 0.5) * 0.22,
  })
  return writer.compile()
}

// ── Gorgonian sea fan ────────────────────────────────────────────────────

/**
 * A sea fan grown as a real branch lattice in a near-vertical plane —
 * tapered tube segments forking outward-upward with slight out-of-plane
 * wobble and knobbed tips (the authored thickness/branching the 2026-07-11
 * ruling demanded before fans could return). animWeight rises with height
 * for the compliant sway; tint = branch order (1 = pale polyp tips).
 */
export function createSeaFanGeometry(rng: Rng): BufferGeometry {
  const writer = new FloraMeshWriter()
  const height = 1.55
  interface FanJob {
    x: number
    y: number
    z: number
    angle: number // in-plane, 0 = straight up
    length: number
    radius: number
    order: number
  }
  const queue: FanJob[] = [
    { x: 0, y: 0, z: 0, angle: rng.range(-0.12, 0.12), length: 0.42, radius: 0.042, order: 0 },
  ]
  let emitted = 0
  while (queue.length > 0 && emitted < 42) {
    const job = queue.shift()!
    emitted++
    const endX = job.x + Math.sin(job.angle) * job.length
    const endY = job.y + Math.cos(job.angle) * job.length
    const endZ = job.z + rng.range(-0.035, 0.035)
    const terminal = job.order >= 3 || endY > height * 0.92
    const tint = Math.min(1, job.order / 3)
    writer.tube(
      [
        new Vector3(job.x, job.y, job.z),
        new Vector3(
          (job.x + endX) / 2 + Math.cos(job.angle) * job.length * 0.05,
          (job.y + endY) / 2,
          (job.z + endZ) / 2,
        ),
        new Vector3(endX, endY, endZ),
      ],
      {
        sides: job.order <= 1 ? 4 : 3,
        radiusAt: (t) => job.radius * (1 - t * 0.3),
        weightAt: (t) => Math.pow((job.y + (endY - job.y) * t) / height, 1.5),
        tintAt: (t) => Math.min(1, tint + (terminal ? t * 0.4 : 0)),
        phase: rng.range(0, Math.PI * 2),
        capStart: job.order === 0,
        tipLength: terminal ? job.radius * 2.2 : 0.008,
      },
    )
    if (terminal) continue
    const children = job.order === 0 ? 3 : rng.next() < 0.85 ? 2 : 1
    for (let c = 0; c < children; c++) {
      if (job.order > 0 && rng.next() < 0.1) continue // pruned — irregularity
      const spread =
        children === 1
          ? rng.range(-0.2, 0.2)
          : (c - (children - 1) / 2) * rng.range(0.42, 0.6) + rng.range(-0.08, 0.08)
      queue.push({
        x: endX,
        y: endY,
        z: endZ,
        angle: job.angle * 0.72 + spread,
        length: job.length * rng.range(0.68, 0.8),
        radius: job.radius * 0.64,
        order: job.order + 1,
      })
    }
  }
  // Holdfast mound gripping the rock/sand.
  writer.ellipsoid([0, 0.015, 0], [0.11, 0.06, 0.11], 7, 3, 0, 0, 0)
  return writer.compile()
}

// ── Anemone ──────────────────────────────────────────────────────────────

/**
 * Sea anemone: closed column lathe (foot flare → waist → crown lip → oral
 * disc) with two whorls of genuinely tubular tentacles. Each tentacle
 * carries its own animPhase so the crown waves independently; tint: 0
 * column, 0.25 disc, 0.6→1 tentacle base→tip.
 */
export function createAnemoneGeometry(rng: Rng): BufferGeometry {
  const writer = new FloraMeshWriter()
  const crownY = rng.range(0.26, 0.34)
  const crownR = rng.range(0.26, 0.32)
  writer.lathe(
    [
      new Vector2(0.34, 0),
      new Vector2(crownR * 1.12, crownY * 0.28),
      new Vector2(crownR * 0.92, crownY * 0.62),
      new Vector2(crownR * 1.05, crownY * 0.92),
      new Vector2(crownR, crownY),
      new Vector2(crownR * 0.62, crownY + 0.02),
      new Vector2(crownR * 0.2, crownY + 0.035),
      new Vector2(0.001, crownY + 0.04),
    ],
    12,
    {
      tintAt: (index) => (index >= 5 ? 0.25 : 0),
      radialJitter: (angleIndex, index) =>
        index < 5 ? Math.sin(angleIndex * 2.6 + index) * 0.012 : 0,
    },
  )
  const whorls: { count: number; lean: number; ring: number; length: [number, number] }[] = [
    { count: 12, lean: rng.range(0.75, 1.0), ring: 0.86, length: [0.26, 0.36] },
    { count: 8, lean: rng.range(0.3, 0.5), ring: 0.5, length: [0.2, 0.3] },
  ]
  let tentacleIndex = 0
  for (const whorl of whorls) {
    for (let i = 0; i < whorl.count; i++) {
      const yaw = (i / whorl.count) * Math.PI * 2 + rng.range(-0.14, 0.14) + whorl.ring
      const out = new Vector3(Math.cos(yaw), 0, Math.sin(yaw))
      const baseR = crownR * whorl.ring
      const base = new Vector3(out.x * baseR, crownY + 0.01, out.z * baseR)
      const lean = whorl.lean + rng.range(-0.12, 0.12)
      const length = rng.range(whorl.length[0], whorl.length[1])
      const dir = new Vector3(
        Math.sin(lean) * out.x, Math.cos(lean), Math.sin(lean) * out.z,
      )
      const curl = rng.range(0.1, 0.3)
      const mid = base.clone().addScaledVector(dir, length * 0.5)
      const tip = base
        .clone()
        .addScaledVector(dir, length)
        .add(new Vector3(out.x * curl * length, -curl * length * 0.3, out.z * curl * length))
      const phase = (tentacleIndex / 20) * Math.PI * 2 + rng.range(0, 1.2)
      writer.tube([base, mid, tip], {
        sides: 4,
        radiusAt: (t) => 0.028 * (1 - t * 0.55),
        weightAt: (t) => 0.15 + 0.85 * t * t,
        tintAt: (t) => 0.6 + t * 0.4,
        phase,
        tipLength: 0.02,
      })
      tentacleIndex++
    }
  }
  return writer.compile()
}

// ── Urchin & starfish ────────────────────────────────────────────────────

/** Sea urchin: plated test with radial bump rows + a jittered spine forest.
 *  animWeight = 1 at spine tips (slow independent waving). */
export function createUrchinGeometry(rng: Rng): BufferGeometry {
  const writer = new FloraMeshWriter()
  const SEGMENTS = 12
  const RINGS = 8
  const rows: number[][] = []
  for (let j = 0; j <= RINGS; j++) {
    const phi = (j / RINGS) * Math.PI
    const row: number[] = []
    for (let i = 0; i < SEGMENTS; i++) {
      const theta = (i / SEGMENTS) * Math.PI * 2
      const plates = 1 + 0.035 * Math.cos(theta * 5) * Math.sin(phi)
      row.push(
        writer.vertex(
          Math.sin(phi) * Math.cos(theta) * plates,
          Math.cos(phi) * 0.78 * plates,
          Math.sin(phi) * Math.sin(theta) * plates,
          0, 0, 0,
        ),
      )
    }
    rows.push(row)
  }
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < SEGMENTS; i++) {
      const next = (i + 1) % SEGMENTS
      writer.quad(rows[j][i], rows[j][next], rows[j + 1][next], rows[j + 1][i])
    }
  }
  const SPINES = 38
  const normal = new Vector3()
  const jitter = new Vector3()
  for (let s = 0; s < SPINES; s++) {
    // Fibonacci-sphere directions keep spines even without clumping.
    const t = (s + 0.5) / SPINES
    const phi = Math.acos(1 - 2 * t * 0.86) // bias off the buried underside
    const theta = s * 2.39996
    normal.set(Math.sin(phi) * Math.cos(theta), Math.cos(phi) * 0.78, Math.sin(phi) * Math.sin(theta)).normalize()
    jitter.set(rng.range(-0.22, 0.22), rng.range(-0.22, 0.22), rng.range(-0.22, 0.22))
    const dir = normal.clone().add(jitter).normalize()
    const length = rng.range(0.4, 0.75)
    const base = normal.clone().multiplyScalar(0.92)
    const phase = rng.range(0, Math.PI * 2)
    writer.tube(
      [
        new Vector3(base.x, base.y * 0.78, base.z),
        new Vector3(base.x + dir.x * length, base.y * 0.78 + dir.y * length, base.z + dir.z * length),
      ],
      {
        sides: 3,
        radiusAt: (tt) => 0.024 * (1 - tt * 0.7),
        weightAt: (tt) => 0.25 + tt * 0.75,
        tintAt: () => 1,
        phase,
        tipLength: 0.05,
      },
    )
  }
  return writer.compile()
}

/** Five-armed starfish: star-boundary polar sheet with bulged arms, upturned
 *  tips, knobbed top (tint = knob speckle field), closed underside. */
export function createStarfishGeometry(rng: Rng): BufferGeometry {
  const writer = new FloraMeshWriter()
  const seed = rng.range(0, 100)
  const THETA = 25
  const RINGS = 5
  const armPow = rng.range(1.2, 1.7)
  const boundary = (theta: number): number =>
    0.34 + 0.66 * Math.pow(0.5 + 0.5 * Math.cos(theta * 5), armPow)
  const armMask = (theta: number): number => Math.pow(0.5 + 0.5 * Math.cos(theta * 5), 0.8)
  const top: number[][] = []
  const rim: number[] = []
  for (let j = 0; j <= RINGS; j++) {
    const rFraction = j / RINGS
    const row: number[] = []
    for (let i = 0; i < THETA; i++) {
      const theta = (i / THETA) * Math.PI * 2
      const edge = boundary(theta)
      const radius = rFraction * edge
      const mask = armMask(theta)
      const height =
        (0.16 * (1 - rFraction * rFraction) * (0.45 + 0.55 * mask) +
          0.05 * Math.pow(rFraction, 4) * mask) *
        (1 + 0.06 * Math.sin(rFraction * 20))
      const knob = fbmCpu(Math.cos(theta) * radius * 5 + seed, Math.sin(theta) * radius * 5 - seed, 3, 37)
      row.push(
        writer.vertex(
          Math.cos(theta) * radius,
          height + (knob - 0.5) * 0.035,
          Math.sin(theta) * radius,
          0, 0, knob,
        ),
      )
    }
    top.push(row)
    if (j === RINGS) {
      for (let i = 0; i < THETA; i++) {
        const theta = (i / THETA) * Math.PI * 2
        rim.push(writer.vertex(Math.cos(theta) * boundary(theta), 0.004, Math.sin(theta) * boundary(theta), 0, 0, 0.3))
      }
    }
  }
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < THETA; i++) {
      const next = (i + 1) % THETA
      writer.quad(top[j][i], top[j + 1][i], top[j + 1][next], top[j][next])
    }
  }
  const bottomCenter = writer.vertex(0, 0.002, 0, 0, 0, 0.3)
  for (let i = 0; i < THETA; i++) {
    const next = (i + 1) % THETA
    writer.quad(top[RINGS][i], rim[i], rim[next], top[RINGS][next])
    writer.triangle(bottomCenter, rim[next], rim[i])
  }
  return writer.compile()
}

// ── Shells ───────────────────────────────────────────────────────────────

/** Turban shell: a genuine logarithmic-spiral swept whorl (aperture to
 *  apex), banded tint for the material's spiral stripes. */
export function createTurbanShellGeometry(): BufferGeometry {
  const writer = new FloraMeshWriter()
  const TURNS = 3.2
  const SAMPLES = 30
  const growth = 0.56 // whorl scale factor per turn
  const points: Vector3[] = []
  const radii: number[] = []
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES
    const angle = t * TURNS * Math.PI * 2
    const scale = Math.pow(growth, t * TURNS)
    const whorlR = 0.3 * scale
    points.push(
      new Vector3(Math.cos(angle) * whorlR, 0.16 + t * 0.34 - scale * 0.12, Math.sin(angle) * whorlR),
    )
    radii.push(0.17 * scale + 0.008)
  }
  writer.tube(points, {
    sides: 6,
    radiusAt: (t) => radii[Math.min(SAMPLES, Math.round(t * SAMPLES))],
    tintAt: (t) => (Math.floor(t * TURNS * 8) % 2 === 0 ? 0.85 : 0.3),
    capStart: true,
    tipLength: 0.02,
  })
  const geometry = writer.compile()
  geometry.rotateX(-0.25)
  geometry.computeBoundingBox()
  const minY = geometry.boundingBox!.min.y
  geometry.translate(0, -minY, 0)
  return geometry
}

/** Small scallop-fan shell halves for the beach-litter families. */
export function createClamShellGeometry(): BufferGeometry {
  const writer = new FloraMeshWriter()
  const segments = 14
  const hinge = [writer.vertex(0, 0.07, -0.08, 0, 0, 0.6), writer.vertex(0, 0, -0.08, 0, 0, 0.6)]
  const rim: number[][] = []
  for (let i = 0; i <= segments; i++) {
    const angle = -Math.PI / 2 + (i / segments) * Math.PI
    const scallop = Math.sin((i / segments) * Math.PI * segments * 0.5)
    const radial = 0.56 + scallop * 0.025
    const x = Math.sin(angle) * radial
    const z = Math.cos(angle) * radial
    const rib = 0.045 + Math.cos(i * Math.PI) * 0.012
    rim.push([
      writer.vertex(x, rib, z, 0, 0, 0.4 + scallop * 0.4),
      writer.vertex(x, 0, z, 0, 0, 0.4 + scallop * 0.4),
    ])
    if (i > 0) {
      writer.triangle(hinge[0], rim[i - 1][0], rim[i][0])
      writer.triangle(hinge[1], rim[i][1], rim[i - 1][1])
      writer.quad(rim[i - 1][0], rim[i - 1][1], rim[i][1], rim[i][0])
    }
  }
  return writer.compile()
}

// ── Sponges (kept craft, ported to the shared writer channels) ──────────

/** A cluster of 3–4 open-mouthed tube sponges leaning apart; each tube is a
 *  closed clockwise loop so the hollow throat shows without DoubleSide.
 *  tint rises to the rim. */
export function createTubeSpongeGeometry(rng: Rng): BufferGeometry {
  const writer = new FloraMeshWriter()
  const count = 4
  for (let i = 0; i < count; i++) {
    const h = rng.range(0.85, 1.5)
    const r = rng.range(0.14, 0.22)
    const lean = rng.range(0.06, 0.24)
    const yaw = (i / count) * Math.PI * 2 + rng.range(-0.4, 0.4)
    const offsetX = Math.sin(yaw) * rng.range(0.08, 0.22)
    const offsetZ = Math.cos(yaw) * rng.range(0.08, 0.22)
    const seed = rng.range(0, 100)
    const profile: Vector2[] = [
      new Vector2(r * 1.3, 0),
      new Vector2(r * 1.15, h * 0.12),
      new Vector2(r * 0.92, h * 0.4),
      new Vector2(r * 1.0, h * 0.78),
      new Vector2(r * 1.14, h * 0.95),
      new Vector2(r * 1.18, h),
      new Vector2(r * 0.8, h),
      new Vector2(r * 0.66, h * 0.55),
      new Vector2(r * 0.52, h * 0.16),
    ]
    const inner = new FloraMeshWriter()
    inner.lathe(profile, 12, {
      tintAt: (index, point) => Math.min(1, point.y / h) * (index >= 6 ? 0.5 : 1),
      radialJitter: (angleIndex, index) =>
        (fbmCpu(angleIndex * 1.1 + seed, index * 0.9 - seed, 3, 5) - 0.5) * 0.07,
    })
    const tubeGeometry = inner.compile()
    tubeGeometry.rotateZ(lean)
    tubeGeometry.rotateY(yaw)
    tubeGeometry.translate(offsetX, 0, offsetZ)
    appendGeometry(writer, tubeGeometry)
    tubeGeometry.dispose()
  }
  return writer.compile()
}

/** One great barrel sponge: ridged flank, rolled rim, visible dark throat. */
export function createBarrelSpongeGeometry(rng: Rng): BufferGeometry {
  const writer = new FloraMeshWriter()
  const seed = rng.range(0, 100)
  writer.lathe(
    [
      new Vector2(0.52, 0),
      new Vector2(0.66, 0.14),
      new Vector2(0.72, 0.45),
      new Vector2(0.66, 0.78),
      new Vector2(0.58, 0.96),
      new Vector2(0.6, 1.0),
      new Vector2(0.46, 0.98),
      new Vector2(0.38, 0.6),
      new Vector2(0.34, 0.24),
    ],
    16,
    {
      tintAt: (index, point) => (index >= 6 ? 0.15 : Math.min(1, point.y)),
      radialJitter: (angleIndex, index) =>
        (fbmCpu(angleIndex * 0.8 + seed, index * 1.2 + seed, 3, 9) - 0.5) * 0.1 +
        Math.cos(angleIndex * (Math.PI * 2 / 16) * 8) * 0.02,
    },
  )
  return writer.compile()
}

// ── Sea treasures (unchanged craft, relocated from flora.ts) ─────────────

/**
 * A giant clam: two fluted valves hinged at the back, the upper gaping
 * ~35°. animWeight = 1 on the upper valve (the material breathes the gape);
 * tint = rim weight for the mantle-edge glow mask.
 */
export function createGiantClamGeometry(rng: Rng): BufferGeometry {
  void rng
  const writer = new FloraMeshWriter()
  const SEGMENTS = 40
  const RINGS = 8
  const buildValve = (upper: boolean): void => {
    const rows: number[][] = []
    for (let j = 0; j <= RINGS; j++) {
      const phi = (j / RINGS) * (Math.PI / 2)
      const row: number[] = []
      for (let i = 0; i < SEGMENTS; i++) {
        const theta = (i / SEGMENTS) * Math.PI * 2
        let x = Math.sin(phi) * Math.cos(theta)
        let z = Math.sin(phi) * Math.sin(theta)
        let y = Math.cos(phi) * (upper ? 1 : -1)
        const rimWeight = 1 - Math.min(1, Math.abs(y))
        const wave = Math.cos(theta * 9)
        const scale = 1 + 0.11 * wave * rimWeight
        x *= scale
        z *= scale
        y = y * 0.48 + (upper ? 1 : -1) * 0.07 * wave * rimWeight
        const vertex = new Vector3(x, y, z)
        if (upper) {
          // Hinge the dome open at the back: rotate about the hinge line.
          vertex.z -= -0.92
          const cos = Math.cos(-0.62)
          const sin = Math.sin(-0.62)
          const ry = vertex.y * cos - vertex.z * sin
          const rz = vertex.y * sin + vertex.z * cos
          vertex.y = ry + 0.04
          vertex.z = rz - 0.92
        }
        row.push(
          writer.vertex(vertex.x, vertex.y, vertex.z, upper ? 1 : 0, 0, rimWeight),
        )
      }
      rows.push(row)
    }
    for (let j = 0; j < RINGS; j++) {
      for (let i = 0; i < SEGMENTS; i++) {
        const next = (i + 1) % SEGMENTS
        if (upper) writer.quad(rows[j][i], rows[j][next], rows[j + 1][next], rows[j + 1][i])
        else writer.quad(rows[j][i], rows[j + 1][i], rows[j + 1][next], rows[j][next])
      }
    }
  }
  buildValve(false)
  buildValve(true)
  return writer.compile()
}

/** A shipping amphora: closed lathe foot→rolled rim with interior lip, two
 *  shoulder handles. tint = slip-band field. */
export function createAmphoraGeometry(rng: Rng): BufferGeometry {
  void rng
  const writer = new FloraMeshWriter()
  const profile = [
    new Vector2(0.09, 0),
    new Vector2(0.16, 0.02),
    new Vector2(0.13, 0.1),
    new Vector2(0.3, 0.32),
    new Vector2(0.4, 0.62),
    new Vector2(0.38, 0.88),
    new Vector2(0.28, 1.08),
    new Vector2(0.16, 1.22),
    new Vector2(0.14, 1.34),
    new Vector2(0.2, 1.4),
    new Vector2(0.21, 1.45),
    new Vector2(0.15, 1.46),
    new Vector2(0.11, 1.42),
    new Vector2(0.1, 1.3),
  ]
  writer.lathe(profile, 16, {
    tintAt: (_index, point) => 0.5 + 0.5 * Math.sin(point.y * 26),
  })
  // Handles: quadratic arcs from neck to shoulder, both endpoints embedded
  // inside the body wall so nothing ever floats.
  for (const side of [-1, 1]) {
    const neck = new Vector3(side * 0.11, 1.3, 0)
    const shoulder = new Vector3(side * 0.3, 0.96, 0)
    const control = new Vector3(side * 0.52, 1.2, 0)
    const handle: Vector3[] = []
    for (let i = 0; i <= 8; i++) {
      const t = i / 8
      const a = (1 - t) * (1 - t)
      const b = 2 * (1 - t) * t
      const c = t * t
      handle.push(
        new Vector3(
          neck.x * a + control.x * b + shoulder.x * c,
          neck.y * a + control.y * b + shoulder.y * c,
          neck.z * a + control.z * b + shoulder.z * c,
        ),
      )
    }
    writer.tube(handle, {
      sides: 5,
      radiusAt: () => 0.035,
      tintAt: () => 0.5,
      capStart: true,
      tipLength: 0.01,
    })
  }
  return writer.compile()
}

// ── Shared helpers ───────────────────────────────────────────────────────

/** Append a compiled writer geometry into another writer (channel-aware). */
function appendGeometry(writer: FloraMeshWriter, geometry: BufferGeometry): void {
  const position = geometry.getAttribute('position')
  const weight = geometry.getAttribute('animWeight')
  const phase = geometry.getAttribute('animPhase')
  const tint = geometry.getAttribute('tint')
  const index = geometry.getIndex()!
  const map: number[] = []
  for (let i = 0; i < position.count; i++) {
    map.push(
      writer.vertex(
        position.getX(i), position.getY(i), position.getZ(i),
        weight ? weight.getX(i) : 0,
        phase ? phase.getX(i) : 0,
        tint ? tint.getX(i) : 0.5,
      ),
    )
  }
  for (let i = 0; i < index.count; i += 3) {
    writer.triangle(map[index.getX(i)], map[index.getX(i + 1)], map[index.getX(i + 2)])
  }
}

export function floraGeometryMetrics(geometry: BufferGeometry): FloraGeometryMetrics {
  geometry.computeBoundingBox()
  const box = geometry.boundingBox!
  return {
    vertices: geometry.getAttribute('position').count,
    triangles: (geometry.getIndex()?.count ?? geometry.getAttribute('position').count) / 3,
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  }
}

// ── Offline audit ────────────────────────────────────────────────────────

export interface FloraGeometryAudit {
  archetypes: Record<string, FloraGeometryMetrics>
  failures: string[]
}

/** Numeric self-check for `npm run audit:geometry`: every archetype builds,
 *  stays finite, respects its triangle budget, keeps channels in range, and
 *  closed forms face outward. */
export function auditFloraGeometry(makeRng: (label: string) => Rng): FloraGeometryAudit {
  const failures: string[] = []
  const archetypes: Record<string, FloraGeometryMetrics> = {}
  const cases: {
    name: string
    build: () => BufferGeometry
    maxTriangles: number
    outwardCheck?: boolean
  }[] = [
    { name: 'strap-kelp', build: () => createStrapKelpGeometry(makeRng('kelp')), maxTriangles: 460 },
    { name: 'rockweed', build: () => createAlgaeTuftGeometry(makeRng('rockweed'), 'rockweed'), maxTriangles: 320 },
    { name: 'codium', build: () => createAlgaeTuftGeometry(makeRng('codium'), 'codium'), maxTriangles: 420 },
    { name: 'plume', build: () => createAlgaeTuftGeometry(makeRng('plume'), 'plume'), maxTriangles: 220 },
    { name: 'brain', build: () => createBrainCoralGeometry(makeRng('brain')), maxTriangles: 780, outwardCheck: true },
    { name: 'staghorn', build: () => createStaghornColonyGeometry(makeRng('stag')), maxTriangles: 1400 },
    { name: 'table', build: () => createTableCoralGeometry(makeRng('table')), maxTriangles: 700 },
    { name: 'boulder', build: () => createBoulderGeometry(makeRng('boulder')), maxTriangles: 400, outwardCheck: true },
    { name: 'pinnacle', build: () => createPinnacleGeometry(makeRng('pinnacle')), maxTriangles: 420 },
    { name: 'seafan', build: () => createSeaFanGeometry(makeRng('fan')), maxTriangles: 1300 },
    { name: 'anemone', build: () => createAnemoneGeometry(makeRng('anemone')), maxTriangles: 800 },
    { name: 'urchin', build: () => createUrchinGeometry(makeRng('urchin')), maxTriangles: 560, outwardCheck: true },
    { name: 'starfish', build: () => createStarfishGeometry(makeRng('star')), maxTriangles: 480 },
    { name: 'turban', build: () => createTurbanShellGeometry(), maxTriangles: 480 },
    { name: 'clam-fan', build: () => createClamShellGeometry(), maxTriangles: 90 },
    { name: 'tube-sponge', build: () => createTubeSpongeGeometry(makeRng('sponge')), maxTriangles: 1300 },
    { name: 'barrel-sponge', build: () => createBarrelSpongeGeometry(makeRng('barrel')), maxTriangles: 340 },
    { name: 'giant-clam', build: () => createGiantClamGeometry(makeRng('clam')), maxTriangles: 1500 },
    { name: 'amphora', build: () => createAmphoraGeometry(makeRng('amphora')), maxTriangles: 700 },
  ]
  for (const testCase of cases) {
    const geometry = testCase.build()
    const metrics = floraGeometryMetrics(geometry)
    archetypes[testCase.name] = metrics
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
    const weight = geometry.getAttribute('animWeight')
    for (let i = 0; i < weight.count; i++) {
      const value = weight.getX(i)
      if (value < -0.001 || value > 1.001) {
        failures.push(`${testCase.name}: animWeight ${value.toFixed(3)} out of range at ${i}`)
        break
      }
    }
    if (testCase.outwardCheck) {
      // Closed masses must shade outward: normals point away from centroid.
      geometry.computeBoundingBox()
      const centroid = new Vector3()
      geometry.boundingBox!.getCenter(centroid)
      const normal = geometry.getAttribute('normal')
      let outwardSum = 0
      const p = new Vector3()
      const n = new Vector3()
      for (let i = 0; i < position.count; i++) {
        p.set(position.getX(i), position.getY(i), position.getZ(i)).sub(centroid)
        n.set(normal.getX(i), normal.getY(i), normal.getZ(i))
        if (p.lengthSq() > 1e-6) outwardSum += n.dot(p.normalize())
      }
      const outwardMean = outwardSum / position.count
      if (outwardMean < 0.3) {
        failures.push(`${testCase.name}: normals face inward (mean outward dot ${outwardMean.toFixed(2)})`)
      }
    }
    geometry.dispose()
  }
  // Strap kelp must rise plant-like (instances scale 0.7–1.6 → 2–7 m
  // stands) and stream wider than it is tall — the marine silhouette.
  const kelp = createStrapKelpGeometry(makeRng('kelp-span'))
  const kelpMetrics = floraGeometryMetrics(kelp)
  const kelpRise = kelpMetrics.max[1]
  const kelpSpread = Math.max(
    kelpMetrics.max[0] - kelpMetrics.min[0],
    kelpMetrics.max[2] - kelpMetrics.min[2],
  )
  if (kelpRise < 2.6 || kelpRise > 5.6) {
    failures.push(`strap-kelp: rise ${kelpRise.toFixed(2)} outside the 2.6–5.6 authored band`)
  }
  if (kelpSpread < kelpRise) {
    failures.push(`strap-kelp: spread ${kelpSpread.toFixed(2)} < rise ${kelpRise.toFixed(2)} — straps not streaming`)
  }
  kelp.dispose()
  return { archetypes, failures }
}
