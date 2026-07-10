/**
 * CPU 2D value noise + fbm — deterministic (seed-offset based), used by
 * terrain heights, scatter masks, and anything that must agree between
 * CPU colliders and GPU visuals.
 */

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

export function valueNoise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const a = hash2(xi, yi, seed)
  const b = hash2(xi + 1, yi, seed)
  const c = hash2(xi, yi + 1, seed)
  const d = hash2(xi + 1, yi + 1, seed)
  const u = smooth(xf)
  const v = smooth(yf)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

/** ~[0,1], `octaves` rotated-ish via seed bump per octave. */
export function fbm2(x: number, y: number, octaves = 5, seed = 0): number {
  let value = 0
  let amplitude = 0.5
  let fx = x
  let fy = y
  for (let i = 0; i < octaves; i++) {
    value += valueNoise2(fx, fy, seed + i * 101) * amplitude
    const rx = fx * 0.8 - fy * 0.6
    const ry = fx * 0.6 + fy * 0.8
    fx = rx * 2.03
    fy = ry * 2.03
    amplitude *= 0.5
  }
  return value
}
