import { StaticDrawUsage } from 'three'
import type { BufferAttribute, BufferGeometry, Mesh, Object3D } from 'three'

/**
 * Release the CPU copies of static geometry after the loading-screen warmup.
 *
 * Every procedural merge in the park keeps its Float32Arrays alive in JS for
 * the whole session even though the data now lives in GPU buffers — hundreds
 * of megabytes of external memory that (a) raises baseline memory pressure,
 * the main trigger for the browser's aggressive full garbage collections
 * (felt as random CPU-spike/GPU-idle freezes with no location pattern), and
 * (b) adds sweep work to every major GC pass.
 *
 * The WebGPU renderer never calls `BufferAttribute.onUpload`, so this is a
 * deliberate pass instead. It must run AFTER `warmupRenderer`: the warm
 * frames draw every mesh (culling lifted, hidden subtrees revealed), which
 * uploads every attribute below.
 *
 * Safety model — arrays are replaced with ZERO-LENGTH arrays of the same
 * type, never null: the renderer still reads `array.constructor` and
 * `array.BYTES_PER_ELEMENT` when deriving vertex formats for later pipeline
 * layouts, and `attribute.count` (set at construction) keeps supplying the
 * true draw counts. Only provably static data qualifies:
 *  · plain Mesh only — Instanced/Skinned meshes write matrices per frame
 *  · no morph attributes
 *  · every attribute is a plain, StaticDrawUsage BufferAttribute
 *    (no interleaved, instanced, or storage attributes)
 *  · bounding volumes are computed FIRST — three would otherwise compute
 *    them lazily from the (now empty) arrays on the first frustum test
 * A geometry can opt out with `geometry.userData.keepCpuArrays = true`;
 * released geometries are flagged `userData.cpuArraysReleased`.
 */
export interface GeometryReleaseStats {
  meshesSeen: number
  geometriesReleased: number
  geometriesSkipped: number
  megabytesReleased: number
}

type TypedArray = BufferAttribute['array']
type TypedArrayConstructor = new (length: number) => TypedArray

export function releaseStaticGeometryArrays(root: Object3D): GeometryReleaseStats {
  const visited = new Set<BufferGeometry>()
  const stats: GeometryReleaseStats = {
    meshesSeen: 0,
    geometriesReleased: 0,
    geometriesSkipped: 0,
    megabytesReleased: 0,
  }
  let bytes = 0

  root.traverse((object: Object3D) => {
    const mesh = object as Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean }
    if (!mesh.isMesh) return
    stats.meshesSeen++
    const geometry = mesh.geometry as BufferGeometry
    if (visited.has(geometry)) return
    visited.add(geometry)

    if (
      mesh.isInstancedMesh === true
      || mesh.isSkinnedMesh === true
      || geometry.userData.keepCpuArrays === true
      || Object.keys(geometry.morphAttributes).length > 0
    ) {
      stats.geometriesSkipped++
      return
    }
    const attributes = [
      ...Object.values(geometry.attributes),
      ...(geometry.index ? [geometry.index] : []),
    ] as BufferAttribute[]
    const releasable = attributes.every((attribute) => {
      const flags = attribute as BufferAttribute & {
        isInterleavedBufferAttribute?: boolean
        isInstancedBufferAttribute?: boolean
        isStorageBufferAttribute?: boolean
        isStorageInstancedBufferAttribute?: boolean
      }
      return (
        flags.isBufferAttribute === true
        && flags.isInterleavedBufferAttribute !== true
        && flags.isInstancedBufferAttribute !== true
        && flags.isStorageBufferAttribute !== true
        && flags.isStorageInstancedBufferAttribute !== true
        && attribute.usage === StaticDrawUsage
        && attribute.array.length > 0
      )
    })
    if (!releasable) {
      stats.geometriesSkipped++
      return
    }

    // Frustum culling and any later Box3 queries must never need the arrays.
    if (geometry.boundingSphere === null) geometry.computeBoundingSphere()
    if (geometry.boundingBox === null) geometry.computeBoundingBox()

    for (const attribute of attributes) {
      bytes += attribute.array.byteLength
      const ArrayType = attribute.array.constructor as TypedArrayConstructor
      attribute.array = new ArrayType(0)
    }
    geometry.userData.cpuArraysReleased = true
    stats.geometriesReleased++
  })

  stats.megabytesReleased = Math.round(bytes / 1048576)
  return stats
}
