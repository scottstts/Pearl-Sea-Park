import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  LatheGeometry,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
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

  /** Fluted marble column with entasis, brass ogee capital ringed by leaf
   *  fronds, and a bead under the abacus. Height from floor. The shaft is a
   *  genuinely fluted solid (18 concave flutes carved into the cylinder,
   *  with the classical mid-height swell) — light raking across a colonnade
   *  now draws a ridge-and-hollow rhythm instead of a smooth pipe. */
  column(w: SlotWriter, x: number, y: number, z: number, height = 7, radius = 0.33): void {
    const plinth = this.proto('col-plinth', () => new BoxGeometry(1, 0.35, 1))
    const base = this.proto('col-base', () => new TorusGeometry(1, 0.3, 10, 24))
    const shaft = this.proto('col-shaft-fluted', () => flutedShaftGeometry(18, 0.05))
    const neck = this.proto('col-neck', () => new TorusGeometry(0.86, 0.14, 8, 24))
    const cap = this.proto('col-cap-ogee', () =>
      new LatheGeometry(
        [
          new Vector2(0.82, 0),
          new Vector2(0.9, 0.05),
          new Vector2(0.84, 0.12),
          new Vector2(0.86, 0.2),
          new Vector2(1.02, 0.3),
          new Vector2(1.28, 0.4),
          new Vector2(1.46, 0.48),
          new Vector2(1.5, 0.55),
          new Vector2(0.0, 0.55),
        ],
        24,
      ),
    )
    const leaf = this.proto('col-leaf', () => {
      const petal = new SphereGeometry(1, 8, 6)
      petal.scale(0.09, 0.3, 0.045)
      return petal
    })
    const bead = this.proto('col-bead', () => new TorusGeometry(1.42, 0.05, 8, 28))
    const abacus = this.proto('col-abacus', () => new BoxGeometry(2.4, 0.22, 2.4))

    const r = radius
    const shaftHeight = height - 1.1
    this.place(w, this.m.marble, plinth, x, y + 0.175, z, 0, r * 2.4)
    this.placeScaled(w, this.m.brass, base, x, y + 0.42, z, r * 1.05, r * 0.5, r * 1.05, Math.PI / 2)
    this.placeScaled(w, this.m.marble, shaft, x, y + 0.45 + shaftHeight / 2, z, r, shaftHeight, r)
    this.placeScaled(w, this.m.brass, neck, x, y + height - 0.62, z, r, r, r, Math.PI / 2)
    // Ogee capital: lathe bottom rests on the neck, top meets the abacus.
    const capScaleY = r * 0.9 + 0.5
    this.placeScaled(w, this.m.brass, cap, x, y + height - 0.13 - 0.55 * capScaleY, z, r, capScaleY, r)
    // Eight verdigris leaf fronds cup the capital, tips leaning outward —
    // the stylized acanthus ring that makes the order read Art Nouveau.
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2
      const lx = x + Math.sin(angle) * r * 0.98
      const lz = z + Math.cos(angle) * r * 0.98
      const composed = new Matrix4()
        .makeRotationX(0.32)
        .premultiply(new Matrix4().makeRotationY(angle))
        .scale(new Vector3(r * 2.6, r * 2.6, r * 2.6))
      composed.setPosition(lx, y + height - 0.42, lz)
      w.emit(this.m.verdigris, leaf, composed)
    }
    this.placeScaled(w, this.m.brass, bead, x, y + height - 0.12, z, r, r, r, Math.PI / 2)
    this.place(w, this.m.marble, abacus, x, y + height - 0.02, z, 0, r)
  }

  /** Semi-elliptical arch between two points (columns' tops): a broad
   *  verdigris archivolt with a slimmer brass moulding rib tucked inside it,
   *  a marble keystone crowning the apex, and brass rosettes at both
   *  springing points — the whiplash-curve trim that keeps a plain half
   *  torus from reading as a pipe bend. */
  arch(w: SlotWriter, x1: number, z1: number, x2: number, z2: number, y: number, rise = 1.6): void {
    const arc = this.proto('arch-arc', () => new TorusGeometry(1, 0.09, 10, 28, Math.PI))
    const rib = this.proto('arch-rib', () => new TorusGeometry(1, 0.045, 8, 28, Math.PI))
    const keystone = this.proto('arch-keystone', () => {
      const stone = new CylinderGeometry(0.16, 0.11, 0.5, 4, 1)
      stone.rotateY(Math.PI / 4)
      return stone
    })
    const rosette = this.proto('arch-rosette', () => new SphereGeometry(0.1, 10, 8))
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
    const inner = new Matrix4()
      .makeScale(span / 2 - 0.14, rise * 0.9, 1.0)
      .premultiply(new Matrix4().makeRotationY(-yaw))
    inner.setPosition((x1 + x2) / 2, y, (z1 + z2) / 2)
    w.emit(this.m.brass, rib, inner)
    const keyMatrix = new Matrix4().makeRotationY(-yaw)
    keyMatrix.setPosition((x1 + x2) / 2, y + rise * 0.97, (z1 + z2) / 2)
    w.emit(this.m.marble, keystone, keyMatrix)
    w.place(this.m.brass, rosette, x1, y + 0.02, z1)
    w.place(this.m.brass, rosette, x2, y + 0.02, z2)
  }

  /** Balustrade run: profiled rail with a brass half-round cap + turned
   *  vase balusters between two points. */
  balustrade(w: SlotWriter, x1: number, z1: number, x2: number, z2: number, y: number): void {
    const rail = this.proto('bal-rail', () => new BoxGeometry(1, 0.07, 0.12))
    const railCap = this.proto('bal-rail-cap', () => {
      const cap = new CylinderGeometry(0.032, 0.032, 1, 10)
      cap.rotateZ(Math.PI / 2)
      return cap
    })
    const lowerRail = this.proto('bal-lower-rail', () => new BoxGeometry(1, 0.045, 0.08))
    const post = this.proto('bal-post', () =>
      new LatheGeometry(
        [
          new Vector2(0.055, 0),
          new Vector2(0.078, 0.045),
          new Vector2(0.06, 0.09),
          new Vector2(0.034, 0.2),
          new Vector2(0.052, 0.3),
          new Vector2(0.078, 0.46),
          new Vector2(0.07, 0.56),
          new Vector2(0.046, 0.68),
          new Vector2(0.065, 0.75),
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
    const cap = composed.clone()
    cap.elements[13] = y + 0.9
    w.emit(this.m.brass, railCap, cap)
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
    // Latitude rings complete the glazing grid: meridian ribs alone read as
    // a bare cage. Radius-keyed (tube must not scale with the dome), seated
    // fractionally proud of the glass so they never z-fight it.
    for (const lat of [0.42, 0.82]) {
      const latRadius = radius * Math.cos(lat) * 1.008
      const latY = radius * 0.815 * Math.sin(lat)
      const band = this.proto(`dome-lat-${radius.toFixed(1)}-${lat}`, () =>
        new TorusGeometry(latRadius, 0.05, 8, 64),
      )
      this.placeScaled(w, this.m.brass, band, x, y + latY, z, 1, 1, 1, Math.PI / 2)
    }
    this.placeScaled(w, this.m.brass, ring, x, y + 0.05, z, 1, 1, 1, Math.PI / 2)
    this.place(w, this.m.brass, finial, x, y + radius * 0.82, z, 0, radius * 0.12)
    const finialPearl = this.proto('dome-finial-pearl', () => new SphereGeometry(1, 14, 10))
    this.place(w, this.m.nacre, finialPearl, x, y + radius * 0.82 + radius * 0.187, z, 0, radius * 0.028)
  }

  /** Gabled glass roof with verdigris ridge, brass glazing bars dividing the
   *  panes, eave rails, and lathe finials at both ridge ends (midway hall). */
  gableRoof(w: SlotWriter, cx: number, y: number, cz: number, width: number, depth: number, rise: number): void {
    const panel = this.proto('roof-panel', () => new BoxGeometry(1, 0.05, 1))
    const ridge = this.proto('roof-ridge', () => new CylinderGeometry(0.09, 0.09, 1, 10))
    const bar = this.proto('roof-bar', () => new BoxGeometry(0.055, 0.075, 1))
    const slopeLength = Math.hypot(depth / 2, rise)
    const pitch = Math.atan2(rise, depth / 2)
    for (const side of [-1, 1]) {
      const composed = new Matrix4()
        .makeScale(width, 1, slopeLength)
        .premultiply(new Matrix4().makeRotationX(side * pitch))
      composed.setPosition(cx, y + rise / 2, cz + (side * depth) / 4)
      w.emit(this.m.glass, panel, composed)
      // Glazing bars ride each slope every ~2.2 m — the iron-and-glass grid
      // is what makes a glass roof read as architecture instead of a sheet.
      const bars = Math.max(2, Math.round(width / 2.2))
      for (let i = 0; i <= bars; i++) {
        const bx = cx - width / 2 + (i / bars) * width
        const barMatrix = new Matrix4()
          .makeScale(1, 1, slopeLength)
          .premultiply(new Matrix4().makeRotationX(side * pitch))
        barMatrix.setPosition(bx, y + rise / 2 + 0.05, cz + (side * depth) / 4)
        w.emit(this.m.brass, bar, barMatrix)
      }
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
    // Ridge-end finials: a turned spike and pearl closing each gable point.
    const ridgeFinial = this.proto('roof-finial', () =>
      new LatheGeometry(
        [
          new Vector2(0.14, 0),
          new Vector2(0.18, 0.07),
          new Vector2(0.05, 0.26),
          new Vector2(0.09, 0.42),
          new Vector2(0.0, 0.66),
        ],
        12,
      ),
    )
    const ridgePearl = this.proto('roof-finial-pearl', () => new SphereGeometry(0.07, 10, 8))
    for (const end of [-1, 1]) {
      w.place(this.m.brass, ridgeFinial, cx + end * (width / 2), y + rise - 0.04, cz)
      w.place(this.m.nacre, ridgePearl, cx + end * (width / 2), y + rise + 0.66, cz)
    }
  }

  /** Brass ticket-punch machine: panelled cabinet, nacre punch dial in a
   *  riveted bezel with clock hands, side crank, ticket slot with a brass
   *  presentation lip, claw feet, and a pearl atop the domed cap — the
   *  Atrium's first hands-on machine deserves watchmaker's finish. */
  ticketMachine(w: SlotWriter, x: number, y: number, z: number, yaw = 0): void {
    const pedestal = this.proto('tm-pedestal', () => new BoxGeometry(0.62, 1.15, 0.5))
    const panel = this.proto('tm-panel', () => new BoxGeometry(0.5, 0.72, 0.03))
    const bezel = this.proto('tm-bezel', () => new TorusGeometry(0.22, 0.028, 8, 28))
    const face = this.proto('tm-face', () => new CylinderGeometry(0.21, 0.21, 0.06, 24))
    const hand = this.proto('tm-hand', () => new BoxGeometry(0.022, 0.16, 0.012))
    const cap = this.proto('tm-cap', () => new SphereGeometry(0.36, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2))
    const capPearl = this.proto('tm-pearl', () => new SphereGeometry(0.075, 12, 9))
    const slot = this.proto('tm-slot', () => new BoxGeometry(0.2, 0.03, 0.08))
    const lip = this.proto('tm-lip', () => new BoxGeometry(0.24, 0.02, 0.1))
    const crankArm = this.proto('tm-crank-arm', () => new BoxGeometry(0.035, 0.22, 0.035))
    const crankAxle = this.proto('tm-crank-axle', () => {
      const axle = new CylinderGeometry(0.028, 0.028, 0.16, 10)
      axle.rotateZ(Math.PI / 2)
      return axle
    })
    const crankKnob = this.proto('tm-crank-knob', () => new SphereGeometry(0.045, 10, 8))
    const foot = this.proto('tm-foot', () => new SphereGeometry(0.05, 8, 6))

    const sinYaw = Math.sin(yaw)
    const cosYaw = Math.cos(yaw)
    const forward = (distance: number) => ({ fx: x - sinYaw * distance, fz: z - cosYaw * distance })
    const sideways = (distance: number) => ({ sx: x + cosYaw * distance, sz: z - sinYaw * distance })

    w.place(this.m.woodDark, pedestal, x, y + 0.575, z, yaw)
    // Verdigris face panel frames the dial on the guest side.
    const panelAt = forward(0.255)
    w.place(this.m.verdigris, panel, panelAt.fx, y + 0.82, panelAt.fz, yaw)
    const faceMatrix = new Matrix4().makeRotationX(Math.PI / 2)
    faceMatrix.premultiply(new Matrix4().makeRotationY(yaw))
    const faceAt = forward(0.26)
    faceMatrix.setPosition(faceAt.fx, y + 0.95, faceAt.fz)
    w.emit(this.m.nacre, face, faceMatrix)
    const bezelAt = forward(0.285)
    const bezelMatrix = new Matrix4().makeRotationY(yaw)
    bezelMatrix.setPosition(bezelAt.fx, y + 0.95, bezelAt.fz)
    w.emit(this.m.brass, bezel, bezelMatrix)
    // Punch-dial hands, frozen at ten past golden hour.
    for (const [lean, length] of [
      [0.6, 1],
      [-2.1, 0.68],
    ] as const) {
      const handMatrix = new Matrix4()
        .makeScale(1, length, 1)
        .premultiply(new Matrix4().makeRotationZ(lean))
        .premultiply(new Matrix4().makeRotationY(yaw))
      const handAt = forward(0.3)
      handMatrix.setPosition(handAt.fx, y + 0.95, handAt.fz)
      w.emit(this.m.iron, hand, handMatrix)
    }
    w.place(this.m.brass, cap, x, y + 1.15, z, yaw)
    w.place(this.m.nacre, capPearl, x, y + 1.5, z)
    const slotAt = forward(0.28)
    w.place(this.m.brass, slot, slotAt.fx, y + 0.72, slotAt.fz, yaw)
    const lipAt = forward(0.31)
    w.place(this.m.brass, lip, lipAt.fx, y + 0.7, lipAt.fz, yaw)
    // Side crank: axle through the cabinet wall, arm down, wooden knob.
    const crankAt = sideways(0.36)
    const axleMatrix = new Matrix4().makeRotationY(yaw)
    axleMatrix.setPosition(crankAt.sx, y + 0.9, crankAt.sz)
    w.emit(this.m.brass, crankAxle, axleMatrix)
    w.place(this.m.brass, crankArm, crankAt.sx, y + 0.8, crankAt.sz, yaw)
    w.place(this.m.woodDark, crankKnob, crankAt.sx, y + 0.7, crankAt.sz)
    for (const cornerX of [-1, 1]) {
      for (const cornerZ of [-1, 1]) {
        w.place(
          this.m.brass,
          foot,
          x + cosYaw * cornerX * 0.26 - sinYaw * cornerZ * 0.2,
          y + 0.02,
          z - sinYaw * cornerX * 0.26 - cosYaw * cornerZ * 0.2,
        )
      }
    }
  }

  /** Circular mosaic floor plate with marble curb, a brass compass-inlay
   *  ring, and a nacre centre medallion in its own brass collet. The
   *  medallion is a real 2.4 cm plinth — coplanar discs on plates z-fight
   *  in radiating star patterns (the turtle-lagoon lesson). */
  mosaicPlaza(w: SlotWriter, x: number, y: number, z: number, radius: number): void {
    const plate = this.proto('plaza-plate', () => new CylinderGeometry(1, 1, 0.18, 56))
    const curb = this.proto(`plaza-curb-${radius.toFixed(1)}`, () => new TorusGeometry(radius, 0.09, 10, 72))
    this.placeScaled(w, this.m.mosaic, plate, x, y + 0.09, z, radius, 1, radius)
    this.placeScaled(w, this.m.marble, curb, x, y + 0.18, z, 1, 1, 1, Math.PI / 2)
    const inlay = this.proto(`plaza-inlay-${radius.toFixed(1)}`, () =>
      new TorusGeometry(radius * 0.55, 0.03, 6, 64),
    )
    this.placeScaled(w, this.m.brass, inlay, x, y + 0.185, z, 1, 0.45, 1, Math.PI / 2)
    const medallion = this.proto('plaza-medallion', () =>
      new LatheGeometry(
        [
          new Vector2(0.5, 0),
          new Vector2(0.52, 0.012),
          new Vector2(0.46, 0.024),
          new Vector2(0.0, 0.024),
        ],
        40,
      ),
    )
    const medallionDisc = this.proto('plaza-medallion-disc', () =>
      new CylinderGeometry(0.4, 0.42, 0.02, 32),
    )
    const medallionScale = Math.max(1, radius * 0.09)
    this.place(w, this.m.brass, medallion, x, y + 0.18, z, 0, medallionScale)
    this.placeScaled(
      w,
      this.m.nacre,
      medallionDisc,
      x,
      y + 0.18 + 0.024 * medallionScale + 0.006,
      z,
      medallionScale,
      1,
      medallionScale,
    )
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

  /** Sculptural pedestal planter, used sparingly at gates and path junctions.
   *  A stepped marble plinth, a watertight verdigris vessel (closed clockwise
   *  lathe: base, cavetto foot, knopped stem, gadrooned bowl, rolled rim,
   *  interior wall and floor), a soil fill, and a live rosette of arcing
   *  sea-fern fronds around a nacre bud. Local origin: plinth bottom center.
   *  Planted height ≈ 1.45·scale; body radius ≈ 0.54·scale. */
  urn(w: SlotWriter, x: number, y: number, z: number, scale = 1): void {
    const plinthLow = this.proto('urn-plinth-low', () => new BoxGeometry(0.84, 0.09, 0.84))
    const plinthHigh = this.proto('urn-plinth-high', () => new BoxGeometry(0.72, 0.09, 0.72))
    const body = this.proto('urn-body', () => {
      const vessel = new LatheGeometry(
        [
          // Bottom (faces down onto the plinth).
          new Vector2(0.03, 0.16),
          new Vector2(0.31, 0.16),
          // Outer face, base to rim (ascending → faces outward).
          new Vector2(0.345, 0.2),
          new Vector2(0.33, 0.26),
          new Vector2(0.24, 0.31),
          new Vector2(0.185, 0.38),
          new Vector2(0.175, 0.46),
          new Vector2(0.24, 0.52),
          new Vector2(0.25, 0.565),
          new Vector2(0.21, 0.61),
          new Vector2(0.2, 0.66),
          new Vector2(0.3, 0.72),
          new Vector2(0.36, 0.76),
          new Vector2(0.4, 0.8),
          new Vector2(0.43, 0.84),
          new Vector2(0.455, 0.88),
          new Vector2(0.44, 0.925),
          new Vector2(0.48, 0.97),
          new Vector2(0.525, 1.02),
          new Vector2(0.535, 1.065),
          new Vector2(0.5, 1.095),
          // Rim top (inward → faces up), then interior wall (descending →
          // faces the bowl cavity) and floor. Closing the loop is the whole
          // point: the old open ribbon showed culled backfaces into the bowl.
          new Vector2(0.435, 1.1),
          new Vector2(0.415, 1.03),
          new Vector2(0.375, 0.92),
          new Vector2(0.3, 0.83),
          new Vector2(0.1, 0.79),
          new Vector2(0.03, 0.785),
          new Vector2(0.03, 0.16),
        ],
        40,
      )
      // The profile CALLS the bowl gadrooned — now it is: sixteen convex
      // lobes carved into the swell (y 0.7–0.93, fading at both ends), the
      // repoussé rhythm raking light picks up across a whole planter ring.
      const position = vessel.getAttribute('position')
      const vertex = new Vector3()
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i)
        const radial = Math.hypot(vertex.x, vertex.z)
        if (radial < 0.08) continue
        const zone =
          Math.max(0, Math.min(1, (vertex.y - 0.68) / 0.08)) *
          Math.max(0, Math.min(1, (0.95 - vertex.y) / 0.08))
        if (zone <= 0) continue
        const angle = Math.atan2(vertex.x, vertex.z)
        const lobe = Math.abs(Math.sin(angle * 8))
        const scale = 1 + 0.055 * lobe * zone
        position.setX(i, vertex.x * scale)
        position.setZ(i, vertex.z * scale)
      }
      position.needsUpdate = true
      vessel.computeVertexNormals()
      return vessel
    })
    const soilFill = this.proto('urn-soil', () => new CylinderGeometry(0.3, 0.24, 0.08, 20))
    const frondLong = this.proto('urn-frond-long', () =>
      frondGeometry([
        new Vector3(0.05, 0.84, 0),
        new Vector3(0.16, 1.1, 0),
        new Vector3(0.34, 1.27, 0),
        new Vector3(0.54, 1.33, 0),
      ]),
    )
    const frondShort = this.proto('urn-frond-short', () =>
      frondGeometry([
        new Vector3(0.03, 0.84, 0),
        new Vector3(0.08, 1.08, 0),
        new Vector3(0.16, 1.28, 0),
        new Vector3(0.27, 1.42, 0),
      ]),
    )
    // Trailing fronds spill over the rolled rim and droop down the gadrooned
    // bowl — the planting reads abundant instead of bristled.
    const frondTrailing = this.proto('urn-frond-trailing', () =>
      // Clears the rolled rim (outer r 0.535, top y 1.1) at y 1.13 before
      // drooping down the outside of the gadrooned bowl.
      frondGeometry([
        new Vector3(0.08, 0.88, 0),
        new Vector3(0.32, 1.09, 0),
        new Vector3(0.55, 1.13, 0),
        new Vector3(0.68, 0.94, 0),
        new Vector3(0.71, 0.74, 0),
      ]),
    )
    const bud = this.proto('urn-bud', () => new SphereGeometry(0.075, 12, 9))
    const stemCollar = this.proto('urn-stem-collar', () => new TorusGeometry(0.21, 0.022, 7, 22))

    w.place(this.m.marble, plinthLow, x, y + 0.045 * scale, z, 0, scale)
    w.place(this.m.marble, plinthHigh, x, y + 0.125 * scale, z, 0, scale)
    w.place(this.m.verdigris, body, x, y, z, 0, scale)
    // Brass girdle at the knop — a jewelled waist between stem and bowl.
    this.placeScaled(w, this.m.brass, stemCollar, x, y + 0.565 * scale, z, scale, scale, scale, Math.PI / 2)
    w.place(this.m.soil, soilFill, x, y + 0.83 * scale, z, 0, scale)
    // Deterministic rosette: eight arcing outer fronds, five steeper inner
    // ones, three trailing spillers, yaw-staggered with a fixed jitter table
    // (ArchKit has no RNG).
    const jitter = [0.13, -0.21, 0.33, -0.08, 0.24, -0.29, 0.05, -0.16]
    for (let i = 0; i < 8; i++) {
      const yaw = (i / 8) * Math.PI * 2 + jitter[i]
      w.place(this.m.foliage, frondLong, x, y, z, yaw, scale * (0.92 + 0.02 * (i % 5)))
    }
    for (let i = 0; i < 5; i++) {
      const yaw = (i / 5) * Math.PI * 2 + 0.55 + jitter[i] * 1.4
      w.place(this.m.foliage, frondShort, x, y, z, yaw, scale * (0.95 + 0.025 * (i % 3)))
    }
    for (let i = 0; i < 3; i++) {
      const yaw = (i / 3) * Math.PI * 2 + 1.05 + jitter[i + 3] * 1.2
      w.place(this.m.foliage, frondTrailing, x, y, z, yaw, scale * (0.9 + 0.04 * i))
    }
    w.place(this.m.nacre, bud, x, y + 0.87 * scale, z, 0, scale)
  }

  /** Low marble step ring around a plaza: one closed tread with a rounded
   *  nosing and a buried skirt. Radius-keyed because tread depth must not
   *  scale with plaza size. The profile is a closed clockwise loop (outer
   *  riser up, tread top inward, buried inner wall down) — the old open
   *  cylinder + torus left a see-through hollow between plaza edge and cap. */
  stepsRing(w: SlotWriter, x: number, y: number, z: number, radius: number): void {
    const ring = this.proto(`steps-ring-${radius.toFixed(2)}`, () => {
      const segments = Math.min(128, Math.max(48, Math.round(radius * 5)))
      return new LatheGeometry(
        [
          new Vector2(radius + 0.56, -0.26),
          new Vector2(radius + 0.6, 0.02),
          new Vector2(radius + 0.615, 0.075),
          new Vector2(radius + 0.585, 0.125),
          new Vector2(radius + 0.52, 0.14),
          new Vector2(radius - 0.05, 0.14),
          new Vector2(radius - 0.05, -0.26),
          new Vector2(radius + 0.56, -0.26),
        ],
        segments,
      )
    })
    this.place(w, this.m.marble, ring, x, y, z)
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

/**
 * A unit column shaft (bottom r=1, top r=0.82, height 1 centred on origin)
 * with `flutes` concave channels carved around it and a classical entasis
 * swell. Radial segment count rises with flute count so each hollow gets
 * ≥4 segments; normals recomputed so raking light reads the ridges.
 */
function flutedShaftGeometry(flutes: number, fluteDepth: number): BufferGeometry {
  const radialSegments = flutes * 4
  const geometry = new CylinderGeometry(0.82, 1, 1, radialSegments, 8)
  const position = geometry.getAttribute('position')
  const vertex = new Vector3()
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i)
    const radial = Math.hypot(vertex.x, vertex.z)
    if (radial < 1e-5) continue // cap centres stay put
    const angle = Math.atan2(vertex.x, vertex.z)
    const flute = Math.pow(0.5 + 0.5 * Math.cos(angle * flutes), 1.5)
    const entasis = 1 + 0.045 * Math.sin(Math.PI * (vertex.y + 0.5))
    const scale = entasis * (1 - fluteDepth * flute)
    position.setX(i, vertex.x * scale)
    position.setZ(i, vertex.z * scale)
  }
  position.needsUpdate = true
  geometry.computeVertexNormals()
  return geometry
}

/**
 * One arcing sea-fern frond: a chain of tapering closed tubes through the
 * given spine points, with sphere knuckles hiding the joints and a tip bead.
 * Real thickness everywhere — flat cards read as cutouts underwater.
 * Exported for planting beds beyond the urns (Sun Garden parterre).
 */
export function frondGeometry(spine: Vector3[]): BufferGeometry {
  const up = new Vector3(0, 1, 0)
  const radii = [0.024, 0.017, 0.011]
  const parts: BufferGeometry[] = []
  for (let i = 0; i < spine.length - 1; i++) {
    const a = spine[i]
    const b = spine[i + 1]
    const direction = new Vector3().subVectors(b, a)
    const length = direction.length()
    const radius = radii[Math.min(i, radii.length - 1)]
    const segment = new CylinderGeometry(radius * 0.82, radius, length, 6)
    const rotation = new Quaternion().setFromUnitVectors(up, direction.clone().normalize())
    const transform = new Matrix4().compose(
      new Vector3().addVectors(a, b).multiplyScalar(0.5),
      rotation,
      new Vector3(1, 1, 1),
    )
    segment.applyMatrix4(transform)
    parts.push(segment)
    if (i > 0) {
      const knuckle = new SphereGeometry(radius * 1.15, 8, 6)
      knuckle.translate(a.x, a.y, a.z)
      parts.push(knuckle)
    }
  }
  const tip = spine[spine.length - 1]
  const bead = new SphereGeometry(0.013, 8, 6)
  bead.translate(tip.x, tip.y, tip.z)
  parts.push(bead)
  const merged = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (!merged) throw new Error('Failed to merge frond geometry')
  return merged
}
