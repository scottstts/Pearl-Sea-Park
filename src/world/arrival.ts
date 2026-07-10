import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  LatheGeometry,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { atan, float, fract, hash, mix, positionWorld, sin, smoothstep, step, vec2, vec3 } from 'three/tsl'
import { ArchKit } from '../archkit/modules'
import { SlotWriter } from '../archkit/writer'
import { registerBookmark } from '../core/debug'
import type { MaterialsSystem } from '../materials/materialsSystem'
import { fbm2 } from '../render/tslNoise'
import type { PhysicsSystem } from '../physics/physicsWorld'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { terrainHeight } from './terrain'

export const ARRIVAL_POSITION = { x: 0, z: 320 }
/** Deck walking surface — the bell's floor docks level with it. */
export const DECK_TOP_Y = 2.6
/** Where the bell cable meets the headframe sheave. */
export const CABLE_TOP_Y = 7.62

const DECK_OUTER_R = 6.4
const DECK_INNER_R = 1.72
const RAIL_R = 6.05
const PILE_R = 5.55
const PILE_COUNT = 6
const UP = new Vector3(0, 1, 0)

/**
 * The Descent Station (plan §9.1 approach): the visit begins here, standing
 * over the open sea. A circular planked platform on six braced bronze piles
 * driven to the seabed, ringed by a balustrade under a striped canvas canopy,
 * with a curved four-leg headframe carrying the Descent Bell's sheave and a
 * brass winch working the cable. Built like furniture — profiles, couplings,
 * and trim, not primitives.
 */
export class ArrivalSystem implements GameSystem {
  readonly id = 'arrival-pavilion'
  private readonly group = new Object3D()
  private readonly physics: PhysicsSystem | null
  private readonly materials: MaterialsSystem

  constructor(physics: PhysicsSystem | null, materials: MaterialsSystem) {
    this.physics = physics
    this.materials = materials
  }

  init(ctx: GameContext): void {
    const lib = this.materials.lib
    if (!lib) throw new Error('ArrivalSystem requires materials')
    const kit = new ArchKit(lib)
    const w = new SlotWriter()
    const { x, z } = ARRIVAL_POSITION

    // Shared strut helper: unit cylinder posed between two world points.
    const unitCylinder = new CylinderGeometry(1, 1, 1, 10)
    const strut = (
      material: MeshStandardNodeMaterial,
      a: Vector3,
      b: Vector3,
      radius: number,
    ): void => {
      const direction = new Vector3().subVectors(b, a)
      const length = direction.length()
      if (length < 1e-4) return
      const rotation = new Quaternion().setFromUnitVectors(UP, direction.normalize())
      const transform = new Matrix4().compose(
        new Vector3().addVectors(a, b).multiplyScalar(0.5),
        rotation,
        new Vector3(radius, length, radius),
      )
      w.emit(material, unitCylinder, transform)
    }
    const radial = (r: number, angle: number, y: number): Vector3 =>
      new Vector3(x + r * Math.sin(angle), y, z + r * Math.cos(angle))

    // ── Deck: planked in weathered timber with brass inlay rings ──────────
    const deckWood = new MeshStandardNodeMaterial()
    {
      const boards = positionWorld.x.mul(6.25) // 0.16 m boards running north
      const board = boards.floor()
      const bf = fract(boards)
      const seam = smoothstep(0.0, 0.05, bf).mul(smoothstep(1.0, 0.95, bf))
      const tone = hash(board.mul(17.31))
      const grain = fbm2(vec2(positionWorld.x.mul(21.0), positionWorld.z.mul(1.6)).add(tone.mul(31.0)))
      const radius = positionWorld.xz.sub(vec2(x, z)).length()
      const inlay = smoothstep(0.05, 0.02, radius.sub(2.62).abs()).max(
        smoothstep(0.045, 0.018, radius.sub(5.35).abs()),
      )
      const wood = mix(vec3(0.36, 0.25, 0.145), vec3(0.52, 0.385, 0.235), grain.mul(0.65).add(tone.mul(0.35)))
        .mul(seam.mul(0.4).add(0.6))
      deckWood.colorNode = mix(wood, vec3(0.85, 0.68, 0.34), inlay)
      deckWood.metalnessNode = inlay.mul(0.9)
      deckWood.roughnessNode = mix(grain.mul(0.18).add(0.62), float(0.32), inlay)
    }
    const deckTop = new RingGeometry(DECK_INNER_R, DECK_OUTER_R, 96, 1)
    deckTop.rotateX(-Math.PI / 2)
    const topMesh = new Mesh(deckTop, deckWood)
    topMesh.position.set(x, DECK_TOP_Y, z)
    const deckUnder = new RingGeometry(DECK_INNER_R, DECK_OUTER_R, 96, 1)
    deckUnder.rotateX(Math.PI / 2)
    const underMesh = new Mesh(deckUnder, deckWood)
    underMesh.position.set(x, DECK_TOP_Y - 0.22, z)
    this.group.add(topMesh, underMesh)

    // Fascia: an ogee profile around the rim, with two brass half-rounds.
    const fascia = new LatheGeometry(
      [
        new Vector2(6.4, 2.24),
        new Vector2(6.53, 2.29),
        new Vector2(6.56, 2.38),
        new Vector2(6.46, 2.44),
        new Vector2(6.46, 2.52),
        new Vector2(6.58, 2.58),
        new Vector2(6.6, 2.66),
        new Vector2(6.42, 2.74),
      ],
      96,
    )
    w.emit(lib.woodDark, fascia, new Matrix4().setPosition(x, 0, z))
    for (const [r, ry, tube] of [
      [6.57, 2.62, 0.028],
      [6.5, 2.33, 0.024],
    ] as const) {
      const trim = new TorusGeometry(r, tube, 8, 96)
      const m = new Matrix4().makeRotationX(Math.PI / 2)
      m.setPosition(x, ry, z)
      w.emit(lib.brass, trim, m)
    }

    // Under-deck structure: radial joists on two ring beams, read from the
    // water on the way down.
    const joist = new BoxGeometry(4.55, 0.16, 0.11)
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2
      const m = new Matrix4().makeRotationY(angle + Math.PI / 2)
      const p = radial((DECK_INNER_R + DECK_OUTER_R) / 2, angle, DECK_TOP_Y - 0.31)
      m.setPosition(p.x, p.y, p.z)
      w.emit(lib.iron, joist, m)
    }
    for (const r of [3.1, 5.5]) {
      const beam = new TorusGeometry(r, 0.055, 8, 72)
      const m = new Matrix4().makeRotationX(Math.PI / 2)
      m.setPosition(x, DECK_TOP_Y - 0.34, z)
      w.emit(lib.iron, beam, m)
    }

    // ── The bell mouth: rolled brass collar, stanchions, sagging chains ───
    const collar = new LatheGeometry(
      [
        new Vector2(1.52, 2.5),
        new Vector2(1.5, 2.58),
        new Vector2(1.54, 2.66),
        new Vector2(1.66, 2.72),
        new Vector2(1.82, 2.74),
        new Vector2(1.96, 2.7),
        new Vector2(2.02, 2.62),
        new Vector2(1.96, 2.56),
        new Vector2(1.86, 2.52),
      ],
      64,
    )
    w.emit(lib.brass, collar, new Matrix4().setPosition(x, 0, z))

    const stanchion = new LatheGeometry(
      [
        new Vector2(0.05, 0),
        new Vector2(0.075, 0.03),
        new Vector2(0.045, 0.09),
        new Vector2(0.055, 0.6),
        new Vector2(0.035, 0.68),
        new Vector2(0.06, 0.74),
        new Vector2(0.03, 0.82),
        new Vector2(0.0, 0.88),
      ],
      12,
    )
    const stanchionBall = new SphereGeometry(0.038, 12, 8)
    // Chain arc: torus segment sized so its endpoints land on adjacent posts.
    const chainArc = new TorusGeometry(1.272, 0.015, 6, 16, 1.1)
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2
      const p = radial(2.15, angle, DECK_TOP_Y)
      w.place(lib.brass, stanchion, p.x, p.y, p.z)
      w.place(lib.brass, stanchionBall, p.x, p.y + 0.85, p.z)

      // Arc centred at its lowest point; endpoints land on the post tops.
      const mid = radial(2.15 * Math.cos(Math.PI / 10), angle + Math.PI / 10, DECK_TOP_Y + 0.82 + 1.084)
      const m = new Matrix4()
        .makeRotationZ(-Math.PI / 2 - 0.55)
        .premultiply(new Matrix4().makeRotationY(angle + Math.PI / 10))
      m.setPosition(mid.x, mid.y, mid.z)
      w.emit(lib.brass, chainArc, m)
    }

    // ── Balustrade ring with brass finials on the rail joints ─────────────
    const cornerBall = new SphereGeometry(0.062, 14, 10)
    for (let i = 0; i < 12; i++) {
      const a1 = (i / 12) * Math.PI * 2
      const a2 = ((i + 1) / 12) * Math.PI * 2
      const p1 = radial(RAIL_R, a1, DECK_TOP_Y)
      const p2 = radial(RAIL_R, a2, DECK_TOP_Y)
      kit.balustrade(w, p1.x, p1.z, p2.x, p2.z, DECK_TOP_Y)
      w.place(lib.brass, cornerBall, p1.x, DECK_TOP_Y + 0.93, p1.z)
    }

    // ── Six bronze piles to the seabed: couplings, footings, bracing ──────
    const pileAngles: number[] = []
    const pileGround: number[] = []
    const pileProto = new CylinderGeometry(0.28, 0.36, 1, 18)
    const pileCollar = new TorusGeometry(0.31, 0.05, 8, 24)
    const footing = new LatheGeometry(
      [
        new Vector2(1.05, 0),
        new Vector2(0.95, 0.2),
        new Vector2(0.58, 0.48),
        new Vector2(0.42, 0.8),
        new Vector2(0.37, 1.1),
      ],
      20,
    )
    for (let i = 0; i < PILE_COUNT; i++) {
      const angle = (i / PILE_COUNT) * Math.PI * 2 + Math.PI / 6
      pileAngles.push(angle)
      const p = radial(PILE_R, angle, 0)
      const ground = terrainHeight(p.x, p.z) - 0.5
      pileGround.push(ground)
      const top = DECK_TOP_Y - 0.18
      const m = new Matrix4().makeScale(1, top - ground, 1)
      m.setPosition(p.x, (top + ground) / 2, p.z)
      w.emit(lib.verdigris, pileProto, m)
      // Flanged couplings every ~5 m below the waves, brass above.
      for (let cy = ground + 4; cy < 0; cy += 5) {
        const cm = new Matrix4().makeRotationX(Math.PI / 2)
        cm.setPosition(p.x, cy, p.z)
        w.emit(lib.verdigris, pileCollar, cm)
      }
      const bm = new Matrix4().makeRotationX(Math.PI / 2)
      bm.setPosition(p.x, 1.9, p.z)
      w.emit(lib.brass, pileCollar, bm)
      w.place(lib.verdigris, footing, p.x, ground, p.z)
      this.physics?.addStaticCylinder(p.x, (top + ground) / 2, p.z, (top - ground) / 2, 0.36)
    }
    // X-bracing between neighbours in three tiers, plus chord rings and the
    // waterline girdle that stiffens the pile group above the swell.
    for (let i = 0; i < PILE_COUNT; i++) {
      const a1 = pileAngles[i]
      const a2 = pileAngles[(i + 1) % PILE_COUNT]
      const floor1 = pileGround[i] + 1.2
      const floor2 = pileGround[(i + 1) % PILE_COUNT] + 1.2
      for (const [ya, yb] of [
        [-2, -9],
        [-9, -16],
        [-16, -23],
      ] as const) {
        const topA = radial(PILE_R, a1, Math.max(ya, floor1))
        const topB = radial(PILE_R, a2, Math.max(ya, floor2))
        const botA = radial(PILE_R, a1, Math.max(yb, floor1))
        const botB = radial(PILE_R, a2, Math.max(yb, floor2))
        strut(lib.verdigris, topA, botB, 0.055)
        strut(lib.verdigris, topB, botA, 0.055)
      }
      for (const ringY of [-2, -16]) {
        strut(
          lib.verdigris,
          radial(PILE_R, a1, Math.max(ringY, floor1)),
          radial(PILE_R, a2, Math.max(ringY, floor2)),
          0.07,
        )
      }
      // Girdle beam above the crests.
      const g1 = radial(PILE_R, a1, 1.55)
      const g2 = radial(PILE_R, a2, 1.55)
      const yaw = Math.atan2(g2.x - g1.x, g2.z - g1.z)
      const beam = new BoxGeometry(0.2, 0.3, g1.distanceTo(g2))
      const gm = new Matrix4().makeRotationY(yaw)
      gm.setPosition((g1.x + g2.x) / 2, 1.55, (g1.z + g2.z) / 2)
      w.emit(lib.iron, beam, gm)
    }

    // ── Headframe: four curved legs meeting at the sheave crown ───────────
    const legPoint = (t: number, angle: number): Vector3 => {
      // Quadratic bézier in (radius, height): plants wide, sweeps to centre.
      // Control point stays low/inside so the leg passes UNDER the canvas
      // and rises through the open crown hole (r < 2.3) — never through it.
      const k0 = (1 - t) * (1 - t)
      const k1 = 2 * (1 - t) * t
      const k2 = t * t
      const r = k0 * 3.35 + k1 * 2.6 + k2 * 0.62
      const y = k0 * 2.6 + k1 * 5.6 + k2 * 7.55
      return radial(r, angle, y)
    }
    const legFoot = new LatheGeometry(
      [
        new Vector2(0.28, 0),
        new Vector2(0.24, 0.06),
        new Vector2(0.15, 0.1),
        new Vector2(0.14, 0.2),
      ],
      14,
    )
    const legJoint = new SphereGeometry(0.115, 12, 10)
    const legAngles = [1, 3, 5, 7].map((k) => (k * Math.PI) / 4)
    const legRadii = [0.13, 0.11, 0.095]
    for (const angle of legAngles) {
      const samples = [0, 1 / 3, 2 / 3, 1].map((t) => legPoint(t, angle))
      for (let s = 0; s < 3; s++) strut(lib.iron, samples[s], samples[s + 1], legRadii[s])
      for (let s = 1; s < 3; s++) w.place(lib.iron, legJoint, samples[s].x, samples[s].y, samples[s].z)
      const foot = legPoint(0, angle)
      w.place(lib.iron, legFoot, foot.x, DECK_TOP_Y, foot.z)
      this.physics?.addStaticCylinder(foot.x, DECK_TOP_Y + 0.55, foot.z, 0.55, 0.17)
    }
    // Ties: a square ring at the first joint and diagonals up to the second.
    for (let i = 0; i < 4; i++) {
      const a1 = legAngles[i]
      const a2 = legAngles[(i + 1) % 4]
      strut(lib.iron, legPoint(1 / 3, a1), legPoint(1 / 3, a2), 0.042)
      strut(lib.iron, legPoint(1 / 3, a1), legPoint(2 / 3, a2), 0.032)
    }

    // Crown: bearing ring, drum, the working sheave, housing, finial.
    const crownRing = new TorusGeometry(0.62, 0.07, 10, 36)
    const crownM = new Matrix4().makeRotationX(Math.PI / 2)
    crownM.setPosition(x, 7.55, z)
    w.emit(lib.brass, crownRing, crownM)
    const crownDrum = new CylinderGeometry(0.55, 0.62, 0.35, 24)
    w.place(lib.brass, crownDrum, x, 7.74, z)

    // The sheave plane must CONTAIN the radial direction so the bell cable
    // hanging at the platform centre is tangent to the wheel.
    const winchAngle = 2.17
    const sheaveCenter = radial(0.42, winchAngle, CABLE_TOP_Y)
    const sheave = new TorusGeometry(0.42, 0.06, 8, 30)
    const sheaveM = new Matrix4().makeRotationY(winchAngle - Math.PI / 2)
    sheaveM.setPosition(sheaveCenter.x, sheaveCenter.y, sheaveCenter.z)
    w.emit(lib.brass, sheave, sheaveM)
    for (let s = 0; s < 6; s++) {
      const spokeAngle = (s / 6) * Math.PI * 2
      const inPlane = new Vector3(Math.sin(winchAngle), 0, Math.cos(winchAngle))
      const rim = sheaveCenter
        .clone()
        .addScaledVector(inPlane, Math.cos(spokeAngle) * 0.38)
        .add(new Vector3(0, Math.sin(spokeAngle) * 0.38, 0))
      strut(lib.brass, sheaveCenter, rim, 0.018)
    }
    for (const side of [-0.1, 0.1]) {
      const normal = new Vector3(Math.sin(winchAngle), 0, Math.cos(winchAngle))
        .cross(UP)
        .normalize()
      const plate = new BoxGeometry(0.05, 0.62, 0.98)
      const pm = new Matrix4().makeRotationY(winchAngle)
      pm.setPosition(
        sheaveCenter.x + normal.x * side,
        7.85,
        sheaveCenter.z + normal.z * side,
      )
      w.emit(lib.iron, plate, pm)
    }
    const finial = new LatheGeometry(
      [
        new Vector2(0.22, 0),
        new Vector2(0.28, 0.1),
        new Vector2(0.07, 0.42),
        new Vector2(0.13, 0.7),
        new Vector2(0.0, 1.05),
      ],
      14,
    )
    w.place(lib.brass, finial, x, 7.92, z)

    // ── The winch: pedestal, cable drum, flywheel, return cable ───────────
    const winchBase = radial(2.95, winchAngle, DECK_TOP_Y)
    const pedestal = new BoxGeometry(0.7, 0.55, 0.55)
    const pedM = new Matrix4().makeRotationY(winchAngle)
    pedM.setPosition(winchBase.x, DECK_TOP_Y + 0.28, winchBase.z)
    w.emit(lib.iron, pedestal, pedM)
    this.physics?.addStaticBox(winchBase.x, DECK_TOP_Y + 0.5, winchBase.z, 0.42, 0.5, 0.35, winchAngle)
    const drum = new CylinderGeometry(0.24, 0.24, 0.52, 18)
    const drumM = new Matrix4()
      .makeRotationZ(Math.PI / 2)
      .premultiply(new Matrix4().makeRotationY(winchAngle))
    drumM.setPosition(winchBase.x, DECK_TOP_Y + 0.72, winchBase.z)
    w.emit(lib.brass, drum, drumM)
    const wrap = new TorusGeometry(0.245, 0.016, 6, 24)
    const axis = new Vector3(Math.cos(winchAngle), 0, -Math.sin(winchAngle))
    for (const offset of [-0.1, 0, 0.1]) {
      const wm = new Matrix4().makeRotationY(winchAngle + Math.PI / 2)
      wm.setPosition(
        winchBase.x + axis.x * offset,
        DECK_TOP_Y + 0.72,
        winchBase.z + axis.z * offset,
      )
      w.emit(lib.iron, wrap, wm)
    }
    const flywheelCenter = new Vector3(
      winchBase.x + axis.x * 0.42,
      DECK_TOP_Y + 0.72,
      winchBase.z + axis.z * 0.42,
    )
    const flywheel = new TorusGeometry(0.34, 0.042, 8, 28)
    const fm = new Matrix4().makeRotationY(winchAngle + Math.PI / 2)
    fm.setPosition(flywheelCenter.x, flywheelCenter.y, flywheelCenter.z)
    w.emit(lib.iron, flywheel, fm)
    for (let s = 0; s < 4; s++) {
      const spokeAngle = (s / 4) * Math.PI * 2 + Math.PI / 4
      const inPlane = new Vector3(Math.sin(winchAngle), 0, Math.cos(winchAngle))
      const rim = flywheelCenter
        .clone()
        .addScaledVector(inPlane, Math.cos(spokeAngle) * 0.31)
        .add(new Vector3(0, Math.sin(spokeAngle) * 0.31, 0))
      strut(lib.iron, flywheelCenter, rim, 0.016)
    }
    strut(
      lib.iron,
      radial(0.55, winchAngle, 7.95),
      radial(2.9, winchAngle, DECK_TOP_Y + 0.78),
      0.022,
    )

    // ── Canopy: striped canvas ring on slim posts, open at the crown ──────
    const canvas = new MeshStandardNodeMaterial()
    canvas.side = DoubleSide
    canvas.roughness = 0.92
    {
      const angleNode = atan(positionWorld.x.sub(x), positionWorld.z.sub(z))
      const stripe = step(0.0, sin(angleNode.mul(14.0)))
      const weave = fbm2(positionWorld.xz.mul(3.1)).mul(0.08)
      canvas.colorNode = mix(vec3(0.9, 0.86, 0.76), vec3(0.5, 0.69, 0.68), stripe.mul(0.85)).add(weave)
    }
    const canopy = new Mesh(
      new LatheGeometry(
        [
          new Vector2(2.3, 5.65),
          new Vector2(3.3, 5.3),
          new Vector2(4.5, 5.0),
          new Vector2(5.6, 4.84),
          new Vector2(6.12, 4.78),
        ],
        80,
      ),
      canvas,
    )
    canopy.position.set(x, 0, z)
    this.group.add(canopy)
    for (const [r, ry, tube] of [
      [6.14, 4.77, 0.03],
      [2.3, 5.66, 0.045],
    ] as const) {
      const ring = new TorusGeometry(r, tube, 8, 80)
      const m = new Matrix4().makeRotationX(Math.PI / 2)
      m.setPosition(x, ry, z)
      w.emit(lib.brass, ring, m)
    }
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + Math.PI / 8
      const base = radial(5.85, angle, DECK_TOP_Y)
      const top = radial(5.85, angle, 4.8)
      strut(lib.brass, base, top, 0.035)
      strut(lib.brass, radial(5.85, angle, 4.35), radial(5.28, angle, 4.9), 0.02)
    }

    // ── Rail lanterns, bollards, and the boarding ladder ──────────────────
    // Short harbour lanterns on four rail joints (a full lamp post would
    // punch through the canopy's 2.3 m headroom).
    const lanternPost = new LatheGeometry(
      [
        new Vector2(0.05, 0),
        new Vector2(0.065, 0.04),
        new Vector2(0.03, 0.12),
        new Vector2(0.035, 0.4),
        new Vector2(0.055, 0.46),
        new Vector2(0.02, 0.5),
      ],
      12,
    )
    const lanternGlobe = new SphereGeometry(0.085, 14, 10)
    const lanternCap = new CylinderGeometry(0.02, 0.1, 0.07, 12)
    for (const joint of [1, 4, 7, 10]) {
      const angle = (joint / 12) * Math.PI * 2 // on rail joints, over the finials
      const p = radial(RAIL_R, angle, DECK_TOP_Y + 0.93)
      w.place(lib.brass, lanternPost, p.x, p.y, p.z)
      w.place(lib.lampGlobe, lanternGlobe, p.x, p.y + 0.58, p.z)
      w.place(lib.brass, lanternCap, p.x, p.y + 0.68, p.z)
    }
    const bollard = new LatheGeometry(
      [
        new Vector2(0.09, 0),
        new Vector2(0.11, 0.06),
        new Vector2(0.07, 0.2),
        new Vector2(0.085, 0.32),
        new Vector2(0.1, 0.4),
        new Vector2(0.06, 0.46),
        new Vector2(0.0, 0.5),
      ],
      14,
    )
    for (const angle of [2.7, 3.6]) {
      const p = radial(5.9, angle, DECK_TOP_Y)
      w.place(lib.brass, bollard, p.x, p.y, p.z)
    }
    // Ladder down to the water on the south face.
    const ladderTangent = new Vector3(Math.cos(0), 0, -Math.sin(0))
    for (const side of [-0.28, 0.28]) {
      const sx = x + ladderTangent.x * side
      const sz = z + 6.62 + ladderTangent.z * side
      strut(lib.brass, new Vector3(sx, 0.1, sz), new Vector3(sx, DECK_TOP_Y + 1.05, sz), 0.03)
    }
    for (let rung = 0; rung < 6; rung++) {
      const ry = 0.35 + rung * 0.42
      strut(
        lib.iron,
        new Vector3(x - 0.28, ry, z + 6.62),
        new Vector3(x + 0.28, ry, z + 6.62),
        0.022,
      )
    }

    // ── Physics: deck plate, mouth guard, rail ring ────────────────────────
    this.physics?.addStaticCylinder(x, DECK_TOP_Y - 0.3, z, 0.3, DECK_OUTER_R + 0.1)
    this.physics?.addStaticCylinder(x, DECK_TOP_Y + 0.7, z, 0.7, 2.2)
    for (let i = 0; i < 12; i++) {
      const mid = ((i + 0.5) / 12) * Math.PI * 2
      const center = radial(RAIL_R * Math.cos(Math.PI / 12), mid, DECK_TOP_Y + 0.6)
      this.physics?.addStaticBox(center.x, center.y, center.z, 1.62, 0.62, 0.07, mid)
    }

    this.group.add(w.compile())
    this.group.traverse((node) => {
      if ((node as Mesh).isMesh) {
        node.castShadow = true
        node.receiveShadow = true
      }
    })
    ctx.scene.add(this.group)

    registerBookmark({
      name: 'arrival',
      position: [x + 5.5, 5.2, z + 9],
      look: [x - 2, 1.6, z - 60],
      note: 'Postcard 1 staging — the Descent Station over the park',
    })
    registerBookmark({
      name: 'descent',
      position: [x + 3.5, 1.15, z + 4],
      look: [x, -22, z - 72],
      note: 'Postcard 1 — waterline crossing with the park glowing below',
    })
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
  }
}
