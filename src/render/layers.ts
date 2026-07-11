import type { Camera, Object3D } from 'three'

/**
 * Main-view dynamic detail. Kept as an explicit layer so any future auxiliary
 * render can opt out of bulk particles without changing object ownership.
 */
export const MAIN_DETAIL_LAYER = 1

export function enableMainDetailLayer(camera: Camera): void {
  camera.layers.enable(MAIN_DETAIL_LAYER)
}

export function markMainDetail(object: Object3D): void {
  object.layers.set(MAIN_DETAIL_LAYER)
}
