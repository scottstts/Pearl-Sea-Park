import { Matrix4, Object3D, Vector3 } from 'three'
import { registerBookmark } from '../core/debug'
import type { Rng } from '../core/prng'
import { markDynamicShadowCasters } from '../render/layers'
import type { GameContext } from '../runtime/context'
import type { SeabedColonies } from '../world/reefPatches'
import { rankedPatches } from '../world/reefPatches'
import { terrainHeight } from '../world/terrain'
import type { FaunaInstance, FaunaLibrary } from './faunaAssets'

export interface ReefFishSnapshot {
  angelfishPairs: number
  drifters: number
  tunaCruisers: number
}

interface PatchFish {
  instance: FaunaInstance
  anchor: Vector3
  radius: number
  omega: number
  baseAngle: number
  bobPhase: number
}

interface Drifter {
  instance: FaunaInstance
  seed: Vector3
  /** Fixed cruise heading (yaw); +Z-forward bodies steer by rotation.y. */
  heading: number
  speed: number
  baseScale: number
  bobPhase: number
}

/** The passerby wrap box (the particulate re-tiling trick): fish hold
 *  world positions modulo the box period, so they are stationary in the
 *  world while the box follows the guest. Same dimensions as the old
 *  drifter shoal. */
const BOX = new Vector3(24, 8, 24)

/**
 * The fish, GLB-bodied but behaviorally the OLD system by Scott's ruling
 * (2026-07-22, "this asset replacement should be mesh only"):
 *
 * - The MAIN population is camera-local: a wrap box of emperor angelfish
 *   always swimming near and around the guest (the drifter behavior),
 *   with a few yellowfin tuna cruising through as the big-loner layer the
 *   teal wrasse used to be. Scale fades to zero at the box walls (wrap
 *   pops invisible) and near the waterline. No distant fish.
 * - Angelfish PAIRS additionally work the garden patches by the park —
 *   the old anchored-school role at pair-fish honesty.
 *
 * The wrap/fade math runs on CPU now (a few dozen roots), so the shadow
 * pass is automatically consistent — no viewCenter-vs-cameraPosition
 * caster trap, because there is no shader-side camera dependency at all.
 */
export class ReefFish {
  private readonly fauna: FaunaLibrary
  private readonly group = new Object3D()
  private readonly pairs: PatchFish[] = []
  private readonly drifters: Drifter[] = []
  private tunaCount = 0
  private readonly position = new Vector3()
  private readonly tangent = new Vector3()
  private readonly right = new Vector3()
  private readonly localUp = new Vector3()
  private readonly up = new Vector3(0, 1, 0)
  private readonly orientation = new Matrix4()
  private readonly boxCenter = new Vector3()
  private readonly wrapped = new Vector3()

  constructor(fauna: FaunaLibrary) {
    this.fauna = fauna
  }

  init(ctx: GameContext, colonies: SeabedColonies): void {
    const rng = ctx.rng.fork('wildlife-reef-fish')
    const tier = ctx.quality.tier
    const tierScale = [0.6, 0.8, 1][tier] ?? 0.8
    this.buildPairs(rng, colonies, [4, 5, 6][tier] ?? 5)
    this.buildDrifters(rng, Math.round(38 * tierScale), Math.max(3, Math.round(5 * tierScale)))
    ctx.scene.add(this.group)
  }

  private buildPairs(rng: Rng, colonies: SeabedColonies, patchCount: number): void {
    const patches = rankedPatches(colonies)
    const gardens = patches.filter((patch) => patch.kind === 'garden')
    const anchors = (gardens.length > 0 ? gardens : patches).slice(0, patchCount)
    for (let p = 0; p < anchors.length; p++) {
      const patch = anchors[p]
      const ground = terrainHeight(patch.x, patch.z)
      const anchor = new Vector3(patch.x, ground + rng.range(1.4, 2.3), patch.z)
      const radius = Math.min(5.5, Math.max(2.2, patch.radius * 0.55))
      // ~0.3 m/s beat around the patch, direction per pair.
      const omega = (rng.range(0.24, 0.34) / radius) * (rng.next() < 0.5 ? -1 : 1)
      const baseAngle = rng.range(0, Math.PI * 2)
      // Bonded pair: identical orbit parameters a shoulder apart, or they
      // shear apart within minutes (the butterfly-pair lesson, kept).
      for (let member = 0; member < 2; member++) {
        const instance = this.fauna.spawn('angelfish', {
          scale: rng.range(0.85, 1.1),
          phase: rng.next(),
        })
        instance.root.name = `wildlife-angelfish-${p}-${member}`
        markDynamicShadowCasters(instance.root)
        this.group.add(instance.root)
        this.pairs.push({
          instance,
          anchor,
          radius,
          omega,
          baseAngle: baseAngle + member * 0.38,
          bobPhase: rng.range(0, Math.PI * 2),
        })
      }
    }
    const hero = this.pairs[0]
    if (hero) {
      registerBookmark({
        name: 'fish',
        position: [hero.anchor.x + hero.radius + 2.5, hero.anchor.y + 0.6, hero.anchor.z + 2],
        look: [hero.anchor.x, hero.anchor.y, hero.anchor.z],
        note: 'Emperor angelfish pair working their home reef patch',
      })
    }
  }

  private buildDrifters(rng: Rng, angelCount: number, tunaCount: number): void {
    const spawnDrifter = (species: 'angelfish' | 'tuna', index: number): void => {
      const tuna = species === 'tuna'
      const instance = this.fauna.spawn(species, {
        scale: tuna ? rng.range(0.85, 1.1) : rng.range(0.75, 1.15),
        phase: rng.next(),
        timeScale: rng.range(0.9, 1.15),
      })
      instance.root.name = `wildlife-drifter-${species}-${index}`
      markDynamicShadowCasters(instance.root)
      this.group.add(instance.root)
      this.drifters.push({
        instance,
        seed: new Vector3(rng.next() * 900, rng.next() * 900, rng.next() * 900),
        heading: rng.range(0, Math.PI * 2),
        // Big cruisers move slower than the fry, like the old wrasse.
        speed: tuna ? rng.range(0.24, 0.38) : rng.range(0.3, 0.6),
        baseScale: instance.root.scale.x,
        bobPhase: rng.range(0, Math.PI * 2),
      })
      if (tuna) this.tunaCount++
    }
    for (let i = 0; i < angelCount; i++) spawnDrifter('angelfish', i)
    for (let i = 0; i < tunaCount; i++) spawnDrifter('tuna', i)
  }

  update(ctx: GameContext, dt: number): void {
    const elapsed = ctx.time.elapsed
    const camera = ctx.camera.position

    for (const pair of this.pairs) {
      // A 30 cm fish is sub-pixel long before 140 m — stop paying for it.
      const near = camera.distanceToSquared(pair.anchor) < 140 * 140
      pair.instance.setActive(near)
      if (!near) continue
      const alpha = pair.baseAngle + elapsed * pair.omega
      const bob = Math.sin(elapsed * 0.55 + pair.bobPhase) * 0.22
      this.position.set(
        pair.anchor.x + Math.cos(alpha) * pair.radius,
        pair.anchor.y + bob,
        pair.anchor.z + Math.sin(alpha) * pair.radius,
      )
      const direction = pair.omega >= 0 ? 1 : -1
      this.tangent.set(-Math.sin(alpha) * direction, 0, Math.cos(alpha) * direction).normalize()
      this.right.crossVectors(this.up, this.tangent).normalize()
      this.localUp.crossVectors(this.tangent, this.right).normalize()
      this.orientation.makeBasis(this.right, this.localUp, this.tangent)
      pair.instance.root.position.copy(this.position)
      pair.instance.root.quaternion.setFromRotationMatrix(this.orientation)
      pair.instance.update(dt)
    }

    // The wrap box: world anchor + straight cruise, re-tiled around the
    // guest; identical formula to the old shader, now on the CPU.
    this.boxCenter.copy(camera).add(new Vector3(0, 3, 0))
    for (const drifter of this.drifters) {
      const travel = elapsed * drifter.speed
      const root = drifter.instance.root
      this.wrapped.set(
        drifter.seed.x + Math.sin(drifter.heading) * travel - this.boxCenter.x,
        drifter.seed.y - this.boxCenter.y,
        drifter.seed.z + Math.cos(drifter.heading) * travel - this.boxCenter.z,
      )
      this.wrapped.x = (((this.wrapped.x / BOX.x) % 1 + 1) % 1) * BOX.x - BOX.x / 2
      this.wrapped.y = (((this.wrapped.y / BOX.y) % 1 + 1) % 1) * BOX.y - BOX.y / 2
      this.wrapped.z = (((this.wrapped.z / BOX.z) % 1 + 1) % 1) * BOX.z - BOX.z / 2
      const edge = Math.max(
        Math.abs(this.wrapped.x) / (BOX.x / 2),
        Math.abs(this.wrapped.y) / (BOX.y / 2),
        Math.abs(this.wrapped.z) / (BOX.z / 2),
      )
      const bob = Math.sin(elapsed * 0.42 + drifter.bobPhase) * 0.4
      const worldY = this.boxCenter.y + this.wrapped.y + bob
      // Hide the wrap: shrink to nothing at the box walls and near/above
      // the waterline (fish never hang in the air off the arrival deck).
      const wallFade = smoothstep(1.0, 0.74, edge)
      const surfaceFade = smoothstep(-0.5, -1.8, worldY)
      const fade = wallFade * surfaceFade
      if (fade < 0.02) {
        drifter.instance.setActive(false)
        continue
      }
      drifter.instance.setActive(true)
      root.position.set(
        this.boxCenter.x + this.wrapped.x,
        worldY,
        this.boxCenter.z + this.wrapped.z,
      )
      root.rotation.set(0, drifter.heading, 0)
      root.scale.setScalar(drifter.baseScale * fade)
      drifter.instance.update(dt)
    }
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
    // Instances share the FaunaLibrary's geometry/materials — the library
    // owns that disposal.
  }

  debugSnapshot(): ReefFishSnapshot {
    return {
      angelfishPairs: this.pairs.length / 2,
      drifters: this.drifters.length,
      tunaCruisers: this.tunaCount,
    }
  }
}

function smoothstep(from: number, to: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)))
  return t * t * (3 - 2 * t)
}
