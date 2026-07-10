import {
  AdditiveBlending,
  Color,
  HalfFloatType,
  InstancedMesh,
  LinearFilter,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  RepeatWrapping,
  Scene,
} from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import type { WebGPURenderer, Node } from 'three/webgpu'
import {
  Fn,
  dFdx,
  dFdy,
  exp,
  float,
  instanceIndex,
  max,
  normalize,
  positionGeometry,
  refract,
  texture,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { sunDirectionUniform } from '../sky/sun'
import type { WaveSim } from './waveSim'

/**
 * Differential-area caustics from the live wave field (water-optics skill):
 * a refracted grid is projected onto a virtual floor; the old/new projected
 * area ratio is the light concentration. Rendered as a repeating 17 m tile,
 * drawn 3×3 instanced so light that refracts across the tile edge wraps back
 * in additively.
 *
 * This one texture is THE glint source: floor caustics, wall caustics via
 * `receivedShadowNode`, and the god-ray march all sample it.
 */

/**
 * One cascade drives the caustics: the 17 m band. Its patch tiles exactly,
 * and a 256² grid resolves ~6.6 cm — continuous filaments, not dot chains.
 * (The 5 m cascade's micro-ripples are below what the grid can focus.)
 */
export const CAUSTIC_TILE = 17
const GRID = 256
/** Virtual floor depth used for the projection (park seabed scale). */
const PROJECT_DEPTH = 24

export class CausticsPass {
  readonly renderTarget: RenderTarget
  readonly textureNode: ReturnType<typeof texture>

  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)

  constructor(sim: WaveSim, resolution: number) {
    this.renderTarget = new RenderTarget(resolution, resolution, {
      type: HalfFloatType,
      depthBuffer: false,
    })
    this.renderTarget.texture.wrapS = RepeatWrapping
    this.renderTarget.texture.wrapT = RepeatWrapping
    this.renderTarget.texture.minFilter = LinearFilter
    this.renderTarget.texture.magFilter = LinearFilter
    this.textureNode = texture(this.renderTarget.texture)

    const material = new MeshBasicNodeMaterial()
    material.blending = AdditiveBlending
    material.depthTest = false
    material.depthWrite = false

    const tile = float(CAUSTIC_TILE)
    const uv01 = positionGeometry.xy.mul(0.5).add(0.5)
    const worldXZ = uv01.mul(tile)

    const patch1 = sim.patchLengths[1]
    const der = sim.derivativeNodes[1].sample(worldXZ.div(patch1))
    const disp = sim.displacementNodes[1].sample(worldXZ.div(patch1))

    const surfaceNormal = normalize(vec3(der.x.negate(), 1.0, der.y.negate()))
    const toSun = sunDirectionUniform
    const eta = float(1.0 / 1.333)
    const flatRefract = refract(toSun.negate(), vec3(0, 1, 0), eta)
    const waveRefract = refract(toSun.negate(), surfaceNormal, eta)

    const depth = float(PROJECT_DEPTH)
    const oldPos = worldXZ.add(flatRefract.xz.mul(depth.div(flatRefract.y.abs())))
    const newPos = worldXZ
      .add(disp.xz)
      .add(waveRefract.xz.mul(depth.add(disp.y).div(waveRefract.y.abs())))

    // Remove the mean refraction drift so the pattern stays tile-centered.
    const centered = newPos.sub(flatRefract.xz.mul(depth.div(flatRefract.y.abs())))

    const vOld = varying(oldPos) as unknown as Node<'vec2'>
    const vNew = varying(newPos) as unknown as Node<'vec2'>

    // 3×3 wrap instances.
    const ix = float(instanceIndex.mod(3)).sub(1).mul(2)
    const iy = float(instanceIndex.div(3)).sub(1).mul(2)
    const ndc = centered.div(tile).mul(2).sub(1).add(vec2(ix, iy))
    material.vertexNode = vec4(ndc, 0.0, 1.0)

    material.colorNode = Fn(() => {
      const oldArea = dFdx(vOld).length().mul(dFdy(vOld).length())
      const newArea = max(dFdx(vNew).length().mul(dFdy(vNew).length()), 1e-6)
      const intensity = oldArea.div(newArea).mul(0.18)
      return vec4(vec3(intensity.min(6.0)), 1.0)
    })()

    const mesh = new InstancedMesh(new PlaneGeometry(2, 2, GRID, GRID), material, 9)
    mesh.frustumCulled = false
    this.scene.add(mesh)
    this.scene.background = new Color(0x000000)
  }

  update(renderer: WebGPURenderer): void {
    renderer.setRenderTarget(this.renderTarget)
    void renderer.render(this.scene, this.camera)
    renderer.setRenderTarget(null)
  }

  dispose(): void {
    this.renderTarget.dispose()
  }
}

/**
 * Sample caustic light at a world position: project along the sun to the
 * surface plane, wrap into the tile, chromatic triple-tap, fade with depth.
 * Returns an rgb concentration factor around 1.
 */
export function causticWorldSample(causticsNode: ReturnType<typeof texture>) {
  return Fn(([worldPos]: [Node<'vec3'>]) => {
    const toSun = sunDirectionUniform
    const up = toSun.y.max(0.2)
    const travel = worldPos.y.negate().div(up)
    const surfaceXZ = vec2(
      worldPos.x.add(toSun.x.mul(travel)),
      worldPos.z.add(toSun.z.mul(travel)),
    )
    const uv = surfaceXZ.div(CAUSTIC_TILE)
    const spread = float(0.0016)
    const r = causticsNode.sample(uv).r
    const g = causticsNode.sample(uv.add(vec2(spread, spread.negate()))).r
    const b = causticsNode.sample(uv.add(vec2(spread.negate().mul(1.6), spread))).r
    const depthFade = exp(worldPos.y.mul(0.055)).min(1.0)
    return vec3(r, g, b).mul(depthFade)
  })
}
