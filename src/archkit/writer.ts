import { BufferGeometry, Matrix4, Mesh, Object3D } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { MeshStandardNodeMaterial } from 'three/webgpu'
import { isOpticallyTransparent } from '../materials/glass'

/**
 * Material-slot mesh compiler (procedural-architecture skill): modules emit
 * transformed geometry into named slots; `compile()` merges each slot into
 * one Mesh — draw calls stay at slot count no matter how ornate the build.
 */
export class SlotWriter {
  private readonly chunks = new Map<string, Map<MeshStandardNodeMaterial, BufferGeometry[]>>()
  private readonly scratch = new Matrix4()
  private readonly chunkSize: number

  constructor(chunkSize = Number.POSITIVE_INFINITY) {
    this.chunkSize = chunkSize
  }

  emit(material: MeshStandardNodeMaterial, geometry: BufferGeometry, transform?: Matrix4): void {
    const instance = geometry.clone()
    if (transform) instance.applyMatrix4(transform)
    const chunk = this.chunkFor(instance, transform)
    let list = chunk.get(material)
    if (!list) {
      list = []
      chunk.set(material, list)
    }
    list.push(instance)
  }

  /** Convenience: emit with position/rotationY/scale. */
  place(
    material: MeshStandardNodeMaterial,
    geometry: BufferGeometry,
    x: number,
    y: number,
    z: number,
    rotationY = 0,
    scale = 1,
  ): void {
    this.scratch.makeRotationY(rotationY)
    this.scratch.scale({ x: scale, y: scale, z: scale } as never)
    this.scratch.setPosition(x, y, z)
    this.emit(material, geometry, this.scratch)
  }

  /** Merge every slot into a Mesh under one parent. */
  compile(shadows = true): Object3D {
    const parent = new Object3D()
    for (const [chunkKey, slots] of this.chunks) {
      const chunk = new Object3D()
      chunk.name = `architecture-chunk:${chunkKey}`
      for (const [material, geometries] of slots) {
        const merged = mergeGeometries(geometries, false)
        if (!merged) continue
        merged.computeBoundingBox()
        merged.computeBoundingSphere()
        const mesh = new Mesh(merged, material)
        // Alpha and transmission optics (glass roofs, domes) must not throw
        // opaque plywood shadows.
        mesh.castShadow = shadows && !isOpticallyTransparent(material)
        mesh.receiveShadow = true
        chunk.add(mesh)
        for (const geometry of geometries) geometry.dispose()
      }
      parent.add(chunk)
    }
    this.chunks.clear()
    return parent
  }

  private chunkFor(
    geometry: BufferGeometry,
    transform?: Matrix4,
  ): Map<MeshStandardNodeMaterial, BufferGeometry[]> {
    let key = 'all'
    if (Number.isFinite(this.chunkSize)) {
      let x = transform?.elements[12]
      let z = transform?.elements[14]
      if (x === undefined || z === undefined) {
        geometry.computeBoundingBox()
        const bounds = geometry.boundingBox
        x = bounds ? (bounds.min.x + bounds.max.x) * 0.5 : 0
        z = bounds ? (bounds.min.z + bounds.max.z) * 0.5 : 0
      }
      key = `${Math.floor(x / this.chunkSize)}:${Math.floor(z / this.chunkSize)}`
    }

    let chunk = this.chunks.get(key)
    if (!chunk) {
      chunk = new Map()
      this.chunks.set(key, chunk)
    }
    return chunk
  }
}
