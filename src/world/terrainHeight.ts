import { fbm2 as fbmCpu } from '../core/noise2.ts'

/**
 * The seabed height authority (plan §6): a white-sand plateau around −26 m
 * with gentle dunes, a flattened park pad in the middle, the sheer drop-off
 * along the north rim falling to −300 m, and softened edges elsewhere.
 *
 * `terrainHeight(x, z)` is THE height authority — scatter, colliders (S5),
 * and gameplay all query it. Keep it cheap and deterministic.
 *
 * This lives in a LEAF module (only ../core/noise2.ts, with an explicit .ts
 * import) so offline geometry audits under `node --experimental-strip-types`
 * can sample the exact same field the game uses (torrent clearance, basin
 * collider checks). world/terrain.ts re-exports everything.
 */

export const TERRAIN_EXTENT = 1200
export const PLATEAU_Y = -26
/** North rim line (z, negative = north) where the shelf ends. */
export const RIM_Z = -250
const ABYSS_Y = -300

export function terrainHeight(x: number, z: number): number {
  // Base dunes.
  let height =
    PLATEAU_Y + (fbmCpu(x * 0.012, z * 0.012, 4, 11) - 0.5) * 2.6 +
    (fbmCpu(x * 0.045, z * 0.045, 3, 23) - 0.5) * 0.7

  // Central park pad — flat enough to build on, still organic.
  const centerDistance = Math.hypot(x, z * 0.9)
  const padBlend = 1 - smoothstepJs(180, 300, centerDistance)
  height = height * (1 - padBlend * 0.75) + (PLATEAU_Y + 1.2) * padBlend * 0.75

  // The Great Wheel basin (wheel anchor 175,40 — literals to avoid a cycle
  // with parkPlan): a dredged round pit so the 40 m wheel can turn with only
  // its crest breaching the surface.
  const wheelDistance = Math.hypot(x - 175, z - 40)
  const basinBlend = 1 - smoothstepJs(13, 26, wheelDistance)
  if (basinBlend > 0) {
    const basinFloor = -40 + (fbmCpu(x * 0.06, z * 0.06, 2, 71) - 0.5) * 1.2
    height = height * (1 - basinBlend) + basinFloor * basinBlend
  }

  // (The former grotto reef massif, boarding gorge, and channel cuts near
  // 185–210, 100–130 were removed with the Grotto of Pearls — the plateau
  // and coral gardens own that ground again.)

  // The drop-off: a jagged rim north of RIM_Z plunging to the abyss.
  const rimJitter =
    (fbmCpu(x * 0.008, 77.7, 3, 31) - 0.5) * 44 + (fbmCpu(x * 0.05, 12.3, 3, 53) - 0.5) * 10
  const rimDistance = z - (RIM_Z + rimJitter) // negative = past the rim
  if (rimDistance < 0) {
    const plunge = smoothstepJs(0, 85, -rimDistance)
    const ledges = (fbmCpu(x * 0.02, z * 0.02, 3, 47) - 0.5) * 18 * (1 - plunge)
    height = height * (1 - plunge) + (ABYSS_Y + ledges) * plunge
  }

  // Soft outer sink east/west/south so the mid-distance drowns in haze.
  const edge = Math.max(Math.abs(x), z) // z positive = south
  const sink = smoothstepJs(430, 590, edge)
  height -= sink * 34

  // The lagoon saucer (quality walkthrough): far beyond the park the seabed
  // rises toward the surface — flat at the centre, lifted at the horizon —
  // so no open-water gap column survives in any direction. The rim crests
  // at −2.5 m worst case: under every wave trough, never breaching. North it
  // becomes the trench's far wall, leaving the drop-off's open blue intact.
  const saucerDistance = Math.hypot(x, z)
  const saucer = smoothstepJs(680, 1150, saucerDistance)
  if (saucer > 0) {
    const rimTop = -3.6 + (fbmCpu(x * 0.006, z * 0.006, 3, 131) - 0.5) * 2.2
    height = height * (1 - saucer) + rimTop * saucer
  }

  return height
}

function smoothstepJs(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
