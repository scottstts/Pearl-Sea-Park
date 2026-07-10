import type { Camera, Object3D } from 'three'

/**
 * Main-only dynamic detail. The gameplay camera sees this layer; planar
 * reflectors deliberately omit it so their soft mirror does not submit bulk
 * particles and schooling wildlife a second time.
 */
export const MAIN_DETAIL_LAYER = 1

export function enableMainDetailLayer(camera: Camera): void {
  camera.layers.enable(MAIN_DETAIL_LAYER)
}

export function markMainDetail(object: Object3D): void {
  object.layers.set(MAIN_DETAIL_LAYER)
}
