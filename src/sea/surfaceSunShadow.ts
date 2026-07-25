import {
  AdditiveBlending,
  Box3,
  Color,
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  OrthographicCamera,
  RenderTarget,
} from 'three'
import type { Material, Mesh, Object3D } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import {
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  modelWorldMatrix,
  positionLocal,
  step,
  texture,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { isOpaqueAuxiliaryCapture } from '../materials/glass'
import { MAIN_DETAIL_LAYER } from '../render/layers'
import type { GameContext } from '../runtime/context'
import { sunDirection, sunDirectionUniform } from '../sky/sun'

/**
 * The sun's shadow cast ON the water, as a world-anchored mask over the mean
 * surface plane.
 *
 * The ocean is a `MeshBasicNodeMaterial`, so it has no lighting model and had
 * never been shadowed by anything: the Descent Station stood in open sea
 * casting nothing onto the water it stands in. The obvious route — sampling
 * the sun's cached clipmap node directly — does not build in a material
 * outside the lighting path, so this bakes the one thing that is actually
 * static: a fixed sun plus fixed above-water structures means the shadow
 * footprint on y = 0 is a fixed function of world XZ.
 *
 * This is the one cast shadow the water itself shows. It is co-located with
 * the surface, so nothing has to place it at depth. The capture-free
 * transmission path contains no seabed or park shadow imagery.
 */

/**
 * Half-extent (m) and centre. Only above-water structures cast here — the
 * Descent Station at (0, 320) and the Great Wheel's crest at (175, 40) — so
 * the field is sized to hold both rather than the whole park. Outside it,
 * clamp-to-edge returns the unlit border, which is the correct answer: there
 * is nothing out there to cast.
 */
const EXTENT = 400
const CENTER_Z = 160
const RESOLUTION = 2048
/** 0.39 m/texel: a 13 m deck shadow lands across ~33 texels. */
const CAMERA_Y = 300
const FLOOR_Y = -400
/** Ignore anything at or below the mean waterline; it cannot shadow the water. */
const ABOVE_WATER_EPSILON = 0.05
const SURFACE_BOUNDS = new Box3()

export interface SurfaceSunShadowBakeSummary {
  nonOpaqueMeshes: number
  submergedMeshes: number
}

export class SurfaceSunShadow {
  /** Sun visibility at a displaced surface point: 1 lit, 0 fully shadowed. */
  readonly node: (worldPosition: Node<'vec3'>) => Node<'float'>

  private readonly target: RenderTarget
  private readonly camera: OrthographicCamera
  private readonly material: MeshBasicNodeMaterial
  private readonly savedClearColor = new Color()

  constructor() {
    this.target = new RenderTarget(RESOLUTION, RESOLUTION, { depthBuffer: false })
    this.target.texture.minFilter = LinearMipmapLinearFilter
    this.target.texture.magFilter = LinearFilter
    this.target.texture.generateMipmaps = true

    this.camera = new OrthographicCamera(
      -EXTENT,
      EXTENT,
      EXTENT,
      -EXTENT,
      0,
      CAMERA_Y - FLOOR_Y,
    )
    this.camera.position.set(0, CAMERA_Y, CENTER_Z)
    // Image +x is world +x and image +y is world −z, so the UV remap below
    // needs no flip on either axis.
    this.camera.up.set(0, 0, -1)
    this.camera.lookAt(0, 0, CENTER_Z)
    this.camera.layers.set(0)
    this.camera.layers.enable(MAIN_DETAIL_LAYER)
    this.camera.updateMatrixWorld(true)

    // Shear every vertex down its own sun ray onto y = 0 before projecting, so
    // what lands in the texture IS the shadow footprint, indexed by world XZ.
    // Depth is meaningless once everything is coplanar, hence no depth test and
    // additive coverage; the sub-water half of a pile writes zero instead.
    this.material = new MeshBasicNodeMaterial()
    this.material.fog = false
    // A soffit shadows as well as a roof.
    this.material.side = DoubleSide
    this.material.depthTest = false
    this.material.depthWrite = false
    this.material.blending = AdditiveBlending
    const sourceWorld = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz
    const toPlane = sourceWorld.y.div(float(sunDirection.y))
    const projected = sourceWorld.sub(sunDirectionUniform.mul(toPlane))
    this.material.vertexNode = cameraProjectionMatrix
      .mul(cameraViewMatrix)
      .mul(vec4(projected, 1))
    this.material.colorNode = vec4(
      vec3(step(ABOVE_WATER_EPSILON, sourceWorld.y)),
      1,
    )

    const maskNode = texture(this.target.texture)
    this.node = (worldPosition) => {
      // Walk this surface point up its sun ray to the mean plane, so a crest
      // riding above y = 0 reads the mask where its own light comes from.
      const planeXZ = worldPosition.xz.sub(
        sunDirectionUniform.xz.mul(worldPosition.y.div(float(sunDirection.y))),
      )
      const uv = planeXZ.sub(vec2(0, CENTER_Z)).div(EXTENT * 2).add(0.5)
      return float(1).sub(maskNode.sample(uv as Node<'vec2'>).r.clamp(0, 1))
    }
  }

  /** Capture the fixed structures' shadow on the water surface. */
  bake(ctx: GameContext): SurfaceSunShadowBakeSummary {
    const { renderer, scene } = ctx
    const hidden: Object3D[] = []
    let nonOpaqueMeshes = 0
    let submergedMeshes = 0
    scene.updateMatrixWorld(true)
    scene.traverse((object) => {
      const mesh = object as Mesh
      if (!mesh.isMesh || !mesh.visible || !mesh.material) return
      const materials: Material[] = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]
      const opaque = materials.every(isOpaqueAuxiliaryCapture)
      const submerged = opaque && isProvablySubmerged(mesh)
      if (!opaque || submerged) {
        if (submerged) submergedMeshes++
        else nonOpaqueMeshes++
        mesh.visible = false
        hidden.push(mesh)
      }
    })

    const previousTarget = renderer.getRenderTarget()
    const previousMrt = renderer.getMRT()
    const previousAlpha = renderer.getClearAlpha()
    const previousOverride = scene.overrideMaterial
    renderer.getClearColor(this.savedClearColor)
    try {
      scene.overrideMaterial = this.material
      renderer.setRenderTarget(this.target)
      renderer.setMRT(null)
      renderer.setClearColor(0x000000, 1)
      renderer.clear()
      renderer.render(scene, this.camera)
    } finally {
      scene.overrideMaterial = previousOverride
      renderer.setRenderTarget(previousTarget)
      renderer.setMRT(previousMrt)
      renderer.setClearColor(this.savedClearColor, previousAlpha)
      for (const object of hidden) object.visible = true
    }
    return { nonOpaqueMeshes, submergedMeshes }
  }

  dispose(): void {
    this.target.dispose()
    this.material.dispose()
  }
}

/**
 * The override shader projects base geometry and writes exactly zero for every
 * point at/below the mean waterline. A plain mesh whose transformed bounding
 * box is wholly below that plane therefore cannot affect the mask at all.
 *
 * Keep instanced, skinned and morphed geometry conservatively: their runtime
 * vertex transforms are not represented by geometry.boundingBox. This is an
 * output-equivalent submission prune, not a caster or quality heuristic.
 */
function isProvablySubmerged(mesh: Mesh): boolean {
  const dynamic = mesh as Mesh & {
    isInstancedMesh?: boolean
    isSkinnedMesh?: boolean
  }
  const geometry = mesh.geometry
  if (
    dynamic.isInstancedMesh === true ||
    dynamic.isSkinnedMesh === true ||
    Object.keys(geometry.morphAttributes).length > 0
  ) {
    return false
  }
  if (geometry.boundingBox === null) geometry.computeBoundingBox()
  if (geometry.boundingBox === null) return false
  SURFACE_BOUNDS.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld)
  return SURFACE_BOUNDS.max.y < ABOVE_WATER_EPSILON
}
