import type { RigidBody } from '@dimforge/rapier3d-compat'
import type { Object3D, Vector3 } from 'three'
import type { HeldItemKind } from '../player/heldItems'

export type ThrowSpawn = (origin: Vector3, direction: Vector3) => void

export interface ThrowRequest {
  kind: HeldItemKind
  remaining: number
  spawn: ThrowSpawn
}

export type ArmThrow = (request: ThrowRequest) => void

export interface DynamicProp {
  body: RigidBody
  mesh: Object3D
  age: number
  scored: boolean
}

export function syncDynamicProp(prop: DynamicProp): void {
  const translation = prop.body.translation()
  const rotation = prop.body.rotation()
  prop.mesh.position.set(translation.x, translation.y, translation.z)
  prop.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
}
