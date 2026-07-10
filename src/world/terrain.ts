import { BufferAttribute, BufferGeometry, Color, Mesh, Object3D } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { Fn, mix, normalGeometry, normalize, positionWorld, sin, vec2, vec3 } from 'three/tsl'
import { fbm2 as fbmCpu } from '../core/noise2'
import { registerBookmark } from '../core/debug'
import { fbm2, valueNoise2 } from '../render/tslNoise'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { SeaMediumSystem } from '../sea/medium'

/**
 * The seabed (plan §6): a white-sand plateau around −26 m with gentle dunes,
 * a flattened park pad in the middle, the sheer drop-off along the north rim
 * falling to −300 m, and softened edges elsewhere that sink into the haze.
 *
 * `terrainHeight(x, z)` is THE height authority — scatter, colliders (S5),
 * and gameplay all query it. Keep it cheap and deterministic.
 */

const EXTENT = 1200
const CHUNKS = 10
const PLATEAU_Y = -26
/** North rim line (z, negative = north) where the shelf ends. */
const RIM_Z = -250
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

  // The drop-off: a jagged rim north of RIM_Z plunging to the abyss.
  const rimJitter =
    (fbmCpu(x * 0.008, 77.7, 3, 31) - 0.5) * 44 + (fbmCpu(x * 0.05, 12.3, 3, 53) - 0.5) * 10
  const rimDistance = z - (RIM_Z + rimJitter) // negative = past the rim
  if (rimDistance < 0) {
    const plunge = smoothstepJs(0, 85, -rimDistance)
    const ledges = (fbmCpu(x * 0.02, z * 0.02, 3, 47) - 0.5) * 18 * (1 - plunge)
    height = height * (1 - plunge) + (ABYSS_Y + ledges) * plunge
  }

  // Soft outer sink east/west/south so the world edge drowns in haze.
  const edge = Math.max(Math.abs(x), z) // z positive = south
  const sink = smoothstepJs(430, 590, edge)
  height -= sink * 34

  return height
}

function smoothstepJs(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function buildChunk(cx: number, cz: number, verts: number): BufferGeometry {
  const size = EXTENT / CHUNKS
  const x0 = -EXTENT / 2 + cx * size
  const z0 = -EXTENT / 2 + cz * size
  const positions = new Float32Array(verts * verts * 3)
  const normals = new Float32Array(verts * verts * 3)
  const step = size / (verts - 1)
  const eps = step * 0.5

  let p = 0
  for (let j = 0; j < verts; j++) {
    for (let i = 0; i < verts; i++) {
      const x = x0 + i * step
      const z = z0 + j * step
      const y = terrainHeight(x, z)
      positions[p] = x
      positions[p + 1] = y
      positions[p + 2] = z
      const hx = terrainHeight(x + eps, z) - terrainHeight(x - eps, z)
      const hz = terrainHeight(x, z + eps) - terrainHeight(x, z - eps)
      const inv = 1 / Math.hypot(hx, 2 * eps, hz)
      normals[p] = -hx * inv
      normals[p + 1] = 2 * eps * inv
      normals[p + 2] = -hz * inv
      p += 3
    }
  }

  const indices = new Uint32Array((verts - 1) * (verts - 1) * 6)
  let q = 0
  for (let j = 0; j < verts - 1; j++) {
    for (let i = 0; i < verts - 1; i++) {
      const a = j * verts + i
      const b = a + 1
      const c = a + verts
      const d = c + 1
      indices[q++] = a
      indices[q++] = c
      indices[q++] = b
      indices[q++] = b
      indices[q++] = c
      indices[q++] = d
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setIndex(new BufferAttribute(indices, 1))
  return geometry
}

/** Sand with procedural ripples, tonal variation, and caustic light. */
export function createSandMaterial(medium: SeaMediumSystem): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial()
  material.roughness = 1
  material.metalness = 0

  const xz = positionWorld.xz

  const tone = fbm2(xz.mul(0.02))
  const patchTone = fbm2(xz.mul(0.0045))
  const base = mix(vec3(0.48, 0.43, 0.33), vec3(0.58, 0.54, 0.43), tone)
  const seagrassTint = mix(base, vec3(0.33, 0.4, 0.3), patchTone.smoothstep(0.62, 0.85).mul(0.5))
  material.colorNode = seagrassTint

  // Sand ripples: banded sine distorted by noise, as a normal perturbation.
  material.normalNode = Fn(() => {
    const warp = fbm2(xz.mul(0.09)).mul(7.0)
    const band = sin(xz.x.mul(1.9).add(xz.y.mul(0.9)).add(warp))
    const band2 = sin(xz.x.mul(-1.0).add(xz.y.mul(2.3)).add(warp.mul(1.4)))
    const micro = valueNoise2(xz.mul(7.0)).sub(0.5).mul(0.24)
    const slope = vec2(band.mul(0.08), band2.mul(0.06)).add(micro)
    return normalize(normalGeometry.add(vec3(slope.x, 0, slope.y)))
  })()

  medium.applyCaustics(material, 1.15)
  return material
}

export class TerrainSystem implements GameSystem {
  readonly id = 'seabed'
  private readonly group = new Object3D()
  private readonly medium: SeaMediumSystem

  constructor(medium: SeaMediumSystem) {
    this.medium = medium
  }

  init(ctx: GameContext): void {
    const verts = [64, 80, 96][ctx.quality.tier] ?? 80
    const material = createSandMaterial(this.medium)
    material.color = new Color(0xffffff)

    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const mesh = new Mesh(buildChunk(cx, cz, verts), material)
        mesh.receiveShadow = true
        this.group.add(mesh)
      }
    }
    ctx.scene.add(this.group)

    registerBookmark({
      name: 'dropoff',
      position: [30, -21, -232],
      look: [10, -60, -420],
      note: 'Postcard 4 staging — the edge of the world',
    })
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
  }
}

/** Convenience for other systems: float node of terrain height is not
 * available on GPU — query CPU-side and bake into transforms. */
export { PLATEAU_Y, RIM_Z, EXTENT as TERRAIN_EXTENT }
