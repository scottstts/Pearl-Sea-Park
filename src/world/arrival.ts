import { BoxGeometry, Color, CylinderGeometry, Mesh, Object3D, TorusGeometry } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { registerBookmark } from '../core/debug'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'

export const ARRIVAL_POSITION = { x: 0, z: 320 }

function standard(color: number, roughness: number, metalness = 0): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial()
  material.color = new Color(color)
  material.roughness = roughness
  material.metalness = metalness
  return material
}

/**
 * The buoy pavilion — where the visit begins, floating over the park.
 * S2 stub proves the above-water world; S8 dresses it fully and adds the bell.
 */
export class ArrivalSystem implements GameSystem {
  readonly id = 'arrival-pavilion'
  private readonly group = new Object3D()

  init(ctx: GameContext): void {
    const wood = standard(0x7d6042, 0.85)
    const brass = standard(0xc9a250, 0.35, 1)
    const { x, z } = ARRIVAL_POSITION

    const deck = new Mesh(new BoxGeometry(9, 0.4, 9), wood)
    deck.position.set(x, 1.1, z)

    // Pontoons.
    for (const [px, pz] of [
      [-3.4, -3.4],
      [3.4, -3.4],
      [-3.4, 3.4],
      [3.4, 3.4],
    ]) {
      const pontoon = new Mesh(new CylinderGeometry(0.85, 0.85, 2.6, 20), standard(0x8a2f2a, 0.6))
      pontoon.position.set(x + px, -0.1, z + pz)
      this.group.add(pontoon)
    }

    // Rail posts + rails.
    const railTop = new Mesh(new BoxGeometry(8.8, 0.07, 0.07), brass)
    railTop.position.set(x, 2.35, z - 4.35)
    const railBack = railTop.clone()
    railBack.position.set(x, 2.35, z + 4.35)
    const railLeft = new Mesh(new BoxGeometry(0.07, 0.07, 8.8), brass)
    railLeft.position.set(x - 4.35, 2.35, z)
    const railRight = railLeft.clone()
    railRight.position.set(x + 4.35, 2.35, z)
    for (let i = 0; i < 4; i++) {
      for (const side of [-4.35, 4.35]) {
        const post = new Mesh(new CylinderGeometry(0.04, 0.05, 1.05, 10), brass)
        post.position.set(x - 3.3 + i * 2.2, 1.82, z + side)
        this.group.add(post)
        const post2 = new Mesh(new CylinderGeometry(0.04, 0.05, 1.05, 10), brass)
        post2.position.set(x + side, 1.82, z - 3.3 + i * 2.2)
        this.group.add(post2)
      }
    }

    // The bell shaft mouth — a brass ring waiting for S8.
    const ring = new Mesh(new TorusGeometry(1.5, 0.12, 12, 40), brass)
    ring.rotation.x = Math.PI / 2
    ring.position.set(x, 1.36, z)

    this.group.add(deck, railTop, railBack, railLeft, railRight, ring)
    this.group.traverse((node) => {
      node.castShadow = true
      node.receiveShadow = true
    })
    ctx.scene.add(this.group)

    registerBookmark({
      name: 'arrival',
      position: [x + 5.5, 4.1, z + 9],
      look: [x - 2, 0.8, z - 60],
      note: 'Postcard 1 staging — buoy pavilion over the park',
    })
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
  }
}
