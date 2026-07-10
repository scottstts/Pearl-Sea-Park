import {
  ClampToEdgeWrapping,
  DataUtils,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  RedFormat,
} from 'three'
import { parkFootprintSignedDistance } from '../world/parkPlan'
import { terrainHeight } from '../world/terrain'

export const WILDLIFE_FIELD = Object.freeze({
  minX: -280,
  minZ: -260,
  width: 560,
  depth: 610,
  resolution: 128,
})

export interface WildlifeFieldMaps {
  readonly parkSdf: DataTexture
  readonly terrain: DataTexture
  dispose(): void
}

/**
 * Coarse park-scale fields for the boid compute. Obstacles and ground are
 * sampled from the same CPU authorities as architecture, scatter, and
 * Rapier, then linearly filtered on the GPU. At 128² this is deliberately a
 * flow field, not per-baluster collision.
 */
export function createWildlifeFieldMaps(): WildlifeFieldMaps {
  const { minX, minZ, width, depth, resolution } = WILDLIFE_FIELD
  const sdf = new Float32Array(resolution * resolution)
  const ground = new Float32Array(resolution * resolution)

  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const u = x / (resolution - 1)
      const v = z / (resolution - 1)
      const worldX = minX + u * width
      const worldZ = minZ + v * depth
      const index = z * resolution + x
      sdf[index] = parkFootprintSignedDistance(worldX, worldZ)
      ground[index] = terrainHeight(worldX, worldZ)
    }
  }

  const parkSdf = fieldTexture(sdf, resolution)
  const terrain = fieldTexture(ground, resolution)
  return {
    parkSdf,
    terrain,
    dispose() {
      parkSdf.dispose()
      terrain.dispose()
    },
  }
}

function fieldTexture(data: Float32Array, resolution: number): DataTexture {
  // r32float is not linearly filterable on every WebGPU adapter. Half-float
  // comfortably covers park distances/heights and is baseline-filterable.
  const half = new Uint16Array(data.length)
  for (let i = 0; i < data.length; i++) half[i] = DataUtils.toHalfFloat(data[i])
  const texture = new DataTexture(half, resolution, resolution, RedFormat, HalfFloatType)
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
