import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  CircleGeometry,
  ClampToEdgeWrapping,
  Color,
  CubicBezierCurve3,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  MathUtils,
  Matrix4,
  Mesh,
  NoColorSpace,
  Object3D,
  PointLight,
  RepeatWrapping,
  RGBAFormat,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { MeshBasicNodeMaterial, MeshPhysicalNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import {
  color,
  float,
  frontFacing,
  mix,
  mrt,
  mx_noise_float,
  normalView,
  positionGeometry,
  select,
  texture,
  time,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import type { SeaMediumSystem } from '../sea/medium'

/**
 * Le Nautile Blanc — the porcelain-and-brass salon submersible, ported
 * verbatim from refs/submarine.html (design contract, geometry kit, detail
 * atlas, every sculpted part). The reference is authored in metres at true
 * one-occupant scale (~4.2 m hull); SUBMARINE_SCALE lifts it to a grand
 * 5.1 m salon craft — the realistic envelope of a luxury personal
 * submersible — without touching any authored proportion.
 *
 * Adaptations for the park's pipeline (geometry preserved exactly):
 * - Material noise fields sample positionGeometry, not positionWorld — the
 *   vehicle moves, and worldspace patterns would crawl across the hull
 *   (the carousel/wildlife body-locked patterning rule).
 * - Transmission glass needs a backdrop pass this pipeline does not run;
 *   the dome and windows use the park's thin transparent-pane recipe (the
 *   Descent Bell shell), with the AO-receiver MRT alpha 0 fix.
 * - Lamp emission is recalibrated into the park's HDR hierarchy (the
 *   reference values were tuned for an ACES studio at exposure 1).
 * - Every lit material receives caustic light via the medium.
 */
export const SUBMARINE_SCALE = 1.22

/** Sub-origin height above the ground at rest — the belly step (the lowest
 *  member, local y −1.1525) settles into the sand by a few millimetres. */
export const SUBMARINE_REST_HEIGHT = 1.15 * SUBMARINE_SCALE

export interface SubmarineModel {
  group: Group
  /** Tail propeller assembly — spin around local z. */
  propeller: Object3D
  /** Cabin helm wheel — cosmetic steering animation around local z. */
  helmWheel: Object3D
  dispose(): void
}

/* ---------------- deterministic seed ---------------- */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ---------------- design contract (metres) ----------------
 * +Z is forward (glass nose), +Y is up. One object = one role. */
const D = {
  dome: {
    center: new Vector3(0, 0.02, 0.92),
    radius: 1.0,
    tilt: MathUtils.degToRad(24), // collar plane lean (top aft)
    planeOffset: 0.14, // collar plane behind sphere centre
  },
  hull: { tailZ: -1.3, tailR: 0.3, maxR: 1.015, rings: 56, segs: 128 },
  tail: {
    collarZ: -1.3,
    tipZ: -1.74,
    tipR: 0.105,
    ringZ: -1.76,
    ringR: 0.8,
    ringW: 0.145,
    ringD: 0.26,
    prop: { blades: 8, r: 0.62, hubR: 0.115 },
  },
  finH: {
    rootZ0: -0.42,
    rootZ1: -1.22,
    tipZ0: -1.18,
    tipZ1: -1.66,
    span: 0.98,
    dihedral: MathUtils.degToRad(3),
  },
  window: { uCenter: 0.345, vCenter: 0.205, uHalf: 0.052, vHalf: 0.135 },
  seat: { x: 0, y: -0.34, z: 0.62 },
  deck: { y: -0.52 },
} as const

/* ---------------- palette ---------------- */
const PAL = {
  porcelain: new Color(0xf8f4ea),
  porcelainLow: new Color(0xe9e2d2),
  brass: new Color(0xc7973f),
  brassDeep: new Color(0x8f6a28),
  leather: new Color(0xefe3cb),
  wood: new Color(0x5c4430),
  glassTint: new Color(0xdcebe6),
  lamp: new Color(0xffd9a4),
  interiorDark: new Color(0x3d3225),
} as const

/* ---------------- small math helpers ---------------- */
const V3 = (x = 0, y = 0, z = 0): Vector3 => new Vector3(x, y, z)
const lerp = MathUtils.lerp
const TAU = Math.PI * 2

function smooth01(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Catmull-Rom sample of 2D control points -> array of Vector2. */
function splinePts(ctrl: readonly (readonly [number, number])[], n: number): Vector2[] {
  const c = new CatmullRomCurve3(ctrl.map((p) => V3(p[0], p[1], 0)))
  c.curveType = 'centripetal'
  return c.getSpacedPoints(n).map((p) => new Vector2(p.x, p.y))
}

interface TransportFrames {
  tangents: Vector3[]
  normals: Vector3[]
  binormals: Vector3[]
}

/** Parallel-transport frames along sampled points. */
function transportFrames(pts: Vector3[]): TransportFrames {
  const tangents: Vector3[] = []
  const normals: Vector3[] = []
  const binormals: Vector3[] = []
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    tangents.push(V3().subVectors(b, a).normalize())
  }
  let nrm = Math.abs(tangents[0].y) < 0.94 ? V3(0, 1, 0) : V3(1, 0, 0)
  nrm = V3().crossVectors(tangents[0], V3().crossVectors(nrm, tangents[0])).normalize()
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const axis = V3().crossVectors(tangents[i - 1], tangents[i])
      if (axis.length() > 1e-6) {
        axis.normalize()
        const ang = Math.acos(MathUtils.clamp(tangents[i - 1].dot(tangents[i]), -1, 1))
        nrm = nrm.clone().applyAxisAngle(axis, ang)
      }
    }
    normals.push(nrm.clone())
    binormals.push(V3().crossVectors(tangents[i], nrm).normalize())
  }
  return { tangents, normals, binormals }
}

/* ================================================================== *
 *  GEOMETRY KIT — grid lofts with analytic normals, lathes, sweeps   *
 *  Triangle emission is the last step; everything is a sampled plan. *
 * ================================================================== */

interface GridOptions {
  closeU?: boolean
  flip?: boolean
  vRow?: number[] | null
  uOffset?: number
}

/** rows: Vector3[nRows][nCols]. closeU wraps each row into a loop.
 *  vRow: optional per-row v coordinate (arc-length UVs). */
function gridGeometry(rows: Vector3[][], options: GridOptions = {}): BufferGeometry {
  const { closeU = true, flip = false, vRow = null, uOffset = 0 } = options
  const nR = rows.length
  const nC = rows[0].length
  const cols = closeU ? nC + 1 : nC
  const pos = new Float32Array(nR * cols * 3)
  const nor = new Float32Array(nR * cols * 3)
  const uvA = new Float32Array(nR * cols * 2)
  const wrap = (j: number): number => ((j % nC) + nC) % nC
  const P = (i: number, j: number): Vector3 =>
    rows[i][closeU ? wrap(j) : MathUtils.clamp(j, 0, nC - 1)]

  const dU = V3()
  const dV = V3()
  const n = V3()
  for (let i = 0; i < nR; i++) {
    for (let j = 0; j < cols; j++) {
      const p = P(i, j)
      const k = i * cols + j
      pos[k * 3] = p.x
      pos[k * 3 + 1] = p.y
      pos[k * 3 + 2] = p.z

      dU.subVectors(P(i, j + 1), P(i, j - 1))
      dV.subVectors(P(Math.min(nR - 1, i + 1), j), P(Math.max(0, i - 1), j))
      n.crossVectors(dU, dV)
      if (n.lengthSq() < 1e-12) {
        // pole fallback: use row-to-row direction
        const c0 = V3()
        const c1 = V3()
        const a = Math.max(0, i - 1)
        const b = Math.min(nR - 1, i + 1)
        for (const q of rows[a]) c0.add(q)
        c0.divideScalar(nC)
        for (const q of rows[b]) c1.add(q)
        c1.divideScalar(nC)
        n.subVectors(c0, c1)
        if (n.lengthSq() < 1e-12) n.set(0, 1, 0)
      }
      n.normalize()
      if (flip) n.negate()
      nor[k * 3] = n.x
      nor[k * 3 + 1] = n.y
      nor[k * 3 + 2] = n.z

      uvA[k * 2] = uOffset + j / (cols - 1)
      uvA[k * 2 + 1] = vRow ? vRow[i] : i / (nR - 1)
    }
  }
  const idx: number[] = []
  for (let i = 0; i < nR - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j
      const b = a + 1
      const c = a + cols
      const d = c + 1
      if (flip) {
        idx.push(a, c, b, b, c, d)
      } else {
        idx.push(a, b, c, b, d, c)
      }
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('normal', new BufferAttribute(nor, 3))
  g.setAttribute('uv', new BufferAttribute(uvA, 2))
  g.setIndex(idx)
  g.computeBoundingSphere()
  return g
}

/** Closed ring of points around `center`, in the plane spanned by axU/axV. */
function ringPoints(
  center: Vector3,
  axU: Vector3,
  axV: Vector3,
  radius: number,
  segs: number,
  phase = 0,
): Vector3[] {
  const pts: Vector3[] = []
  for (let j = 0; j < segs; j++) {
    const a = phase + (j / segs) * TAU
    pts.push(
      V3()
        .copy(center)
        .addScaledVector(axU, Math.sin(a) * radius)
        .addScaledVector(axV, -Math.cos(a) * radius),
    )
  }
  return pts
}

/** Revolve profile [(r,z),...] around +Z. phase=0 puts u=0 at -Y (belly). */
function latheZ(profile: Vector2[], segs = 48, { flip = false } = {}): BufferGeometry {
  const rows = profile.map((p) =>
    ringPoints(V3(0, 0, p.y), V3(1, 0, 0), V3(0, 1, 0), Math.max(p.x, 0.0015), segs),
  )
  // arc-length v
  const vRow = [0]
  let acc = 0
  for (let i = 1; i < profile.length; i++) {
    acc += Math.hypot(profile[i].x - profile[i - 1].x, profile[i].y - profile[i - 1].y)
    vRow.push(acc)
  }
  for (let i = 0; i < vRow.length; i++) vRow[i] /= acc || 1
  return gridGeometry(rows, { closeU: true, flip, vRow })
}

type RadiusFn = number | ((t: number) => number)

/** Sweep a circular section along a 3D path; radiusFn(t) in [0,1].
 *  roundEnds tapers the tube into hemispherical tips. */
function sweepTube(
  path: Vector3[],
  radiusFn: RadiusFn,
  radialSegs = 14,
  { roundEnds = false, flip = false } = {},
): BufferGeometry {
  const pts = path
  const rF = typeof radiusFn === 'number' ? () => radiusFn : radiusFn
  if (roundEnds) {
    const capN = 5
    const first = pts[0]
    const second = pts[1]
    const last = pts[pts.length - 1]
    const prev = pts[pts.length - 2]
    const d0 = V3().subVectors(first, second).normalize()
    const d1 = V3().subVectors(last, prev).normalize()
    const r0 = rF(0)
    const r1 = rF(1)
    const head: { p: Vector3; s: number }[] = []
    const tail: { p: Vector3; s: number }[] = []
    for (let k = capN; k >= 1; k--) {
      const a = ((k / capN) * Math.PI) / 2
      head.push({ p: V3().copy(first).addScaledVector(d0, Math.sin(a) * r0), s: Math.cos(a) })
      tail.push({ p: V3().copy(last).addScaledVector(d1, Math.sin(a) * r1), s: Math.cos(a) })
    }
    const mids = pts.map((p) => ({ p: p.clone(), s: 1 }))
    const seq = [...head, ...mids, ...tail.reverse()]
    const frames0 = transportFrames(seq.map((o) => o.p))
    const rows = seq.map((o, i) => {
      const t = MathUtils.clamp((i - capN) / (pts.length - 1), 0, 1)
      return ringPoints(
        o.p,
        frames0.normals[i],
        frames0.binormals[i],
        Math.max(rF(t) * o.s, 0.0012),
        radialSegs,
      )
    })
    return gridGeometry(rows, { closeU: true, flip })
  }
  const frames = transportFrames(pts)
  const rows = pts.map((p, i) =>
    ringPoints(
      p,
      frames.normals[i],
      frames.binormals[i],
      Math.max(rF(i / (pts.length - 1)), 0.0012),
      radialSegs,
    ),
  )
  return gridGeometry(rows, { closeU: true, flip })
}

/** Circular arc in the plane of (axU,axV) around center — as path points. */
function arcPath(
  center: Vector3,
  axU: Vector3,
  axV: Vector3,
  radius: number,
  a0: number,
  a1: number,
  n = 32,
): Vector3[] {
  const pts: Vector3[] = []
  for (let i = 0; i <= n; i++) {
    const a = lerp(a0, a1, i / n)
    pts.push(
      V3()
        .copy(center)
        .addScaledVector(axU, Math.cos(a) * radius)
        .addScaledVector(axV, Math.sin(a) * radius),
    )
  }
  return pts
}

interface FinStation {
  le: Vector3
  te: Vector3
  up: Vector3
  thick: number
}

/** Fin loft: stations of {le, te, thick} lofted with a lens airfoil section;
 *  `up` is the fin-plane normal per station. */
function finLoft(stations: FinStation[], sectionSegs = 40, { flip = false } = {}): BufferGeometry {
  const rows = stations.map((st) => {
    const loop: Vector3[] = []
    for (let k = 0; k < sectionSegs; k++) {
      const a = (k / sectionSegs) * TAU
      const cx = 0.5 - 0.5 * Math.cos(a) // 0 at LE, 1 at TE, both surfaces
      const side = Math.sin(a)
      const w = st.thick * Math.pow(Math.max(Math.sin(Math.PI * Math.pow(cx, 0.85)), 0), 0.62)
      loop.push(V3().lerpVectors(st.le, st.te, cx).addScaledVector(st.up, side * w * 0.5))
    }
    return loop
  })
  return gridGeometry(rows, { closeU: true, flip })
}

/* ================================================================== *
 *  DETAIL ATLAS — hull ornament painted in UV space (2048×1024)      *
 *  R = window cut-out · G = gold leaf mask · B = soft grime/AO       *
 * ================================================================== */
const ATLAS_W = 2048
const ATLAS_H = 1024

function buildDetailAtlas(rng: () => number): CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = ATLAS_W
  cv.height = ATLAS_H
  const context2d = cv.getContext('2d')
  if (!context2d) throw new Error('Submarine detail atlas needs a 2d canvas')
  const ctx: CanvasRenderingContext2D = context2d
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, ATLAS_W, ATLAS_H)
  ctx.globalCompositeOperation = 'lighter'
  const X = (u: number): number => u * ATLAS_W
  const Y = (v: number): number => v * ATLAS_H

  /* tapered, curling stroke; returns spine samples for attaching leaflets */
  interface SpineSample {
    x: number
    y: number
    a: number
    t: number
  }
  function curl(
    x: number,
    y: number,
    ang: number,
    len: number,
    curv: number,
    w0: number,
    grow = 1.1,
  ): SpineSample[] {
    const steps = Math.max(10, (len / 5) | 0)
    const ds = len / steps
    const spine: SpineSample[] = []
    let a = ang
    let cu = curv
    for (let i = 0; i <= steps; i++) {
      spine.push({ x, y, a, t: i / steps })
      x += Math.cos(a) * ds
      y += Math.sin(a) * ds
      a += cu
      cu *= grow
    }
    const L: [number, number][] = []
    const R: [number, number][] = []
    for (const s of spine) {
      const w = w0 * Math.pow(1 - s.t, 1.25) * 0.5 + 0.25
      L.push([s.x - Math.sin(s.a) * w, s.y + Math.cos(s.a) * w])
      R.push([s.x + Math.sin(s.a) * w, s.y - Math.cos(s.a) * w])
    }
    ctx.beginPath()
    ctx.moveTo(L[0][0], L[0][1])
    for (const p of L) ctx.lineTo(p[0], p[1])
    for (let i = R.length - 1; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1])
    ctx.closePath()
    ctx.fill()
    return spine
  }
  function fern(x: number, y: number, ang: number, len: number, w0: number, dir = 1): void {
    const spine = curl(x, y, ang, len, dir * 0.028, w0, 1.065)
    for (let i = 2; i < spine.length - 2; i++) {
      const s = spine[i]
      if ((i - 2) % 2) continue
      const f = 1 - s.t
      const side = i % 4 < 2 ? 1 : -1
      curl(
        s.x,
        s.y,
        s.a + side * (1.25 + 0.2 * rng()),
        len * 0.24 * f + 6,
        side * dir * 0.16,
        w0 * 0.55 * f,
        1.22,
      )
    }
  }
  function scroll(x: number, y: number, ang: number, len: number, w0: number, dir = 1): void {
    // simple volute
    curl(x, y, ang, len, dir * 0.075, w0, 1.16)
    curl(x, y, ang + Math.PI * 0.92, len * 0.45, -dir * 0.11, w0 * 0.8, 1.2)
  }

  /* one hull side painted around u=0.345; mirrored for the port side */
  function paintSide(): void {
    const wu = D.window.uCenter
    const wv = D.window.vCenter
    const cx = X(wu)
    const cy = Y(wv)
    const uh = D.window.uHalf * ATLAS_W
    const vh = D.window.vHalf * ATLAS_H

    /* — window aperture (R channel): teardrop, round bow, tail sweeping aft — */
    function windowPath(scale = 1): void {
      ctx.beginPath()
      const s = scale
      ctx.moveTo(cx, cy - vh * s)
      ctx.bezierCurveTo(cx + uh * s, cy - vh * s, cx + uh * s, cy - vh * 0.15 * s, cx + uh * 0.92 * s, cy + vh * 0.12 * s)
      ctx.bezierCurveTo(cx + uh * 0.72 * s, cy + vh * 0.62 * s, cx + uh * 0.3 * s, cy + vh * 1.02 * s, cx - uh * 0.12 * s, cy + vh * 1.06 * s)
      ctx.bezierCurveTo(cx - uh * 0.5 * s, cy + vh * 1.02 * s, cx - uh * 0.86 * s, cy + vh * 0.6 * s, cx - uh * 0.98 * s, cy + vh * 0.1 * s)
      ctx.bezierCurveTo(cx - uh * s, cy - vh * 0.2 * s, cx - uh * 0.85 * s, cy - vh * s, cx, cy - vh * s)
      ctx.closePath()
    }
    ctx.fillStyle = '#ff0000'
    windowPath()
    ctx.fill()

    /* — gold work (G channel) — */
    ctx.fillStyle = '#00cc00'
    ctx.strokeStyle = '#00cc00'
    ctx.lineCap = 'round'
    ctx.lineWidth = 7
    windowPath(1.1)
    ctx.stroke() // outer pinstripe
    ctx.lineWidth = 3
    windowPath(1.2)
    ctx.stroke() // hairline echo

    /* sweeping coach-lines: bow collar → over window → tail */
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.moveTo(X(wu + 0.075), Y(0.035))
    ctx.bezierCurveTo(X(wu + 0.095), Y(0.18), X(wu + 0.075), Y(0.42), X(wu + 0.02), Y(0.66))
    ctx.bezierCurveTo(X(wu - 0.01), Y(0.78), X(wu - 0.03), Y(0.84), X(wu - 0.045), Y(0.9))
    ctx.stroke()
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.moveTo(X(wu + 0.088), Y(0.035))
    ctx.bezierCurveTo(X(wu + 0.108), Y(0.2), X(wu + 0.086), Y(0.44), X(wu + 0.028), Y(0.68))
    ctx.bezierCurveTo(X(wu - 0.002), Y(0.8), X(wu - 0.024), Y(0.86), X(wu - 0.04), Y(0.92))
    ctx.stroke()
    /* lower swash under the window toward the belly step */
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(X(wu - 0.065), Y(0.06))
    ctx.bezierCurveTo(X(wu - 0.1), Y(0.22), X(wu - 0.088), Y(0.4), X(wu - 0.052), Y(0.52))
    ctx.stroke()

    /* fern sprays — the engraved plumes */
    fern(cx + uh * 0.4, cy + vh * 1.55, Math.PI * 0.44, 200, 10, 1)
    fern(cx - uh * 1.7, cy + vh * 0.28, Math.PI * 0.52, 150, 8, -1)
    fern(X(wu + 0.058), Y(0.083), Math.PI * 0.62, 120, 7, -1)
    scroll(X(wu - 0.052), Y(0.6), Math.PI * 0.35, 70, 6, 1)
    scroll(X(wu + 0.01), Y(0.76), Math.PI * 0.3, 84, 6, -1)

    /* — soft shading (B): halo under window & along swage line — */
    ctx.save()
    ctx.filter = 'blur(14px)'
    ctx.strokeStyle = 'rgba(0,0,90,1)'
    ctx.lineWidth = 16
    windowPath(1.16)
    ctx.stroke()
    ctx.restore()
  }

  paintSide()
  ctx.save()
  ctx.translate(ATLAS_W, 0)
  ctx.scale(-1, 1)
  paintSide()
  ctx.restore()

  /* — full-circumference coach rings near collar and tail — */
  ctx.strokeStyle = '#00cc00'
  const ring = (v: number, w: number): void => {
    ctx.lineWidth = w
    ctx.beginPath()
    ctx.moveTo(0, Y(v))
    ctx.lineTo(ATLAS_W, Y(v))
    ctx.stroke()
  }
  ring(0.022, 6)
  ring(0.045, 2.5)
  ring(0.865, 6)
  ring(0.895, 2.5)
  ring(0.925, 10)
  ctx.save()
  ctx.filter = 'blur(18px)'
  ctx.strokeStyle = 'rgba(0,0,70,1)'
  ring(0.94, 26)
  ctx.restore()

  const tex = new CanvasTexture(cv)
  tex.flipY = false
  tex.wrapS = RepeatWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.colorSpace = NoColorSpace
  tex.anisotropy = 8
  return tex
}

/** Small enamel gauge face. */
function buildGaugeFace(): CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 128
  const c = cv.getContext('2d')
  if (!c) throw new Error('Submarine gauge face needs a 2d canvas')
  c.fillStyle = '#f7f2e4'
  c.beginPath()
  c.arc(64, 64, 62, 0, TAU)
  c.fill()
  c.strokeStyle = '#5a4a30'
  c.lineWidth = 2
  for (let i = 0; i <= 12; i++) {
    const a = Math.PI * 0.75 + (i / 12) * Math.PI * 1.5
    const r0 = i % 3 === 0 ? 44 : 50
    c.beginPath()
    c.moveTo(64 + Math.cos(a) * r0, 64 + Math.sin(a) * r0)
    c.lineTo(64 + Math.cos(a) * 56, 64 + Math.sin(a) * 56)
    c.stroke()
  }
  c.strokeStyle = '#8a2f1d'
  c.lineWidth = 3
  c.beginPath()
  c.moveTo(64, 64)
  const na = Math.PI * 0.75 + 0.62 * Math.PI * 1.5
  c.lineTo(64 + Math.cos(na) * 46, 64 + Math.sin(na) * 46)
  c.stroke()
  c.fillStyle = '#5a4a30'
  c.beginPath()
  c.arc(64, 64, 4, 0, TAU)
  c.fill()
  const t = new CanvasTexture(cv)
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 4
  return t
}

/** Diamond-quilt normal map, baked once (height → Sobel). */
function buildQuiltNormalTex(cells = 6): DataTexture {
  const S = 512
  const h = new Float32Array(S * S)
  const cell = S / cells
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const rx = (x + y) / cell // 45° lattice
      const ry = (x - y) / cell
      const fx = Math.abs(rx - Math.round(rx))
      const fy = Math.abs(ry - Math.round(ry))
      const d = Math.min(fx, fy) // distance to seam
      let v = smooth01(Math.min(d * 6, 1)) // puffed cell
      const gx = rx - Math.round(rx)
      const gy = ry - Math.round(ry)
      const cd = Math.hypot(gx, gy)
      v *= 1 - 0.85 * Math.exp(-cd * cd * 90) // button dimple
      h[y * S + x] = v
    }
  }
  const data = new Uint8Array(S * S * 4)
  const H = (x: number, y: number): number => h[((y + S) % S) * S + ((x + S) % S)]
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * 2.2
      const dy = (H(x, y + 1) - H(x, y - 1)) * 2.2
      const inv = 1 / Math.hypot(dx, dy, 1)
      const i = (y * S + x) * 4
      data[i] = (-dx * inv * 0.5 + 0.5) * 255
      data[i + 1] = (dy * inv * 0.5 + 0.5) * 255
      data[i + 2] = (1 * inv * 0.5 + 0.5) * 255
      data[i + 3] = 255
    }
  }
  const t = new DataTexture(data, S, S, RGBAFormat)
  t.wrapS = t.wrapT = RepeatWrapping
  t.needsUpdate = true
  t.anisotropy = 8
  return t
}

/* ================================================================== *
 *  MATERIAL BUNDLES — porcelain, brass, glass, quilted leather, wood *
 * ================================================================== */
interface SubmarineMaterials {
  hull: MeshPhysicalNodeMaterial
  porcelain: MeshPhysicalNodeMaterial
  brass: MeshPhysicalNodeMaterial
  brassSatin: MeshPhysicalNodeMaterial
  brassDark: MeshPhysicalNodeMaterial
  glass: MeshPhysicalNodeMaterial
  leatherQ: MeshPhysicalNodeMaterial
  leatherPl: MeshPhysicalNodeMaterial
  wood: MeshPhysicalNodeMaterial
  lampCore: MeshBasicNodeMaterial
  lampGlass: MeshPhysicalNodeMaterial
  darkMetal: MeshPhysicalNodeMaterial
  gauge: MeshBasicNodeMaterial
}

function buildMaterials(
  medium: SeaMediumSystem,
  detailAtlas: CanvasTexture,
  gaugeFace: CanvasTexture,
  quiltTex: DataTexture,
  ownedTextures: { push(t: DataTexture): void },
): SubmarineMaterials {
  // Body-locked noise: the vehicle moves, so every field samples geometry
  // space — worldspace patterns would crawl across the hull under way.
  const noiseAt = (scale: number) => mx_noise_float(positionGeometry.mul(scale))

  /* — porcelain hull with painted gold & window cut-outs — */
  const atlas = texture(detailAtlas, uv())
  const goldMask = atlas.g.clamp(0, 1)
  const grime = atlas.b.clamp(0, 1)
  const paintCol = mix(
    color(PAL.porcelain),
    color(PAL.porcelainLow),
    noiseAt(1.6).mul(0.5).add(0.5).mul(0.35),
  )
  const leafCol = mix(color(PAL.brass), color(PAL.brassDeep), noiseAt(30).mul(0.5).add(0.5).mul(0.4))
  const frontCol = mix(paintCol, leafCol, goldMask).mul(grime.mul(0.22).oneMinus())
  const hull = new MeshPhysicalNodeMaterial()
  hull.side = DoubleSide
  // select() over a color()/vec3 pair loses arity — cast at creation.
  hull.colorNode = select(frontFacing, frontCol, color(PAL.interiorDark)) as unknown as Node<'vec3'>
  hull.metalnessNode = select(frontFacing, goldMask.mul(0.95), float(0))
  hull.roughnessNode = select(
    frontFacing,
    mix(float(0.34).add(noiseAt(9).mul(0.05)), float(0.22), goldMask),
    float(0.85),
  )
  hull.clearcoat = 0.9
  hull.clearcoatRoughness = 0.14
  hull.opacityNode = atlas.r.oneMinus()
  hull.alphaTest = 0.5

  /* — plain porcelain for fins, shroud, pods, step — */
  const porcelain = new MeshPhysicalNodeMaterial()
  porcelain.colorNode = mix(
    color(PAL.porcelain),
    color(PAL.porcelainLow),
    noiseAt(2.2).mul(0.5).add(0.5).mul(0.3),
  )
  porcelain.roughnessNode = float(0.33).add(noiseAt(8).mul(0.05))
  porcelain.metalness = 0
  porcelain.clearcoat = 0.9
  porcelain.clearcoatRoughness = 0.14

  /* — brasses — */
  const brassOf = (rough: number, cc: number): MeshPhysicalNodeMaterial => {
    const m = new MeshPhysicalNodeMaterial()
    m.colorNode = mix(color(PAL.brass), color(PAL.brassDeep), noiseAt(26).mul(0.5).add(0.5).mul(0.45))
    m.metalness = 1.0
    m.roughnessNode = float(rough).add(noiseAt(14).mul(0.07))
    m.clearcoat = cc
    m.clearcoatRoughness = 0.2
    return m
  }
  const brass = brassOf(0.17, 0.35) // polished trim
  const brassSatin = brassOf(0.3, 0.15) // structural
  const brassDark = brassOf(0.42, 0)
  brassDark.colorNode = color(PAL.brassDeep)

  /* — dome & window glass —
   * The reference's transmission glass needs a backdrop pass this pipeline
   * does not run; use the park's thin transparent-pane recipe (the Descent
   * Bell shell) with the AO-receiver MRT alpha 0 fix — transparent optics
   * must not feed the opaque AO's depth/normal pair. */
  const glass = new MeshPhysicalNodeMaterial()
  glass.transparent = true
  glass.opacity = 0.09
  glass.roughness = 0.035
  glass.metalness = 0
  glass.color = PAL.glassTint.clone()
  glass.clearcoat = 1.0
  glass.clearcoatRoughness = 0.06
  glass.depthWrite = false
  glass.mrtNode = mrt({ normal: vec4(normalView, 0) })

  /* — quilted leather (two orientations by repeat) — */
  const leatherOf = (repeat: number, quilted: boolean): MeshPhysicalNodeMaterial => {
    const m = new MeshPhysicalNodeMaterial()
    m.colorNode = mix(
      color(PAL.leather),
      color(PAL.leather).mul(0.9),
      noiseAt(20).mul(0.5).add(0.5).mul(0.5),
    )
    m.roughnessNode = float(0.52).add(noiseAt(40).mul(0.06))
    m.metalness = 0
    m.sheen = 0.5
    m.sheenRoughness = 0.6
    m.sheenColor = new Color(0xfff6e0)
    m.clearcoat = 0.12
    m.clearcoatRoughness = 0.4
    if (quilted) {
      const t = quiltTex.clone()
      t.repeat.set(repeat, repeat)
      t.needsUpdate = true
      ownedTextures.push(t)
      m.normalMap = t
      m.normalScale = new Vector2(0.55, 0.55)
    }
    return m
  }
  const leatherQ = leatherOf(1.4, true) // quilted faces
  const leatherPl = leatherOf(1, false)

  /* — varnished walnut deck — */
  const wood = new MeshPhysicalNodeMaterial()
  const grain = mx_noise_float(positionGeometry.mul(vec3(9, 9, 2.2))).mul(0.5).add(0.5)
  wood.colorNode = mix(color(PAL.wood), color(PAL.wood).mul(0.55), grain)
  wood.roughnessNode = mix(float(0.32), float(0.5), grain)
  wood.metalness = 0
  wood.clearcoat = 0.8
  wood.clearcoatRoughness = 0.18

  /* — lamps — emission recalibrated into the park's HDR hierarchy (the
   * reference's ×6 core was tuned for an ACES studio at exposure 1). */
  const flicker = time.mul(2.1).sin().mul(time.mul(3.7).sin()).mul(0.05).add(1.0)
  const lampCore = new MeshBasicNodeMaterial()
  lampCore.colorNode = color(PAL.lamp).mul(flicker.mul(3.2))
  const lampGlass = new MeshPhysicalNodeMaterial()
  lampGlass.colorNode = color(PAL.lamp)
  lampGlass.emissiveNode = color(PAL.lamp).mul(flicker.mul(0.9))
  lampGlass.roughness = 0.18
  lampGlass.metalness = 0
  lampGlass.transparent = true
  lampGlass.opacity = 0.85
  lampGlass.mrtNode = mrt({ normal: vec4(normalView, 0) })

  /* — interior fittings — */
  const darkMetal = new MeshPhysicalNodeMaterial()
  darkMetal.colorNode = color(PAL.interiorDark).mul(1.15)
  darkMetal.metalness = 0.85
  darkMetal.roughness = 0.5

  const gauge = new MeshBasicNodeMaterial()
  gauge.colorNode = texture(gaugeFace, uv()).mul(1.1)

  // Every lit surface takes caustic light like the rest of the park.
  for (const m of [hull, porcelain, brass, brassSatin, brassDark, leatherQ, leatherPl, wood, darkMetal]) {
    medium.applyCaustics(m, 1.25)
  }

  return {
    hull,
    porcelain,
    brass,
    brassSatin,
    brassDark,
    glass,
    leatherQ,
    leatherPl,
    wood,
    lampCore,
    lampGlass,
    darkMetal,
    gauge,
  }
}

/** Convenience mesh maker with shadows on. */
function M(geo: BufferGeometry, mat: MeshPhysicalNodeMaterial | MeshBasicNodeMaterial, parent: Object3D, name?: string): Mesh {
  const m = new Mesh(geo, mat)
  m.castShadow = true
  m.receiveShadow = true
  if (name) m.name = name
  parent.add(m)
  return m
}

/* ================================================================== *
 *  ASSEMBLY — hull, dome & cabin, stern, fins: the reference verbatim *
 * ================================================================== */
export function buildSubmarineModel(medium: SeaMediumSystem): SubmarineModel {
  const rng = mulberry32(20260714)
  const ownedTextures: (CanvasTexture | DataTexture)[] = []
  const detailAtlas = buildDetailAtlas(rng)
  const gaugeFace = buildGaugeFace()
  const quiltTex = buildQuiltNormalTex()
  ownedTextures.push(detailAtlas, gaugeFace, quiltTex)
  const MAT = buildMaterials(medium, detailAtlas, gaugeFace, quiltTex, ownedTextures)

  const sub = new Group() // the whole submersible
  sub.name = 'le-nautile-blanc'

  /* — collar frame from the dome contract — */
  const domeC = D.dome.center
  const domeR = D.dome.radius
  const tilt = D.dome.tilt
  const nColl = V3(0, Math.sin(tilt), Math.cos(tilt)) // collar plane normal
  const rimC = V3().copy(domeC).addScaledVector(nColl, -D.dome.planeOffset)
  const rimR = Math.sqrt(domeR * domeR - D.dome.planeOffset ** 2)
  const rimU = V3(1, 0, 0)
  const rimV = V3(0, Math.cos(tilt), -Math.sin(tilt)) // in-plane "up"

  /* — hull spine & radius laws, sampled once — */
  const HP = {
    n: 240,
    cy: [] as number[],
    z: [] as number[],
    r: [] as number[],
    tiltA: [] as number[],
    v: [] as number[],
  }
  {
    const rCtrl = splinePts(
      [
        [0.995, 0],
        [1.014, 0.07],
        [1.006, 0.25],
        [0.958, 0.42],
        [0.845, 0.6],
        [0.645, 0.78],
        [0.43, 0.92],
        [D.hull.tailR, 1.0],
      ],
      HP.n - 1,
    )
    const cyCtrl = splinePts(
      [
        [rimC.y, 0],
        [0.012, 0.18],
        [-0.012, 0.5],
        [0.02, 0.8],
        [0.075, 1.0],
      ],
      HP.n - 1,
    )
    let acc = 0
    for (let i = 0; i < HP.n; i++) {
      const t = i / (HP.n - 1)
      HP.r[i] = rCtrl[Math.min(i, rCtrl.length - 1)].x
      HP.cy[i] = cyCtrl[Math.min(i, cyCtrl.length - 1)].x
      HP.z[i] = lerp(rimC.z, D.hull.tailZ, t)
      HP.tiltA[i] = tilt * (1 - smooth01(Math.min(t / 0.34, 1)))
      if (i > 0) {
        acc += Math.hypot(HP.z[i] - HP.z[i - 1], HP.r[i] - HP.r[i - 1]) + Math.abs(HP.cy[i] - HP.cy[i - 1])
      }
      HP.v[i] = acc
    }
    for (let i = 0; i < HP.n; i++) HP.v[i] /= acc
  }
  interface HullRing {
    c: Vector3
    r: number
    axU: Vector3
    axV: Vector3
    v: number
  }
  function hullRingAt(t: number): HullRing {
    const f = MathUtils.clamp(t, 0, 1) * (HP.n - 1)
    const i = Math.min(HP.n - 2, f | 0)
    const fr = f - i
    const tiltAngle = lerp(HP.tiltA[i], HP.tiltA[i + 1], fr)
    return {
      c: V3(0, lerp(HP.cy[i], HP.cy[i + 1], fr), lerp(HP.z[i], HP.z[i + 1], fr)),
      r: lerp(HP.r[i], HP.r[i + 1], fr),
      axU: V3(1, 0, 0),
      axV: V3(0, Math.cos(tiltAngle), -Math.sin(tiltAngle)),
      v: lerp(HP.v[i], HP.v[i + 1], fr),
    }
  }
  function hullPoint(u01: number, t: number): Vector3 {
    const R = hullRingAt(t)
    const a = u01 * TAU
    return V3()
      .copy(R.c)
      .addScaledVector(R.axU, Math.sin(a) * R.r)
      .addScaledVector(R.axV, -Math.cos(a) * R.r)
  }
  function hullSample(u01: number, t: number): { p: Vector3; n: Vector3 } {
    const e = 0.004
    const p = hullPoint(u01, t)
    const pu = hullPoint(u01 + e, t).sub(hullPoint(u01 - e, t))
    const pt = hullPoint(u01, Math.min(t + e, 1)).sub(hullPoint(u01, Math.max(t - e, 0)))
    const n = V3().crossVectors(pu, pt).normalize().negate() // outward
    return { p, n }
  }

  /* — hull skin — */
  {
    const rows: Vector3[][] = []
    const vRow: number[] = []
    for (let i = 0; i < D.hull.rings; i++) {
      const t = i / (D.hull.rings - 1)
      const R = hullRingAt(t)
      rows.push(ringPoints(R.c, R.axU, R.axV, R.r, D.hull.segs))
      vRow.push(R.v)
    }
    const g = gridGeometry(rows, { closeU: true, flip: true, vRow })
    M(g, MAT.hull, sub, 'hull')
  }

  /* — brass collar: main torus + glazing bead — */
  {
    const rim = ringPoints(rimC, rimU, rimV, rimR + 0.004, 140)
    rim.push(rim[0].clone())
    M(sweepTube(rim, 0.042, 18), MAT.brass, sub, 'collar')
    const bead = ringPoints(V3().copy(rimC).addScaledVector(nColl, 0.045), rimU, rimV, rimR - 0.028, 120)
    bead.push(bead[0].clone())
    M(sweepTube(bead, 0.016, 12), MAT.brass, sub, 'collarBead')
  }

  /* — side windows: sculpted frame + bulged glazing (both sides) — */
  function windowOutlineUV(scale = 1, n = 64): Vector2[] {
    const { uCenter: wu, vCenter: wv, uHalf: uh, vHalf: vh } = D.window
    const s = scale
    const P: [number, number][] = [
      [wu, wv - vh * s],
      [wu + uh * s, wv - vh * s],
      [wu + uh * s, wv - vh * 0.15 * s],
      [wu + uh * 0.92 * s, wv + vh * 0.12 * s],
      [wu + uh * 0.72 * s, wv + vh * 0.62 * s],
      [wu + uh * 0.3 * s, wv + vh * 1.02 * s],
      [wu - uh * 0.12 * s, wv + vh * 1.06 * s],
      [wu - uh * 0.5 * s, wv + vh * 1.02 * s],
      [wu - uh * 0.86 * s, wv + vh * 0.6 * s],
      [wu - uh * 0.98 * s, wv + vh * 0.1 * s],
      [wu - uh * s, wv - vh * 0.2 * s],
      [wu - uh * 0.85 * s, wv - vh * s],
    ]
    const curve = new CatmullRomCurve3(P.map((q) => V3(q[0], q[1], 0)), true, 'centripetal')
    return curve.getSpacedPoints(n).map((p) => new Vector2(p.x, p.y))
  }
  function buildWindow(mirror: boolean): void {
    const outUV = windowOutlineUV(1.06, 72)
    const lift = (uv3: Vector2): { p: Vector3; n: Vector3 } => {
      const u = mirror ? 1 - uv3.x : uv3.x
      return hullSample(u, uv3.y)
    }
    /* frame: sculpted double bead following the aperture */
    const path = outUV.map((q) => {
      const { p, n } = lift(q)
      return p.addScaledVector(n, 0.01)
    })
    path.push(path[0].clone())
    M(sweepTube(path, 0.017, 12), MAT.brass, sub, 'windowFrame')
    const echoUV = windowOutlineUV(1.22, 72)
    const path2 = echoUV.map((q) => {
      const { p, n } = lift(q)
      return p.addScaledVector(n, 0.006)
    })
    path2.push(path2[0].clone())
    M(sweepTube(path2, 0.006, 8), MAT.brass, sub, 'windowEcho')
    /* glazing: rows shrink to centre with a gentle outward bulge */
    const rowsN = 9
    const ctrUV = new Vector2(D.window.uCenter, D.window.vCenter + D.window.vHalf * 0.05)
    const rows: Vector3[][] = []
    for (let i = 0; i < rowsN; i++) {
      const k = 1 - (i / (rowsN - 1)) * 0.985
      const bulge = Math.sqrt(Math.max(1 - k * k, 0))
      rows.push(
        outUV.map((q) => {
          const uvq = new Vector2().copy(ctrUV).lerp(q, k)
          const { p, n } = lift(uvq)
          return p.addScaledVector(n, 0.004 + 0.028 * bulge)
        }),
      )
    }
    const gg = gridGeometry(rows, { closeU: true, flip: mirror ? false : true })
    const mesh = M(gg, MAT.glass, sub, 'windowGlass')
    mesh.castShadow = false
  }
  buildWindow(false)
  buildWindow(true)

  /* — flank spears: rod + arrow tip + tail finial + saddle mounts — */
  function buildSpear(sideU: number): void {
    const grp = new Group()
    sub.add(grp)
    const a = hullSample(sideU, 0.06)
    const b = hullSample(sideU, 0.52)
    const A = a.p.clone().addScaledVector(a.n, 0.034)
    const Bp = b.p.clone().addScaledVector(b.n, 0.034)
    const contactT = 0.29
    const contact = hullSample(sideU, contactT)
    const tangentStep = 0.004
    const dir = hullPoint(sideU, contactT - tangentStep)
      .sub(hullPoint(sideU, contactT + tangentStep))
      .normalize()
    const contactSpan = A.distanceTo(Bp)
    const axisContact = contact.p.clone().addScaledVector(contact.n, 0.034)
    const tail = axisContact.clone().addScaledVector(dir, -(0.12 + contactSpan * 0.5))
    /* lathe profile: ball → collar → arrow blade → long rod → tail acorn */
    const L = contactSpan + 0.46
    const prof = [
      [0.0015, 0],
      [0.016, 0.012],
      [0.021, 0.03],
      [0.009, 0.05],
      [0.03, 0.075],
      [0.037, 0.1],
      [0.0135, 0.135],
      [0.0125, 0.15],
      [0.0125, 0.86],
      [0.02, 0.885],
      [0.02, 0.91],
      [0.013, 0.925],
      [0.024, 0.965],
      [0.0015, 1.0],
    ].map((q) => new Vector2(q[0], (1 - q[1]) * L))
    const m = M(latheZ(prof, 26, { flip: false }), MAT.brass, grp, 'spear')
    m.position.copy(tail)
    m.quaternion.setFromUnitVectors(V3(0, 0, 1), dir)
    for (const tm of [0.16, 0.44]) {
      const s = hullSample(sideU, tm)
      const base = s.p.clone().addScaledVector(s.n, -0.005)
      const axisDistance = V3().subVectors(base, tail).dot(dir)
      const top = tail.clone().addScaledVector(dir, axisDistance)
      const gM = sweepTube([base, base.clone().lerp(top, 0.5), top], (t) => lerp(0.02, 0.011, t), 10)
      M(gM, MAT.brassSatin, grp, 'spearMount')
    }
  }
  buildSpear(0.25)
  buildSpear(0.75)

  /* — belly step with brass rails & S-brackets — */
  {
    const grp = new Group()
    sub.add(grp)
    const bz = 0.3
    const by = -1.115
    const board = new RoundedBoxGeometry(0.46, 0.075, 0.34, 4, 0.035)
    M(board, MAT.porcelain, grp, 'step').position.set(0, by, bz)
    /* gold outline inset on the tread */
    const rr = (w: number, d: number, r: number): Vector3[] => {
      const p: Vector3[] = []
      const seg = 7
      const cs: [number, number, number][] = [
        [w - r, d - r, 0],
        [-w + r, d - r, Math.PI / 2],
        [-w + r, -d + r, Math.PI],
        [w - r, -d + r, Math.PI * 1.5],
      ]
      for (const [cx, cz, a0] of cs) {
        for (let i = 0; i <= seg; i++) {
          const a = a0 + ((i / seg) * Math.PI) / 2
          p.push(V3(cx + Math.cos(a) * r, by + 0.041, bz + cz + Math.sin(a) * r))
        }
      }
      p.push(p[0].clone())
      return p
    }
    M(sweepTube(rr(0.185, 0.125, 0.05), 0.0045, 8), MAT.brass, grp, 'stepTrim')
    /* brackets: hull → board, gentle S */
    for (const tz of [0.17, 0.43]) {
      const t = (0.792 - tz) / (0.792 - D.hull.tailZ) // z → hull t
      const s = hullSample(0, t)
      const p0 = s.p.clone().addScaledVector(s.n, -0.01)
      const p3 = V3(0, by + 0.03, tz)
      const p1 = p0.clone().addScaledVector(s.n, 0.06)
      const p2 = p3.clone().add(V3(0, 0.06, 0))
      const bez = new CubicBezierCurve3(p0, p1, p2, p3)
      const gB = sweepTube(bez.getSpacedPoints(22), (t2) => lerp(0.02, 0.014, t2), 10, { roundEnds: false })
      M(gB, MAT.brassSatin, grp, 'stepBracket')
    }
  }

  /* — under-nose lamp — */
  {
    const s = hullSample(0, 0.1)
    const grp = new Group()
    grp.position.copy(s.p)
    sub.add(grp)
    grp.quaternion.setFromUnitVectors(V3(0, 0, 1), s.n)
    const ringG = latheZ(
      [
        [0.028, 0.055],
        [0.055, 0.045],
        [0.062, 0.02],
        [0.058, 0.0],
        [0.048, -0.008],
      ].map((q) => new Vector2(q[0], q[1])),
      26,
    )
    M(ringG, MAT.brass, grp, 'noseLampRing')
    const bm = M(new SphereGeometry(0.044, 20, 14), MAT.lampGlass, grp, 'noseLampBulb')
    bm.position.z = 0.028
    bm.castShadow = false
    M(new SphereGeometry(0.02, 10, 8), MAT.lampCore, grp, 'noseLampCore').position.z = 0.028
  }

  /* — top handle pipe (staple) + escutcheons + vent dome — */
  {
    const grp = new Group()
    sub.add(grp)
    const zA = -0.3
    const zB = -0.78
    const lift = 0.15
    const rC = 0.06
    const sA = hullSample(0.5, (0.792 - zA) / (0.792 - D.hull.tailZ))
    const sB = hullSample(0.5, (0.792 - zB) / (0.792 - D.hull.tailZ))
    const yTop = Math.max(sA.p.y, sB.p.y) + lift
    const pts: Vector3[] = [sA.p.clone().addScaledVector(sA.n, -0.02)]
    pts.push(V3(0, yTop - rC, zA))
    const corner = (cy: number, cz: number, a0: number, a1: number): void => {
      for (let i = 1; i <= 6; i++) {
        const a = lerp(a0, a1, i / 6)
        pts.push(V3(0, cy + Math.sin(a) * rC, cz + Math.cos(a) * rC))
      }
    }
    corner(yTop - rC, zA - rC, 0, Math.PI / 2)
    pts.push(V3(0, yTop, zB + rC))
    corner(yTop - rC, zB + rC, Math.PI / 2, Math.PI)
    pts.push(V3(0, yTop - rC, zB))
    pts.push(sB.p.clone().addScaledVector(sB.n, -0.02))
    M(sweepTube(pts, 0.026, 14), MAT.brass, grp, 'handle')
    for (const s of [sA, sB]) {
      const fl = latheZ(
        [
          [0.012, 0.055],
          [0.05, 0.03],
          [0.058, 0.012],
          [0.05, 0.0],
        ].map((q) => new Vector2(q[0], q[1])),
        20,
      )
      const fm = M(fl, MAT.brass, grp, 'flange')
      fm.position.copy(s.p).addScaledVector(s.n, -0.004)
      fm.quaternion.setFromUnitVectors(V3(0, 0, 1), s.n)
    }
    const sV = hullSample(0.5, 0.055)
    const vent = latheZ(
      [
        [0.001, 0.05],
        [0.03, 0.046],
        [0.048, 0.03],
        [0.055, 0.012],
        [0.046, 0.0],
      ].map((q) => new Vector2(q[0], q[1])),
      22,
    )
    const vm = M(vent, MAT.brass, grp, 'vent')
    vm.position.copy(sV.p).addScaledVector(sV.n, -0.004)
    vm.quaternion.setFromUnitVectors(V3(0, 0, 1), sV.n)
  }

  /* — collar rivets — */
  {
    const N = 30
    const geo = new SphereGeometry(0.0105, 8, 6)
    const inst = new InstancedMesh(geo, MAT.brassDark, N)
    const m4 = new Matrix4()
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU
      const p = V3()
        .copy(rimC)
        .addScaledVector(rimU, Math.sin(a) * (rimR + 0.004))
        .addScaledVector(rimV, -Math.cos(a) * (rimR + 0.004))
        .addScaledVector(V3().copy(rimU).multiplyScalar(Math.sin(a)).addScaledVector(rimV, -Math.cos(a)), 0.04)
      m4.setPosition(p)
      inst.setMatrixAt(i, m4)
    }
    inst.castShadow = true
    sub.add(inst)
  }

  /* ================================================================ *
   *  DOME, CAGE & CABIN — the glass salon                            *
   * ================================================================ */

  /* — glass cap: revolve about the collar normal — */
  {
    const thMax = Math.acos(-D.dome.planeOffset / domeR)
    const prof: Vector2[] = []
    for (let i = 0; i <= 46; i++) {
      const th = lerp(0.015, thMax, i / 46)
      prof.push(new Vector2(domeR * Math.sin(th), domeR * Math.cos(th)))
    }
    const mesh = M(latheZ(prof, 96, { flip: true }), MAT.glass, sub, 'domeGlass')
    mesh.castShadow = false
    mesh.position.copy(domeC)
    mesh.quaternion.setFromUnitVectors(V3(0, 0, 1), nColl)
  }

  /* — armillary cage inside the glass, concentric on +Z — */
  {
    const grp = new Group()
    grp.position.copy(domeC)
    sub.add(grp)
    const rC = 0.947
    for (const th of [0.42, 0.85, 1.28]) {
      // latitude rings
      const ring = ringPoints(V3(0, 0, rC * Math.cos(th)), V3(1, 0, 0), V3(0, 1, 0), rC * Math.sin(th), 84)
      ring.push(ring[0].clone())
      M(sweepTube(ring, 0.0105, 10), MAT.brass, grp, 'cageRing').castShadow = false
    }
    for (let k = 0; k < 6; k++) {
      // meridian ribs, seated on the collar
      const psi = Math.PI / 6 + (k * Math.PI) / 3
      const rad = V3(Math.cos(psi), Math.sin(psi), 0)
      /* theta where this rib's great arc meets the collar plane */
      const A = Math.sin(psi) * Math.sin(tilt)
      const B = Math.cos(tilt)
      const phi0 = Math.atan2(A, B)
      const thetaEnd = phi0 + Math.acos(-D.dome.planeOffset / (rC * Math.hypot(A, B)))
      const pts: Vector3[] = []
      const N = 46
      for (let i = 0; i <= N; i++) {
        const s = i / N
        const theta = lerp(0.1, thetaEnd, s)
        const rr = lerp(rC, 0.972, smooth01(Math.max(0, (s - 0.86) / 0.14))) // flare tip onto collar tube
        pts.push(V3(0, 0, Math.cos(theta) * rr).addScaledVector(rad, Math.sin(theta) * rr))
      }
      const g = sweepTube(pts, (t) => lerp(0.013, 0.0095, t), 10, { roundEnds: false })
      M(g, MAT.brass, grp, 'cageRib').castShadow = false
    }
    /* pole boss + headlight */
    const boss = new Group()
    boss.position.z = rC - 0.012
    grp.add(boss)
    const collarG = latheZ(
      [
        [0.012, -0.02],
        [0.075, -0.012],
        [0.085, 0.012],
        [0.07, 0.03],
        [0.028, 0.038],
      ].map((q) => new Vector2(q[0], q[1])),
      26,
    )
    M(collarG, MAT.brass, boss, 'headlightRing')
    const lensG = new SphereGeometry(0.055, 22, 12, 0, TAU, 0, Math.PI * 0.46)
    const lm = M(lensG, MAT.lampGlass, boss, 'headlightLens')
    lm.rotation.x = Math.PI / 2
    lm.position.z = 0.02
    lm.castShadow = false
    M(new SphereGeometry(0.026, 10, 8), MAT.lampCore, boss).position.z = 0.02
  }

  /* — crown lantern astride the collar top — */
  {
    const topPt = V3().copy(rimC).addScaledVector(rimV, rimR + 0.01)
    const grp = new Group()
    grp.position.copy(topPt)
    sub.add(grp)
    grp.quaternion.setFromUnitVectors(V3(0, 0, 1), V3(0, 1, 0.16).normalize())
    const base = latheZ(
      [
        [0.004, 0.0],
        [0.065, 0.006],
        [0.072, 0.022],
        [0.05, 0.036],
        [0.034, 0.05],
        [0.038, 0.062],
      ].map((q) => new Vector2(q[0], q[1])),
      26,
    )
    M(base, MAT.brass, grp, 'lanternBase')
    const drum = new CylinderGeometry(0.034, 0.037, 0.06, 20)
    const dm = M(drum, MAT.lampGlass, grp, 'lanternDrum')
    dm.rotation.x = Math.PI / 2
    dm.position.z = 0.092
    dm.castShadow = false
    M(new SphereGeometry(0.018, 10, 8), MAT.lampCore, grp).position.z = 0.092
    const cap = latheZ(
      [
        [0.042, 0.125],
        [0.046, 0.135],
        [0.012, 0.152],
        [0.012, 0.16],
        [0.022, 0.175],
        [0.013, 0.19],
        [0.0015, 0.198],
      ].map((q) => new Vector2(q[0], q[1])),
      22,
    )
    M(cap, MAT.brass, grp, 'lanternCap')
  }

  /* ================================================================ *
   *  CABIN                                                           *
   * ================================================================ */
  const cabin = new Group()
  sub.add(cabin)
  let helmWheel: Object3D

  /* — walnut deck with brass nosing — */
  {
    const shape = new Shape()
    const rx = 0.6
    const rz = 0.82
    const cz = 0.52
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * TAU
      const x = Math.sin(a) * rx
      const z = cz + Math.cos(a) * rz * (1 - 0.12 * Math.abs(Math.cos(a)))
      if (i) shape.lineTo(x, z)
      else shape.moveTo(x, z)
    }
    const g = new ExtrudeGeometry(shape, {
      depth: 0.045,
      bevelEnabled: true,
      bevelThickness: 0.012,
      bevelSize: 0.012,
      bevelSegments: 3,
      curveSegments: 8,
    })
    g.rotateX(Math.PI / 2)
    const dm = M(g, MAT.wood, cabin, 'deck')
    dm.position.y = D.deck.y + 0.045
    const rimPts: Vector3[] = []
    for (let i = 0; i <= 72; i++) {
      const a = (i / 72) * TAU
      rimPts.push(
        V3(Math.sin(a) * (rx + 0.008), D.deck.y + 0.03, cz + Math.cos(a) * (rz + 0.008) * (1 - 0.12 * Math.abs(Math.cos(a)))),
      )
    }
    M(sweepTube(rimPts, 0.012, 10), MAT.brass, cabin, 'deckNosing')
  }

  /* — the quilted salon chair — */
  {
    const S = new Group()
    S.position.set(D.seat.x, D.seat.y, D.seat.z)
    cabin.add(S)

    const cushion = new RoundedBoxGeometry(0.47, 0.17, 0.45, 5, 0.065)
    M(cushion, MAT.leatherQ, S, 'seatCushion').position.set(0, 0.085, 0.02)

    const back = new RoundedBoxGeometry(0.46, 0.64, 0.14, 5, 0.06)
    const bm = M(back, MAT.leatherQ, S, 'seatBack')
    bm.position.set(0, 0.42, -0.225)
    bm.rotation.x = -0.21

    const head = new RoundedBoxGeometry(0.35, 0.2, 0.11, 4, 0.05)
    const hm = M(head, MAT.leatherPl, S, 'headrest')
    hm.position.set(0, 0.8, -0.3)
    hm.rotation.x = -0.26

    for (const sx of [-1, 1]) {
      // arm bolsters
      const p0 = V3(sx * 0.265, 0.16, -0.2)
      const p1 = V3(sx * 0.285, 0.3, -0.16)
      const p2 = V3(sx * 0.285, 0.3, 0.14)
      const p3 = V3(sx * 0.26, 0.22, 0.22)
      const bez = new CubicBezierCurve3(p0, p1, p2, p3)
      M(sweepTube(bez.getSpacedPoints(18), 0.052, 14, { roundEnds: true }), MAT.leatherPl, S, 'arm')
    }
    const ped = latheZ(
      [
        [0.155, 0.0],
        [0.16, 0.02],
        [0.075, 0.05],
        [0.06, 0.14],
        [0.09, 0.19],
        [0.1, 0.21],
      ].map((q) => new Vector2(q[0], q[1])),
      26,
    )
    const pm = M(ped, MAT.brassSatin, S, 'pedestal')
    pm.rotation.x = -Math.PI / 2
    pm.position.y = -0.215
  }

  /* — helm: wheel, column, gauges, lever — */
  {
    const H = new Group()
    H.position.set(0, -0.16, 1.15)
    cabin.add(H)
    helmWheel = new Group()
    H.add(helmWheel)
    helmWheel.rotation.x = -0.42

    const rimPts: Vector3[] = []
    const RW = 0.185
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * TAU
      rimPts.push(V3(Math.cos(a) * RW, Math.sin(a) * RW, 0))
    }
    M(sweepTube(rimPts, 0.0145, 12), MAT.brass, helmWheel, 'wheelRim')
    const hubG = latheZ(
      [
        [0.0015, 0.05],
        [0.03, 0.045],
        [0.045, 0.025],
        [0.045, -0.01],
        [0.028, -0.028],
        [0.0015, -0.032],
      ].map((q) => new Vector2(q[0], q[1])),
      20,
    )
    M(hubG, MAT.brass, helmWheel, 'wheelHub')
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU
      const dir = V3(Math.cos(a), Math.sin(a), 0)
      const gS = sweepTube(
        [dir.clone().multiplyScalar(0.03), dir.clone().multiplyScalar(RW)],
        (t) => lerp(0.0095, 0.007, t),
        8,
      )
      M(gS, MAT.brass, helmWheel)
      const knob = latheZ(
        [
          [0.0015, 0],
          [0.009, 0.008],
          [0.0115, 0.03],
          [0.0085, 0.052],
          [0.0125, 0.062],
          [0.0015, 0.075],
        ].map((q) => new Vector2(q[0], q[1])),
        12,
      )
      const km = M(knob, MAT.brass, helmWheel)
      km.position.copy(dir.clone().multiplyScalar(RW))
      km.quaternion.setFromUnitVectors(V3(0, 0, 1), V3(dir.x, dir.y, 0))
    }
    /* column down to the deck */
    const colBez = new CubicBezierCurve3(V3(0, 0, 0.02), V3(0, -0.08, 0.06), V3(0, -0.2, 0.09), V3(0, -0.36, 0.05))
    M(sweepTube(colBez.getSpacedPoints(16), (t) => lerp(0.024, 0.038, t), 14), MAT.brassSatin, H, 'column')
    const foot = latheZ(
      [
        [0.09, 0],
        [0.085, 0.015],
        [0.045, 0.03],
        [0.04, 0.05],
      ].map((q) => new Vector2(q[0], q[1])),
      20,
    )
    const fm = M(foot, MAT.brassSatin, H)
    fm.rotation.x = -Math.PI / 2
    fm.position.set(0, -0.36, 0.05)

    /* twin gauges on a saddle plate */
    for (const sx of [-1, 1]) {
      const G = new Group()
      G.position.set(sx * 0.075, -0.1, 0.1)
      H.add(G)
      G.rotation.set(-0.5, 0, 0)
      const rimJ = latheZ(
        [
          [0.012, 0.0],
          [0.048, 0.004],
          [0.052, 0.018],
          [0.044, 0.03],
        ].map((q) => new Vector2(q[0], q[1])),
        20,
      )
      M(rimJ, MAT.brass, G)
      const face = new CircleGeometry(0.041, 24)
      const fc = M(face, MAT.gauge, G)
      fc.position.z = 0.022
      fc.castShadow = false
    }
    /* telegraph lever beside the chair */
    const L = new Group()
    L.position.set(0.3, -0.36, 0.72)
    cabin.add(L)
    const quad = arcPath(V3(0, 0, 0), V3(0, 1, 0), V3(0, 0, 1), 0.09, -0.5, 0.9, 14)
    M(sweepTube(quad, 0.008, 8, { roundEnds: true }), MAT.brass, L)
    M(sweepTube([V3(0, 0, 0), V3(0, 0.16, 0.05)], (t) => lerp(0.011, 0.007, t), 8), MAT.brassSatin, L)
    M(new SphereGeometry(0.018, 12, 10), MAT.brass, L).position.set(0, 0.165, 0.052)
    const lbase = latheZ(
      [
        [0.05, 0],
        [0.045, 0.012],
        [0.02, 0.02],
        [0.018, 0.05],
      ].map((q) => new Vector2(q[0], q[1])),
      16,
    )
    const lb = M(lbase, MAT.brassSatin, L)
    lb.rotation.x = -Math.PI / 2
  }

  /* — a soft warm glow inside the cabin (park-HDR calibrated) — */
  {
    const glow = new PointLight(0xffdcae, 1.6, 3.4, 2)
    glow.position.set(0, 0.25, 0.75)
    sub.add(glow)
  }

  /* ================================================================ *
   *  STERN — tail cone, shroud ring, propeller, spike, fins & pods   *
   * ================================================================ */
  const tailY = 0.075 // spine height at stern
  const propGroup = new Group()

  /* — tail cone (porcelain) with brass junction collars — */
  {
    const prof = splinePts(
      [
        [D.hull.tailR, 0],
        [0.272, -0.13],
        [0.205, -0.27],
        [0.148, -0.37],
        [D.tail.tipR, -0.44],
      ],
      30,
    ).map((p) => new Vector2(p.x, D.tail.collarZ + p.y))
    const m = M(latheZ(prof, 64, { flip: true }), MAT.porcelain, sub, 'tailCone')
    m.position.set(0, tailY, 0)
    const c1 = ringPoints(V3(0, tailY, D.tail.collarZ + 0.005), V3(1, 0, 0), V3(0, 1, 0), D.hull.tailR + 0.006, 60)
    c1.push(c1[0].clone())
    M(sweepTube(c1, 0.024, 12), MAT.brass, sub, 'tailCollarA')
    const c2 = ringPoints(V3(0, tailY, D.tail.tipZ + 0.01), V3(1, 0, 0), V3(0, 1, 0), D.tail.tipR + 0.012, 40)
    c2.push(c2[0].clone())
    M(sweepTube(c2, 0.02, 12), MAT.brass, sub, 'tailCollarB')
  }

  /* — shroud ring: bull-nosed white section swept around the axis — */
  {
    const secN = 36
    const aroundN = 110
    const rows: Vector3[][] = []
    for (let i = 0; i <= secN; i++) {
      const a = (i / secN) * TAU + Math.PI * 0.75 // seam tucked inner-rear
      const co = Math.cos(a)
      const si = Math.sin(a)
      const dr = 0.5 * D.tail.ringW * Math.sign(co) * Math.pow(Math.abs(co), 0.72)
      const dz = 0.5 * D.tail.ringD * Math.sign(si) * Math.pow(Math.abs(si), 0.72)
      rows.push(ringPoints(V3(0, tailY, D.tail.ringZ + dz), V3(1, 0, 0), V3(0, 1, 0), D.tail.ringR + dr, aroundN))
    }
    M(gridGeometry(rows, { closeU: true, flip: false }), MAT.porcelain, sub, 'shroud')
    for (const dz of [D.tail.ringD * 0.34, -D.tail.ringD * 0.34]) {
      for (const dr of [D.tail.ringW * 0.42]) {
        const ring = ringPoints(V3(0, tailY, D.tail.ringZ + dz), V3(1, 0, 0), V3(0, 1, 0), D.tail.ringR + dr + 0.028, 100)
        ring.push(ring[0].clone())
        M(sweepTube(ring, 0.009, 8), MAT.brass, sub, 'shroudTrim')
      }
    }
    /* crest finial at 12 o'clock */
    const fin = latheZ(
      [
        [0.004, 0],
        [0.05, 0.008],
        [0.056, 0.02],
        [0.024, 0.035],
        [0.014, 0.1],
        [0.028, 0.115],
        [0.012, 0.15],
        [0.0015, 0.185],
      ].map((q) => new Vector2(q[0], q[1])),
      20,
    )
    const fm = M(fin, MAT.brass, sub, 'crest')
    fm.position.set(0, tailY + D.tail.ringR + D.tail.ringW * 0.42, D.tail.ringZ)
    fm.quaternion.setFromUnitVectors(V3(0, 0, 1), V3(0, 1, 0))
  }

  /* — struts: four sculpted arms, X configuration — */
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2
    const dir = V3(Math.cos(a), Math.sin(a), 0)
    const st: FinStation[] = []
    for (let i = 0; i <= 4; i++) {
      const s = i / 4
      const r = lerp(0.13, D.tail.ringR - 0.04, s)
      const zc = lerp(-1.6, D.tail.ringZ, s)
      const c = V3(dir.x * r, tailY + dir.y * r, zc)
      const chord = lerp(0.1, 0.062, s)
      const th = lerp(0.032, 0.018, s)
      st.push({
        le: V3(c.x, c.y, c.z + chord / 2),
        te: V3(c.x, c.y, c.z - chord / 2),
        up: V3(-dir.y, dir.x, 0),
        thick: th,
      })
    }
    M(finLoft(st, 26, { flip: false }), MAT.brassSatin, sub, 'strut')
  }

  /* — propeller: brass wheel of eight twisted paddles + halo ring — */
  {
    propGroup.position.set(0, tailY, -1.745)
    sub.add(propGroup)
    const hub = latheZ(
      [
        [0.0015, -0.215],
        [0.045, -0.2],
        [0.08, -0.16],
        [0.105, -0.1],
        [0.115, -0.03],
        [0.108, 0.0],
      ].map((q) => new Vector2(q[0], q[1])),
      30,
      { flip: false },
    )
    M(hub, MAT.brass, propGroup, 'propHub')

    const stN = 8
    const blade: FinStation[] = []
    for (let i = 0; i <= stN; i++) {
      const s = i / stN
      const r = lerp(0.1, D.tail.prop.r, s)
      const c = 0.135 * Math.pow(Math.sin(Math.PI * Math.min(s * 0.94 + 0.05, 1)), 0.6) + 0.018
      const beta = lerp(0.95, 0.5, s)
      const radial = V3(1, 0, 0)
      const tang = V3(0, 1, 0)
      const chordDir = V3().addScaledVector(tang, Math.cos(beta)).addScaledVector(V3(0, 0, 1), Math.sin(beta)).normalize()
      const ctr = V3(r, 0, -0.075)
      blade.push({
        le: ctr.clone().addScaledVector(chordDir, c / 2),
        te: ctr.clone().addScaledVector(chordDir, -c / 2),
        up: V3().crossVectors(radial, chordDir).normalize(),
        thick: lerp(0.02, 0.01, s),
      })
    }
    const bg = finLoft(blade, 22, { flip: true })
    for (let k = 0; k < 8; k++) {
      const bm = M(bg, MAT.brass, propGroup, 'blade')
      bm.rotation.z = (k / 8) * TAU
    }
    const halo = ringPoints(V3(0, 0, -0.075), V3(1, 0, 0), V3(0, 1, 0), D.tail.prop.r + 0.012, 80)
    halo.push(halo[0].clone())
    M(sweepTube(halo, 0.011, 10), MAT.brass, propGroup, 'propHalo')

    /* hub lamp looking astern */
    const lampRing = latheZ(
      [
        [0.02, -0.26],
        [0.052, -0.245],
        [0.058, -0.225],
        [0.05, -0.21],
      ].map((q) => new Vector2(q[0], q[1])),
      20,
    )
    M(lampRing, MAT.brass, propGroup)
    const bm2 = M(new SphereGeometry(0.042, 18, 12), MAT.lampGlass, propGroup)
    bm2.position.z = -0.235
    bm2.castShadow = false
    M(new SphereGeometry(0.02, 10, 8), MAT.lampCore, propGroup).position.z = -0.235
  }

  /* — stern spike with collar & pearl tip — */
  {
    const g = latheZ(
      [
        [0.012, -1.95],
        [0.052, -1.965],
        [0.058, -1.99],
        [0.03, -2.02],
        [0.022, -2.1],
        [0.03, -2.12],
        [0.022, -2.14],
        [0.008, -2.24],
        [0.016, -2.265],
        [0.0015, -2.3],
      ].map((q) => new Vector2(q[0], q[1])),
      22,
      { flip: true },
    )
    const m = M(g, MAT.brass, sub, 'spike')
    m.position.y = tailY
  }

  /* ================================================================ *
   *  FINS with lamp pods                                             *
   * ================================================================ */
  function buildPod(scale = 1): Group {
    const P = new Group()
    const prof = splinePts(
      [
        [0.0015, 0.27],
        [0.052, 0.22],
        [0.092, 0.12],
        [0.105, 0.0],
        [0.09, -0.11],
        [0.068, -0.175],
        [0.054, -0.205],
      ],
      24,
    ).map((p) => new Vector2(p.x * scale, p.y * scale))
    M(latheZ(prof, 30, { flip: true }), MAT.porcelain, P, 'pod')
    const nose = latheZ(
      [
        [0.0015, 0.275],
        [0.036, 0.235],
        [0.055, 0.19],
      ].map((q) => new Vector2(q[0] * scale, q[1] * scale)),
      20,
      { flip: true },
    )
    M(nose, MAT.brass, P, 'podNose')
    const band = ringPoints(V3(0, 0, 0.06 * scale), V3(1, 0, 0), V3(0, 1, 0), 0.1035 * scale, 26)
    band.push(band[0].clone())
    M(sweepTube(band, 0.006 * scale, 8), MAT.brass, P)
    const lr = latheZ(
      [
        [0.028, -0.24],
        [0.054, -0.225],
        [0.058, -0.205],
        [0.05, -0.195],
      ].map((q) => new Vector2(q[0] * scale, q[1] * scale)),
      18,
    )
    M(lr, MAT.brass, P)
    const bm = M(new SphereGeometry(0.042 * scale, 16, 12), MAT.lampGlass, P)
    bm.position.z = -0.225 * scale
    bm.castShadow = false
    M(new SphereGeometry(0.02 * scale, 10, 8), MAT.lampCore, P).position.z = -0.225 * scale
    return P
  }

  function buildFin(): Group {
    const F = new Group()
    const f = D.finH
    const x0 = 0.72
    const x1 = 1.25
    const stN = 8
    const st: FinStation[] = []
    const leZ = (s: number): number => lerp(f.rootZ0, f.tipZ0, smooth01(s) * 0.9 + s * 0.1)
    const teZ = (s: number): number => lerp(f.rootZ1, f.tipZ1, s)
    for (let i = 0; i <= stN; i++) {
      const s = i / stN
      const x = lerp(x0, x1, s)
      const y = 0.01 + Math.sin(f.dihedral) * (x - x0)
      let le = leZ(s)
      let te = teZ(s)
      if (i === stN) {
        const mid = (le + te) / 2
        const half = ((te - le) / 2) * 0.42 // rounded tip
        le = mid - half
        te = mid + half
      }
      st.push({ le: V3(x, y, le), te: V3(x, y, te), up: V3(0, 1, 0), thick: lerp(0.075, 0.026, Math.pow(s, 0.8)) })
    }
    M(finLoft(st, 34, { flip: true }), MAT.porcelain, F, 'fin')
    /* gilt edge: LE → tip → TE */
    const edge: Vector3[] = []
    for (let i = 0; i <= stN; i++) edge.push(V3(st[i].le.x, st[i].le.y, st[i].le.z))
    for (let i = stN; i >= 0; i--) edge.push(V3(st[i].te.x, st[i].te.y, st[i].te.z))
    M(sweepTube(edge, 0.0075, 8, { roundEnds: true }), MAT.brass, F, 'finEdge')
    /* inset coach-line at 22% chord */
    const inset: Vector3[] = []
    for (let i = 0; i <= stN; i++) {
      const q = st[i]
      inset.push(V3(q.le.x, q.le.y + q.thick * 0.5 + 0.002, lerp(q.le.z, q.te.z, 0.22)))
    }
    M(sweepTube(inset, 0.0045, 6, { roundEnds: true }), MAT.brass, F, 'finLine')
    const pod = buildPod(1)
    pod.position.set(x1 + 0.02, 0.01 + Math.sin(f.dihedral) * (x1 - x0), -1.42)
    F.add(pod)
    return F
  }

  {
    const finR = buildFin()
    sub.add(finR)
    const finL = buildFin()
    finL.scale.x = -1
    sub.add(finL)
    for (const s of [-1, 1]) {
      const g2 = buildFin()
      g2.scale.set(s * 0.56, 0.56, 0.78)
      g2.position.set(0, tailY - 0.02, -0.42)
      g2.rotation.z = -s * MathUtils.degToRad(55)
      sub.add(g2)
    }
  }

  sub.scale.setScalar(SUBMARINE_SCALE)

  const geometries = new Set<BufferGeometry>()
  sub.traverse((node) => {
    const mesh = node as Mesh
    if (mesh.isMesh) geometries.add(mesh.geometry)
  })

  return {
    group: sub,
    propeller: propGroup,
    helmWheel,
    dispose: () => {
      for (const geometry of geometries) geometry.dispose()
      for (const materialTexture of ownedTextures) materialTexture.dispose()
      for (const material of Object.values(MAT)) material.dispose()
    },
  }
}
