import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  InstancedMesh,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import type { MeshStandardNodeMaterial } from 'three/webgpu'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { DistrictServices } from './districts/atrium'
import { FACILITY_ENTRANCE_SIGNS, PARK_PATHS } from './parkLayout.ts'

const ATLAS_COLUMNS = 4
// Rows follow the roster so the marker count is free to grow (the teleport
// network added the park-entrance node) without re-hand-tuning the grid.
const ATLAS_ROWS = Math.ceil(FACILITY_ENTRANCE_SIGNS.length / ATLAS_COLUMNS)
const TILE_WIDTH = 256
const TILE_HEIGHT = 128
const FACE_WIDTH = 3.08
const FACE_HEIGHT = 1.3
const FACE_Y = 2.05
const FACE_Z = -0.076

type SignPrototype = {
  iron: BufferGeometry
  brass: BufferGeometry
  verdigris: BufferGeometry
}

/**
 * A single authored entrance-marker kit for the whole park. Structural parts
 * are three instanced draws and every named face shares one atlas mesh, so
 * adding legibility does not multiply the frame's draw-call burden.
 */
export class FacilitySignsSystem implements GameSystem {
  readonly id = 'facility-signs'

  private readonly services: DistrictServices
  private readonly groundHeight: (x: number, z: number) => number
  private readonly group = new Object3D()
  private readonly ownedGeometry: BufferGeometry[] = []
  private labelMaterial: MeshBasicNodeMaterial | null = null
  private atlas: CanvasTexture | null = null

  constructor(services: DistrictServices, groundHeight: (x: number, z: number) => number) {
    this.services = services
    this.groundHeight = groundHeight
  }

  init(ctx: GameContext): void {
    const lib = this.services.materials.lib
    if (!lib) throw new Error('FacilitySignsSystem requires park materials')

    const prototype = createFacilitySignPrototype()
    const placements = FACILITY_ENTRANCE_SIGNS.map((sign) => ({
      ...sign,
      y: this.groundHeight(sign.x, sign.z) + 0.08,
      yaw: signYawToward(sign.x, sign.z, sign.approachX, sign.approachZ),
    }))
    const matrix = new Matrix4()
    const slots: [BufferGeometry, MeshStandardNodeMaterial, string][] = [
      [prototype.iron, lib.iron, 'facility-signs:iron'],
      [prototype.brass, lib.brass, 'facility-signs:brass'],
      [prototype.verdigris, lib.verdigris, 'facility-signs:boards'],
    ]
    for (const [geometry, material, name] of slots) {
      const mesh = new InstancedMesh(geometry, material, placements.length)
      mesh.name = name
      mesh.castShadow = true
      mesh.receiveShadow = true
      placements.forEach((sign, index) => {
        matrix.makeRotationY(sign.yaw)
        matrix.setPosition(sign.x, sign.y, sign.z)
        mesh.setMatrixAt(index, matrix)
      })
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingBox()
      mesh.computeBoundingSphere()
      this.group.add(mesh)
      this.ownedGeometry.push(geometry)
    }

    this.atlas = createFacilitySignAtlas()
    const labelMaterial = new MeshBasicNodeMaterial()
    labelMaterial.map = this.atlas
    labelMaterial.toneMapped = false
    this.labelMaterial = labelMaterial
    const labelGeometry = createFacilitySignFaces(placements)
    const labels = new Mesh(labelGeometry, labelMaterial)
    labels.name = 'facility-signs:names-atlas'
    this.group.add(labels)
    this.ownedGeometry.push(labelGeometry)

    for (const sign of placements) {
      if (signFacingDot(sign.x, sign.z, sign.yaw, sign.approachX, sign.approachZ) < 0.999999) {
        throw new Error(`Facility sign ${sign.id} does not face its approach`)
      }
      this.services.physics.addStaticBox(
        sign.x,
        sign.y + 1.55,
        sign.z,
        1.72,
        1.5,
        0.11,
        sign.yaw,
      )
    }

    ctx.scene.add(this.group)
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
    this.group.clear()
    for (const geometry of this.ownedGeometry) geometry.dispose()
    this.ownedGeometry.length = 0
    this.labelMaterial?.dispose()
    this.labelMaterial = null
    this.atlas?.dispose()
    this.atlas = null
  }
}

/** Local sign front is -Z, matching the park bench facing convention. */
export function signYawToward(
  x: number,
  z: number,
  targetX: number,
  targetZ: number,
): number {
  if (Math.hypot(targetX - x, targetZ - z) < 1e-6) {
    throw new Error('Facility sign approach must differ from its position')
  }
  return Math.atan2(x - targetX, z - targetZ)
}

export function signFacingDot(
  x: number,
  z: number,
  yaw: number,
  targetX: number,
  targetZ: number,
): number {
  const dx = targetX - x
  const dz = targetZ - z
  const inverseLength = 1 / Math.hypot(dx, dz)
  return -Math.sin(yaw) * dx * inverseLength - Math.cos(yaw) * dz * inverseLength
}

export function createFacilitySignPrototype(): SignPrototype {
  const iron: BufferGeometry[] = []
  const brass: BufferGeometry[] = []
  const verdigris: BufferGeometry[] = []

  // Twin rooted posts overlap the board sides; nothing is suspended or loose.
  for (const side of [-1, 1]) {
    iron.push(cylinderPart(0.075, 2.82, side * 1.55, 1.41, 0, 10))
    iron.push(cylinderPart(0.14, 0.16, side * 1.55, 0.08, 0, 12))
    brass.push(spherePart(0.13, side * 1.55, 2.98, 0))
  }
  iron.push(boxPart(3.28, 0.07, 0.11, 0, 1.25, 0))
  verdigris.push(boxPart(3.3, 1.55, 0.14, 0, FACE_Y, 0))

  // Raised brass picture-frame and a small arched crown give the marker the
  // same civic language as the park's gates without spending silhouettes.
  brass.push(boxPart(3.12, 0.05, 0.045, 0, 1.37, -0.09))
  brass.push(boxPart(3.12, 0.05, 0.045, 0, 2.73, -0.09))
  brass.push(boxPart(0.05, 1.41, 0.045, -1.535, FACE_Y, -0.09))
  brass.push(boxPart(0.05, 1.41, 0.045, 1.535, FACE_Y, -0.09))
  const crown = new TorusGeometry(0.5, 0.04, 7, 18, Math.PI)
  crown.translate(0, 2.75, 0)
  brass.push(crown)
  brass.push(spherePart(0.085, -0.5, 2.75, 0))
  brass.push(spherePart(0.085, 0.5, 2.75, 0))

  return {
    iron: mergeParts(iron),
    brass: mergeParts(brass),
    verdigris: mergeParts(verdigris),
  }
}

type FacePlacement = (typeof FACILITY_ENTRANCE_SIGNS)[number] & {
  y: number
  yaw: number
}

function createFacilitySignFaces(placements: readonly FacePlacement[]): BufferGeometry {
  const faces = placements.map((sign, index) => {
    const face = new PlaneGeometry(FACE_WIDTH, FACE_HEIGHT)
    const column = index % ATLAS_COLUMNS
    const row = Math.floor(index / ATLAS_COLUMNS)
    const u0 = column / ATLAS_COLUMNS
    const u1 = (column + 1) / ATLAS_COLUMNS
    const v0 = 1 - (row + 1) / ATLAS_ROWS
    const v1 = 1 - row / ATLAS_ROWS
    const uv = face.getAttribute('uv')
    for (let vertex = 0; vertex < uv.count; vertex++) {
      const sourceU = uv.getX(vertex)
      const sourceV = uv.getY(vertex)
      uv.setXY(vertex, u0 + sourceU * (u1 - u0), v0 + sourceV * (v1 - v0))
    }
    face.rotateY(Math.PI)
    face.translate(0, FACE_Y, FACE_Z)
    const transform = new Matrix4().makeRotationY(sign.yaw)
    transform.setPosition(sign.x, sign.y, sign.z)
    face.applyMatrix4(transform)
    return face
  })
  const merged = mergeGeometries(faces, false)
  for (const face of faces) face.dispose()
  if (!merged) throw new Error('Could not merge facility sign name faces')
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  return merged
}

function createFacilitySignAtlas(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = TILE_WIDTH * ATLAS_COLUMNS
  canvas.height = TILE_HEIGHT * ATLAS_ROWS
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not create facility sign name atlas')

  FACILITY_ENTRANCE_SIGNS.forEach((sign, index) => {
    const x = (index % ATLAS_COLUMNS) * TILE_WIDTH
    const y = Math.floor(index / ATLAS_COLUMNS) * TILE_HEIGHT
    const gradient = context.createLinearGradient(x, y, x, y + TILE_HEIGHT)
    gradient.addColorStop(0, '#16383a')
    gradient.addColorStop(1, '#081f24')
    context.fillStyle = gradient
    context.fillRect(x, y, TILE_WIDTH, TILE_HEIGHT)
    context.strokeStyle = '#c8a85d'
    context.lineWidth = 3
    context.strokeRect(x + 8, y + 8, TILE_WIDTH - 16, TILE_HEIGHT - 16)
    context.strokeStyle = '#6f916f'
    context.lineWidth = 1
    context.strokeRect(x + 13, y + 13, TILE_WIDTH - 26, TILE_HEIGHT - 26)

    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillStyle = '#f0dfae'
    context.font = fitFont(context, sign.title, 27, TILE_WIDTH - 34, 'Georgia, serif', 600)
    context.fillText(sign.title, x + TILE_WIDTH / 2, y + (sign.subtitle ? 53 : 64))
    if (sign.subtitle) {
      context.fillStyle = '#b8cfca'
      context.font = fitFont(context, sign.subtitle, 15, TILE_WIDTH - 38, 'Arial, sans-serif', 500)
      context.fillText(sign.subtitle, x + TILE_WIDTH / 2, y + 84)
      context.fillStyle = '#c8a85d'
      context.fillRect(x + 91, y + 101, 74, 1)
    }
  })

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

function fitFont(
  context: CanvasRenderingContext2D,
  text: string,
  startSize: number,
  maxWidth: number,
  family: string,
  weight: number,
): string {
  let size = startSize
  while (size > 10) {
    const font = `${weight} ${size}px ${family}`
    context.font = font
    if (context.measureText(text).width <= maxWidth) return font
    size--
  }
  return `${weight} 10px ${family}`
}

function boxPart(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
): BufferGeometry {
  const geometry = new BoxGeometry(width, height, depth)
  geometry.translate(x, y, z)
  return geometry
}

function cylinderPart(
  radius: number,
  height: number,
  x: number,
  y: number,
  z: number,
  segments: number,
): BufferGeometry {
  const geometry = new CylinderGeometry(radius, radius, height, segments)
  geometry.translate(x, y, z)
  return geometry
}

function spherePart(radius: number, x: number, y: number, z: number): BufferGeometry {
  const geometry = new SphereGeometry(radius, 10, 7)
  geometry.translate(x, y, z)
  return geometry
}

function mergeParts(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (!merged) throw new Error('Could not merge facility sign prototype')
  merged.computeVertexNormals()
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  return merged
}

export function auditFacilitySigns(): {
  signCount: number
  drawSlots: number
  atlasBytes: number
  frameBounds: Box3
  minimumFacingDot: number
  minimumPathClearance: number
} {
  if (FACILITY_ENTRANCE_SIGNS.length > ATLAS_COLUMNS * ATLAS_ROWS) {
    throw new Error('Facility entrance sign atlas overflows its grid')
  }
  const ids = new Set(FACILITY_ENTRANCE_SIGNS.map((sign) => sign.id))
  if (ids.size !== FACILITY_ENTRANCE_SIGNS.length) {
    throw new Error('Facility entrance sign ids must be unique')
  }
  const prototype = createFacilitySignPrototype()
  const frameBounds = new Box3()
  for (const geometry of Object.values(prototype)) {
    geometry.computeBoundingBox()
    if (geometry.boundingBox) frameBounds.union(geometry.boundingBox)
  }
  const minimumFacingDot = Math.min(...FACILITY_ENTRANCE_SIGNS.map((sign) => {
    const yaw = signYawToward(sign.x, sign.z, sign.approachX, sign.approachZ)
    return signFacingDot(sign.x, sign.z, yaw, sign.approachX, sign.approachZ)
  }))
  const pathClearances = FACILITY_ENTRANCE_SIGNS.flatMap((sign) => PARK_PATHS.map((path) => ({
    id: sign.id,
    clearance: pointSegmentDistance(sign.x, sign.z, path.ax, path.az, path.bx, path.bz) - path.width / 2,
  })))
  const minimumPathClearance = Math.min(...pathClearances.map((entry) => entry.clearance))
  const obstructing = pathClearances.filter((entry) => entry.clearance < 0.35)
  if (obstructing.length > 0) {
    throw new Error(`Facility signs obstruct walking lanes: ${obstructing.map((entry) => `${entry.id} (${entry.clearance.toFixed(2)}m)`).join(', ')}`)
  }
  if (minimumFacingDot < 0.999999) throw new Error('A facility entrance sign faces away from its approach')
  if (frameBounds.min.y > 0.001 || frameBounds.max.y < 2.9) {
    throw new Error('Facility entrance sign frame is not rooted and crowned')
  }
  for (const geometry of Object.values(prototype)) geometry.dispose()
  return {
    signCount: FACILITY_ENTRANCE_SIGNS.length,
    drawSlots: 4,
    atlasBytes: TILE_WIDTH * ATLAS_COLUMNS * TILE_HEIGHT * ATLAS_ROWS * 4,
    frameBounds,
    minimumFacingDot,
    minimumPathClearance,
  }
}

function pointSegmentDistance(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax
  const abz = bz - az
  const lengthSquared = abx * abx + abz * abz
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / lengthSquared))
  return Math.hypot(x - (ax + abx * t), z - (az + abz * t))
}
