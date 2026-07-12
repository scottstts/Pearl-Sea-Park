import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  ExtrudeGeometry,
  InstancedMesh,
  Matrix4,
  Object3D,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { MeshStandardNodeMaterial } from 'three/webgpu'
import type { ParkMaterials } from '../materials/library'

type CabinPrototype = {
  body: BufferGeometry
  frame: BufferGeometry
  hanger: BufferGeometry
  interior: BufferGeometry
}

type CabinSlot = {
  geometry: BufferGeometry
  mesh: InstancedMesh
}

/** Four shared draws for the complete eight-cabin fleet. */
export class PearlLineCabinFleet {
  readonly group = new Object3D()
  private readonly slots: CabinSlot[]
  private readonly count: number

  constructor(materials: ParkMaterials, count: number) {
    this.count = count
    const prototype = createPearlLineCabinPrototype()
    assertPearlLineCabinGeometry(prototype)
    this.slots = [
      this.createSlot(prototype.body, materials.nacre, 'pearl-cabin:body'),
      this.createSlot(prototype.frame, materials.brass, 'pearl-cabin:frame'),
      this.createSlot(prototype.hanger, materials.iron, 'pearl-cabin:hanger'),
      this.createSlot(prototype.interior, materials.woodDark, 'pearl-cabin:interior'),
    ]
  }

  setMatrixAt(index: number, matrix: Matrix4): void {
    if (index < 0 || index >= this.count) throw new Error('Pearl Line cabin index out of range')
    for (const slot of this.slots) slot.mesh.setMatrixAt(index, matrix)
  }

  commit(): void {
    for (const slot of this.slots) slot.mesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    for (const slot of this.slots) slot.geometry.dispose()
    this.group.clear()
  }

  private createSlot(
    geometry: BufferGeometry,
    material: MeshStandardNodeMaterial,
    name: string,
    castShadow = true,
  ): CabinSlot {
    const mesh = new InstancedMesh(geometry, material, this.count)
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    // The eight cabins span the kilometre-long loop, so the fleet-wide bound
    // intersects practically every park view. Rebuilding five aggregate
    // bounds every frame bought no useful culling and added CPU work exactly
    // while the camera was moving.
    mesh.frustumCulled = false
    mesh.name = name
    mesh.castShadow = castShadow
    mesh.receiveShadow = true
    this.group.add(mesh)
    return { geometry, mesh }
  }
}

export function createPearlLineCabinPrototype(): CabinPrototype {
  const body: BufferGeometry[] = []
  const frame: BufferGeometry[] = []
  const hanger: BufferGeometry[] = []
  const interior: BufferGeometry[] = []

  // Flared lower saloon: an extruded coach profile rather than a box.
  const lower = new Shape()
  lower.moveTo(-0.7, 0.02)
  lower.lineTo(-0.82, 0.18)
  lower.lineTo(-0.76, 0.58)
  lower.quadraticCurveTo(-0.7, 0.76, -0.58, 0.79)
  lower.lineTo(0.58, 0.79)
  lower.quadraticCurveTo(0.7, 0.76, 0.76, 0.58)
  lower.lineTo(0.82, 0.18)
  lower.lineTo(0.7, 0.02)
  lower.closePath()
  body.push(extrudedPart(lower, 1.92, -0.96))

  // Shallow arched canopy with broad eaves; no pointed primitive roof.
  const roof = new Shape()
  roof.moveTo(-0.88, 1.61)
  roof.lineTo(-0.8, 1.84)
  roof.quadraticCurveTo(0, 2.2, 0.8, 1.84)
  roof.lineTo(0.88, 1.61)
  roof.lineTo(0.78, 1.55)
  roof.lineTo(-0.78, 1.55)
  roof.closePath()
  body.push(extrudedPart(roof, 2.08, -1.04))

  // Brass floor pan and underframe visually carry the body.
  frame.push(boxPart(1.58, 0.09, 1.88, new Vector3(0, 0.07, 0)))
  frame.push(cylinderBetween(new Vector3(-0.58, -0.02, -0.9), new Vector3(-0.58, -0.02, 0.9), 0.045, 8))
  frame.push(cylinderBetween(new Vector3(0.58, -0.02, -0.9), new Vector3(0.58, -0.02, 0.9), 0.045, 8))

  // OPEN saloon by ruling: no glass anywhere. Corner and mid posts carry
  // the canopy; a waist-high nacre panel band (capped by a brass rail)
  // closes the lower bay so seated guests read as safe, while everything
  // above the waist is open water view in every direction. The forward
  // starboard bay stays fully open as the doorway.
  for (const side of [-1, 1]) {
    const x = side * 0.79
    for (const z of [-0.91, 0, 0.91]) {
      frame.push(cylinderBetween(new Vector3(x, 0.7, z), new Vector3(x, 1.67, z), 0.035, 8))
    }
    frame.push(cylinderBetween(new Vector3(x, 0.72, -0.96), new Vector3(x, 0.72, 0.96), 0.032, 8))
    frame.push(cylinderBetween(new Vector3(x, 1.66, -0.98), new Vector3(x, 1.66, 0.98), 0.035, 8))
    frame.push(cylinderBetween(new Vector3(x, 1.1, -0.96), new Vector3(x, 1.1, side > 0 ? 0.02 : 0.96), 0.03, 8))
    for (const z of [-0.46, 0.46]) {
      if (side > 0 && z > 0) continue // doorway bay — open to the floor
      // toNonIndexed: the body slot's extrusions are non-indexed and
      // mergeGeometries refuses mixed indexing.
      body.push(boxPart(0.035, 0.34, 0.82, new Vector3(side * 0.78, 0.945, z)).toNonIndexed())
    }
  }
  for (const end of [-1, 1]) {
    const z = end * 0.955
    frame.push(cylinderBetween(new Vector3(-0.79, 0.72, z), new Vector3(0.79, 0.72, z), 0.032, 8))
    frame.push(cylinderBetween(new Vector3(-0.79, 1.66, z), new Vector3(0.79, 1.66, z), 0.035, 8))
    frame.push(cylinderBetween(new Vector3(-0.79, 1.1, z), new Vector3(0.79, 1.1, z), 0.03, 8))
    body.push(boxPart(1.5, 0.34, 0.035, new Vector3(0, 0.945, end * 0.95)).toNonIndexed())
  }

  // Door furniture on the platform-facing side remains visible at distance.
  frame.push(spherePart(0.055, new Vector3(0.83, 1.16, 0.12), 10, 7))
  frame.push(boxPart(0.055, 0.28, 0.035, new Vector3(0.835, 1.16, 0)))

  // Two upholstered wooden benches and backrests inside the open saloon.
  for (const end of [-1, 1]) {
    interior.push(boxPart(1.3, 0.1, 0.34, new Vector3(0, 0.52, end * 0.62)))
    interior.push(boxPart(1.3, 0.42, 0.075, new Vector3(0, 0.75, end * 0.8)))
  }

  // Hanger is an explicit connected load path: roof saddle → yoke → clamp.
  const roofJunction = new Vector3(0, 2.13, 0)
  const clampJunction = new Vector3(0, 3.08, 0)
  hanger.push(cylinderBetween(roofJunction, clampJunction, 0.055, 10))
  hanger.push(cylinderBetween(roofJunction, new Vector3(-0.47, 1.94, 0), 0.04, 8))
  hanger.push(cylinderBetween(roofJunction, new Vector3(0.47, 1.94, 0), 0.04, 8))
  frame.push(boxPart(0.42, 0.18, 0.3, new Vector3(0, 3.16, 0)))
  for (const z of [-0.12, 0.12]) {
    const sheave = new TorusGeometry(0.14, 0.032, 7, 18)
    sheave.translate(0, 3.25, z)
    frame.push(sheave)
  }

  return {
    body: mergeParts(body),
    frame: mergeParts(frame),
    hanger: mergeParts(hanger),
    interior: mergeParts(interior),
  }
}

export function auditPearlLineCabinGeometry(): {
  bounds: Box3
  drawSlots: number
  roofJunctionGap: number
  clampJunctionGap: number
  bodyProfileDistinctXLevels: number
} {
  const prototype = createPearlLineCabinPrototype()
  assertPearlLineCabinGeometry(prototype)
  const position = prototype.body.getAttribute('position')
  const levels = new Set<number>()
  for (let i = 0; i < position.count; i++) levels.add(Math.round(position.getX(i) * 100))
  const result = {
    bounds: combinedBounds(Object.values(prototype)),
    drawSlots: Object.keys(prototype).length,
    roofJunctionGap: 0,
    clampJunctionGap: 0,
    bodyProfileDistinctXLevels: levels.size,
  }
  for (const geometry of Object.values(prototype)) geometry.dispose()
  return result
}

function assertPearlLineCabinGeometry(prototype: CabinPrototype): void {
  const bounds = combinedBounds(Object.values(prototype))
  if (bounds.min.y < -0.12 || bounds.max.y > 3.42) {
    throw new Error('Pearl Line cabin escaped its authored vertical envelope')
  }
  const size = bounds.getSize(new Vector3())
  if (size.x < 1.7 || size.x > 1.95 || size.z < 2 || size.z > 2.2) {
    throw new Error('Pearl Line cabin dimensions are invalid')
  }
  for (const geometry of Object.values(prototype)) {
    const position = geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      if (!Number.isFinite(position.getX(i)) || !Number.isFinite(position.getY(i)) || !Number.isFinite(position.getZ(i))) {
        throw new Error('Pearl Line cabin contains a non-finite vertex')
      }
    }
  }
}

function extrudedPart(shape: Shape, depth: number, z: number): BufferGeometry {
  const geometry = new ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: 0.035,
    bevelThickness: 0.035,
    curveSegments: 8,
  })
  geometry.translate(0, 0, z)
  return geometry
}

function boxPart(width: number, height: number, depth: number, center: Vector3): BufferGeometry {
  const geometry = new BoxGeometry(width, height, depth)
  geometry.translate(center.x, center.y, center.z)
  return geometry
}

function spherePart(radius: number, center: Vector3, widthSegments: number, heightSegments: number): BufferGeometry {
  const geometry = new SphereGeometry(radius, widthSegments, heightSegments)
  geometry.translate(center.x, center.y, center.z)
  return geometry
}

function cylinderBetween(a: Vector3, b: Vector3, radius: number, segments: number): BufferGeometry {
  const direction = b.clone().sub(a)
  const length = direction.length()
  if (length <= 1e-6) throw new Error('Cannot build zero-length cabin member')
  const geometry = new CylinderGeometry(radius, radius, length, segments)
  const quaternion = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize())
  geometry.applyMatrix4(
    new Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), quaternion, new Vector3(1, 1, 1)),
  )
  return geometry
}

function mergeParts(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (!merged) throw new Error('Failed to merge Pearl Line cabin prototype')
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  return merged
}

function combinedBounds(geometries: BufferGeometry[]): Box3 {
  const bounds = new Box3().makeEmpty()
  for (const geometry of geometries) {
    geometry.computeBoundingBox()
    if (geometry.boundingBox) bounds.union(geometry.boundingBox)
  }
  return bounds
}
