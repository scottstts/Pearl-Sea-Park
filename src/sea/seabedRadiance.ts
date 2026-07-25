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
 * World-anchored bathymetry for capture-free above-water transmission.
 *
 * It carries no scene color or structure canopy: the ocean uses only the
 * terrain depth to transport one authored mean sand radiance through the
 * water column. The submerged park is therefore never encoded here.
 */

/** Half-extent of the bathymetry field (m), covering the park and approaches. */
const SEABED_MAP_EXTENT = 800
/** 512² at 3.1 m cells — a sand/structure discriminator, not geometry. */
const SEABED_MAP_RESOLUTION = 512

/**
 * How much of fully-lit seabed radiance comes from the sun rather than from
 * sky ambient and the mean caustic lift. Ripples and caustics modulate only
 * that share: in a structure's shadow there is no direct light for them to
 * brighten, and letting them do so anyway paints light onto darkness.
 *
 * 1.45 is the measured ratio of lit sand radiance to bare Lambert sun
 * (albedo/π · intensity · sunDirection.y) under this park's fixed sun and
 * 0.5-intensity PMREM environment.
 */
const AMBIENT_AND_CAUSTIC_BOOST = 1.45
export const SEABED_DIRECT_SHARE = 1 / AMBIENT_AND_CAUSTIC_BOOST

/**
 * Mean lit radiance of the sand plateau in air. This deliberately contains no
 * spatial scene information; bathymetry and water transport supply the only
 * variation visible from above.
 */
const SEABED_MEAN_ALBEDO = [0.5, 0.465, 0.36] as const
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
