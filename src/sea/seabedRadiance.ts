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
import { terrainHeight } from '../world/terrainHeight'

/**
 * The BARE seabed height, as distinct from the undersea radiance field's
 * canopy height (sea/underseaRadiance.ts), which is the topmost underwater
 * surface of any kind.
 *
 * Where the two agree, the water is looking at sand, and the ocean may
 * re-add the ripple band and caustic web that the capture deliberately froze
 * at their mean. Where the canopy stands proud of the seabed, it is a park
 * structure and neither belongs. That comparison is the only remaining
 * consumer of this field.
 */

/** Half-extent of the baked field (m), matching the undersea radiance field. */
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
