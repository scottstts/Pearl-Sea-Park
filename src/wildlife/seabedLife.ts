import {
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3,
} from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import {
  atan,
  attribute,
  cameraPosition,
  cos,
  float,
  mix,
  normalGeometry,
  positionGeometry,
  positionLocal,
  sin,
  smoothstep,
  transformNormalToView,
  uniform,
  vec3,
} from 'three/tsl'
import type { Rng } from '../core/prng'
import { fbm2 } from '../render/tslNoise'
import { markMainDetail } from '../render/layers'
import type { GameContext } from '../runtime/context'
import { currentFlow } from '../sea/current'
import type { SeaMediumSystem } from '../sea/medium'
import { inParkFootprint } from '../world/parkPlan'
import type { SeabedColonies } from '../world/reefPatches'
import { sampleParkVergePoint } from '../world/reefPatches'
import { terrainHeight, RIM_Z } from '../world/terrain'
import type { FaunaInstance, FaunaLibrary } from './faunaAssets'
import {
  createGardenEelGeometry,
  createScallopGeometry,
  geometryMetrics,
  SCALLOP_HINGE,
} from './speciesGeometry'
import type { GeometryMetrics } from './speciesGeometry'

export interface SeabedLifeSnapshot {
  crabs: number
  gardenEels: number
  scallops: number
  geometry: Record<string, GeometryMetrics>
}

/** The crab GLB's authored front is assumed +Z; set to Math.PI if the walk
 *  clip turns out to lead with the other flank on visual inspection. */
const CRAB_FACING_FLIP = 0

interface CrabMember {
  instance: FaunaInstance
  home: Vector3
  /** Shuffle-line direction (slowly wanders). */
  heading: number
  /** Half-length of the back-and-forth line, metres. */
  halfSpan: number
  /** Shuffle cycle rate, rad/s (one full back+forth = 2π/omega). */
  omega: number
  phase: number
  wanderPhase: number
  /** Authored clip speed at spawn — sign-flipped when the crab reverses. */
  baseTimeScale: number
}

/**
 * Ground-dwelling small fauna:
 *
 * - Crabs are loaded GLB rigs (Scott's ruling, 2026-07-22) playing their
 *   authored walk clip while a CPU patrol drives slow contour circles,
 *   body facing outward and sidestepping along the ring the way real
 *   crabs travel. Mixer + visibility are distance-gated (a 30 cm crab is
 *   invisible at 80 m).
 * - Garden-eel lawns stay vertex-TSL: sway in the current and shyly sink
 *   into the sand as the camera approaches.
 * - Scallops stay vertex-TSL: valves breathe open and rarely clap shut.
 *
 * No colliders (walk-through by ruling). Eels/scallops keep the
 * main-detail layer; crabs keep castShadow off like before.
 */
export class SeabedLife {
  private readonly medium: SeaMediumSystem
  private readonly fauna: FaunaLibrary
  private readonly timeUniform = uniform(0)
  private readonly group = new Object3D()
  private readonly meshes: InstancedMesh[] = []
  private readonly materials = new Set<MeshStandardNodeMaterial>()
  private readonly geometries = new Map<string, GeometryMetrics>()
  private readonly crabs: CrabMember[] = []
  private eelCount = 0
  private scallopCount = 0

  constructor(medium: SeaMediumSystem, fauna: FaunaLibrary) {
    this.medium = medium
    this.fauna = fauna
  }

  init(ctx: GameContext, colonies: SeabedColonies): void {
    const rng = ctx.rng.fork('wildlife-seabed-life')
    const tierScale = [0.55, 0.8, 1][ctx.quality.tier] ?? 0.8
    this.buildCrabs(ctx, rng.fork('crabs'), tierScale)
    this.buildGardenEels(ctx, rng.fork('eels'), colonies)
    this.buildScallops(ctx, rng.fork('scallops'), tierScale)
    ctx.scene.add(this.group)
  }

  // ── Crabs ────────────────────────────────────────────────────────────

  private buildCrabs(ctx: GameContext, rng: Rng, tierScale: number): void {
    void ctx
    // Scott's ruling (2026-07-22, final): 100% of the crabs live in the
    // walkway-verge tuft band — the flora clusters BETWEEN the paths and
    // the open sand, the only places the player actually goes and looks.
    // Same sampler flora plants those tufts with; these draws deliberately
    // SKIP the park-footprint filter, whose 2.2 m margin had silently
    // rejected the entire verge band since the procedural era (the
    // placement census caught it — that's why path-side crabs never
    // existed in any earlier build).
    const homes: { x: number; y: number; z: number }[] = []
    const target = Math.round(90 * tierScale)
    const flatEnough = (x: number, z: number): boolean => {
      // Flat ground only: a shuffle line on a slope would sink its feet.
      const slopeX = terrainHeight(x + 2, z) - terrainHeight(x - 2, z)
      const slopeZ = terrainHeight(x, z + 2) - terrainHeight(x, z - 2)
      return Math.hypot(slopeX, slopeZ) / 4 <= 0.045
    }
    for (let attempt = 0; attempt < target * 8 && homes.length < target; attempt++) {
      const spot = sampleParkVergePoint(rng, 0.5, 5.5)
      if (!spot || !flatEnough(spot.x, spot.z)) continue
      homes.push({ x: spot.x, y: terrainHeight(spot.x, spot.z), z: spot.z })
    }
    if (homes.length === 0) return

    for (let i = 0; i < homes.length; i++) {
      const home = homes[i]
      const instance = this.fauna.spawn('crab', {
        // 2× display scale by Scott's ruling: 42–73 cm leg spans.
        scale: rng.range(1.5, 2.6),
        phase: rng.next(),
        timeScale: rng.range(0.85, 1.25),
      })
      instance.root.name = `wildlife-crab-${i}`
      markMainDetail(instance.root)
      this.group.add(instance.root)
      this.crabs.push({
        instance,
        home: new Vector3(home.x, home.y, home.z),
        heading: rng.range(0, Math.PI * 2),
        halfSpan: rng.range(0.8, 1.6),
        omega: rng.range(0.14, 0.26),
        phase: rng.range(0, Math.PI * 2),
        wanderPhase: rng.range(0, Math.PI * 2),
        baseTimeScale: instance.mixer.timeScale,
      })
    }
  }

  // ── Garden eels ──────────────────────────────────────────────────────

  private buildGardenEels(ctx: GameContext, rng: Rng, colonies: SeabedColonies): void {
    void ctx
    if (colonies.eelLawns.length === 0) return
    const geometry = createGardenEelGeometry()
    this.geometries.set('garden-eel', geometryMetrics(geometry))
    const material = this.createEelMaterial()

    for (let lawnIndex = 0; lawnIndex < colonies.eelLawns.length; lawnIndex++) {
      const lawn = colonies.eelLawns[lawnIndex]
      const place = rng.fork(`lawn-${lawnIndex}`)
      const count = place.int(38, 50)
      const homes = new Float32Array(count * 3)
      const miscs = new Float32Array(count * 4)
      const lawnGeometry = geometry.clone()
      const mesh = new InstancedMesh(lawnGeometry, material, count)
      const matrix = new Matrix4()
      const quaternion = new Quaternion()
      const scaleVector = new Vector3()
      for (let i = 0; i < count; i++) {
        const angle = place.range(0, Math.PI * 2)
        const radius = lawn.radius * Math.sqrt(place.next())
        const x = lawn.x + Math.cos(angle) * radius
        const z = lawn.z + Math.sin(angle) * radius
        const y = terrainHeight(x, z)
        const scale = place.range(0.75, 1.3)
        homes.set([x, y, z], i * 3)
        miscs.set([place.range(0, Math.PI * 2), scale, place.next(), 0], i * 4)
        scaleVector.setScalar(scale)
        matrix.compose(new Vector3(x, y, z), quaternion, scaleVector)
        mesh.setMatrixAt(i, matrix)
        this.eelCount++
      }
      lawnGeometry.setAttribute('instanceHome', new InstancedBufferAttribute(homes, 3))
      lawnGeometry.setAttribute('instanceMisc', new InstancedBufferAttribute(miscs, 4))
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 1
      mesh.frustumCulled = true
      mesh.castShadow = false
      mesh.receiveShadow = true
      mesh.name = `wildlife-garden-eels-${lawnIndex}`
      markMainDetail(mesh)
      this.group.add(mesh)
      this.meshes.push(mesh)
    }
  }

  private createEelMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial()
    material.roughness = 0.55
    const home = attribute('instanceHome', 'vec3') as unknown as Node<'vec3'>
    const misc = attribute('instanceMisc', 'vec4') as unknown as Node<'vec4'>
    const morph = attribute('morphWeight', 'float') as unknown as Node<'float'>
    const time = this.timeUniform
    const phase = misc.x
    const shySeed = misc.z

    // Shyness: the whole column telescopes into the sand as the camera
    // nears — thresholds staggered per eel so a lawn ripples down in a
    // wave ahead of a walking guest, then periscopes back up behind them.
    const guestDistance = cameraPosition.xz.sub(home.xz).length()
    const nearEdge = float(2.8).add(shySeed.mul(1.4))
    const shy = smoothstep(nearEdge, nearEdge.add(3.4), guestDistance).mul(0.94).add(0.06)

    const relative = (positionLocal as unknown as Node<'vec3'>).sub(home)
    const flow = currentFlow(home, time)
    const swayX = sin(time.mul(1.15).add(phase).add(positionGeometry.y.mul(3.4)))
      .mul(morph.mul(morph)).mul(0.05)
    const swayZ = cos(time.mul(0.95).add(phase.mul(1.3)).add(positionGeometry.y.mul(2.9)))
      .mul(morph.mul(morph)).mul(0.045)
    const fade = smoothstep(float(130), float(100), cameraPosition.xz.sub(home.xz).length())
    material.positionNode = home.add(
      vec3(
        relative.x.add(swayX).add(flow.x.mul(morph).mul(0.09)),
        relative.y.mul(shy),
        relative.z.add(swayZ).add(flow.z.mul(morph).mul(0.09)),
      ).mul(fade),
    )

    // Sandy hide with pepper spots, darker head cap; a faint pale throat
    // gradient keeps the column round under flat light.
    const spots = smoothstep(0.72, 0.8, fbm2(positionGeometry.xy.mul(34).add(positionGeometry.z.mul(21))))
    const headCap = smoothstep(0.9, 1.0, morph)
    let color = mix(vec3(0.62, 0.55, 0.4), vec3(0.42, 0.36, 0.26), morph.mul(0.5))
    color = mix(color, vec3(0.2, 0.16, 0.12), spots.mul(0.7))
    material.colorNode = mix(color, vec3(0.24, 0.2, 0.16), headCap.mul(0.6))
    this.medium.applyCaustics(material, 1.15)
    this.materials.add(material)
    return material
  }

  // ── Scallops ─────────────────────────────────────────────────────────

  private buildScallops(ctx: GameContext, rng: Rng, tierScale: number): void {
    void ctx
    const geometry = createScallopGeometry()
    this.geometries.set('scallop', geometryMetrics(geometry))
    const target = Math.round(190 * tierScale)
    const spots: { x: number; y: number; z: number }[] = []
    for (let attempt = 0; attempt < target * 8 && spots.length < target; attempt++) {
      let x: number
      let z: number
      // Scallop beds: most shells settle near an earlier one; a third of
      // the fresh beds seed on the walking verges so the open/close beat
      // happens right beside the guest.
      if (spots.length > 0 && rng.next() < 0.55) {
        const previous = spots[rng.int(0, spots.length - 1)]
        x = previous.x + rng.range(-2.2, 2.2)
        z = previous.z + rng.range(-2.2, 2.2)
      } else if (rng.next() < 0.38) {
        const spot = sampleParkVergePoint(rng, 0.3, 6.5)
        if (!spot) continue
        x = spot.x
        z = spot.z
      } else {
        const angle = rng.range(0, Math.PI * 2)
        const distance = rng.range(60, 390)
        x = Math.cos(angle) * distance
        z = Math.sin(angle) * distance * 0.92
      }
      if (z < RIM_Z + 26 || inParkFootprint(x, z, 1.2)) continue
      spots.push({ x, y: terrainHeight(x, z), z })
    }
    if (spots.length === 0) return

    const count = spots.length
    const homes = new Float32Array(count * 3)
    const miscs = new Float32Array(count * 4)
    const material = this.createScallopMaterial()
    const mesh = new InstancedMesh(geometry, material, count)
    const matrix = new Matrix4()
    const quaternion = new Quaternion()
    const scaleVector = new Vector3()
    for (let i = 0; i < count; i++) {
      const spot = spots[i]
      const yaw = rng.range(0, Math.PI * 2)
      const scale = rng.range(0.8, 1.7)
      homes.set([spot.x, spot.y + 0.004, spot.z], i * 3)
      miscs.set([rng.range(0, Math.PI * 2), scale, Math.cos(yaw), Math.sin(yaw)], i * 4)
      scaleVector.setScalar(scale)
      matrix.compose(new Vector3(spot.x, spot.y + 0.004, spot.z), quaternion, scaleVector)
      mesh.setMatrixAt(i, matrix)
    }
    geometry.setAttribute('instanceHome', new InstancedBufferAttribute(homes, 3))
    geometry.setAttribute('instanceMisc', new InstancedBufferAttribute(miscs, 4))
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    if (mesh.boundingSphere) mesh.boundingSphere.radius += 0.6
    mesh.frustumCulled = true
    mesh.castShadow = false
    mesh.receiveShadow = true
    mesh.name = 'wildlife-scallops'
    markMainDetail(mesh)
    this.group.add(mesh)
    this.meshes.push(mesh)
    this.scallopCount = count
  }

  private createScallopMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial()
    material.roughness = 0.5
    material.metalness = 0.05
    const home = attribute('instanceHome', 'vec3') as unknown as Node<'vec3'>
    const misc = attribute('instanceMisc', 'vec4') as unknown as Node<'vec4'>
    const morph = attribute('morphWeight', 'float') as unknown as Node<'float'>
    const time = this.timeUniform
    const phase = misc.x
    const scale = misc.y
    const facingCos = misc.z
    const facingSin = misc.w

    // Gape cycle: a slow breathing open (up to ~22°) interrupted by rare,
    // desynchronized clap bursts — the "shells open and close" beat.
    const breathe = sin(time.mul(0.32).add(phase)).mul(0.5).add(0.5).pow(1.5).mul(0.38)
    const snapGate = smoothstep(0.965, 0.995, sin(time.mul(0.11).add(phase.mul(3.7))))
    const clap = sin(time.mul(9.0).add(phase)).mul(0.5).add(0.5)
    const gape = breathe.mul(snapGate.mul(clap).oneMinus().clamp(0.08, 1))

    // Rotate upper-valve vertices (morph = 1) about the authored hinge in
    // geometry space, then yaw the whole shell by its facing.
    const angle = gape.mul(morph)
    const cosA = cos(angle)
    const sinA = sin(angle)
    const localY = positionGeometry.y.sub(SCALLOP_HINGE.y)
    const localZ = positionGeometry.z.sub(SCALLOP_HINGE.z)
    const hinged = vec3(
      positionGeometry.x,
      localY.mul(cosA).add(localZ.mul(sinA)).add(SCALLOP_HINGE.y),
      localY.negate().mul(sinA).add(localZ.mul(cosA)).add(SCALLOP_HINGE.z),
    )
    const yawed = vec3(
      hinged.x.mul(facingCos).add(hinged.z.mul(facingSin)),
      hinged.y,
      hinged.x.negate().mul(facingSin).add(hinged.z.mul(facingCos)),
    )
    const fade = smoothstep(float(85), float(65), cameraPosition.xz.sub(home.xz).length())
    material.positionNode = home.add(yawed.mul(scale).mul(fade))
    const hingedNormal = vec3(
      normalGeometry.x,
      normalGeometry.y.mul(cosA).add(normalGeometry.z.mul(sinA)),
      normalGeometry.y.negate().mul(sinA).add(normalGeometry.z.mul(cosA)),
    )
    material.normalNode = transformNormalToView(
      vec3(
        hingedNormal.x.mul(facingCos).add(hingedNormal.z.mul(facingSin)),
        hingedNormal.y,
        hingedNormal.x.negate().mul(facingSin).add(hingedNormal.z.mul(facingCos)),
      ),
    )

    // Ribbed coral-rose outside, nacre inside — the inner faces are the
    // ones whose geometry normals point INTO the shell cavity.
    const upperInner = smoothstep(-0.1, -0.5, normalGeometry.y)
    const lowerInner = smoothstep(0.1, 0.5, normalGeometry.y)
    const innerMask = mix(lowerInner, upperInner, morph)
    // Same fan angle the geometry carved its ribs with — color follows
    // the exact ridges.
    const spread = atan(positionGeometry.x, positionGeometry.z.sub(SCALLOP_HINGE.z))
    const ribs = cos(spread.mul(6.5)).mul(0.5).add(0.5)
    const speckle = fbm2(positionGeometry.xz.mul(30)).mul(0.24).add(0.86)
    const outer = mix(vec3(0.66, 0.3, 0.22), vec3(0.9, 0.66, 0.5), ribs.mul(0.7)).mul(speckle)
    const inner = vec3(0.93, 0.88, 0.8)
    material.colorNode = mix(outer, inner, innerMask)
    material.roughnessNode = mix(float(0.55), float(0.22), innerMask)
    this.medium.applyCaustics(material, 1.25)
    this.materials.add(material)
    return material
  }

  update(ctx: GameContext, dt: number): void {
    this.timeUniform.value = ctx.time.elapsed
    const elapsed = ctx.time.elapsed
    const camera = ctx.camera.position
    for (const crab of this.crabs) {
      // A 30 cm crab is invisible at 100 m — skip render, skeleton, AND
      // the matrix-world walk of its 184 joints.
      const near = camera.distanceToSquared(crab.home) < 100 * 100
      crab.instance.setActive(near)
      if (!near) continue
      // Back-and-forth shuffle (Scott's ruling): the crab works a short
      // line near its home, easing to a stop at each end, and the walk
      // clip PLAYS IN REVERSE on the way back. The line's direction
      // wanders slowly and a small cross-line drift keeps the path from
      // reading as a rail.
      const cycle = elapsed * crab.omega + crab.phase
      const along = Math.sin(cycle) * crab.halfSpan
      const travelSign = Math.cos(cycle)
      const heading = crab.heading + Math.sin(elapsed * 0.05 + crab.wanderPhase) * 0.35
      const dirX = Math.sin(heading)
      const dirZ = Math.cos(heading)
      const drift = Math.sin(elapsed * 0.23 + crab.wanderPhase * 1.7) * 0.15
      const root = crab.instance.root
      root.position.set(
        crab.home.x + dirX * along + dirZ * drift,
        crab.home.y,
        crab.home.z + dirZ * along - dirX * drift,
      )
      // Sideways body: faces across the shuffle line, constant while the
      // travel direction alternates — the real crab gait.
      const wobble = Math.sin(elapsed * 0.4 + crab.wanderPhase) * 0.12
      root.rotation.set(0, heading + Math.PI / 2 + wobble + CRAB_FACING_FLIP, 0)
      crab.instance.mixer.timeScale =
        crab.baseTimeScale * (travelSign >= 0 ? 1 : -1) * (0.35 + Math.abs(travelSign) * 0.75)
      crab.instance.update(dt)
    }
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
    for (const mesh of this.meshes) mesh.geometry.dispose()
    for (const material of this.materials) material.dispose()
    // Crab instances share the FaunaLibrary's resources.
  }

  debugSnapshot(): SeabedLifeSnapshot {
    return {
      crabs: this.crabs.length,
      gardenEels: this.eelCount,
      scallops: this.scallopCount,
      geometry: Object.fromEntries(this.geometries),
    }
  }
}
