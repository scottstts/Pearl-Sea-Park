import { BackSide, DirectionalLight, Mesh, Scene, SphereGeometry } from 'three'
import { MeshBasicNodeMaterial, PMREMGenerator } from 'three/webgpu'
import { normalize, positionLocal } from 'three/tsl'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { CachedShadowClipmapNode } from '../render/cachedShadowClipmaps'
import { skyRadiance } from './skyRadiance'
import { SUN_LIGHT_INTENSITY, sunColor, sunDirection } from './sun'

/**
 * Sky dome (shared radiance function), the one directional sun light with a
 * cached camera-centered shadow clipmaps, and a once-baked PMREM environment
 * (the sun never moves, so the environment never regenerates).
 */
export class SkySystem implements GameSystem {
  readonly id = 'ocean-sky'

  private dome: Mesh | null = null
  private sun: DirectionalLight | null = null
  private clipmaps: CachedShadowClipmapNode | null = null
  private debugCanvas: HTMLCanvasElement | null = null

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
    sun.shadow.mapSize.set(quality.params.shadowMapSizes[0], quality.params.shadowMapSizes[0])
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.02
    sun.position.copy(sunDirection).multiplyScalar(700)
    sun.target.position.set(0, 0, 0)
    scene.add(sun)
    scene.add(sun.target)
    this.sun = sun
    this.clipmaps = new CachedShadowClipmapNode(sun, {
      camera: ctx.camera,
      levelMapSizes: quality.params.shadowMapSizes,
      firstRadius: 28,
      scaleFactor: 3,
      maxDistance: 650,
      dynamicLevels: 1,
      updateBudget: 1,
      maxCacheAge: 180,
    }).attach()
    if (ctx.flags.debug) this.debugCanvas = renderer.domElement

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

    if (this.debugCanvas && ctx.time.frame % 60 === 0) {
      this.debugCanvas.dataset.shadowClipmaps = JSON.stringify(this.clipmaps?.debugSnapshot())
    }
  }

  dispose(ctx: GameContext): void {
    if (this.dome) ctx.scene.remove(this.dome)
    if (this.sun) {
      ctx.scene.remove(this.sun.target)
      ctx.scene.remove(this.sun)
    }
    this.clipmaps?.dispose()
    this.clipmaps = null
    if (this.debugCanvas) delete this.debugCanvas.dataset.shadowClipmaps
  }
}
