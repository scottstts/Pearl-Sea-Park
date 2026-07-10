import {
  clamp,
  float,
  luminance,
  mix,
  pow,
  screenUV,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl'

/**
 * TSL node generics in @types/three churn per release; the pipeline boundary
 * accepts any node object and casts once, here, to a vec4-shaped node.
 */
type AnyNode = object
const asColor = (node: AnyNode) => node as ReturnType<typeof vec4>

/**
 * The dream grade (plan §0 "color" lever), applied post-tonemap.
 * Implemented as TSL math rather than a baked LUT so it stays live-tunable
 * from the debug pane; the math is the LUT.
 *
 * Teal-lifted shadows, warm gold highlights, gentle vibrance, soft vignette.
 */
export const gradeParams = {
  /** Pre-tonemap exposure in EV (stops). */
  exposureEV: uniform(0.0),
  liftR: uniform(0.012),
  liftG: uniform(0.03),
  liftB: uniform(0.038),
  gainR: uniform(1.045),
  gainG: uniform(1.01),
  gainB: uniform(0.965),
  gamma: uniform(1.0),
  vibrance: uniform(0.16),
  vignette: uniform(0.14),
}

/** Post-tonemap display-referred grade; expects an LDR node, returns LDR vec4. */
export function dreamGrade(inputColor: AnyNode) {
  const p = gradeParams
  const c = clamp(asColor(inputColor).rgb, 0.0, 1.0)

  // Lift/gain (split-toned by construction: lift is teal, gain is gold).
  const lift = vec3(p.liftR, p.liftG, p.liftB)
  const gain = vec3(p.gainR, p.gainG, p.gainB)
  const balanced = c.mul(gain).add(lift.mul(float(1.0).sub(c)))

  // Gamma trim.
  const curved = pow(clamp(balanced, 0.0001, 1.0), vec3(float(1.0).div(p.gamma)))

  // Vibrance — push chroma harder where saturation is low (protects skin/gold).
  const lum = luminance(curved)
  const vibrant = mix(vec3(lum), curved, float(1.0).add(p.vibrance))

  // Soft corner vignette.
  const centered = screenUV.sub(0.5)
  const falloff = smoothstep(0.35, 0.95, centered.length().mul(1.35))
  const vignetted = vibrant.mul(float(1.0).sub(falloff.mul(p.vignette)))

  return vec4(clamp(vignetted, 0.0, 1.0), 1.0)
}
