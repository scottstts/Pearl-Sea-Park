import type { Rng } from '../core/prng'
import { inParkFootprint, KEEPOUT_DISCS, PARK_PATHS } from './parkPlan'
import { RIM_Z, terrainHeight } from './terrain'

/**
 * The shared, deterministic layout of natural life on the seabed: reef
 * colony patches, kelp groves, garden-eel lawns — and the PARK VERGE
 * sampler, which plants life along the exact edges the guest actually
 * walks (path shoulders and plaza rims). Flora scatters its corals/rocks
 * around these patches and the wildlife anchors its fish schools to the
 * same centers — both systems call `computeSeabedColonies` with forks of
 * the root rng, so they derive the exact same world without referencing
 * each other (fork sequences depend only on seed + label).
 *
 * Distribution philosophy: real reefs are CLUMPED — dense colony heads on
 * shared framework rock, thinning to loners over open sand — and a guest
 * standing anywhere in the park should see life within arm's reach, so
 * close-in "garden" patches and verge planting matter more than far
 * wilderness.
 */

export interface ReefPatch {
  x: number
  z: number
  /** Colony footprint radius (m). */
  radius: number
  /** 0.5–1.5 population multiplier; also the fish-school ranking key. */
  richness: number
  /** Yaw of the patch's tangential direction (fans face across it). */
  tangentYaw: number
  /** Garden patches hug the park; open patches roam the outer sand. */
  kind: 'garden' | 'open'
}

export interface KelpGrove {
  x: number
  z: number
  radius: number
  /** Stalk budget share for this grove (all groves sum to ~1). */
  share: number
}

export interface EelLawn {
  x: number
  z: number
  radius: number
}

export interface SeabedColonies {
  patches: ReefPatch[]
  groves: KelpGrove[]
  eelLawns: EelLawn[]
}

const GARDEN_PATCH_TARGET = 10
const OPEN_PATCH_TARGET = 14
const GROVE_TARGET = 10
const EEL_TARGET = 4

/** Local terrain slope magnitude via central differences over ±2 m. */
function slopeAt(x: number, z: number): number {
  const hx = terrainHeight(x + 2, z) - terrainHeight(x - 2, z)
  const hz = terrainHeight(x, z + 2) - terrainHeight(x, z - 2)
  return Math.hypot(hx, hz) / 4
}

function groundAccepts(x: number, z: number): boolean {
  const ground = terrainHeight(x, z)
  return ground >= -33 && ground <= -17
}

export function computeSeabedColonies(rootRng: Rng): SeabedColonies {
  const patches: ReefPatch[] = []
  const tryPatch = (
    rng: Rng,
    kind: 'garden' | 'open',
    band: [number, number],
    radiusRange: [number, number],
    marginOf: (radius: number) => number,
    richnessRange: [number, number],
  ): void => {
    const angle = rng.range(0, Math.PI * 2)
    const distance = rng.range(band[0], band[1])
    const x = Math.cos(angle) * distance
    const z = Math.sin(angle) * distance * 0.94
    const radius = rng.range(radiusRange[0], radiusRange[1])
    const richness = rng.range(richnessRange[0], richnessRange[1])
    if (z < RIM_Z + 35) return
    if (inParkFootprint(x, z, marginOf(radius))) return
    if (!groundAccepts(x, z)) return
    for (const other of patches) {
      const spacing = kind === 'garden' && other.kind === 'garden' ? 18 : 24
      if (Math.hypot(x - other.x, z - other.z) < radius + other.radius + spacing) return
    }
    patches.push({ x, z, radius, richness, tangentYaw: angle + Math.PI / 2, kind })
  }

  // Garden patches: small colonies hugging the park so guests meet the
  // reef the moment they leave a path. Open patches: the far wilderness.
  const gardenRng = rootRng.fork('seabed-colonies:garden-patches')
  for (let attempt = 0; attempt < 420; attempt++) {
    if (patches.length >= GARDEN_PATCH_TARGET) break
    tryPatch(gardenRng, 'garden', [55, 205], [8, 16], (r) => r * 0.4 + 4.5, [0.55, 1.05])
  }
  const gardenCount = patches.length
  const patchRng = rootRng.fork('seabed-colonies:patches')
  for (let attempt = 0; attempt < 420; attempt++) {
    if (patches.length - gardenCount >= OPEN_PATCH_TARGET) break
    tryPatch(patchRng, 'open', [150, 470], [13, 28], (r) => r * 0.55 + 9, [0.7, 1.5])
  }

  // Kelp groves stand along the southern/east/west boundary arc (kelp never
  // blocks the north rim view), gathered into true stands with clearings.
  // Two of them now step in toward the park so the forest is part of a
  // walk, not just a horizon.
  const groves: KelpGrove[] = []
  const groveRng = rootRng.fork('seabed-colonies:groves')
  for (let attempt = 0; attempt < 260 && groves.length < GROVE_TARGET; attempt++) {
    const near = groves.length < 2
    const angle = Math.PI * 0.5 + groveRng.range(-1, 1) * Math.PI * (near ? 0.5 : 0.72)
    const distance = near ? groveRng.range(235, 320) : groveRng.range(330, 452)
    const x = Math.cos(angle) * distance
    const z = Math.sin(angle) * distance
    const radius = groveRng.range(22, 40)
    if (z < RIM_Z + 45) continue
    if (inParkFootprint(x, z, 12)) continue
    if (!groundAccepts(x, z)) continue
    let crowded = false
    for (const other of groves) {
      if (Math.hypot(x - other.x, z - other.z) < radius + other.radius + 14) {
        crowded = true
        break
      }
    }
    if (crowded) continue
    groves.push({ x, z, radius, share: radius })
  }
  const shareTotal = groves.reduce((sum, grove) => sum + grove.share, 0)
  for (const grove of groves) grove.share = shareTotal > 0 ? grove.share / shareTotal : 0

  // Garden-eel lawns want open, flat, bare sand away from the reef heads.
  const eelLawns: EelLawn[] = []
  const eelRng = rootRng.fork('seabed-colonies:eels')
  for (let attempt = 0; attempt < 300 && eelLawns.length < EEL_TARGET; attempt++) {
    const angle = eelRng.range(0, Math.PI * 2)
    const distance = eelRng.range(90, 380)
    const x = Math.cos(angle) * distance
    const z = Math.sin(angle) * distance * 0.92
    const radius = eelRng.range(6, 10)
    if (z < RIM_Z + 40) continue
    if (inParkFootprint(x, z, radius + 5)) continue
    if (slopeAt(x, z) > 0.05) continue
    if (!groundAccepts(x, z)) continue
    let crowded = false
    for (const patch of patches) {
      if (Math.hypot(x - patch.x, z - patch.z) < patch.radius + radius + 14) {
        crowded = true
        break
      }
    }
    for (const other of eelLawns) {
      if (Math.hypot(x - other.x, z - other.z) < 60) crowded = true
    }
    if (crowded) continue
    eelLawns.push({ x, z, radius })
  }

  return { patches, groves, eelLawns }
}

/** Patches ordered richest-first — the fish-school anchor ranking. */
export function rankedPatches(colonies: SeabedColonies): ReefPatch[] {
  return [...colonies.patches].sort((a, b) => b.richness - a.richness)
}

// ── Park verge sampling ──────────────────────────────────────────────────

interface VergeEdge {
  kind: 'segment' | 'ring'
  ax: number
  az: number
  bx: number
  bz: number
  halfWidth: number // path half-width incl. the keepout buffer
  x: number
  z: number
  r: number
  weight: number // length/circumference for weighted picking
}

let vergeEdges: VergeEdge[] | null = null
let vergeTotalWeight = 0

function buildVergeEdges(): VergeEdge[] {
  if (vergeEdges) return vergeEdges
  const edges: VergeEdge[] = []
  for (const path of PARK_PATHS) {
    const length = Math.hypot(path.bx - path.ax, path.bz - path.az)
    if (length < 2) continue
    edges.push({
      kind: 'segment',
      ax: path.ax, az: path.az, bx: path.bx, bz: path.bz,
      halfWidth: path.width / 2 + 1.5,
      x: 0, z: 0, r: 0,
      weight: length * 2, // both shoulders
    })
  }
  for (const disc of KEEPOUT_DISCS) {
    edges.push({
      kind: 'ring',
      ax: 0, az: 0, bx: 0, bz: 0, halfWidth: 0,
      x: disc.x, z: disc.z, r: disc.r,
      weight: Math.PI * 2 * disc.r,
    })
  }
  vergeTotalWeight = edges.reduce((sum, edge) => sum + edge.weight, 0)
  vergeEdges = edges
  return edges
}

/**
 * One deterministic sample on the park's walking verges: a point just off
 * a path shoulder or a plaza/keepout rim, where a strolling guest will
 * actually SEE it. `lateral` is measured from the reserved edge, biased
 * close (rng² falloff). Returns null when the draw lands somewhere
 * invalid — callers simply retry with their own budget.
 */
export function sampleParkVergePoint(
  rng: Rng,
  lateralMin: number,
  lateralMax: number,
): { x: number; z: number } | null {
  const edges = buildVergeEdges()
  if (edges.length === 0) return null
  let pick = rng.next() * vergeTotalWeight
  let edge = edges[edges.length - 1]
  for (const candidate of edges) {
    pick -= candidate.weight
    if (pick <= 0) {
      edge = candidate
      break
    }
  }
  const lateral = lateralMin + (lateralMax - lateralMin) * rng.next() ** 2
  let x: number
  let z: number
  if (edge.kind === 'segment') {
    const t = rng.next()
    const side = rng.next() < 0.5 ? -1 : 1
    const dx = edge.bx - edge.ax
    const dz = edge.bz - edge.az
    const inv = 1 / Math.max(0.001, Math.hypot(dx, dz))
    x = edge.ax + dx * t + -dz * inv * side * (edge.halfWidth + lateral)
    z = edge.az + dz * t + dx * inv * side * (edge.halfWidth + lateral)
  } else {
    const angle = rng.range(0, Math.PI * 2)
    x = edge.x + Math.cos(angle) * (edge.r + lateral)
    z = edge.z + Math.sin(angle) * (edge.r + lateral)
  }
  if (z < RIM_Z + 30) return null
  if (inParkFootprint(x, z, 0.05)) return null
  if (!groundAccepts(x, z)) return null
  return { x, z }
}
