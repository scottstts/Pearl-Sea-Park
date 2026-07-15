import { exp, float, mix, step } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { marineHazeTint } from './skyRadiance'

/** Preserve the near field while letting mist build through the mid-distance. */
const FOG_START_METERS = 150
/** One cheap analytic extinction term: e-folding distance is 2 km. */
const FOG_EXTINCTION_PER_METER = 0.0005
/** Keep a little surface signal at infinity instead of flattening to a card. */
const MAX_FOG_AMOUNT = 0.78
/** The sky dome does not write depth, so 1 remains the background sentinel. */
const BACKGROUND_DEPTH = 0.999999

export interface MarineAerialPerspective {
  color: Node<'vec3'>
  amount: Node<'float'>
}

/**
 * Low-cost above-water aerial perspective for distant scene surfaces.
 *
 * This is one existing scene-depth read, one exponential, and a mix: no
 * volume mesh, auxiliary texture, or march. Raw depth prevents the sky itself
 * from being fogged, while the displaced-waterline state makes the whole term
 * a strict underwater no-op.
 */
export function applyMarineAerialPerspective(
  scene: Node<'vec3'>,
  viewZ: Node<'float'>,
  sceneDepth: Node<'float'>,
  submerged: Node<'float'>,
): MarineAerialPerspective {
  const distanceThroughHaze = viewZ.negate().sub(FOG_START_METERS).max(0)
  const transmittance = exp(distanceThroughHaze.mul(-FOG_EXTINCTION_PER_METER))
  const surfaceMask = float(1).sub(step(BACKGROUND_DEPTH, sceneDepth))
  const aboveWater = float(1).sub(submerged)
  const amount = float(1)
    .sub(transmittance)
    .min(MAX_FOG_AMOUNT)
    .mul(surfaceMask)
    .mul(aboveWater)

  // The dome applies its tint before a 1.25 radiance scale and blends it with
  // the base horizon. 1.16 lands near that resulting horizon brightness while
  // retaining the deliberately lavender aerosol identity.
  const inscatter = marineHazeTint.mul(1.16)
  return { color: mix(scene, inscatter, amount), amount }
}
