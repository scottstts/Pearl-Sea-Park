import RAPIER from '@dimforge/rapier3d-compat'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { TERRAIN_EXTENT, terrainHeight } from '../world/terrain'
import { vehicleStructureColliders } from './vehicleStructureColliders'

/**
 * Rapier world (plan §2). The sea is air (plan §1): plain gravity, no
 * buoyancy. Terrain enters as a heightfield sampled from `terrainHeight` —
 * the same authority the visuals use, so feet and eyes always agree.
 */
export class PhysicsSystem implements GameSystem {
  readonly id = 'physics'

  world: RAPIER.World | null = null
  rapier: typeof RAPIER | null = null
  private pendingVerify = false
  private readonly vehicleOnlyColliderHandles = new Set<number>()

  async init(ctx: GameContext): Promise<void> {
    await initializeRapier()
    this.rapier = RAPIER
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    this.world = world

    // Terrain heightfield: rapier stores heights COLUMN-major
    // (index = column * (nrows+1) + row), rows advancing along Z.
    // The global grid's ~9.4 m cells cannot represent the Great Wheel's
    // dredged basin (15 m deep over a 13 m slope) — guests clipped through
    // the collider/visual mismatch and fell under the field. A dense local
    // patch owns the basin; the coarse samples inside it sink far below so
    // the patch surface is the only ground there. (Basin anchor literals
    // match terrainHeight's — see world/terrain.ts.)
    const BASIN = { x: 175, z: 40, half: 44, divisions: 88, sinkRadius: 30 }
    const divisions = 128
    const samples = divisions + 1
    const heights = new Float32Array(samples * samples)
    for (let col = 0; col < samples; col++) {
      for (let row = 0; row < samples; row++) {
        const x = (col / divisions - 0.5) * TERRAIN_EXTENT
        const z = (row / divisions - 0.5) * TERRAIN_EXTENT
        const insideBasinPatch =
          Math.abs(x - BASIN.x) < BASIN.sinkRadius && Math.abs(z - BASIN.z) < BASIN.sinkRadius
        heights[col * samples + row] = insideBasinPatch ? -60 : terrainHeight(x, z)
      }
    }
    const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(
      RAPIER.ColliderDesc.heightfield(divisions, divisions, heights, {
        x: TERRAIN_EXTENT,
        y: 1,
        z: TERRAIN_EXTENT,
      }),
      ground,
    )
    // Dense basin patch: ~1 m cells matching the visual mesh density. Its
    // half-extent (44) reaches past the coarse grid's sink-slope influence
    // (sinkRadius + one 9.4 m cell), so no invisible pit ring survives.
    const patchSamples = BASIN.divisions + 1
    const patchHeights = new Float32Array(patchSamples * patchSamples)
    for (let col = 0; col < patchSamples; col++) {
      for (let row = 0; row < patchSamples; row++) {
        const x = BASIN.x + (col / BASIN.divisions - 0.5) * BASIN.half * 2
        const z = BASIN.z + (row / BASIN.divisions - 0.5) * BASIN.half * 2
        patchHeights[col * patchSamples + row] = terrainHeight(x, z)
      }
    }
    const basinBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(BASIN.x, 0, BASIN.z),
    )
    world.createCollider(
      RAPIER.ColliderDesc.heightfield(BASIN.divisions, BASIN.divisions, patchHeights, {
        x: BASIN.half * 2,
        y: 1,
        z: BASIN.half * 2,
      }),
      basinBody,
    )

    // Guest architecture uses detailed floor/post/rail collision so its
    // interiors stay walkable. Vehicles additionally see broad building and
    // ride envelopes, which stop the submarine from passing through roofs,
    // domes, and elevated machinery.
    for (const obstacle of vehicleStructureColliders()) {
      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
        obstacle.x,
        obstacle.y,
        obstacle.z,
      )
      if (obstacle.kind === 'box' && obstacle.yaw) {
        bodyDesc.setRotation({
          x: 0,
          y: Math.sin(obstacle.yaw / 2),
          z: 0,
          w: Math.cos(obstacle.yaw / 2),
        })
      }
      const body = world.createRigidBody(bodyDesc)
      const desc = obstacle.kind === 'box'
        ? RAPIER.ColliderDesc.cuboid(obstacle.hx, obstacle.hy, obstacle.hz)
        : RAPIER.ColliderDesc.cylinder(obstacle.halfHeight, obstacle.radius)
      // Character-controller queries still see these shapes, but the solver
      // must not let an invisible envelope push dynamic midway game pieces.
      desc.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED)
      const collider = world.createCollider(desc, body)
      this.vehicleOnlyColliderHandles.add(collider.handle)
    }

    // Query pipeline is only valid after the first step — verify then.
    if (ctx.flags.debug) this.pendingVerify = true
  }

  /** Cross-check collider vs. terrainHeight with downward rays. */
  private verifyHeightfield(world: RAPIER.World): void {
    const RayCtor = this.rapier!.Ray
    let worst = 0
    for (const [x, z] of [
      [0, 0],
      [120, 80],
      [-200, 150],
      [80, -180],
      [-350, -100],
      [175, 40], // Great Wheel basin floor — exercises the dense patch
      [163, 52], // basin slope — the old fall-through region
    ]) {
      const ray = new RayCtor({ x, y: 50, z }, { x: 0, y: -1, z: 0 })
      const hit = world.castRay(ray, 500, true)
      if (hit) {
        const hitY = 50 - hit.timeOfImpact
        worst = Math.max(worst, Math.abs(hitY - terrainHeight(x, z)))
      } else {
        worst = Infinity
      }
    }
    const pass = worst < 1.5
    console.info(
      `[physics] heightfield check ${pass ? 'PASS' : 'FAIL'} — worst deviation ${worst.toFixed(2)} m (grid interpolation tolerance 1.5 m)`,
    )
  }

  /** Static cylinder (plaza plates, columns). */
  addStaticCylinder(cx: number, cy: number, cz: number, halfHeight: number, radius: number): void {
    if (!this.world || !this.rapier) return
    const body = this.world.createRigidBody(
      this.rapier.RigidBodyDesc.fixed().setTranslation(cx, cy, cz),
    )
    this.world.createCollider(this.rapier.ColliderDesc.cylinder(halfHeight, radius), body)
  }

  /** Static box helper for structures (archkit, decks, rails). */
  addStaticBox(
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    yaw = 0,
  ): void {
    if (!this.world || !this.rapier) return
    const body = this.world.createRigidBody(
      this.rapier.RigidBodyDesc.fixed()
        .setTranslation(cx, cy, cz)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
    )
    this.world.createCollider(this.rapier.ColliderDesc.cuboid(hx, hy, hz), body)
  }

  /** Vehicle envelopes are deliberately absent from guest walking queries. */
  isVehicleOnlyCollider(collider: RAPIER.Collider): boolean {
    return this.vehicleOnlyColliderHandles.has(collider.handle)
  }

  fixedUpdate(_ctx: GameContext, dt: number): void {
    if (!this.world) return
    this.world.timestep = dt
    this.world.step()
    if (this.pendingVerify) {
      this.pendingVerify = false
      this.verifyHeightfield(this.world)
    }
  }

  dispose(): void {
    this.world?.free()
    this.world = null
    this.vehicleOnlyColliderHandles.clear()
  }
}

/**
 * rapier3d-compat 0.19.3 initializes correctly but its generated compatibility
 * wrapper still calls wasm-bindgen's old positional signature and emits one
 * known upstream warning. Suppress only that exact dependency message while
 * preserving every other warning and restoring the console immediately.
 */
async function initializeRapier(): Promise<void> {
  const deprecatedInitWarning =
    'using deprecated parameters for the initialization function; pass a single object instead'
  const warn = console.warn
  console.warn = (...args: unknown[]) => {
    if (args.length === 1 && args[0] === deprecatedInitWarning) return
    warn.apply(console, args)
  }
  try {
    await RAPIER.init()
  } finally {
    console.warn = warn
  }
}
