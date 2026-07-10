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

    const count = Math.max(2, Math.round(length / 0.42))
    for (let i = 0; i <= count; i++) {
      const t = i / count
      w.place(this.m.marble, post, x1 + dx * t, y, z1 + dz * t, 0, 1)
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

  /** Iron lamp post with one warm globe. Returns globe position for lights. */
  lampPost(w: SlotWriter, x: number, y: number, z: number): { x: number; y: number; z: number } {
    const post = this.proto('lamp-post', () => new CylinderGeometry(0.05, 0.09, 1, 10))
    const collar = this.proto('lamp-collar', () => new TorusGeometry(0.09, 0.025, 8, 16))
    const arm = this.proto('lamp-arm', () => new TorusGeometry(0.35, 0.03, 8, 20, Math.PI * 0.75))
    const globe = this.proto('lamp-globe', () => new SphereGeometry(0.16, 18, 12))

    const height = 3.4
    this.placeScaled(w, this.m.iron, post, x, y + height / 2, z, 1, height, 1)
    this.placeScaled(w, this.m.iron, collar, x, y + 1.1, z, 1, 1, 1, Math.PI / 2)
    const composed = new Matrix4().makeRotationZ(-0.2)
    composed.setPosition(x + 0.18, y + height, z)
    w.emit(this.m.iron, arm, composed)
    const globePos = { x: x + 0.5, y: y + height + 0.16, z }
    w.place(this.m.lampGlobe, globe, globePos.x, globePos.y, globePos.z)
    return globePos
  }

  /** Park bench: iron scroll sides, wood slats. Faces -z before yaw. */
  bench(w: SlotWriter, x: number, y: number, z: number, yaw = 0): void {
    const slat = this.proto('bench-slat', () => new BoxGeometry(1.7, 0.035, 0.09))
    const side = this.proto('bench-side', () => new TorusGeometry(0.3, 0.035, 8, 18, Math.PI * 1.25))
    const leg = this.proto('bench-leg', () => new CylinderGeometry(0.035, 0.045, 0.45, 8))

    const rotate = (px: number, pz: number): [number, number] => [
      x + px * Math.cos(yaw) - pz * Math.sin(yaw),
      z + px * Math.sin(yaw) + pz * Math.cos(yaw),
    ]
    for (let i = 0; i < 4; i++) {
      const [sx, sz] = rotate(0, -0.09 + i * 0.09)
      w.place(this.m.woodDark, slat, sx, y + 0.45 + (i > 1 ? (i - 1) * 0.001 : 0), sz, yaw)
    }
    for (let i = 0; i < 3; i++) {
      const [sx, sz] = rotate(0, 0.21 + i * 0.07)
      w.place(this.m.woodDark, slat, sx, y + 0.62 + i * 0.14, sz, yaw)
    }
    for (const sideX of [-0.8, 0.8]) {
      const [px, pz] = rotate(sideX, 0.05)
      const composed = new Matrix4().makeRotationY(yaw + Math.PI / 2)
      composed.setPosition(px, y + 0.42, pz)
      w.emit(this.m.iron, side, composed)
      const [lx, lz] = rotate(sideX, -0.12)
      w.place(this.m.iron, leg, lx, y + 0.22, lz, yaw)
      const [bx, bz] = rotate(sideX, 0.18)
      w.place(this.m.iron, leg, bx, y + 0.22, bz, yaw)
    }
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
  }

  /** Café table: marble round top on brass column, with two stools. */
  table(w: SlotWriter, x: number, y: number, z: number): void {
    const top = this.proto('table-top', () => new CylinderGeometry(0.45, 0.45, 0.05, 22))
    const stem = this.proto('table-stem', () => new CylinderGeometry(0.05, 0.09, 0.72, 10))
    const foot = this.proto('table-foot', () => new CylinderGeometry(0.24, 0.28, 0.05, 14))
    const stool = this.proto('table-stool', () => new CylinderGeometry(0.19, 0.16, 0.48, 12))
    w.place(this.m.marble, top, x, y + 0.76, z)
    w.place(this.m.brass, stem, x, y + 0.38, z)
    w.place(this.m.brass, foot, x, y + 0.03, z)
    w.place(this.m.woodDark, stool, x + 0.75, y + 0.24, z + 0.1)
    w.place(this.m.woodDark, stool, x - 0.62, y + 0.24, z - 0.42)
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
