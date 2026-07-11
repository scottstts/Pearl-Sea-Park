import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  LatheGeometry,
  Matrix4,
  SphereGeometry,
  TorusGeometry,
  Vector2,
} from 'three'
import type { ParkMaterials } from '../materials/library'
import type { SlotWriter } from './writer'

/**
 * Art Nouveau module kit (plan §7). Real meters everywhere. Modules emit
 * into the slot writer; geometry prototypes are built once and reused.
 * The sea is air — buildings are open pavilions, glass is jewelry.
 */
export class ArchKit {
  private readonly m: ParkMaterials
  private readonly prototypes = new Map<string, BufferGeometry>()

  constructor(materials: ParkMaterials) {
    this.m = materials
  }

  private proto(key: string, build: () => BufferGeometry): BufferGeometry {
    let geometry = this.prototypes.get(key)
    if (!geometry) {
      geometry = build()
      this.prototypes.set(key, geometry)
    }
    return geometry
  }

  /** Fluted column with plinth, shaft, and brass capital. Height from floor. */
  column(w: SlotWriter, x: number, y: number, z: number, height = 7, radius = 0.33): void {
    const plinth = this.proto('col-plinth', () => new BoxGeometry(1, 0.35, 1))
    const base = this.proto('col-base', () => new TorusGeometry(1, 0.3, 10, 24))
    const shaft = this.proto('col-shaft', () => new CylinderGeometry(0.82, 1, 1, 20, 1))
    const neck = this.proto('col-neck', () => new TorusGeometry(0.86, 0.14, 8, 24))
    const cap = this.proto('col-cap', () =>
      new CylinderGeometry(1.5, 0.85, 0.55, 20, 1),
    )
    const abacus = this.proto('col-abacus', () => new BoxGeometry(2.4, 0.22, 2.4))

    const r = radius
    const shaftHeight = height - 1.1
    this.place(w, this.m.marble, plinth, x, y + 0.175, z, 0, r * 2.4)
    this.placeScaled(w, this.m.brass, base, x, y + 0.42, z, r * 1.05, r * 0.5, r * 1.05, Math.PI / 2)
    this.placeScaled(w, this.m.marble, shaft, x, y + 0.45 + shaftHeight / 2, z, r, shaftHeight, r)
    this.placeScaled(w, this.m.brass, neck, x, y + height - 0.62, z, r, r, r, Math.PI / 2)
    this.placeScaled(w, this.m.brass, cap, x, y + height - 0.33, z, r, 1, r)
    this.place(w, this.m.marble, abacus, x, y + height - 0.02, z, 0, r)
  }

  /** Semi-elliptical arch between two points (columns' tops). */
  arch(w: SlotWriter, x1: number, z1: number, x2: number, z2: number, y: number, rise = 1.6): void {
    const arc = this.proto('arch-arc', () => new TorusGeometry(1, 0.09, 10, 28, Math.PI))
    const dx = x2 - x1
    const dz = z2 - z1
    const span = Math.hypot(dx, dz)
    const yaw = Math.atan2(dz, dx)
    // Half-torus is already in a vertical plane; scale to span/rise, then yaw.
    const composed = new Matrix4()
      .makeScale(span / 2, rise, 1.7)
      .premultiply(new Matrix4().makeRotationY(-yaw))
    composed.setPosition((x1 + x2) / 2, y, (z1 + z2) / 2)
    w.emit(this.m.verdigris, arc, composed)
  }

  /** Balustrade run: rail + turned balusters between two points. */
  balustrade(w: SlotWriter, x1: number, z1: number, x2: number, z2: number, y: number): void {
    const rail = this.proto('bal-rail', () => new BoxGeometry(1, 0.07, 0.12))
    const lowerRail = this.proto('bal-lower-rail', () => new BoxGeometry(1, 0.045, 0.08))
    const post = this.proto('bal-post', () =>
      new LatheGeometry(
        [
          new Vector2(0.055, 0),
          new Vector2(0.075, 0.06),
          new Vector2(0.035, 0.22),
          new Vector2(0.075, 0.52),
          new Vector2(0.05, 0.72),
          new Vector2(0.085, 0.8),
        ],
        10,
      ),
    )
    const dx = x2 - x1
    const dz = z2 - z1
    const length = Math.hypot(dx, dz)
    const yaw = Math.atan2(dz, dx)
    const composed = new Matrix4().makeScale(length, 1, 1).premultiply(new Matrix4().makeRotationY(-yaw))
    composed.setPosition((x1 + x2) / 2, y + 0.84, (z1 + z2) / 2)
    w.emit(this.m.brass, rail, composed)
    const lower = composed.clone()
    lower.elements[13] = y + 0.17
    w.emit(this.m.verdigris, lowerRail, lower)

    const count = Math.max(2, Math.round(length / 0.42))
    for (let i = 0; i <= count; i++) {
      const t = i / count
      w.place(this.m.marble, post, x1 + dx * t, y, z1 + dz * t, 0, 1)
    }
    const terminal = this.proto('bal-terminal', () => new SphereGeometry(0.11, 10, 7))
    w.place(this.m.brass, terminal, x1, y + 0.86, z1)
    w.place(this.m.brass, terminal, x2, y + 0.86, z2)
  }

  /** Layered entablature between columns: readable shadow lines, dentils, and crest rail. */
  cornice(w: SlotWriter, x1: number, z1: number, x2: number, z2: number, y: number): void {
    const beam = this.proto('cornice-beam', () => new BoxGeometry(1, 1, 1))
    const dx = x2 - x1
    const dz = z2 - z1
    const length = Math.hypot(dx, dz)
    const yaw = Math.atan2(dz, dx)
    const placeRun = (height: number, depth: number, atY: number, material: ParkMaterials['brass' | 'marble' | 'verdigris']) => {
      const matrix = new Matrix4()
        .makeScale(length, height, depth)
        .premultiply(new Matrix4().makeRotationY(-yaw))
      matrix.setPosition((x1 + x2) / 2, atY, (z1 + z2) / 2)
      w.emit(material, beam, matrix)
    }
    placeRun(0.28, 0.36, y, this.m.marble)
    placeRun(0.09, 0.54, y + 0.2, this.m.brass)
    placeRun(0.08, 0.3, y - 0.2, this.m.verdigris)

    const dentil = this.proto('cornice-dentil', () => new BoxGeometry(0.22, 0.16, 0.42))
    const count = Math.max(2, Math.floor(length / 0.72))
    for (let i = 0; i <= count; i++) {
      const t = i / count
      w.place(this.m.brass, dentil, x1 + dx * t, y - 0.32, z1 + dz * t, -yaw)
    }
  }

  /** Ribbed glass dome with brass ribs, base ring, and finial. */
  dome(w: SlotWriter, x: number, y: number, z: number, radius: number, ribs = 12): void {
    const shell = this.proto(`dome-shell`, () => new SphereGeometry(1, 40, 22, 0, Math.PI * 2, 0, Math.PI / 2))
    const rib = this.proto('dome-rib', () => new TorusGeometry(1, 0.055, 8, 26, Math.PI / 2))
    // Rings are radius-keyed: uniform-scaling a unit torus fattens the tube
    // with the major radius (a r=8 dome would wear a 1.3 m brass donut).
    const ring = this.proto(`dome-ring-${radius.toFixed(1)}`, () => new TorusGeometry(radius, 0.16, 10, 64))
    const finial = this.proto('dome-finial', () =>
      new LatheGeometry(
        [
          new Vector2(0.24, 0),
          new Vector2(0.3, 0.12),
          new Vector2(0.08, 0.5),
          new Vector2(0.16, 0.9),
          new Vector2(0.0, 1.5),
        ],
        12,
      ),
    )
    this.placeScaled(w, this.m.glass, shell, x, y, z, radius * 0.995, radius * 0.815, radius * 0.995)
    for (let i = 0; i < ribs; i++) {
      const angle = (i / ribs) * Math.PI * 2
      // Quarter torus in XY already arcs equator→zenith; scale then yaw only.
      const composed = new Matrix4()
        .makeScale(radius * 1.012, radius * 0.828, 1)
        .premultiply(new Matrix4().makeRotationY(angle))
      composed.setPosition(x, y, z)
      w.emit(this.m.brass, rib, composed)
    }
    this.placeScaled(w, this.m.brass, ring, x, y + 0.05, z, 1, 1, 1, Math.PI / 2)
    this.place(w, this.m.brass, finial, x, y + radius * 0.82, z, 0, radius * 0.12)
  }

  /** Gabled glass roof with verdigris ridge (midway hall). */
  gableRoof(w: SlotWriter, cx: number, y: number, cz: number, width: number, depth: number, rise: number): void {
    const panel = this.proto('roof-panel', () => new BoxGeometry(1, 0.05, 1))
    const ridge = this.proto('roof-ridge', () => new CylinderGeometry(0.09, 0.09, 1, 10))
    const slopeLength = Math.hypot(depth / 2, rise)
    const pitch = Math.atan2(rise, depth / 2)
    for (const side of [-1, 1]) {
      const composed = new Matrix4()
        .makeScale(width, 1, slopeLength)
        .premultiply(new Matrix4().makeRotationX(side * pitch))
      composed.setPosition(cx, y + rise / 2, cz + (side * depth) / 4)
      w.emit(this.m.glass, panel, composed)
    }
    const ridgeMatrix = new Matrix4()
      .makeScale(1, width, 1)
      .premultiply(new Matrix4().makeRotationZ(Math.PI / 2))
    ridgeMatrix.setPosition(cx, y + rise, cz)
    w.emit(this.m.verdigris, ridge, ridgeMatrix)
    const edge = this.proto('roof-edge', () => new BoxGeometry(1, 0.12, 0.12))
    for (const end of [-1, 1]) {
      const run = new Matrix4().makeScale(width + 0.5, 1, 1)
      run.setPosition(cx, y, cz + end * depth / 2)
      w.emit(this.m.brass, edge, run)
    }
  }

  /** Brass ticket-punch machine: pedestal, dial face, domed cap. */
  ticketMachine(w: SlotWriter, x: number, y: number, z: number, yaw = 0): void {
    const pedestal = this.proto('tm-pedestal', () => new BoxGeometry(0.62, 1.15, 0.5))
    const face = this.proto('tm-face', () => new CylinderGeometry(0.21, 0.21, 0.06, 24))
    const cap = this.proto('tm-cap', () => new SphereGeometry(0.36, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2))
    const slot = this.proto('tm-slot', () => new BoxGeometry(0.2, 0.03, 0.08))

    w.place(this.m.woodDark, pedestal, x, y + 0.575, z, yaw)
    const faceMatrix = new Matrix4().makeRotationX(Math.PI / 2)
    faceMatrix.premultiply(new Matrix4().makeRotationY(yaw))
    faceMatrix.setPosition(
      x - Math.sin(yaw) * 0.26,
      y + 0.95,
      z - Math.cos(yaw) * 0.26,
    )
    w.emit(this.m.brass, face, faceMatrix)
    w.place(this.m.brass, cap, x, y + 1.15, z, yaw)
    w.place(this.m.brass, slot, x - Math.sin(yaw) * 0.28, y + 0.72, z - Math.cos(yaw) * 0.28, yaw)
  }

  /** Circular mosaic floor plate with marble curb. */
  mosaicPlaza(w: SlotWriter, x: number, y: number, z: number, radius: number): void {
    const plate = this.proto('plaza-plate', () => new CylinderGeometry(1, 1, 0.18, 56))
    const curb = this.proto(`plaza-curb-${radius.toFixed(1)}`, () => new TorusGeometry(radius, 0.09, 10, 72))
    this.placeScaled(w, this.m.mosaic, plate, x, y + 0.09, z, radius, 1, radius)
    this.placeScaled(w, this.m.marble, curb, x, y + 0.18, z, 1, 1, 1, Math.PI / 2)
  }

  /** Straight mosaic path plate between two points. */
  mosaicPath(w: SlotWriter, x1: number, z1: number, x2: number, z2: number, y: number, width: number): void {
    const plate = this.proto('path-plate', () => new BoxGeometry(1, 0.16, 1))
    const dx = x2 - x1
    const dz = z2 - z1
    const length = Math.hypot(dx, dz)
    const yaw = Math.atan2(dx, dz)
    const composed = new Matrix4()
      .makeScale(width, 1, length)
      .premultiply(new Matrix4().makeRotationY(yaw))
    composed.setPosition((x1 + x2) / 2, y + 0.08, (z1 + z2) / 2)
    w.emit(this.m.mosaic, plate, composed)
    const curb = this.proto('path-curb', () => new BoxGeometry(0.18, 0.14, 1))
    const inlay = this.proto('path-inlay', () => new BoxGeometry(0.055, 0.018, 1))
    const nx = -dz / Math.max(length, 0.001)
    const nz = dx / Math.max(length, 0.001)
    for (const side of [-1, 1]) {
      const curbMatrix = new Matrix4()
        .makeScale(1, 1, length)
        .premultiply(new Matrix4().makeRotationY(yaw))
      curbMatrix.setPosition(
        (x1 + x2) / 2 + nx * (width / 2 - 0.07) * side,
        y + 0.17,
        (z1 + z2) / 2 + nz * (width / 2 - 0.07) * side,
      )
      w.emit(this.m.marble, curb, curbMatrix)
      const inlayMatrix = new Matrix4()
        .makeScale(1, 1, length)
        .premultiply(new Matrix4().makeRotationY(yaw))
      inlayMatrix.setPosition(
        (x1 + x2) / 2 + nx * (width * 0.32) * side,
        y + 0.171,
        (z1 + z2) / 2 + nz * (width * 0.32) * side,
      )
      w.emit(this.m.brass, inlay, inlayMatrix)
    }
  }

  /** Café table: marble round top on brass column, with two stools. */
  table(w: SlotWriter, x: number, y: number, z: number): void {
    const top = this.proto('table-top', () => new CylinderGeometry(0.45, 0.45, 0.05, 22))
    const stem = this.proto('table-stem', () => new CylinderGeometry(0.05, 0.09, 0.72, 10))
    const foot = this.proto('table-foot', () => new CylinderGeometry(0.24, 0.28, 0.05, 14))
    const stool = this.proto('table-stool', () => new CylinderGeometry(0.19, 0.16, 0.48, 12))
    const rim = this.proto('table-rim', () => new TorusGeometry(0.45, 0.025, 7, 22))
    const stoolRing = this.proto('stool-ring', () => new TorusGeometry(0.16, 0.018, 6, 12))
    w.place(this.m.marble, top, x, y + 0.76, z)
    w.place(this.m.brass, stem, x, y + 0.38, z)
    w.place(this.m.brass, foot, x, y + 0.03, z)
    this.placeScaled(w, this.m.brass, rim, x, y + 0.785, z, 1, 1, 1, Math.PI / 2)
    for (const [sx, sz, yaw] of [[0.75, 0.1, 0], [-0.62, -0.42, 2.2], [-0.16, 0.82, -1.3]] as const) {
      w.place(this.m.woodDark, stool, x + sx, y + 0.24, z + sz, yaw)
      this.placeScaled(w, this.m.brass, stoolRing, x + sx, y + 0.48, z + sz, 1, 1, 1, Math.PI / 2)
    }
  }

  /** Sculptural planter/marker, used sparingly at gates and path junctions. */
  urn(w: SlotWriter, x: number, y: number, z: number, scale = 1): void {
    const body = this.proto('urn-body', () => new LatheGeometry([
      new Vector2(0.22, 0), new Vector2(0.35, 0.08), new Vector2(0.31, 0.22),
      new Vector2(0.46, 0.5), new Vector2(0.4, 0.78), new Vector2(0.24, 0.92),
      new Vector2(0.48, 1.02),
    ], 18))
    const pearl = this.proto('urn-pearl', () => new SphereGeometry(0.12, 12, 8))
    w.place(this.m.verdigris, body, x, y, z, 0, scale)
    w.place(this.m.nacre, pearl, x, y + scale * 1.13, z, 0, scale)
  }

  /** Low steps ring (two treads) around a plaza. */
  stepsRing(w: SlotWriter, x: number, y: number, z: number, radius: number): void {
    const stepRadius = radius + 0.55
    const tread = this.proto('steps-tread', () => new CylinderGeometry(1, 1, 0.14, 56, 1, true))
    const cap = this.proto(`steps-cap-${stepRadius.toFixed(1)}`, () => new TorusGeometry(stepRadius, 0.07, 8, 72))
    this.placeScaled(w, this.m.marble, tread, x, y + 0.07, z, stepRadius, 1, stepRadius)
    this.placeScaled(w, this.m.marble, cap, x, y + 0.14, z, 1, 1, 1, Math.PI / 2)
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private place(
    w: SlotWriter,
    material: Parameters<SlotWriter['place']>[0],
    geometry: BufferGeometry,
    x: number,
    y: number,
    z: number,
    rotationY = 0,
    scale = 1,
  ): void {
    w.place(material, geometry, x, y, z, rotationY, scale)
  }

  private placeScaled(
    w: SlotWriter,
    material: Parameters<SlotWriter['place']>[0],
    geometry: BufferGeometry,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    rotationX = 0,
  ): void {
    const composed = new Matrix4().makeScale(sx, sy, sz)
    if (rotationX !== 0) composed.premultiply(new Matrix4().makeRotationX(rotationX))
    composed.setPosition(x, y, z)
    w.emit(material, geometry, composed)
  }
}
