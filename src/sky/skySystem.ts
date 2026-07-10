import { BackSide, DirectionalLight, Mesh, Scene, SphereGeometry, Vector3 } from 'three'
import { MeshBasicNodeMaterial, PMREMGenerator } from 'three/webgpu'
import { normalize, positionLocal } from 'three/tsl'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { skyRadiance } from './skyRadiance'
import { SUN_LIGHT_INTENSITY, sunColor, sunDirection } from './sun'

const SHADOW_FOCUS_QUANT = 8

/**
 * Sky dome (shared radiance function), the one directional sun light with a
 * camera-following shadow frustum, and a once-baked PMREM environment
 * (the sun never moves, so the environment never regenerates).
 */
export class SkySystem implements GameSystem {
  readonly id = 'ocean-sky'

  private dome: Mesh | null = null
  private sun: DirectionalLight | null = null
  private readonly focus = new Vector3()

  init(ctx: GameContext): void {
    const { scene, renderer, quality } = ctx

    const domeMaterial = new MeshBasicNodeMaterial()
    domeMaterial.colorNode = skyRadiance(normalize(positionLocal))
    domeMaterial.side = BackSide
    domeMaterial.depthWrite = false
    domeMaterial.fog = false
    const dome = new Mesh(new SphereGeometry(3400, 48, 24), domeMaterial)
    dome.frustumCulled = false
    dome.renderOrder = -100
    scene.add(dome)
    this.dome = dome

    const sun = new DirectionalLight(sunColor, SUN_LIGHT_INTENSITY)
    sun.castShadow = true
    const size = quality.params.shadowMapSize
    sun.shadow.mapSize.set(size, size)
    const extent = 90
    sun.shadow.camera.left = -extent
    sun.shadow.camera.right = extent
    sun.shadow.camera.top = extent
    sun.shadow.camera.bottom = -extent
    sun.shadow.camera.near = 10
    sun.shadow.camera.far = 600
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.02
    scene.add(sun)
    scene.add(sun.target)
    this.sun = sun

    // Fixed sky → bake the environment exactly once.
    const envScene = new Scene()
    const envDome = new Mesh(new SphereGeometry(50, 32, 16), domeMaterial)
    envScene.add(envDome)
    const pmrem = new PMREMGenerator(renderer)
    const envTarget = pmrem.fromScene(envScene, 0.03, 1, 90)
    scene.environment = envTarget.texture
    scene.environmentIntensity = 0.5
    pmrem.dispose()
  }

  update(ctx: GameContext): void {
    const camera = ctx.camera
    this.dome?.position.copy(camera.position)

    // Shadow frustum follows the camera on a coarse grid (full texel-stable
    // clipmaps land with the terrain stage).
    if (this.sun) {
      this.focus.set(
        Math.round(camera.position.x / SHADOW_FOCUS_QUANT) * SHADOW_FOCUS_QUANT,
        0,
        Math.round(camera.position.z / SHADOW_FOCUS_QUANT) * SHADOW_FOCUS_QUANT,
      )
      this.sun.position.copy(this.focus).addScaledVector(sunDirection, 260)
      this.sun.target.position.copy(this.focus)
    }
  }

  dispose(ctx: GameContext): void {
    if (this.dome) ctx.scene.remove(this.dome)
    if (this.sun) {
      ctx.scene.remove(this.sun.target)
      ctx.scene.remove(this.sun)
    }
  }
}
