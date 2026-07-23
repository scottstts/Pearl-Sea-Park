import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RedFormat,
} from 'three'
import { texture } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { SUN_LIGHT_INTENSITY, sunColor, sunDirection } from '../sky/sun'
import { terrainHeight } from '../world/terrainHeight'

/**
 * World-anchored seabed knowledge for the above-water ocean.
 *
 * The air→water transmitted base must know where the bottom actually is:
 * a screen-space trace can only report geometry that happens to be inside
 * the current frustum, so any radiance it alone contributes is shaped like
 * the camera frustum and swells/shrinks with pure head tilt — the reported
 * "expanding pale patch". This tiny baked height field lets every water
 * pixel run the same Beer–Lambert transport to the true local bottom, with
 * the traced sample only substituting real imagery at matched luminance.
 */

/** Half-extent of the baked field (m): park ±600 plus the 160 m trace range. */
const SEABED_MAP_EXTENT = 800
/** 256² at 6.25 m cells — radiance grading, not geometry; features are 10s of m. */
const SEABED_MAP_RESOLUTION = 256

/**
 * Mean lit radiance of the sand plateau as the opaque buffer renders it in
 * air (Lambert albedo/π under the fixed sun), so the analytic base and the
 * traced buffer agree across the validity boundary. Albedo is the mean of
 * the terrain palette in world/terrain.ts; the boost stands in for sky/PMREM
 * ambient plus the mean caustic lift on receivedShadowNode.
 */
const SEABED_MEAN_ALBEDO = [0.5, 0.465, 0.36] as const
const AMBIENT_AND_CAUSTIC_BOOST = 1.45
const seabedChannel = (albedo: number, sunTint: number): number =>
  (albedo / Math.PI) *
  SUN_LIGHT_INTENSITY *
  sunTint *
  sunDirection.y *
  AMBIENT_AND_CAUSTIC_BOOST

export const SEABED_MEAN_RADIANCE = [
  seabedChannel(SEABED_MEAN_ALBEDO[0], sunColor.r),
  seabedChannel(SEABED_MEAN_ALBEDO[1], sunColor.g),
  seabedChannel(SEABED_MEAN_ALBEDO[2], sunColor.b),
] as const

export interface SeabedHeightField {
  /** Seabed world y (always ≤ −0.5) at a world XZ, linearly filtered. */
  sampleHeight: (worldXZ: Node<'vec2'>) => Node<'float'>
  dispose: () => void
}

/** Bake `terrainHeight` once at init into an R16F map (R32F is not baseline filterable). */
export function createSeabedHeightField(): SeabedHeightField {
  const resolution = SEABED_MAP_RESOLUTION
  const data = new Uint16Array(resolution * resolution)
  const cell = (SEABED_MAP_EXTENT * 2) / resolution
  for (let row = 0; row < resolution; row++) {
    const z = -SEABED_MAP_EXTENT + (row + 0.5) * cell
    for (let column = 0; column < resolution; column++) {
      const x = -SEABED_MAP_EXTENT + (column + 0.5) * cell
      data[row * resolution + column] = DataUtils.toHalfFloat(
        Math.min(terrainHeight(x, z), -0.5),
      )
    }
  }
  const map = new DataTexture(data, resolution, resolution, RedFormat, HalfFloatType)
  map.wrapS = ClampToEdgeWrapping
  map.wrapT = ClampToEdgeWrapping
  map.minFilter = LinearFilter
  map.magFilter = LinearFilter
  map.needsUpdate = true
  const mapNode = texture(map)
  return {
    sampleHeight: (worldXZ) =>
      mapNode.sample(worldXZ.div(SEABED_MAP_EXTENT * 2).add(0.5)).r,
    dispose: () => map.dispose(),
  }
}
