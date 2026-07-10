import { Fn, cos, sin, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

/**
 * The global current field (plan §5) — a gentle curl-ish flow every swaying
 * thing samples: kelp, banners, gondolas, jellies, particulates.
 * "Nothing is ever perfectly still."
 *
 * Returns meters/second, magnitude ≈ 0.
 */
export const currentFlow = /*@__PURE__*/ Fn(([p, t]: [Node<'vec3'>, Node<'float'>]) => {
  const x = p.x.mul(0.05)
  const z = p.z.mul(0.05)
  const s1 = sin(x.add(t.mul(0.11))).mul(cos(z.mul(1.3).sub(t.mul(0.07))))
  const s2 = sin(z.mul(0.7).add(t.mul(0.05)).add(x.mul(0.4)))
  const s3 = cos(x.mul(1.7).sub(z.mul(0.6)).add(t.mul(0.09)))
  return vec3(
    s1.mul(0.5).add(s2.mul(0.2)),
    s3.mul(0.12),
    s2.mul(0.45).sub(s1.mul(0.15)),
  )
})
