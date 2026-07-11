import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  LatheGeometry,
  Matrix4,
  SphereGeometry,
  TorusGeometry,
  Vector2,
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
  const { kit, writer } = ctx
  const atrium = PARK_PLAN.atrium
  const stations = ringStations(atrium.x, atrium.z, 17, 16)
  for (let i = 0; i < stations.length; i++) {
    const next = (i + 1) % stations.length
    if (i === 0 || next === 0 || i === 8 || next === 8) continue
    kit.cornice(writer, stations[i].x, stations[i].z, stations[next].x, stations[next].z, floorY + 9.12)
  }
  for (const z of [atrium.z - 18.4, atrium.z + 18.4]) {
    kit.urn(writer, atrium.x - 2.2, floorY + 0.18, z, 1.1)
    kit.urn(writer, atrium.x + 2.2, floorY + 0.18, z, 1.1)
  }
}

/**
 * Architectural finish layer for the park's civic sites. Each function works
 * from an explicit bay/ring plan and emits into the shared material slots, so
 * ornamental density does not turn into ornamental draw-call density.
 */
export function detailEsplanade(ctx: FacilityDetailContext, floorY: number): void {
  const { kit, writer } = ctx
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
      kit.urn(writer, esp.x + side * (esp.width / 2 - 1), floorY + 0.18, z, 1.15)
    }
  }
}

export function detailTidalCourt(ctx: FacilityDetailContext, floorY: number): void {
  const { kit, writer, materials } = ctx
  const hub = PARK_PLAN.tidalCourt
  const stations = ringStations(hub.x, hub.z, hub.colonnadeRadius, 28)
  const gates = new Set([0, 3, 7, 14, 21])
  for (let i = 0; i < stations.length; i++) {
    const next = (i + 1) % stations.length
    if (gates.has(i) || gates.has(next)) continue
    kit.cornice(writer, stations[i].x, stations[i].z, stations[next].x, stations[next].z, floorY + 7.65)
  }

  const pedestal = new LatheGeometry([
    new Vector2(0.52, 0), new Vector2(0.6, 0.1), new Vector2(0.42, 0.24),
    new Vector2(0.34, 0.82), new Vector2(0.5, 0.96),
  ], 16)
  const pearl = new SphereGeometry(0.22, 14, 9)
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + Math.PI / 8
    const x = hub.x + Math.sin(angle) * (hub.lagoonRadius + 2.5)
    const z = hub.z + Math.cos(angle) * (hub.lagoonRadius + 2.5)
    writer.place(materials.marble, pedestal, x, floorY + 0.18, z)
    writer.place(materials.nacre, pearl, x, floorY + 1.3, z)
  }
  pedestal.dispose()
  pearl.dispose()
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
  // silhouettes are low-poly, but bevel bands, canopy valances, and finials
  // keep them from reading as boxes.
  const counter = new BoxGeometry(4.6, 0.9, 1.15)
  const counterTop = new BoxGeometry(4.9, 0.12, 1.42)
  const canopy = new ConeGeometry(2.75, 0.82, 8, 1, true)
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

  const bar = new LatheGeometry([
    new Vector2(1.85, 0), new Vector2(1.95, 0.12), new Vector2(1.82, 0.24),
    new Vector2(1.78, 0.9), new Vector2(2.02, 1.02),
  ], 28)
  const canopy = new TorusGeometry(2.02, 0.065, 8, 36)
  writer.place(materials.woodDark, bar, cafe.x, floorY + 0.18, cafe.z)
  const canopyMatrix = new Matrix4().makeRotationX(Math.PI / 2)
  canopyMatrix.setPosition(cafe.x, floorY + 1.23, cafe.z)
  writer.emit(materials.brass, canopy, canopyMatrix)
  physics.addStaticCylinder(cafe.x, floorY + 0.7, cafe.z, 0.55, 2)
  bar.dispose()
  canopy.dispose()
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

  // Central armillary: a legible scientific focal point at human scale.
  const plinth = new CylinderGeometry(0.82, 1.05, 0.7, 20)
  const ring = new TorusGeometry(1.35, 0.045, 8, 40)
  const globe = new SphereGeometry(0.22, 14, 9)
  writer.place(materials.marble, plinth, obs.x, floorY + 0.53, obs.z)
  for (const [rx, ry, rz] of [[0, 0, 0], [Math.PI / 2, 0, 0], [0.5, 0.72, 0.2]] as const) {
    const matrix = new Matrix4().makeRotationFromEuler(new Euler(rx, ry, rz))
    matrix.setPosition(obs.x, floorY + 2.05, obs.z)
    writer.emit(materials.brass, ring, matrix)
  }
  writer.place(materials.nacre, globe, obs.x, floorY + 2.05, obs.z)
  physics.addStaticCylinder(obs.x, floorY + 0.65, obs.z, 0.65, 1.05)
  plinth.dispose()
  ring.dispose()
  globe.dispose()
}

export function detailOverlook(
  ctx: FacilityDetailContext,
  centerX: number,
  centerZ: number,
  floorY: number,
): void {
  const { kit, writer, materials } = ctx
  for (const x of [centerX - 30, centerX, centerX + 30]) {
    kit.urn(writer, x, floorY + 0.1, centerZ - 1, x === centerX ? 1.35 : 1.05)
  }
  const telescope = new CylinderGeometry(0.18, 0.28, 1.7, 14)
  const eyepiece = new TorusGeometry(0.19, 0.035, 7, 18)
  const yoke = new CylinderGeometry(0.07, 0.1, 0.3, 10)
  const pivot = new SphereGeometry(0.18, 12, 8)
  const foot = new LatheGeometry([
    new Vector2(0.4, 0), new Vector2(0.48, 0.08), new Vector2(0.2, 0.25),
    new Vector2(0.11, 1.12), new Vector2(0.25, 1.22),
  ], 14)
  for (const x of [centerX - 12, centerX + 12]) {
    const standZ = centerZ + 0.45
    writer.place(materials.verdigris, foot, x, floorY + 0.1, standZ)
    writer.place(materials.brass, yoke, x, floorY + 1.37, standZ)
    writer.place(materials.brass, pivot, x, floorY + 1.55, standZ)
    const body = new Matrix4().makeRotationX(Math.PI / 2 - 0.18)
    body.setPosition(x, floorY + 1.8, centerZ - 0.05)
    writer.emit(materials.brass, telescope, body)
    const eye = new Matrix4().makeRotationX(Math.PI / 2 - 0.18)
    eye.setPosition(x, floorY + 2.0, centerZ + 0.72)
    writer.emit(materials.iron, eyepiece, eye)
  }
  telescope.dispose()
  eyepiece.dispose()
  yoke.dispose()
  pivot.dispose()
  foot.dispose()
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
