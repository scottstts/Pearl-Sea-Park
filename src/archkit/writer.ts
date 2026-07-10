import { BufferGeometry, Matrix4, Mesh, Object3D } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { MeshStandardNodeMaterial } from 'three/webgpu'

/**
 * Material-slot mesh compiler (procedural-architecture skill): modules emit
 * transformed geometry into named slots; `compile()` merges each slot into
 * one Mesh — draw calls stay at slot count no matter how ornate the build.
 */
export class SlotWriter {
  private readonly slots = new Map<MeshStandardNodeMaterial, BufferGeometry[]>()
  private readonly scratch = new Matrix4()

  emit(material: MeshStandardNodeMaterial, geometry: BufferGeometry, transform?: Matrix4): void {
    const instance = geometry.clone()
    if (transform) instance.applyMatrix4(transform)
    let list = this.slots.get(material)
    if (!list) {
      list = []
      this.slots.set(material, list)
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
    for (const [material, geometries] of this.slots) {
      const merged = mergeGeometries(geometries, false)
      if (!merged) continue
      const mesh = new Mesh(merged, material)
      // Transparent slots (glass roofs, domes) must not throw plywood shadows.
      mesh.castShadow = shadows && material.transparent !== true
      mesh.receiveShadow = true
      parent.add(mesh)
      for (const g of geometries) g.dispose()
    }
    this.slots.clear()
    return parent
  }
}
