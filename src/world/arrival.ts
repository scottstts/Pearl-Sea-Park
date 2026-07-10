import { BoxGeometry, Color, CylinderGeometry, Mesh, Object3D, TorusGeometry } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { registerBookmark } from '../core/debug'
import type { PhysicsSystem } from '../physics/physicsWorld'
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
  private readonly physics: PhysicsSystem | null

  constructor(physics: PhysicsSystem | null = null) {
    this.physics = physics
  }

  init(ctx: GameContext): void {
    const wood = standard(0x7d6042, 0.85)
    const brass = standard(0xc9a250, 0.35, 1)
    const { x, z } = ARRIVAL_POSITION

    // Deck with a 3.2 m shaft mouth for the bell: four slabs around the hole.
    const deck = new Object3D()
    const slabNS = new BoxGeometry(9, 0.4, 2.9)
    const slabEW = new BoxGeometry(2.9, 0.4, 3.2)
    for (const [px, pz, geometry] of [
      [0, -3.05, slabNS],
      [0, 3.05, slabNS],
      [-3.05, 0, slabEW],
      [3.05, 0, slabEW],
    ] as const) {
      const slab = new Mesh(geometry, wood)
      slab.position.set(x + px, 2.4, z + pz)
      deck.add(slab)
      this.physics?.addStaticBox(x + px, 2.4, z + pz, geometry.parameters.width / 2, 0.2, geometry.parameters.depth / 2)
    }
    // Rails keep guests off the edge (thin, above the visual rails' feet).
    this.physics?.addStaticBox(x, 3.3, z - 4.42, 4.5, 0.7, 0.08)
    this.physics?.addStaticBox(x, 3.3, z + 4.42, 4.5, 0.7, 0.08)
    this.physics?.addStaticBox(x - 4.42, 3.3, z, 0.08, 0.7, 4.5)
    this.physics?.addStaticBox(x + 4.42, 3.3, z, 0.08, 0.7, 4.5)

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
      const pile = new Mesh(new CylinderGeometry(0.16, 0.2, 1.3, 12), wood)
      pile.position.set(x + px, 1.6, z + pz)
      this.group.add(pile)
    }

    // Rail posts + rails.
    const railTop = new Mesh(new BoxGeometry(8.8, 0.07, 0.07), brass)
    railTop.position.set(x, 3.65, z - 4.35)
    const railBack = railTop.clone()
    railBack.position.set(x, 3.65, z + 4.35)
    const railLeft = new Mesh(new BoxGeometry(0.07, 0.07, 8.8), brass)
    railLeft.position.set(x - 4.35, 3.65, z)
    const railRight = railLeft.clone()
    railRight.position.set(x + 4.35, 3.65, z)
    for (let i = 0; i < 4; i++) {
      for (const side of [-4.35, 4.35]) {
        const post = new Mesh(new CylinderGeometry(0.04, 0.05, 1.05, 10), brass)
        post.position.set(x - 3.3 + i * 2.2, 3.12, z + side)
        this.group.add(post)
        const post2 = new Mesh(new CylinderGeometry(0.04, 0.05, 1.05, 10), brass)
        post2.position.set(x + side, 3.12, z - 3.3 + i * 2.2)
        this.group.add(post2)
      }
    }

    // The bell shaft mouth.
    const ring = new Mesh(new TorusGeometry(1.6, 0.12, 12, 40), brass)
    ring.rotation.x = Math.PI / 2
    ring.position.set(x, 2.66, z)

    this.group.add(deck, railTop, railBack, railLeft, railRight, ring)
    this.group.traverse((node) => {
      node.castShadow = true
      node.receiveShadow = true
    })
    ctx.scene.add(this.group)

    registerBookmark({
      name: 'arrival',
      position: [x + 5.5, 5.2, z + 9],
      look: [x - 2, 1.6, z - 60],
      note: 'Postcard 1 staging — buoy pavilion over the park',
    })
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
  }
}
