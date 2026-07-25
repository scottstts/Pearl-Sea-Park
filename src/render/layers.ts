import type { Camera, Material, Mesh, Object3D } from 'three'
import { isOpaqueAuxiliaryCapture } from '../materials/glass'

/**
 * Main-view dynamic detail. Kept as an explicit layer so any future auxiliary
 * render can opt out of bulk particles without changing object ownership.
 */
export const MAIN_DETAIL_LAYER = 1
/** Moving sun-shadow casters rendered by the lightweight dynamic map. */
export const DYNAMIC_SHADOW_LAYER = 2
/**
 * Anything that can ever break the ocean surface, rendered by the mirrored
 * camera in sea/oceanReflection.ts. Membership is additive, so an object keeps
 * whatever layer already carries it into the main view.
 */
export const WATER_REFLECTION_LAYER = 3

export function enableMainDetailLayer(camera: Camera): void {
  camera.layers.enable(MAIN_DETAIL_LAYER)
  camera.layers.enable(DYNAMIC_SHADOW_LAYER)
}

export function markMainDetail(object: Object3D): void {
  object.layers.set(MAIN_DETAIL_LAYER)
}

/**
 * Move already-authored shadow casters out of the cached static-world maps.
 * Layers are per-object rather than inherited, so only actual caster meshes
 * change; non-rendering transform parents stay untouched.
 */
export function markDynamicShadowCasters(object: Object3D): void {
  object.traverse((node) => {
    const caster = node as Object3D & { castShadow?: boolean }
    if (caster.castShadow === true) caster.layers.set(DYNAMIC_SHADOW_LAYER)
  })
}

/**
 * Move an entire moving subtree onto the dynamic layer, casters or not.
 *
 * `markDynamicShadowCasters` only relocates meshes whose `castShadow` is true,
 * which is right for the shadow system but leaves a vehicle's non-casting
 * parts on layer 0. Keeping the whole moving subtree together also prevents
 * future static auxiliary passes from freezing only part of it. The main
 * camera renders this layer, so visibility is unchanged.
 */
export function markDynamic(object: Object3D): void {
  object.traverse((node) => {
    if ((node as Object3D & { isMesh?: boolean }).isMesh) {
      node.layers.set(DYNAMIC_SHADOW_LAYER)
    }
  })
}

/**
 * Opt a subtree into the ocean's mirrored reflection render. Additive, unlike
 * the two `set` helpers above — so it must be applied AFTER
 * `markDynamicShadowCasters`, whose exclusive `set` would otherwise clear it.
 *
 * Only opaque members join: the mirrored pass writes one plain colour
 * attachment, and glass/transmissive materials carry their own `mrtNode` that
 * would replace it with an empty fragment struct. Glazing therefore does not
 * appear in the reflection while its frame does — the same boundary
 * `InterfaceStructureLayer` registrations already draw.
 */
export function markWaterReflector(object: Object3D): void {
  object.traverse((node) => {
    const mesh = node as Mesh
    if (!mesh.isMesh || !mesh.material) return
    const materials: Material[] = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material]
    if (!materials.every(isOpaqueAuxiliaryCapture)) return
    node.layers.enable(WATER_REFLECTION_LAYER)
  })
}
