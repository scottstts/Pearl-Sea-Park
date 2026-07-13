import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  LatheGeometry,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import type { ArchKit } from '../archkit/modules'
import type { SlotWriter } from '../archkit/writer'
import type { ParkMaterials } from '../materials/library'
import type { PhysicsSystem } from '../physics/physicsWorld'
import { PARK_PLAN } from './parkPlan'

export interface FacilityDetailContext {
  kit: ArchKit
  writer: SlotWriter
  materials: ParkMaterials
  physics: PhysicsSystem
}

export function detailAtrium(ctx: FacilityDetailContext, floorY: number): void {
  const { kit, writer, physics } = ctx
  const atrium = PARK_PLAN.atrium
  const stations = ringStations(atrium.x, atrium.z, 17, 16)
  for (let i = 0; i < stations.length; i++) {
    const next = (i + 1) % stations.length
    if (i === 0 || next === 0 || i === 8 || next === 8) continue
    kit.cornice(writer, stations[i].x, stations[i].z, stations[next].x, stations[next].z, floorY + 9.12)
  }
  for (const z of [atrium.z - 18.4, atrium.z + 18.4]) {
    for (const side of [-1, 1]) {
      kit.urn(writer, atrium.x + side * 2.2, floorY + 0.18, z, 1.1)
      physics.addStaticCylinder(atrium.x + side * 2.2, floorY + 0.18 + 0.6, z, 0.6, 0.48)
    }
  }
}

/**
 * Architectural finish layer for the park's civic sites. Each function works
 * from an explicit bay/ring plan and emits into the shared material slots, so
 * ornamental density does not turn into ornamental draw-call density.
 */
export function detailEsplanade(ctx: FacilityDetailContext, floorY: number): void {
  const { kit, writer, physics } = ctx
  const esp = PARK_PLAN.esplanade
  const gap = 12
  for (let z = esp.zTo + 6; z < esp.zFrom - 6 - gap; z += gap) {
    for (const side of [-1, 1]) {
      const x = esp.x + side * (esp.width / 2 + 0.8)
      kit.cornice(writer, x, z, x, z + gap, floorY + 6.65)
    }
  }

  // Four gate urns mark the boulevard as a designed threshold, not a path
  // that happens to pass between columns.
  for (const z of [esp.zTo + 3.2, esp.zFrom - 3.2]) {
    for (const side of [-1, 1]) {
      const x = esp.x + side * (esp.width / 2 - 1)
      kit.urn(writer, x, floorY + 0.18, z, 1.15)
      physics.addStaticCylinder(x, floorY + 0.18 + 0.62, z, 0.62, 0.5)
    }
  }
}

export function detailTidalCourt(ctx: FacilityDetailContext, floorY: number): void {
  const { kit, writer, physics } = ctx
  const hub = PARK_PLAN.tidalCourt
  const stations = ringStations(hub.x, hub.z, hub.colonnadeRadius, 28)
  const gates = new Set([0, 3, 7, 14, 21])
  for (let i = 0; i < stations.length; i++) {
    const next = (i + 1) % stations.length
    if (gates.has(i) || gates.has(next)) continue
    kit.cornice(writer, stations[i].x, stations[i].z, stations[next].x, stations[next].z, floorY + 7.65)
  }

  // Eight planters ring the lagoon (the old open-lathe pedestals showed
  // culled backfaces and floated their pearls above the cap).
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + Math.PI / 8
    const x = hub.x + Math.sin(angle) * (hub.lagoonRadius + 2.5)
    const z = hub.z + Math.cos(angle) * (hub.lagoonRadius + 2.5)
    kit.urn(writer, x, floorY + 0.18, z, 1.05)
    physics.addStaticCylinder(x, floorY + 0.18 + 0.58, z, 0.58, 0.46)
  }
}

export function detailMidway(ctx: FacilityDetailContext, floorY: number): void {
  const { kit, writer, materials, physics } = ctx
  const mid = PARK_PLAN.midway
  const columns = 6
  for (let i = 0; i < columns; i++) {
    const x1 = mid.x - mid.width / 2 + (i / columns) * mid.width
    const x2 = mid.x - mid.width / 2 + ((i + 1) / columns) * mid.width
    for (const side of [-1, 1]) {
      const z = mid.z + side * mid.depth / 2
      kit.arch(writer, x1, z, x2, z, floorY + 6.05, 1.15)
      kit.cornice(writer, x1, z, x2, z, floorY + 6.15)
    }
  }

  // A row of proper game counters gives the hall an inhabited frontage. The
  // silhouettes are low-poly, but bevel bands, scalloped parasol canopies,
  // and finials keep them from reading as boxes.
  const counter = new BoxGeometry(4.6, 0.9, 1.15)
  const counterTop = new BoxGeometry(4.9, 0.12, 1.42)
  const canopy = new ConeGeometry(2.75, 0.82, 40, 2, true)
  {
    // Scalloped hem: the fairground parasol edge, cut into the cone rim.
    const position = canopy.getAttribute('position')
    const vertex = new Vector3()
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i)
      const hem = Math.max(0, Math.min(1, (0.41 - vertex.y) / 0.82))
      const angle = Math.atan2(vertex.x, vertex.z)
      position.setY(i, vertex.y + 0.11 * (0.5 + 0.5 * Math.cos(angle * 10)) * hem * hem)
    }
    position.needsUpdate = true
    canopy.computeVertexNormals()
  }
  const finial = new SphereGeometry(0.12, 10, 7)
  const canopyPost = new CylinderGeometry(0.045, 0.055, 1.72, 8)
  for (let i = 0; i < 5; i++) {
    const x = mid.x - 15.2 + i * 7.6
    const z = mid.z + (i % 2 === 0 ? 2.9 : -2.9)
    writer.place(materials.woodDark, counter, x, floorY + 0.63, z)
    writer.place(materials.brass, counterTop, x, floorY + 1.14, z)
    writer.place(materials.canvasCream, canopy, x, floorY + 3.3, z, Math.PI / 8)
    writer.place(materials.brass, finial, x, floorY + 3.8, z)
    for (const side of [-1, 1]) {
      for (const face of [-1, 1]) {
        writer.place(
          materials.brass,
          canopyPost,
          x + side * 2.05,
          floorY + 2.02,
          z + face * 0.43,
        )
      }
    }
    physics.addStaticBox(x, floorY + 0.72, z, 2.3, 0.55, 0.58)
  }
  counter.dispose()
  counterTop.dispose()
  canopy.dispose()
  finial.dispose()
  canopyPost.dispose()
}

export function detailCafe(ctx: FacilityDetailContext, floorY: number): void {
  const { kit, writer, materials, physics } = ctx
  const cafe = PARK_PLAN.cafe
  const stations = ringStations(cafe.x, cafe.z, 7, 6, Math.PI / 6)
  for (let i = 0; i < stations.length; i++) {
    const next = (i + 1) % stations.length
    kit.arch(writer, stations[i].x, stations[i].z, stations[next].x, stations[next].z, floorY + 4.64, 0.9)
    kit.cornice(writer, stations[i].x, stations[i].z, stations[next].x, stations[next].z, floorY + 4.72)
  }

  // The center piece is a circular BAR: a closed clockwise lathe with a real
  // counter top (the old open ribbon had no top surface and showed culled
  // backfaces from across the ring), a rim-hugging brass trim, and a samovar
  // centerpiece on a marble pedestal filling the ring's middle.
  const bar = new LatheGeometry([
    new Vector2(1.66, 0),
    new Vector2(1.95, 0),
    new Vector2(1.98, 0.08),
    new Vector2(1.86, 0.2),
    new Vector2(1.82, 0.55),
    new Vector2(1.88, 0.82),
    new Vector2(2.06, 0.96),
    new Vector2(2.1, 1.04),
    new Vector2(2.02, 1.06),
    new Vector2(1.58, 1.06),
    new Vector2(1.52, 1.0),
    new Vector2(1.56, 0.9),
    new Vector2(1.62, 0.3),
    new Vector2(1.66, 0),
  ], 40)
  writer.place(materials.woodDark, bar, cafe.x, floorY + 0.18, cafe.z)
  const rimTrim = new TorusGeometry(2.06, 0.045, 8, 40)
  const rimMatrix = new Matrix4().makeRotationX(Math.PI / 2)
  rimMatrix.setPosition(cafe.x, floorY + 1.24, cafe.z)
  writer.emit(materials.brass, rimTrim, rimMatrix)

  const pedestal = new LatheGeometry([
    new Vector2(0.06, 0),
    new Vector2(0.52, 0),
    new Vector2(0.56, 0.08),
    new Vector2(0.4, 0.2),
    new Vector2(0.34, 0.6),
    new Vector2(0.4, 1.0),
    new Vector2(0.52, 1.08),
    new Vector2(0.55, 1.16),
    new Vector2(0.06, 1.18),
    new Vector2(0.06, 0),
  ], 22)
  writer.place(materials.marble, pedestal, cafe.x, floorY + 0.18, cafe.z)
  const samovar = new LatheGeometry([
    new Vector2(0.05, 0),
    new Vector2(0.3, 0.02),
    new Vector2(0.42, 0.16),
    new Vector2(0.44, 0.38),
    new Vector2(0.34, 0.58),
    new Vector2(0.18, 0.68),
    new Vector2(0.2, 0.74),
    new Vector2(0.12, 0.78),
    new Vector2(0.05, 0.79),
    new Vector2(0.05, 0),
  ], 24)
  writer.place(materials.brass, samovar, cafe.x, floorY + 1.36, cafe.z)
  const samovarPearl = new SphereGeometry(0.085, 12, 9)
  writer.place(materials.nacre, samovarPearl, cafe.x, floorY + 2.2, cafe.z)
  physics.addStaticCylinder(cafe.x, floorY + 0.75, cafe.z, 0.6, 2.12)
  bar.dispose()
  rimTrim.dispose()
  pedestal.dispose()
  samovar.dispose()
  samovarPearl.dispose()
}

export function detailObservatory(ctx: FacilityDetailContext, floorY: number): void {
  const { kit, writer, materials, physics } = ctx
  const obs = PARK_PLAN.observatory
  const stations = ringStations(obs.x, obs.z, 8, 8, Math.PI / 8)
  for (let i = 0; i < stations.length; i++) {
    const next = (i + 1) % stations.length
    kit.arch(writer, stations[i].x, stations[i].z, stations[next].x, stations[next].z, floorY + 5.05, 0.95)
    kit.cornice(writer, stations[i].x, stations[i].z, stations[next].x, stations[next].z, floorY + 5.12)
  }

  // Central armillary sphere: a real instrument, not three loose hoops.
  // Marble pedestal (closed clockwise lathe), then a ring assembly tilted
  // 23.4° like the Earth's axis: two meridians, a broad equator band, both
  // tropics, the ecliptic, a polar axis rod with finials, and a nacre globe.
  // Every attachment point is computed THROUGH the assembly matrix so the
  // axis socket and cradle struts genuinely meet what they support.
  const pedestal = new LatheGeometry([
    new Vector2(0.06, 0),
    new Vector2(1.05, 0),
    new Vector2(1.1, 0.09),
    new Vector2(0.92, 0.22),
    new Vector2(0.62, 0.32),
    new Vector2(0.5, 0.5),
    new Vector2(0.46, 0.85),
    new Vector2(0.52, 1.0),
    new Vector2(0.72, 1.08),
    new Vector2(0.76, 1.18),
    new Vector2(0.06, 1.18),
    new Vector2(0.06, 0),
  ], 26)
  writer.place(materials.marble, pedestal, obs.x, floorY, obs.z)

  const tilt = 0.41 // 23.4°
  const R = 1.15
  const centerY = floorY + 1.2 + R * Math.cos(tilt) * 1.26 // axis foot rests on the capital
  const assembly = new Matrix4().makeRotationZ(tilt)
  assembly.setPosition(obs.x, centerY, obs.z)
  const emitRing = (radius: number, tube: number, local: Matrix4) => {
    const ring = new TorusGeometry(radius, tube, 9, 48)
    writer.emit(materials.brass, ring, local.clone().premultiply(assembly))
    ring.dispose()
  }
  // Meridians (contain the polar axis), equator, tropics, ecliptic.
  emitRing(R, 0.05, new Matrix4())
  emitRing(R, 0.05, new Matrix4().makeRotationY(Math.PI / 2))
  emitRing(R, 0.075, new Matrix4().makeRotationX(Math.PI / 2))
  const tropicRadius = R * Math.cos(0.41)
  const tropicY = R * Math.sin(0.41)
  for (const side of [-1, 1]) {
    const local = new Matrix4().makeRotationX(Math.PI / 2)
    local.setPosition(0, side * tropicY, 0)
    emitRing(tropicRadius, 0.03, local)
  }
  emitRing(R * 1.02, 0.055, new Matrix4().makeRotationX(Math.PI / 2 - 0.41))

  // Polar axis rod through the globe, finials on both ends; the lower end
  // seats into a socket boss half-sunk in the pedestal capital.
  const toWorld = (x: number, y: number, z: number) =>
    new Vector3(x, y, z).applyMatrix4(assembly)
  const rod = new CylinderGeometry(0.032, 0.032, 2.9, 10)
  writer.emit(materials.brass, rod, new Matrix4().makeRotationZ(tilt).setPosition(obs.x, centerY, obs.z))
  const finial = new SphereGeometry(0.075, 12, 9)
  const rodTop = toWorld(0, 1.45, 0)
  const rodBottom = toWorld(0, -1.45, 0)
  writer.place(materials.brass, finial, rodTop.x, rodTop.y, rodTop.z)
  const socket = new SphereGeometry(0.1, 12, 9)
  writer.place(materials.brass, socket, rodBottom.x, rodBottom.y, rodBottom.z)
  const globe = new SphereGeometry(0.42, 22, 16)
  writer.place(materials.nacre, globe, obs.x, centerY, obs.z)

  // Cradle: two brass struts from the capital rim to points ON the meridian
  // ring's lower quadrants (positions computed through the same matrix).
  const strutProto = new CylinderGeometry(1, 1, 1, 8)
  for (const angle of [(4 * Math.PI) / 3, (5 * Math.PI) / 3]) {
    const onRing = toWorld(Math.cos(angle) * R, Math.sin(angle) * R, 0)
    const foot = new Vector3(
      obs.x + (onRing.x > obs.x ? 0.52 : -0.52),
      floorY + 1.12,
      obs.z,
    )
    const direction = new Vector3().subVectors(onRing, foot)
    const strut = new Matrix4().compose(
      new Vector3().addVectors(foot, onRing).multiplyScalar(0.5),
      new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.clone().normalize()),
      new Vector3(0.035, direction.length(), 0.035),
    )
    writer.emit(materials.brass, strutProto, strut)
    const knuckle = new SphereGeometry(0.05, 10, 8)
    writer.place(materials.brass, knuckle, onRing.x, onRing.y, onRing.z)
    knuckle.dispose()
  }

  physics.addStaticCylinder(obs.x, floorY + 0.7, obs.z, 0.7, 1.12)
  pedestal.dispose()
  rod.dispose()
  finial.dispose()
  socket.dispose()
  globe.dispose()
  strutProto.dispose()
}

export function detailOverlook(
  ctx: FacilityDetailContext,
  centerX: number,
  centerZ: number,
  floorY: number,
): void {
  const { kit, writer, materials, physics } = ctx
  // Planters stand ON the terrace, 1.5 m clear of the balustrade line
  // (z = centerZ − 1) and mid-segment in x — the old row sat exactly on the
  // fence line, threaded through the posts.
  for (const x of [centerX - 25, centerX, centerX + 25]) {
    const scale = x === centerX ? 1.3 : 1.05
    kit.urn(writer, x, floorY + 0.1, centerZ + 0.5, scale)
    physics.addStaticCylinder(x, floorY + 0.1 + 0.6 * scale, centerZ + 0.5, 0.6 * scale, 0.46 * scale)
  }

  // Harbor telescopes: baluster pedestal, fork yoke with a real axle, and a
  // tube train (draw tube → barrel → objective bell → eyecup) whose parts
  // are all posed along ONE sight line through the pivot, aimed out over
  // the rim and slightly down toward the whale lane.
  const pedestal = new LatheGeometry([
    new Vector2(0.05, 0),
    new Vector2(0.42, 0),
    new Vector2(0.46, 0.07),
    new Vector2(0.3, 0.16),
    new Vector2(0.17, 0.3),
    new Vector2(0.13, 0.65),
    new Vector2(0.16, 0.98),
    new Vector2(0.23, 1.1),
    new Vector2(0.26, 1.2),
    new Vector2(0.05, 1.22),
    new Vector2(0.05, 0),
  ], 16)
  const cheek = new BoxGeometry(0.05, 0.34, 0.2)
  const axle = new CylinderGeometry(0.035, 0.035, 0.36, 10)
  const trunnion = new SphereGeometry(0.055, 10, 8)
  const barrel = new CylinderGeometry(0.075, 0.095, 1.15, 16)
  const bell = new CylinderGeometry(0.125, 0.085, 0.22, 16)
  const drawTube = new CylinderGeometry(0.048, 0.052, 0.38, 12)
  const eyecup = new LatheGeometry([
    new Vector2(0.03, 0),
    new Vector2(0.06, 0.02),
    new Vector2(0.075, 0.07),
    new Vector2(0.05, 0.1),
    new Vector2(0.03, 0.1),
  ], 12)
  const counterweight = new SphereGeometry(0.09, 12, 9)
  const up = new Vector3(0, 1, 0)
  const sight = new Vector3(0, -0.1, -0.995).normalize() // out over the rim, tipped down
  const sightRotation = new Quaternion().setFromUnitVectors(up, sight)
  for (const x of [centerX - 12, centerX + 12]) {
    const standZ = centerZ + 0.45
    writer.place(materials.verdigris, pedestal, x, floorY + 0.1, standZ)
    const pivot = new Vector3(x, floorY + 1.42, standZ)
    for (const side of [-1, 1]) {
      const cheekMatrix = new Matrix4().setPosition(pivot.x + side * 0.11, pivot.y - 0.05, pivot.z)
      writer.emit(materials.brass, cheek, cheekMatrix)
      writer.place(materials.brass, trunnion, pivot.x + side * 0.15, pivot.y, pivot.z)
    }
    const axleMatrix = new Matrix4()
      .makeRotationZ(Math.PI / 2)
    axleMatrix.setPosition(pivot.x, pivot.y, pivot.z)
    writer.emit(materials.brass, axle, axleMatrix)
    const along = (offset: number) => pivot.clone().addScaledVector(sight, offset)
    const poseAt = (offset: number) => {
      const at = along(offset)
      return new Matrix4().compose(at, sightRotation, new Vector3(1, 1, 1))
    }
    writer.emit(materials.brass, barrel, poseAt(0.15))
    writer.emit(materials.brass, bell, poseAt(0.82))
    writer.emit(materials.brass, drawTube, poseAt(-0.6))
    const cupAt = along(-0.78)
    const cupMatrix = new Matrix4().compose(
      cupAt,
      new Quaternion().setFromUnitVectors(up, sight.clone().negate()),
      new Vector3(1, 1, 1),
    )
    writer.emit(materials.iron, eyecup, cupMatrix)
    const weightAt = along(-0.42)
    writer.place(materials.iron, counterweight, weightAt.x, weightAt.y - 0.16, weightAt.z)
    const weightArm = new CylinderGeometry(0.02, 0.02, 0.16, 8)
    writer.place(materials.iron, weightArm, weightAt.x, weightAt.y - 0.08, weightAt.z)
    weightArm.dispose()
    physics.addStaticCylinder(x, floorY + 0.75, standZ, 0.75, 0.4)
  }
  pedestal.dispose()
  cheek.dispose()
  axle.dispose()
  trunnion.dispose()
  barrel.dispose()
  bell.dispose()
  drawTube.dispose()
  eyecup.dispose()
  counterweight.dispose()
}

function ringStations(
  x: number,
  z: number,
  radius: number,
  count: number,
  phase = 0,
): { x: number; z: number }[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2 + phase
    return { x: x + Math.sin(angle) * radius, z: z + Math.cos(angle) * radius }
  })
}
