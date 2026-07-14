import { BufferAttribute, BufferGeometry, Color, Mesh, Object3D } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  Fn,
  mix,
  normalGeometry,
  normalize,
  positionWorld,
  sin,
  transformNormalToView,
  vec2,
  vec3,
} from 'three/tsl'
import { registerBookmark } from '../core/debug'
import { fbm2, valueNoise2 } from '../render/tslNoise'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { SeaMediumSystem } from '../sea/medium'

/**
 * The seabed (plan §6). The height field itself lives in the audit-friendly
 * leaf module world/terrainHeight.ts — this system owns the visual meshes
 * and the sand material. `terrainHeight(x, z)` remains THE height authority.
 */

import { PLATEAU_Y, RIM_Z, TERRAIN_EXTENT as EXTENT, terrainHeight } from './terrainHeight.ts'
export { terrainHeight }

const CHUNKS = 10

function buildChunk(x0: number, z0: number, size: number, verts: number): BufferGeometry {
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
  material.colorNode = mix(base, vec3(0.33, 0.4, 0.3), patchTone.smoothstep(0.62, 0.85).mul(0.5))

  // Sand ripples: banded sine distorted by noise, as a normal perturbation.
  material.normalNode = Fn(() => {
    const warp = fbm2(xz.mul(0.09)).mul(7.0)
    const band = sin(xz.x.mul(1.9).add(xz.y.mul(0.9)).add(warp))
    const band2 = sin(xz.x.mul(-1.0).add(xz.y.mul(2.3)).add(warp.mul(1.4)))
    const micro = valueNoise2(xz.mul(7.0)).sub(0.5).mul(0.24)
    const slope = vec2(band.mul(0.08), band2.mul(0.06)).add(micro)
    // NodeMaterial.normalNode is a view-space hook. Keep the authored ripple
    // field in terrain-local space, then transform the resolved normal exactly
    // once; passing the local vector through directly made the sun rotate
    // around a camera-fixed normal as the player looked around.
    const localNormal = normalize(normalGeometry.add(vec3(slope.x, 0, slope.y)))
    return transformNormalToView(localNormal)
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

    const chunkSize = EXTENT / CHUNKS
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const mesh = new Mesh(
          buildChunk(-EXTENT / 2 + cx * chunkSize, -EXTENT / 2 + cz * chunkSize, chunkSize, verts),
          material,
        )
        mesh.receiveShadow = true
        this.group.add(mesh)
      }
    }
    // The saucer ring: coarse far tiles out to ±1400 m carry the seabed's
    // rise to the horizon (rim features span hundreds of metres — 32 verts
    // per 400 m tile is plenty). The inner 3×3 of this 7×7 layout is the
    // detailed grid above.
    for (let tz = 0; tz < 7; tz++) {
      for (let tx = 0; tx < 7; tx++) {
        if (tx >= 2 && tx <= 4 && tz >= 2 && tz <= 4) continue
        const mesh = new Mesh(buildChunk(-1400 + tx * 400, -1400 + tz * 400, 400, 32), material)
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
