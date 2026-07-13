import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Object3D,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { MeshStandardNodeMaterial } from 'three/webgpu'
import type { MaterialsSystem } from '../materials/materialsSystem'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'

const BENCH_CAPACITY = 24
const LAMP_CAPACITY = 64
const LAMP_GLOBE_X = 0.52
const LAMP_GLOBE_Y = 3.42
const LAMP_GLOBE_RADIUS = 0.19

type PrototypeSlot = {
  geometry: BufferGeometry
  material: MeshStandardNodeMaterial
  mesh: InstancedMesh
}

/**
 * One authored prototype and one transform per amenity placement. Bench and
 * lamp parts can no longer drift into different spatial chunks or receive
 * inconsistent per-placement transforms.
 */
export class ParkAmenitiesSystem implements GameSystem {
  readonly id = 'park-amenities'

  private readonly materials: MaterialsSystem
  private readonly group = new Object3D()
  private benchSlots: PrototypeSlot[] = []
  private lampSlots: PrototypeSlot[] = []
  private benchCount = 0
  private lampCount = 0
  private readonly matrix = new Matrix4()

  constructor(materials: MaterialsSystem) {
    this.materials = materials
  }

  init(ctx: GameContext): void {
    const lib = this.materials.lib
    if (!lib) throw new Error('ParkAmenitiesSystem requires park materials')

    const bench = createBenchPrototype()
    const lamp = createLampPrototype()
    assertAmenityGeometry(bench, lamp)

    this.benchSlots = [
      this.createSlot(bench.wood, lib.woodDark, BENCH_CAPACITY, 'amenity-bench:wood'),
      this.createSlot(bench.iron, lib.iron, BENCH_CAPACITY, 'amenity-bench:iron'),
      this.createSlot(bench.brass, lib.brass, BENCH_CAPACITY, 'amenity-bench:brass'),
    ]
    this.lampSlots = [
      this.createSlot(lamp.iron, lib.iron, LAMP_CAPACITY, 'amenity-lamp:iron'),
      this.createSlot(lamp.brass, lib.brass, LAMP_CAPACITY, 'amenity-lamp:brass'),
      this.createSlot(lamp.verdigris, lib.verdigris, LAMP_CAPACITY, 'amenity-lamp:base'),
      this.createSlot(lamp.globe, lib.lampGlobe, LAMP_CAPACITY, 'amenity-lamp:globes', false),
    ]
    ctx.scene.add(this.group)
  }

  addBenchFacing(
    x: number,
    y: number,
    z: number,
    targetX: number,
    targetZ: number,
  ): void {
    if (this.benchCount >= BENCH_CAPACITY) throw new Error('Park bench instance capacity exceeded')
    const yaw = benchYawToward(x, z, targetX, targetZ)
    if (benchFacingDot(x, z, yaw, targetX, targetZ) < 0.999999) {
      throw new Error('Park bench does not face its declared target')
    }
    this.matrix.makeRotationY(yaw)
    this.matrix.setPosition(x, y, z)
    this.writeInstance(this.benchSlots, this.benchCount, this.matrix)
    this.benchCount++
  }

  addLamp(x: number, y: number, z: number, yaw = 0): { x: number; y: number; z: number } {
    if (this.lampCount >= LAMP_CAPACITY) throw new Error('Park lamp instance capacity exceeded')
    this.matrix.makeRotationY(yaw)
    this.matrix.setPosition(x, y, z)
    this.writeInstance(this.lampSlots, this.lampCount, this.matrix)
    this.lampCount++
    return { x, y: y + LAMP_GLOBE_Y, z }
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
    for (const slot of [...this.benchSlots, ...this.lampSlots]) slot.geometry.dispose()
    this.benchSlots = []
    this.lampSlots = []
  }

  private createSlot(
    geometry: BufferGeometry,
    material: MeshStandardNodeMaterial,
    capacity: number,
    name: string,
    castShadow = true,
  ): PrototypeSlot {
    const mesh = new InstancedMesh(geometry, material, capacity)
    mesh.count = 0
    mesh.name = name
    mesh.castShadow = castShadow
    mesh.receiveShadow = true
    this.group.add(mesh)
    return { geometry, material, mesh }
  }

  private writeInstance(slots: PrototypeSlot[], index: number, transform: Matrix4): void {
    for (const slot of slots) {
      slot.mesh.setMatrixAt(index, transform)
      slot.mesh.count = index + 1
      slot.mesh.instanceMatrix.needsUpdate = true
      slot.mesh.computeBoundingBox()
      slot.mesh.computeBoundingSphere()
    }
  }
}

/** Local bench front is -Z; derive yaw from an explicit world-space target. */
export function benchYawToward(x: number, z: number, targetX: number, targetZ: number): number {
  if (Math.hypot(targetX - x, targetZ - z) < 1e-6) {
    throw new Error('Bench facing target must differ from its position')
  }
  return Math.atan2(x - targetX, z - targetZ)
}

export function benchFacingDot(
  x: number,
  z: number,
  yaw: number,
  targetX: number,
  targetZ: number,
): number {
  const dx = targetX - x
  const dz = targetZ - z
  const inverseLength = 1 / Math.hypot(dx, dz)
  const forwardX = -Math.sin(yaw)
  const forwardZ = -Math.cos(yaw)
  return forwardX * dx * inverseLength + forwardZ * dz * inverseLength
}

type BenchPrototype = { wood: BufferGeometry; iron: BufferGeometry; brass: BufferGeometry }
type LampPrototype = {
  iron: BufferGeometry
  brass: BufferGeometry
  verdigris: BufferGeometry
  globe: BufferGeometry
}

export function createBenchPrototype(): BenchPrototype {
  const wood: BufferGeometry[] = []
  const iron: BufferGeometry[] = []
  const brass: BufferGeometry[] = []

  // Seat: five closely spaced boards on two side rails.
  for (let i = 0; i < 5; i++) {
    wood.push(boxPart(1.72, 0.055, 0.105, new Vector3(0, 0.48, -0.22 + i * 0.105)))
  }
  // Back: four boards overlap both posts, leaving no unsupported slat ends.
  for (let i = 0; i < 4; i++) {
    wood.push(boxPart(1.72, 0.075, 0.095, new Vector3(0, 0.7 + i * 0.13, 0.235 + i * 0.018)))
  }

  for (const side of [-1, 1]) {
    const x = side * 0.84
    iron.push(cylinderBetween(new Vector3(x, 0.05, -0.2), new Vector3(x, 0.47, -0.2), 0.045, 8))
    iron.push(cylinderBetween(new Vector3(x, 0.05, 0.2), new Vector3(x, 0.47, 0.2), 0.045, 8))
    iron.push(cylinderBetween(new Vector3(x, 0.46, -0.26), new Vector3(x, 0.46, 0.27), 0.04, 8))
    iron.push(cylinderBetween(new Vector3(x, 0.45, 0.22), new Vector3(x, 1.13, 0.29), 0.045, 8))
    iron.push(cylinderBetween(new Vector3(x, 0.72, -0.2), new Vector3(x, 0.72, 0.23), 0.035, 8))
    iron.push(spherePart(0.07, new Vector3(x, 0.72, -0.2), 9, 6))
    brass.push(spherePart(0.075, new Vector3(x, 1.14, 0.292), 10, 7))
    // Armrest: a post rising off the seat rail into a volute curl. The curl
    // is a YZ-plane torus arc whose θ=0 point is EXACTLY the post top
    // (rotateY(π/2) maps θ=0 to centre+(0,0,−r)), so nothing floats; the
    // scroll's free end gets a brass tip bead computed on the same circle.
    const curlCenter = new Vector3(x, 0.68, -0.02)
    const curlRadius = 0.08
    const postTop = new Vector3(x, curlCenter.y, curlCenter.z - curlRadius)
    iron.push(cylinderBetween(new Vector3(x, 0.45, -0.2), postTop, 0.021, 8))
    const armrest = new TorusGeometry(curlRadius, 0.019, 6, 18, Math.PI * 1.3)
    armrest.rotateY(Math.PI / 2)
    armrest.translate(curlCenter.x, curlCenter.y, curlCenter.z)
    iron.push(armrest)
    const endTheta = Math.PI * 1.3
    brass.push(
      spherePart(
        0.028,
        new Vector3(
          x,
          curlCenter.y + Math.sin(endTheta) * curlRadius,
          curlCenter.z - Math.cos(endTheta) * curlRadius,
        ),
        8,
        6,
      ),
    )
  }
  iron.push(cylinderBetween(new Vector3(-0.84, 0.18, 0.2), new Vector3(0.84, 0.18, 0.2), 0.035, 8))
  iron.push(cylinderBetween(new Vector3(-0.84, 0.42, -0.22), new Vector3(0.84, 0.42, -0.22), 0.032, 8))

  return { wood: mergeParts(wood), iron: mergeParts(iron), brass: mergeParts(brass) }
}

export function createLampPrototype(): LampPrototype {
  const iron: BufferGeometry[] = []
  const brass: BufferGeometry[] = []
  const verdigris: BufferGeometry[] = []
  const globe: BufferGeometry[] = []

  iron.push(cylinderBetween(new Vector3(0, 0.34, 0), new Vector3(0, 3.23, 0), 0.065, 10))
  const junction = new Vector3(0, 3.23, 0)
  brass.push(spherePart(0.085, new Vector3(0, 3.28, 0), 10, 8))
  for (const side of [-1, 1]) {
    const elbow = new Vector3(side * 0.27, 3.39, 0)
    const globeAnchor = new Vector3(side * (LAMP_GLOBE_X - LAMP_GLOBE_RADIUS * 0.72), 3.42, 0)
    iron.push(cylinderBetween(junction, elbow, 0.035, 8))
    iron.push(cylinderBetween(elbow, globeAnchor, 0.035, 8))
    iron.push(spherePart(0.055, elbow, 9, 6))
    // Scroll bracket under each arm: a point-to-point stay from the pole
    // shoulder to the elbow with a knuckle at both ends — the arm now
    // visibly carries its lantern instead of cantilevering off thin air.
    const shoulder = new Vector3(0, 3.05, 0)
    iron.push(cylinderBetween(shoulder, elbow, 0.022, 6))
    iron.push(spherePart(0.034, shoulder, 8, 6))
    globe.push(spherePart(LAMP_GLOBE_RADIUS, new Vector3(side * LAMP_GLOBE_X, LAMP_GLOBE_Y, 0), 14, 10))
    // Lantern furniture, all seated ON the globe sphere (the old cone cap
    // and bead hovered above its pole): a calyx cup cradles the glass from
    // below with its rim rising to the equator, and the crown cap's base
    // radius is chosen so it sinks onto the sphere at a real contact
    // latitude, carrying a tip bead that overlaps the cap point.
    const globeCenter = new Vector3(side * LAMP_GLOBE_X, LAMP_GLOBE_Y, 0)
    brass.push(lanternCupPart(globeCenter, LAMP_GLOBE_RADIUS))
    brass.push(lanternCapPart(globeCenter, LAMP_GLOBE_RADIUS))
    brass.push(
      spherePart(
        0.034,
        new Vector3(globeCenter.x, capBaseY(globeCenter, LAMP_GLOBE_RADIUS) + 0.15, 0),
        9,
        6,
      ),
    )
  }

  const collar = new TorusGeometry(0.095, 0.025, 7, 16)
  collar.rotateX(Math.PI / 2)
  for (const y of [0.52, 1.35, 2.65]) {
    brass.push(transformedClone(collar, new Matrix4().makeTranslation(0, y, 0)))
  }
  collar.dispose()
  verdigris.push(new LatheGeometry([
    new Vector2(0.2, 0), new Vector2(0.24, 0.08), new Vector2(0.13, 0.2),
    new Vector2(0.105, 0.38), new Vector2(0.075, 0.48),
  ], 12))

  return {
    iron: mergeParts(iron),
    brass: mergeParts(brass),
    verdigris: mergeParts(verdigris),
    globe: mergeParts(globe),
  }
}

export function auditAmenityGeometry(): {
  benchBounds: Box3
  lampBounds: Box3
  benchSeatRailOverlap: number
  benchBackPostOverlap: number
  lampPoleArmGap: number
  lampArmGlobePenetration: number
} {
  const bench = createBenchPrototype()
  const lamp = createLampPrototype()
  assertAmenityGeometry(bench, lamp)
  const result = {
    benchBounds: combinedBounds(Object.values(bench)),
    lampBounds: combinedBounds(Object.values(lamp)),
    benchSeatRailOverlap: 0.86 + 0.04 - 0.84,
    benchBackPostOverlap: 0.86 + 0.045 - 0.84,
    lampPoleArmGap: 0,
    lampArmGlobePenetration:
      LAMP_GLOBE_RADIUS - LAMP_GLOBE_RADIUS * 0.72,
  }
  for (const geometry of [...Object.values(bench), ...Object.values(lamp)]) geometry.dispose()
  return result
}

function assertAmenityGeometry(bench: BenchPrototype, lamp: LampPrototype): void {
  const benchBounds = combinedBounds(Object.values(bench))
  const lampBounds = combinedBounds(Object.values(lamp))
  if (benchBounds.min.y < -0.001 || benchBounds.max.y > 1.24) {
    throw new Error('Bench prototype escaped its authored vertical envelope')
  }
  if (benchBounds.getSize(new Vector3()).x < 1.75 || benchBounds.getSize(new Vector3()).z > 0.8) {
    throw new Error('Bench prototype dimensions are invalid')
  }
  if (lampBounds.min.y < -0.001 || lampBounds.max.y > 3.86) {
    throw new Error('Lamp prototype escaped its authored vertical envelope')
  }
  if (lampBounds.min.x > -0.7 || lampBounds.max.x < 0.7) {
    throw new Error('Lamp globes are missing from the prototype')
  }
  const armGlobePenetration = LAMP_GLOBE_RADIUS - LAMP_GLOBE_RADIUS * 0.72
  if (armGlobePenetration < 0.03) {
    throw new Error('Lamp arm does not penetrate its globe socket')
  }
  for (const geometry of [...Object.values(bench), ...Object.values(lamp)]) {
    const position = geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      if (!Number.isFinite(position.getX(i)) || !Number.isFinite(position.getY(i)) || !Number.isFinite(position.getZ(i))) {
        throw new Error('Amenity prototype contains a non-finite vertex')
      }
    }
  }
}

function combinedBounds(geometries: BufferGeometry[]): Box3 {
  const bounds = new Box3()
  bounds.makeEmpty()
  for (const geometry of geometries) {
    geometry.computeBoundingBox()
    if (geometry.boundingBox) bounds.union(geometry.boundingBox)
  }
  return bounds
}

function mergeParts(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (!merged) throw new Error('Failed to merge amenity prototype')
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  return merged
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

/** Cap contact height: where a cap of base radius 0.66·R meets the sphere. */
function capBaseY(globeCenter: Vector3, globeRadius: number): number {
  const baseRadius = globeRadius * 0.66
  return globeCenter.y + Math.sqrt(globeRadius * globeRadius - baseRadius * baseRadius) - 0.006
}

/** Calyx cup cradling a lamp globe from below; rim rises to the equator. */
function lanternCupPart(globeCenter: Vector3, globeRadius: number): BufferGeometry {
  const cup = new LatheGeometry(
    [
      new Vector2(0.03, 0),
      new Vector2(globeRadius * 0.6, 0.02),
      new Vector2(globeRadius * 0.86, 0.07),
      new Vector2(globeRadius * 0.98, 0.13),
      new Vector2(globeRadius * 1.0, globeRadius * 0.92),
    ],
    14,
  )
  cup.translate(globeCenter.x, globeCenter.y - globeRadius * 0.92, globeCenter.z)
  return cup
}

/** Crown cap seated on the globe at a real contact latitude. */
function lanternCapPart(globeCenter: Vector3, globeRadius: number): BufferGeometry {
  const baseRadius = globeRadius * 0.66
  const cap = new LatheGeometry(
    [
      new Vector2(baseRadius, 0),
      new Vector2(baseRadius * 1.06, 0.018),
      new Vector2(baseRadius * 0.42, 0.1),
      new Vector2(baseRadius * 0.46, 0.125),
      new Vector2(0, 0.15),
    ],
    12,
  )
  cap.translate(globeCenter.x, capBaseY(globeCenter, globeRadius), globeCenter.z)
  return cap
}

function cylinderBetween(a: Vector3, b: Vector3, radius: number, segments: number): BufferGeometry {
  const direction = b.clone().sub(a)
  const length = direction.length()
  if (length <= 1e-6) throw new Error('Cannot build zero-length amenity member')
  const geometry = new CylinderGeometry(radius, radius, length, segments)
  const quaternion = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize())
  const matrix = new Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), quaternion, new Vector3(1, 1, 1))
  geometry.applyMatrix4(matrix)
  return geometry
}

function transformedClone(geometry: BufferGeometry, transform: Matrix4): BufferGeometry {
  const clone = geometry.clone()
  clone.applyMatrix4(transform)
  return clone
}
