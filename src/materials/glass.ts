import { Color, DoubleSide } from 'three'
import type { Side } from 'three'
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import { mrt, normalView, vec4 } from 'three/tsl'

export interface ClearGlassOptions {
  tint: Color
  thickness?: number
  roughness?: number
  attenuationDistance?: number
  envMapIntensity?: number
  side?: Side
}

/**
 * Physically transmissive clear glass for the main WebGPU scene pass.
 *
 * Three r185 captures the opaque viewport automatically for physical
 * transmission, so this keeps refraction in the material path without adding
 * a second scene render. Glass deliberately owns neither depth nor opaque AO:
 * its color is composited over the captured backdrop, while the distant
 * opaque surface remains authoritative for depth-based post effects.
 */
export function createClearGlassMaterial({
  tint,
  thickness = 0.05,
  roughness = 0.035,
  attenuationDistance = 2.5,
  envMapIntensity = 1,
  side = DoubleSide,
}: ClearGlassOptions): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial()
  material.color.set(0xffffff)
  material.metalness = 0
  material.roughness = roughness
  material.transmission = 1
  material.ior = 1.52
  material.thickness = thickness
  material.attenuationColor.copy(tint)
  material.attenuationDistance = attenuationDistance
  material.clearcoat = 1
  material.clearcoatRoughness = 0.06
  material.envMapIntensity = envMapIntensity
  // Transmission performs the framebuffer composition itself. Keeping alpha
  // blending disabled avoids stacking a second transparency operation.
  material.transparent = false
  material.opacity = 1
  material.side = side
  material.depthWrite = false
  material.mrtNode = mrt({ normal: vec4(normalView, 0) })
  return material
}

/** Alpha-blended and physically transmissive materials are both non-opaque. */
export function isOpticallyTransparent(material: MeshStandardNodeMaterial): boolean {
  const physical = material as MeshStandardNodeMaterial & {
    transmission?: number
    transmissionNode?: Node<'float'> | null
  }
  return (
    material.transparent === true ||
    (physical.transmission ?? 0) > 0 ||
    physical.transmissionNode != null
  )
}
