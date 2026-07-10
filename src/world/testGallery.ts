import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  Object3D,
  SphereGeometry,
} from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { registerBookmark } from '../core/debug'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'

/**
 * Material/pipeline proving ground — S0 boot scene and the S1 `?pass=`
 * verification target. Replaced as the park lands; kept reachable via
 * `?view=gallery` for material work thereafter.
 */
export class TestGallerySystem implements GameSystem {
  readonly id = 'test-gallery'
  private readonly group = new Object3D()

  init(ctx: GameContext): void {
    const { scene, camera } = ctx

    scene.background = new Color(0x0d3a48)

    // Ground disc — sand stand-in.
    const ground = new Mesh(
      new CylinderGeometry(16, 16, 0.3, 72),
      makeStandard({ color: 0xcabfa3, roughness: 0.95 }),
    )
    ground.position.y = -0.15
    ground.receiveShadow = true
    this.group.add(ground)

    // Roughness sweeps: dielectric row and gold row.
    const sphereGeometry = new SphereGeometry(0.5, 48, 24)
    for (let i = 0; i < 6; i++) {
      const roughness = i / 5
      const dielectric = new Mesh(
        sphereGeometry,
        makeStandard({ color: 0xe8e4da, roughness, metalness: 0 }),
      )
      dielectric.position.set(-3.75 + i * 1.5, 0.5, -1.2)
      const gold = new Mesh(
        sphereGeometry,
        makeStandard({ color: 0xd8b56a, roughness, metalness: 1 }),
      )
      gold.position.set(-3.75 + i * 1.5, 0.5, 1.2)
      for (const m of [dielectric, gold]) {
        m.castShadow = true
        m.receiveShadow = true
        this.group.add(m)
      }
    }

    // Marble slab + brass column stubs.
    const slab = new Mesh(
      new BoxGeometry(2.2, 0.5, 1.4),
      makeStandard({ color: 0xf2efe6, roughness: 0.25 }),
    )
    slab.position.set(-5.5, 0.25, 0)
    const column = new Mesh(
      new CylinderGeometry(0.35, 0.42, 3.2, 32),
      makeStandard({ color: 0xc9a250, roughness: 0.35, metalness: 1 }),
    )
    column.position.set(5.5, 1.6, 0)
    for (const m of [slab, column]) {
      m.castShadow = true
      m.receiveShadow = true
      this.group.add(m)
    }

    // Emissive pearl — the S1 bloom probe.
    const pearlMaterial = makeStandard({ color: 0xf6f2e8, roughness: 0.4 })
    pearlMaterial.emissive = new Color(0xfff4dc)
    pearlMaterial.emissiveIntensity = 4
    const pearl = new Mesh(new SphereGeometry(0.28, 32, 16), pearlMaterial)
    pearl.position.set(0, 2.4, 0)
    this.group.add(pearl)

    // Sun stand-in + ambient fill until S2 brings the real sky.
    const sun = new DirectionalLight(0xfff2d8, 3)
    sun.position.set(18, 30, 12)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -20
    sun.shadow.camera.right = 20
    sun.shadow.camera.top = 20
    sun.shadow.camera.bottom = -20
    sun.shadow.camera.far = 80
    sun.shadow.bias = -0.0005
    const fill = new HemisphereLight(0x8fd0cc, 0x2a4a42, 0.6)
    this.group.add(sun, fill)

    scene.add(this.group)

    registerBookmark({ name: 'gallery', position: [8, 5, 10], look: [0, 1, 0] })
    camera.position.set(8, 5, 10)
    camera.lookAt(0, 1, 0)
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
  }
}

function makeStandard(options: {
  color: number
  roughness: number
  metalness?: number
}): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial()
  material.color = new Color(options.color)
  material.roughness = options.roughness
  material.metalness = options.metalness ?? 0
  return material
}
