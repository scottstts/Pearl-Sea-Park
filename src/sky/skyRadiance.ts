import { Fn, dot, float, max, mix, normalize, pow, smoothstep, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { sunColorUniform, sunDirectionUniform } from './sun'

/**
 * Shared HDR sky radiance — sampled by the sky dome, the ocean reflection,
 * and the Snell's window refraction so they can never disagree (spectral-ocean
 * rule: one sky function for dome and reflected ray).
 *
 * Values are linear HDR: the sun disc is far above 1.0 and drives bloom.
 */
export const skyRadiance = /*@__PURE__*/ Fn(([direction]: [Node<'vec3'>]) => {
  const dir = normalize(direction).toVar()
  const up = max(dir.y, 0.0)

  const zenith = vec3(0.05, 0.2, 0.5)
  const horizon = vec3(0.4, 0.54, 0.68)
  const seaMist = vec3(0.32, 0.43, 0.52)

  const gradient = mix(horizon, zenith, pow(up, 0.48))
  const sky = mix(seaMist, gradient, smoothstep(-0.08, 0.02, dir.y)).toVar()

  const sunAmount = max(dot(dir, sunDirectionUniform), 0.0).toVar()
  const halo = pow(sunAmount, 320.0).mul(3.0).add(pow(sunAmount, 18.0).mul(0.4))
  const disc = smoothstep(0.99962, 0.99987, sunAmount).mul(38.0)

  return sky.mul(1.25).add(sunColorUniform.mul(halo.add(disc))).mul(float(1.0))
})
