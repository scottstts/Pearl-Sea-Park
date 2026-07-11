import type { Camera, Object3D } from 'three'

/**
 * Main-view dynamic detail. Kept as an explicit layer so any future auxiliary
 * render can opt out of bulk particles without changing object ownership.
 */
export const MAIN_DETAIL_LAYER = 1
/** Moving sun-shadow casters rendered by the lightweight dynamic map. */
export const DYNAMIC_SHADOW_LAYER = 2

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
