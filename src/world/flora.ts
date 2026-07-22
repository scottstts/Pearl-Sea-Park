import {
  Color,
  DoubleSide,
  Euler,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import type { BufferGeometry } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import {
  attribute,
  cameraPosition,
  cos,
  dot,
  float,
  fract,
  mix,
  normalGeometry,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'
import { registerBookmark } from '../core/debug'
import { fbm2 as fbmCpu } from '../core/noise2'
import type { Rng } from '../core/prng'
import { fbm2 } from '../render/tslNoise'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { currentFlow } from '../sea/current'
import type { SeaMediumSystem } from '../sea/medium'
import {
  createAlgaeTuftGeometry,
  createAmphoraGeometry,
  createAnemoneGeometry,
  createBarrelSpongeGeometry,
  createBoulderGeometry,
  createBrainCoralGeometry,
  createClamShellGeometry,
  createGiantClamGeometry,
  createPinnacleGeometry,
  createSeaFanGeometry,
  createStaghornColonyGeometry,
  createStarfishGeometry,
  createStrapKelpGeometry,
  createTableCoralGeometry,
  createTubeSpongeGeometry,
  createTurbanShellGeometry,
  createUrchinGeometry,
} from './floraGeometry'
import type { AlgaeKind } from './floraGeometry'
import { inParkFootprint } from './parkPlan'
import { computeSeabedColonies, sampleParkVergePoint } from './reefPatches'
import type { ReefPatch } from './reefPatches'
import { terrainHeight, RIM_Z } from './terrain'

/**
 * Flora & reef dressing, remade (2026-07-22): every archetype is a sculpted
 * mesh from floraGeometry.ts, distribution is colony-clustered through the
 * shared reefPatches layout (never uniform confetti), and everything alive
 * sways in vertex TSL off baked channels — zero per-frame CPU.
 *
 * Standing rules honored here: scatter respects inParkFootprint + the rim
 * margin; flora carries no colliders; dense/swaying flora never casts
 * shadows (only rigid reef masses do — they are static-bundle safe);
 * materials are simple Standard nodes with cause-coupled color fields.
 */

interface PlacedInstance {
  x: number
  y: number
  z: number
  rx: number
  ry: number
  rz: number
  sx: number
  sy: number
  sz: number
  phase: number
}

interface FamilyOptions {
  name: string
  castShadow: boolean
  /** Adds instanceOrigin/instancePhase/instanceScale for TSL sway. */
  withOrigin: boolean
  /** Extra world-space motion envelope for culling bounds. */
  boundsMargin: number
  /** Split into quadrant sector draws when the family is large. */
  sectors: boolean
}

export class FloraSystem implements GameSystem {
  readonly id = 'flora'
  private readonly group = new Object3D()
  private readonly timeUniform = uniform(0)
  private readonly medium: SeaMediumSystem

  constructor(medium: SeaMediumSystem) {
    this.medium = medium
  }

  init(ctx: GameContext): void {
    const rng = ctx.rng.fork('flora')
    const tierScale = [0.5, 0.75, 1][ctx.quality.tier] ?? 0.75
    const colonies = computeSeabedColonies(ctx.rng)

    this.buildKelpGroves(rng.fork('kelp'), colonies.groves, tierScale)
    this.buildAlgaeTurf(rng.fork('seagrass'), ctx.quality.params.seagrassDensity)
    this.buildReef(rng.fork('reef'), colonies.patches, tierScale)
    this.buildShellsAndStones(rng.fork('shells-and-stones'))
    this.buildSeaTreasures(rng.fork('sea-treasures'))
    this.group.traverse((node) => {
      if ((node as Mesh).isMesh) node.receiveShadow = true
    })
    ctx.scene.add(this.group)

    registerBookmark({
      name: 'gardens',
      position: [150, terrainHeight(150, 150) + 2, 150],
      look: [190, terrainHeight(190, 120) - 1, 120],
      note: 'Coral gardens + seagrass on the plateau',
    })
    const hero = [...colonies.patches].sort((a, b) => b.richness - a.richness)[0]
    if (hero) {
      registerBookmark({
        name: 'reef',
        position: [hero.x + hero.radius + 6, terrainHeight(hero.x, hero.z) + 3.2, hero.z + 4],
        look: [hero.x, terrainHeight(hero.x, hero.z) + 0.5, hero.z],
        note: 'The richest reef colony patch',
      })
    }
  }

  update(ctx: GameContext): void {
    this.timeUniform.value = ctx.time.elapsed
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
  }

  /**
   * Aggressive distance LOD for dense dressing: 1 within ~75% of `far`,
   * 0 beyond it. Materials multiply their instance-relative geometry by
   * this, collapsing far instances to degenerate points the rasterizer
   * discards — near the camera everything is full detail, far away it
   * simply ceases to exist. (Distant meadow COLOR is already carried by
   * the sand tint's shared field, so nothing visually pops.)
   */
  private lodFade(origin: Node<'vec3'>, far: number): Node<'float'> {
    return smoothstep(
      float(far),
      float(far * 0.75),
      cameraPosition.xz.sub(origin.xz).length(),
    ) as unknown as Node<'float'>
  }

  // ── Shared placement helper ──────────────────────────────────────────

  private emitFamily(
    geometry: BufferGeometry,
    material: MeshStandardNodeMaterial,
    instances: PlacedInstance[],
    options: FamilyOptions,
  ): void {
    if (instances.length === 0) return
    const buckets: PlacedInstance[][] =
      options.sectors && instances.length > 40 ? [[], [], [], []] : [instances]
    if (buckets.length === 4) {
      for (const instance of instances) {
        buckets[(instance.x >= 0 ? 1 : 0) + (instance.z >= 0 ? 2 : 0)].push(instance)
      }
    }
    const matrix = new Matrix4()
    const position = new Vector3()
    const quaternion = new Quaternion()
    const scale = new Vector3()
    const euler = new Euler()
    for (const bucket of buckets) {
      if (bucket.length === 0) continue
      const meshGeometry = options.withOrigin ? geometry.clone() : geometry
      if (options.withOrigin) {
        const origins = new Float32Array(bucket.length * 3)
        const phases = new Float32Array(bucket.length)
        const scales = new Float32Array(bucket.length)
        for (let i = 0; i < bucket.length; i++) {
          origins.set([bucket[i].x, bucket[i].y, bucket[i].z], i * 3)
          phases[i] = bucket[i].phase
          scales[i] = bucket[i].sy
        }
        meshGeometry.setAttribute('instanceOrigin', new InstancedBufferAttribute(origins, 3))
        meshGeometry.setAttribute('instancePhase', new InstancedBufferAttribute(phases, 1))
        meshGeometry.setAttribute('instanceScale', new InstancedBufferAttribute(scales, 1))
      }
      const mesh = new InstancedMesh(meshGeometry, material, bucket.length)
      for (let i = 0; i < bucket.length; i++) {
        const instance = bucket[i]
        position.set(instance.x, instance.y, instance.z)
        quaternion.setFromEuler(euler.set(instance.rx, instance.ry, instance.rz))
        scale.set(instance.sx, instance.sy, instance.sz)
        matrix.compose(position, quaternion, scale)
        mesh.setMatrixAt(i, matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
      if (mesh.boundingSphere) mesh.boundingSphere.radius += options.boundsMargin
      mesh.frustumCulled = true
      mesh.castShadow = options.castShadow
      mesh.receiveShadow = true
      mesh.name = options.name
      this.group.add(mesh)
    }
  }

  // ── Kelp groves ──────────────────────────────────────────────────────

  /**
   * Boundary kelp stands of STRAP kelp: long leathery ribbons rising from
   * holdfasts, bowing over and streaming with the current — plus traveling
   * gust fronts. Roots never move; each grove is one instanced draw,
   * culled as one.
   */
  private buildKelpGroves(
    rng: Rng,
    groves: readonly { x: number; z: number; radius: number; share: number }[],
    tierScale: number,
  ): void {
    const variants = [
      createStrapKelpGeometry(rng.fork('variant-0')),
      createStrapKelpGeometry(rng.fork('variant-1')),
      createStrapKelpGeometry(rng.fork('variant-2')),
    ]
    const material = this.createKelpMaterial()
    const total = Math.round(360 * tierScale)

    for (let g = 0; g < groves.length; g++) {
      const grove = groves[g]
      const budget = Math.max(8, Math.round(total * grove.share))
      const place = rng.fork(`grove-${g}`)
      const instances: PlacedInstance[] = []
      for (let attempt = 0; attempt < budget * 5 && instances.length < budget; attempt++) {
        const angle = place.range(0, Math.PI * 2)
        const radius = grove.radius * Math.sqrt(place.next())
        const x = grove.x + Math.cos(angle) * radius
        const z = grove.z + Math.sin(angle) * radius
        // Patchiness: stands have clearings, not uniform fill.
        if (fbmCpu(x * 0.03, z * 0.03, 3, 61 + g) < 0.42) continue
        if (z < RIM_Z + 40 || inParkFootprint(x, z, 3)) continue
        const y = terrainHeight(x, z)
        if (y < -33) continue
        const s = place.range(0.7, 1.6)
        instances.push({
          x, y, z,
          rx: 0, ry: place.range(0, Math.PI * 2), rz: 0,
          sx: s, sy: s, sz: s,
          phase: place.range(0, Math.PI * 2),
        })
      }
      this.emitFamily(variants[g % variants.length], material, instances, {
        name: `flora-kelp-grove-${g}`,
        castShadow: false,
        withOrigin: true,
        boundsMargin: 4,
        sectors: false,
      })
    }
  }

  private createKelpMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial()
    material.side = DoubleSide
    material.roughness = 0.58
    const origin = attribute('instanceOrigin', 'vec3') as unknown as Node<'vec3'>
    const instancePhase = attribute('instancePhase', 'float') as unknown as Node<'float'>
    const weight = attribute('animWeight', 'float') as unknown as Node<'float'>
    const phase = attribute('animPhase', 'float') as unknown as Node<'float'>
    const tint = attribute('tint', 'float') as unknown as Node<'float'>
    const time = this.timeUniform

    // Streaming, not arcing: the straps are already authored bowed-over,
    // so the current simply drags the free length further along itself —
    // plus a ripple traveling down each strap. Holdfasts never move.
    const flow = currentFlow(origin, time)
    const flowXZ = flow.xz.add(vec2(0.018, 0.011))
    const flowMag = flowXZ.length()
    const direction = flowXZ.div(flowMag.max(0.001))
    const along = dot(origin.xz, direction)
    const gust = sin(along.mul(0.05).sub(time.mul(0.5)).add(instancePhase))
      .mul(0.5).add(0.5).pow(1.7)
    const drag = flowMag.mul(0.9).add(gust.mul(0.55)).add(0.06)
    const shaped = weight.pow(1.5)
    const ripple = sin(time.mul(2.4).add(phase).add(instancePhase).add(weight.mul(6.5)))
      .mul(weight.mul(weight)).mul(0.14)
    const perp = vec2(direction.y.negate(), direction.x)
    material.positionNode = positionLocalOffset(
      vec3(
        direction.x.mul(drag).mul(shaped).mul(1.5).add(perp.x.mul(ripple)),
        drag.mul(shaped).mul(weight).mul(-0.4).add(ripple.mul(0.5)),
        direction.y.mul(drag).mul(shaped).mul(1.5).add(perp.y.mul(ripple)),
      ),
    )

    // Leathery olive deepening to translucent amber at the ruffled edges;
    // the basal pneumatocysts (tint 0.9) ride the amber ramp — golden.
    const stalkTone = fbm2(origin.xz.mul(0.04)).mul(0.45).add(0.72)
    const strap = smoothstep(0.1, 0.7, tint)
    const amber = smoothstep(0.78, 1.0, tint)
    material.colorNode = mix(vec3(0.06, 0.055, 0.02), vec3(0.32, 0.25, 0.075), strap)
      .add(vec3(0.24, 0.15, 0.03).mul(amber))
      .mul(stalkTone)
    material.roughnessNode = float(0.66).sub(amber.mul(0.18))
    this.medium.applyCaustics(material, 1.1)
    return material
  }

  // ── Seagrass meadow ──────────────────────────────────────────────────

  /**
   * The algae turf (2026-07-22, replacing the retired lawn-grass
   * seagrass): low domed clumps of rockweed, codium fingers, and feather
   * plumes — the coastal-algae look from Scott's references. The meadow
   * mask keeps ruling where turf is DENSE (same field as the sand tint),
   * but distribution is now genuinely clustered: a high-frequency clump
   * field gates acceptance into 15–30 m patches, and every accepted
   * parent sprouts 1–3 children beside it (a Neyman–Scott cluster
   * process — multi-scale patchiness, never uniform sprinkle). A quarter
   * of the budget is planted on the walking verges. Chunked 7×7 per
   * variant; the material collapses clumps beyond ~115 m.
   */
  private buildAlgaeTurf(rng: Rng, density: number): void {
    const kinds: AlgaeKind[] = ['rockweed', 'codium', 'plume']
    const geometries = kinds.map((kind) => createAlgaeTuftGeometry(rng.fork(`tuft-${kind}`), kind))
    const materials = [
      this.createAlgaeMaterial('rockweed'),
      this.createAlgaeMaterial('codium'),
      this.createAlgaeMaterial('plume'),
    ]
    const TARGET = Math.floor(15_000 * density)
    const CHUNK = 7
    const cells: PlacedInstance[][][] = []
    for (let i = 0; i < CHUNK * CHUNK; i++) cells.push([[], [], []])

    let placedTotal = 0
    const push = (x: number, z: number, variant: number, scale: number): void => {
      if (inParkFootprint(x, z, 0.3)) return
      const y = terrainHeight(x, z)
      if (y < -32) return
      const ci =
        Math.min(CHUNK - 1, Math.floor(((x + 420) / 840) * CHUNK)) +
        Math.min(CHUNK - 1, Math.floor(((z + 240) / 660) * CHUNK)) * CHUNK
      if (ci < 0 || ci >= cells.length) return
      cells[ci][variant].push({
        x, y, z,
        rx: 0, ry: rng.range(0, Math.PI * 2), rz: 0,
        sx: scale, sy: scale * rng.range(0.85, 1.2), sz: scale,
        phase: rng.range(0, Math.PI * 2),
      })
      placedTotal++
    }
    // Neyman–Scott: each accepted parent seeds a small family around it.
    const plantClump = (x: number, z: number): void => {
      const roll = rng.next()
      const variant = roll < 0.45 ? 0 : roll < 0.75 ? 1 : 2
      const parentScale = rng.range(0.85, 1.7)
      push(x, z, variant, parentScale)
      const children = rng.int(1, 3)
      for (let c = 0; c < children; c++) {
        const yaw = rng.range(0, Math.PI * 2)
        const reach = rng.range(0.5, 1.9)
        push(
          x + Math.cos(yaw) * reach,
          z + Math.sin(yaw) * reach,
          variant,
          parentScale * rng.range(0.65, 0.95),
        )
      }
    }

    // Verge planting first: turf beds line the promenades.
    const vergeTarget = Math.floor(TARGET * 0.25)
    for (let attempt = 0; attempt < vergeTarget * 3 && placedTotal < vergeTarget; attempt++) {
      const spot = sampleParkVergePoint(rng, 0.15, 6.5)
      if (!spot) continue
      plantClump(spot.x, spot.z)
    }
    // Field scatter: meadow mask × clump noise × park living zone.
    let attempts = 0
    while (placedTotal < TARGET && attempts < TARGET * 9) {
      attempts++
      const x = rng.range(-420, 420)
      const z = rng.range(-240, 420)
      const mask = fbmCpu(x * 0.0045, z * 0.0045, 5, 23)
      const clump = fbmCpu(x * 0.033, z * 0.033, 3, 91)
      const clumpGate = smoothstepJs(0.42, 0.7, clump)
      const nearPark = Math.hypot(x, z - 100) < 310
      let probability: number
      if (mask >= 0.62) {
        const coreness = Math.min(1, (mask - 0.62) / 0.16)
        probability = (0.25 + coreness * 0.75) * (nearPark ? 1 : 0.3)
      } else {
        probability = nearPark ? 0.15 : 0.03
      }
      probability *= 0.12 + 0.88 * clumpGate
      if (rng.next() > probability) continue
      if (inParkFootprint(x, z, 0.5)) continue
      plantClump(x, z)
    }

    for (const cell of cells) {
      for (let variant = 0; variant < 3; variant++) {
        this.emitFamily(geometries[variant], materials[variant], cell[variant], {
          name: `flora-algae-${kinds[variant]}`,
          castShadow: false,
          withOrigin: true,
          boundsMargin: 1.1,
          sectors: false,
        })
      }
    }
  }

  private createAlgaeMaterial(kind: AlgaeKind): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial()
    material.roughness = kind === 'codium' ? 0.85 : 0.62
    if (kind !== 'codium') material.side = DoubleSide
    const origin = attribute('instanceOrigin', 'vec3') as unknown as Node<'vec3'>
    const instancePhase = attribute('instancePhase', 'float') as unknown as Node<'float'>
    const weight = attribute('animWeight', 'float') as unknown as Node<'float'>
    const phase = attribute('animPhase', 'float') as unknown as Node<'float'>
    const tint = attribute('tint', 'float') as unknown as Node<'float'>
    const time = this.timeUniform

    // Leathery rock, not grass whip: a gentle gust-front lean plus a tiny
    // per-frond flutter; roots pinned; clumps collapse beyond ~115 m.
    const gustDirection = vec2(0.83, 0.558)
    const along = dot(origin.xz, gustDirection)
    const gust = sin(along.mul(0.085).sub(time.mul(0.62)).add(instancePhase.mul(0.35)))
      .mul(0.5).add(0.5).pow(1.7)
    const flow = currentFlow(origin, time)
    const lean = float(0.03).add(gust.mul(0.1)).add(flow.xz.length().mul(0.1))
    const shaped = weight.pow(1.6)
    const flutter = sin(time.mul(3.1).add(phase.mul(3.3)).add(instancePhase))
      .mul(weight.mul(weight)).mul(0.016)
    const sway = vec3(
      gustDirection.x.mul(lean).mul(shaped).add(flow.x.mul(shaped).mul(0.3)).add(flutter),
      lean.mul(shaped).mul(-0.2),
      gustDirection.y.mul(lean).mul(shaped).add(flow.z.mul(shaped).mul(0.3)).add(flutter.mul(-0.7)),
    )
    const fade = this.lodFade(origin, 115)
    const relative = (positionLocal as unknown as Node<'vec3'>).sub(origin)
    material.positionNode = origin.add(relative.add(sway).mul(fade))

    const patch = fbm2(origin.xz.mul(0.05)).mul(0.45).add(0.75)
    if (kind === 'rockweed') {
      // Olive-brown to golden, translucent amber on the serrated edges.
      material.colorNode = mix(vec3(0.14, 0.11, 0.04), vec3(0.52, 0.4, 0.12), tint)
        .add(vec3(0.2, 0.13, 0.03).mul(smoothstep(0.85, 1.0, tint)))
        .mul(patch)
    } else if (kind === 'codium') {
      // Deep velvet green, tips brightening.
      material.colorNode = mix(vec3(0.035, 0.1, 0.045), vec3(0.14, 0.34, 0.12), tint).mul(patch)
    } else {
      // Feather plumes split rose ↔ violet per clump.
      const pick = smoothstep(0.46, 0.54, fract(instancePhase.mul(0.618)))
      const rose = mix(vec3(0.4, 0.12, 0.16), vec3(0.78, 0.38, 0.4), tint)
      const violet = mix(vec3(0.22, 0.11, 0.36), vec3(0.56, 0.4, 0.72), tint)
      material.colorNode = mix(rose, violet, pick).mul(patch)
    }
    this.medium.applyCaustics(material, 1.2)
    return material
  }

  // ── The reef: colony patches ─────────────────────────────────────────

  /**
   * Corals, rocks, sponges, fans, anemones, urchins, and starfish placed
   * as COLONIES: every patch gets framework boulders first, coral heads in
   * sibling micro-clusters, sponges on the flanks, fans aligned across the
   * patch's current line on the periphery, and anemones/urchins snugged
   * against placed rocks. Loners dust the sand between patches.
   */
  private buildReef(rng: Rng, patches: readonly ReefPatch[], tierScale: number): void {
    const brain = createBrainCoralGeometry(rng.fork('brain'))
    const staghorn = createStaghornColonyGeometry(rng.fork('staghorn'))
    const table = createTableCoralGeometry(rng.fork('table'))
    const boulders = [createBoulderGeometry(rng.fork('boulder-a')), createBoulderGeometry(rng.fork('boulder-b'))]
    const pinnacle = createPinnacleGeometry(rng.fork('pinnacle'))
    const tubeSponge = createTubeSpongeGeometry(rng.fork('tube-sponge'))
    const barrelSponge = createBarrelSpongeGeometry(rng.fork('barrel-sponge'))
    const fans = [createSeaFanGeometry(rng.fork('fan-a')), createSeaFanGeometry(rng.fork('fan-b'))]
    const anemone = createAnemoneGeometry(rng.fork('anemone'))
    const urchin = createUrchinGeometry(rng.fork('urchin'))
    const starfish = createStarfishGeometry(rng.fork('starfish'))

    const lists = {
      brain: [] as PlacedInstance[],
      staghorn: [] as PlacedInstance[],
      table: [] as PlacedInstance[],
      boulderA: [] as PlacedInstance[],
      boulderB: [] as PlacedInstance[],
      pinnacle: [] as PlacedInstance[],
      tubeSponge: [] as PlacedInstance[],
      barrelSponge: [] as PlacedInstance[],
      fanA: [] as PlacedInstance[],
      fanB: [] as PlacedInstance[],
      anemone: [] as PlacedInstance[],
      urchin: [] as PlacedInstance[],
      starfish: [] as PlacedInstance[],
    }

    const accepts = (x: number, z: number, margin: number): boolean => {
      if (z < RIM_Z + 18 || inParkFootprint(x, z, margin)) return false
      const ground = terrainHeight(x, z)
      return ground >= -33 && ground <= -17
    }
    const seat = (
      list: PlacedInstance[],
      x: number,
      z: number,
      s: number,
      sink: number,
      place: Rng,
      tiltRange = 0.16,
      yaw?: number,
      squash = false,
      margin = 2.2,
    ): PlacedInstance | null => {
      if (!accepts(x, z, margin)) return null
      const instance: PlacedInstance = {
        x,
        y: terrainHeight(x, z) - sink * s,
        z,
        rx: place.range(-tiltRange, tiltRange),
        ry: yaw ?? place.range(0, Math.PI * 2),
        rz: place.range(-tiltRange, tiltRange),
        sx: s * place.range(0.82, 1.2),
        sy: s * (squash ? place.range(0.55, 0.85) : place.range(0.85, 1.15)),
        sz: s * place.range(0.82, 1.2),
        phase: place.range(0, Math.PI * 2),
      }
      list.push(instance)
      return instance
    }

    for (let p = 0; p < patches.length; p++) {
      const patch = patches[p]
      const place = rng.fork(`patch-${p}`)
      const scaleAt = (radiusFraction: number, base: number): number =>
        base * (1.28 - 0.5 * radiusFraction) * place.range(0.8, 1.2)
      const spot = (fraction: [number, number]): [number, number, number] => {
        const angle = place.range(0, Math.PI * 2)
        const rf = Math.sqrt(place.range(fraction[0] * fraction[0], fraction[1] * fraction[1]))
        return [patch.x + Math.cos(angle) * rf * patch.radius, patch.z + Math.sin(angle) * rf * patch.radius, rf]
      }
      const count = (base: number): number =>
        Math.round(base * 1.8 * patch.richness * tierScale + place.next() * 0.6)

      // Framework boulders anchor the colony; remember them for snugging.
      const rocks: PlacedInstance[] = []
      for (let i = 0; i < count(4.5); i++) {
        const [x, z, rf] = spot([0, 0.85])
        const placedRock = seat(
          place.next() < 0.5 ? lists.boulderA : lists.boulderB,
          x, z, scaleAt(rf, place.range(0.8, 2.1)), 0.28, place, 0.3, undefined, true,
        )
        if (placedRock) rocks.push(placedRock)
      }
      // Brain corals grow in sibling groups of two or three.
      for (let i = 0; i < count(3); i++) {
        const [x, z, rf] = spot([0, 0.8])
        const s = scaleAt(rf, place.range(0.45, 1.05))
        if (!seat(lists.brain, x, z, s, 0.12, place)) continue
        const siblings = place.next() < 0.6 ? place.int(1, 2) : 0
        for (let sibling = 0; sibling < siblings; sibling++) {
          const yaw = place.range(0, Math.PI * 2)
          const gap = s * place.range(1.6, 2.6)
          seat(lists.brain, x + Math.cos(yaw) * gap, z + Math.sin(yaw) * gap, s * place.range(0.5, 0.85), 0.12, place)
        }
      }
      for (let i = 0; i < count(2.6); i++) {
        const [x, z, rf] = spot([0.1, 0.9])
        seat(lists.staghorn, x, z, scaleAt(rf, place.range(0.75, 1.5)), 0.05, place, 0.1)
      }
      if (patch.radius > 17) {
        for (let i = 0; i < count(1.8); i++) {
          const [x, z, rf] = spot([0.25, 0.95])
          seat(lists.table, x, z, scaleAt(rf, place.range(0.9, 1.9)), 0.04, place, 0.09)
        }
      }
      for (let i = 0; i < count(1.7); i++) {
        const [x, z, rf] = spot([0.45, 1.0])
        seat(lists.tubeSponge, x, z, scaleAt(rf, place.range(0.6, 1.15)), 0.05, place, 0.12)
      }
      for (let i = 0; i < count(1); i++) {
        const [x, z, rf] = spot([0.35, 0.95])
        seat(lists.barrelSponge, x, z, scaleAt(rf, place.range(0.55, 1.35)), 0.06, place, 0.1)
      }
      // Gorgonian fans on the periphery, aligned across the patch current.
      for (let i = 0; i < count(2.4); i++) {
        const [x, z] = spot([0.72, 1.05])
        seat(
          place.next() < 0.5 ? lists.fanA : lists.fanB,
          x, z, place.range(0.8, 1.5), 0.02, place, 0.08,
          patch.tangentYaw + place.range(-0.35, 0.35),
        )
      }
      // Anemones and urchins snug against the placed framework rocks.
      // Urchins LIFT (negative sink): their round test stands proud of the
      // sand on its lower spines instead of nesting half-buried.
      for (let i = 0; i < count(3.2); i++) {
        if (rocks.length === 0) break
        const rock = rocks[place.int(0, rocks.length - 1)]
        const yaw = place.range(0, Math.PI * 2)
        const reach = rock.sx * place.range(1.1, 1.9)
        const isAnemone = i % 2 === 0
        seat(isAnemone ? lists.anemone : lists.urchin,
          rock.x + Math.cos(yaw) * reach, rock.z + Math.sin(yaw) * reach,
          place.range(isAnemone ? 0.7 : 0.16, isAnemone ? 1.25 : 0.3),
          isAnemone ? 0.02 : -0.6, place, 0.1)
      }
      for (let i = 0; i < count(1.4); i++) {
        const [x, z] = spot([0.2, 1.0])
        seat(lists.starfish, x, z, place.range(0.28, 0.6), 0.01, place, 0.06)
      }
    }

    // The park verges: coral garden beds LINING the promenades and plaza
    // rims — this is what a strolling guest actually stands next to.
    // Small-scale pieces (planted-border sizes), snug margins, clustered
    // in twos and threes so beds read as beds.
    const verge = rng.fork('verge-gardens')
    const vergePieces = Math.round(340 * tierScale)
    for (let i = 0; i < vergePieces; i++) {
      const spot = sampleParkVergePoint(verge, 0.35, 5.5)
      if (!spot) continue
      const roll = verge.next()
      const cluster = (
        list: PlacedInstance[],
        scale: [number, number],
        sink: number,
        siblings: number,
        squash = false,
      ): void => {
        const s = verge.range(scale[0], scale[1])
        if (!seat(list, spot.x, spot.z, s, sink, verge, 0.12, undefined, squash, 0.05)) return
        for (let sibling = 0; sibling < siblings; sibling++) {
          const yaw = verge.range(0, Math.PI * 2)
          const gap = s * verge.range(1.5, 2.6) + 0.3
          seat(
            list,
            spot.x + Math.cos(yaw) * gap,
            spot.z + Math.sin(yaw) * gap,
            s * verge.range(0.55, 0.9),
            sink,
            verge,
            0.12,
            undefined,
            squash,
            0.05,
          )
        }
      }
      if (roll < 0.16) cluster(lists.brain, [0.24, 0.52], 0.12, verge.int(1, 2))
      else if (roll < 0.32) cluster(lists.staghorn, [0.35, 0.7], 0.05, verge.int(0, 1))
      else if (roll < 0.44) {
        seat(
          verge.next() < 0.5 ? lists.fanA : lists.fanB,
          spot.x, spot.z, verge.range(0.55, 0.95), 0.02, verge, 0.08,
          verge.range(0, Math.PI * 2), false, 0.05,
        )
      } else if (roll < 0.62) cluster(lists.anemone, [0.6, 1.1], 0.02, verge.int(0, 2))
      else if (roll < 0.74) cluster(lists.urchin, [0.13, 0.24], -0.6, verge.int(0, 2))
      else if (roll < 0.88) cluster(lists.starfish, [0.22, 0.46], 0.01, verge.int(0, 1))
      else cluster(lists.tubeSponge, [0.4, 0.7], 0.05, 0)
    }

    // Loners between the colonies — the thin scatter that ties patches
    // into one continuous seabed instead of isolated dioramas.
    const loners = rng.fork('loners')
    const lonerPlan: { list: PlacedInstance[]; count: number; scale: [number, number]; sink: number; squash?: boolean }[] = [
      { list: lists.boulderA, count: 120, scale: [0.5, 1.7], sink: 0.28, squash: true },
      { list: lists.boulderB, count: 120, scale: [0.4, 2.3], sink: 0.28, squash: true },
      { list: lists.brain, count: 70, scale: [0.35, 0.8], sink: 0.12 },
      { list: lists.staghorn, count: 50, scale: [0.7, 1.2], sink: 0.05 },
      { list: lists.tubeSponge, count: 42, scale: [0.55, 1.0], sink: 0.05 },
      { list: lists.starfish, count: 90, scale: [0.24, 0.55], sink: 0.01 },
      { list: lists.urchin, count: 50, scale: [0.14, 0.3], sink: -0.6 },
      { list: lists.anemone, count: 44, scale: [0.7, 1.2], sink: 0.02 },
    ]
    for (const plan of lonerPlan) {
      for (let i = 0; i < Math.round(plan.count * tierScale); i++) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const angle = loners.range(0, Math.PI * 2)
          // Two thirds of the loner budget stays inside the guest's
          // 300 m living zone; the rest dusts the far sand.
          const distance =
            i % 3 === 2 ? loners.range(260, 520) : loners.range(60, 300)
          const x = Math.cos(angle) * distance
          const z = Math.sin(angle) * distance * 0.92
          if (!accepts(x, z, 2.5)) continue
          seat(plan.list, x, z, loners.range(plan.scale[0], plan.scale[1]), plan.sink, loners, 0.2, undefined, plan.squash)
          break
        }
      }
    }
    // Landmark pinnacles in the far southern/east/west bands only (well
    // clear of the Torrent's northern circuit and the Pearl Line).
    const spires = rng.fork('pinnacles')
    for (let i = 0; i < 8; i++) {
      for (let attempt = 0; attempt < 24; attempt++) {
        const angle = spires.range(0, Math.PI * 2)
        const distance = spires.range(300, 520)
        const x = Math.cos(angle) * distance
        const z = Math.sin(angle) * distance
        if (z < -60) continue
        if (!accepts(x, z, 12)) continue
        let spaced = true
        for (const other of lists.pinnacle) {
          if (Math.hypot(x - other.x, z - other.z) < 60) spaced = false
        }
        if (!spaced) continue
        seat(lists.pinnacle, x, z, spires.range(0.9, 1.6), 0.1, spires, 0.05)
        break
      }
    }

    // Materials: one simple recipe each, colors riding the baked tint
    // fields so light/dark always follows the carved cause.
    const patchField = fbm2(positionWorld.xz.mul(0.14)).mul(0.36).add(0.82)
    const tint = attribute('tint', 'float') as unknown as Node<'float'>

    const brainMaterial = new MeshStandardNodeMaterial()
    brainMaterial.roughness = 0.82
    brainMaterial.colorNode = mix(vec3(0.3, 0.16, 0.15), vec3(0.72, 0.5, 0.4), tint).mul(patchField)
    brainMaterial.roughnessNode = float(0.9).sub(tint.mul(0.18))
    this.medium.applyCaustics(brainMaterial, 1.3)

    const staghornMaterial = new MeshStandardNodeMaterial()
    staghornMaterial.roughness = 0.7
    staghornMaterial.colorNode = mix(vec3(0.62, 0.26, 0.16), vec3(0.95, 0.78, 0.62), smoothstep(0.35, 1.0, tint))
      .mul(patchField)
    this.medium.applyCaustics(staghornMaterial, 1.3)

    const tableMaterial = new MeshStandardNodeMaterial()
    tableMaterial.roughness = 0.76
    tableMaterial.colorNode = mix(vec3(0.42, 0.32, 0.26), mix(vec3(0.55, 0.42, 0.58), vec3(0.88, 0.78, 0.86), tint), smoothstep(0.06, 0.3, tint))
      .mul(patchField)
    this.medium.applyCaustics(tableMaterial, 1.3)

    const rockMaterial = new MeshStandardNodeMaterial()
    rockMaterial.roughness = 0.95
    // Strata banding from the baked field + an algae film on upward FACES
    // (geometry normal — instances only tilt a little, so it stays honest).
    const rockBase = mix(vec3(0.3, 0.32, 0.28), vec3(0.52, 0.48, 0.4), tint)
    const upness = smoothstep(0.35, 0.8, normalGeometry.y)
    rockMaterial.colorNode = mix(rockBase, vec3(0.24, 0.34, 0.2), upness.mul(fbm2(positionWorld.xz.mul(0.6)).mul(0.7)))
      .mul(patchField)
    this.medium.applyCaustics(rockMaterial, 1.15)

    const spongeMaterial = new MeshStandardNodeMaterial()
    spongeMaterial.roughness = 0.92
    spongeMaterial.colorNode = mix(vec3(0.2, 0.16, 0.34), vec3(0.52, 0.44, 0.72), tint).mul(patchField)
    this.medium.applyCaustics(spongeMaterial, 1.25)

    const barrelMaterial = new MeshStandardNodeMaterial()
    barrelMaterial.roughness = 0.94
    barrelMaterial.colorNode = mix(vec3(0.3, 0.14, 0.07), vec3(0.68, 0.42, 0.2), tint).mul(patchField)
    this.medium.applyCaustics(barrelMaterial, 1.25)

    this.emitFamily(brain, brainMaterial, lists.brain, { name: 'flora-brain-coral', castShadow: true, withOrigin: false, boundsMargin: 0, sectors: true })
    this.emitFamily(staghorn, staghornMaterial, lists.staghorn, { name: 'flora-staghorn', castShadow: true, withOrigin: false, boundsMargin: 0, sectors: true })
    this.emitFamily(table, tableMaterial, lists.table, { name: 'flora-table-coral', castShadow: true, withOrigin: false, boundsMargin: 0, sectors: true })
    this.emitFamily(boulders[0], rockMaterial, lists.boulderA, { name: 'flora-boulders', castShadow: true, withOrigin: false, boundsMargin: 0, sectors: true })
    this.emitFamily(boulders[1], rockMaterial, lists.boulderB, { name: 'flora-boulders', castShadow: true, withOrigin: false, boundsMargin: 0, sectors: true })
    this.emitFamily(pinnacle, rockMaterial, lists.pinnacle, { name: 'flora-pinnacles', castShadow: true, withOrigin: false, boundsMargin: 0, sectors: false })
    this.emitFamily(tubeSponge, spongeMaterial, lists.tubeSponge, { name: 'flora-tube-sponges', castShadow: true, withOrigin: false, boundsMargin: 0, sectors: true })
    this.emitFamily(barrelSponge, barrelMaterial, lists.barrelSponge, { name: 'flora-barrel-sponges', castShadow: true, withOrigin: false, boundsMargin: 0, sectors: true })

    // Swaying species (never shadow casters — cached clipmaps would freeze
    // the pose): fans, anemones; plus the small dressers.
    const fanMaterialA = this.createFanMaterial(new Color(0x8e3444), new Color(0xe8c8c2))
    const fanMaterialB = this.createFanMaterial(new Color(0xa8742a), new Color(0xf2e2b8))
    this.emitFamily(fans[0], fanMaterialA, lists.fanA, { name: 'flora-sea-fans', castShadow: false, withOrigin: true, boundsMargin: 1.2, sectors: true })
    this.emitFamily(fans[1], fanMaterialB, lists.fanB, { name: 'flora-sea-fans', castShadow: false, withOrigin: true, boundsMargin: 1.2, sectors: true })

    const anemoneMaterial = this.createAnemoneMaterial()
    this.emitFamily(anemone, anemoneMaterial, lists.anemone, { name: 'flora-anemones', castShadow: false, withOrigin: true, boundsMargin: 0.8, sectors: true })

    const urchinMaterial = new MeshStandardNodeMaterial()
    urchinMaterial.roughness = 0.6
    const urchinWeight = attribute('animWeight', 'float') as unknown as Node<'float'>
    const urchinPhase = attribute('animPhase', 'float') as unknown as Node<'float'>
    const urchinOrigin = attribute('instanceOrigin', 'vec3') as unknown as Node<'vec3'>
    urchinMaterial.colorNode = mix(vec3(0.075, 0.04, 0.1), vec3(0.32, 0.14, 0.36), tint.mul(urchinWeight.mul(0.5).add(0.5)))
    // Spine tips wave almost imperceptibly — alive, not animated-looking.
    const spineSway = urchinWeight.sub(0.25).clamp(0, 1)
    const urchinWave = vec3(
      sin(this.timeUniform.mul(0.7).add(urchinPhase)).mul(spineSway).mul(0.016),
      0,
      cos(this.timeUniform.mul(0.62).add(urchinPhase.mul(1.3))).mul(spineSway).mul(0.016),
    )
    const urchinFade = this.lodFade(urchinOrigin, 100)
    const urchinRelative = (positionLocal as unknown as Node<'vec3'>).sub(urchinOrigin)
    urchinMaterial.positionNode = urchinOrigin.add(urchinRelative.add(urchinWave).mul(urchinFade))
    this.medium.applyCaustics(urchinMaterial, 1.1)
    this.emitFamily(urchin, urchinMaterial, lists.urchin, { name: 'flora-urchins', castShadow: false, withOrigin: true, boundsMargin: 0.2, sectors: true })

    const starfishMaterial = new MeshStandardNodeMaterial()
    starfishMaterial.roughness = 0.85
    const starPick = attribute('instancePhase', 'float') as unknown as Node<'float'>
    const starOrigin = attribute('instanceOrigin', 'vec3') as unknown as Node<'vec3'>
    const starKnob = smoothstep(0.52, 0.78, tint)
    const terracotta = mix(vec3(0.6, 0.22, 0.1), vec3(0.9, 0.72, 0.5), starKnob)
    const slate = mix(vec3(0.16, 0.22, 0.42), vec3(0.6, 0.66, 0.78), starKnob)
    starfishMaterial.colorNode = mix(terracotta, slate, smoothstep(0.48, 0.52, fract(starPick.mul(0.618))))
    const starFade = this.lodFade(starOrigin, 95)
    starfishMaterial.positionNode = starOrigin.add(
      (positionLocal as unknown as Node<'vec3'>).sub(starOrigin).mul(starFade),
    )
    this.medium.applyCaustics(starfishMaterial, 1.2)
    this.emitFamily(starfish, starfishMaterial, lists.starfish, { name: 'flora-starfish', castShadow: false, withOrigin: true, boundsMargin: 0.1, sectors: true })
  }

  private createFanMaterial(base: Color, tips: Color): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial()
    material.roughness = 0.74
    const origin = attribute('instanceOrigin', 'vec3') as unknown as Node<'vec3'>
    const instancePhase = attribute('instancePhase', 'float') as unknown as Node<'float'>
    const weight = attribute('animWeight', 'float') as unknown as Node<'float'>
    const tint = attribute('tint', 'float') as unknown as Node<'float'>
    const time = this.timeUniform
    const flow = currentFlow(origin, time)
    const tremor = sin(time.mul(2.3).add(instancePhase).add(weight.mul(3)))
    // Compliant rock: the lattice leans with the current and shivers at the
    // tips; the root never moves (weight is 0 there). Collapses at 150 m.
    const sway = vec3(
      flow.x.mul(weight.mul(weight)).mul(0.34).add(tremor.mul(weight.mul(weight)).mul(0.02)),
      flow.y.mul(weight.mul(weight)).mul(0.08),
      flow.z.mul(weight.mul(weight)).mul(0.34).add(tremor.mul(weight.mul(weight)).mul(0.014)),
    )
    const fade = this.lodFade(origin, 150)
    const relative = (positionLocal as unknown as Node<'vec3'>).sub(origin)
    material.positionNode = origin.add(relative.add(sway).mul(fade))
    const polyps = smoothstep(0.55, 1.0, tint)
    material.colorNode = mix(
      vec3(base.r, base.g, base.b),
      vec3(tips.r, tips.g, tips.b),
      polyps,
    ).mul(fbm2(positionWorld.xz.mul(0.14)).mul(0.3).add(0.85))
    material.roughnessNode = float(0.78).sub(polyps.mul(0.12))
    this.medium.applyCaustics(material, 1.2)
    return material
  }

  private createAnemoneMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial()
    material.roughness = 0.5
    const origin = attribute('instanceOrigin', 'vec3') as unknown as Node<'vec3'>
    const instancePhase = attribute('instancePhase', 'float') as unknown as Node<'float'>
    const weight = attribute('animWeight', 'float') as unknown as Node<'float'>
    const phase = attribute('animPhase', 'float') as unknown as Node<'float'>
    const tint = attribute('tint', 'float') as unknown as Node<'float'>
    const time = this.timeUniform
    // Every tentacle waves on its own phase; the crown breathes with the
    // current. Column (weight 0) is rooted.
    const flow = currentFlow(origin, time)
    const waveA = sin(time.mul(1.15).add(phase).add(instancePhase))
    const waveB = sin(time.mul(0.9).add(phase.mul(1.3)).add(instancePhase.mul(0.7)))
    const waveC = cos(time.mul(1.05).add(phase.mul(0.7)))
    const tipness = weight.mul(weight)
    const sway = vec3(
      waveA.mul(tipness).mul(0.045).add(flow.x.mul(weight).mul(0.09)),
      waveB.mul(tipness).mul(0.03),
      waveC.mul(tipness).mul(0.045).add(flow.z.mul(weight).mul(0.09)),
    )
    const fade = this.lodFade(origin, 110)
    const relative = (positionLocal as unknown as Node<'vec3'>).sub(origin)
    material.positionNode = origin.add(relative.add(sway).mul(fade))
    // Two palettes picked per instance: rose/cream and jade/seafoam.
    const pick = smoothstep(0.48, 0.52, fract(instancePhase.mul(0.618).add(0.31)))
    const columnRose = vec3(0.42, 0.16, 0.22)
    const columnJade = vec3(0.1, 0.3, 0.24)
    const tentacleRose = mix(vec3(0.74, 0.6, 0.46), vec3(0.94, 0.88, 0.78), smoothstep(0.6, 1, tint))
    const tentacleJade = mix(vec3(0.24, 0.56, 0.44), vec3(0.66, 0.92, 0.78), smoothstep(0.6, 1, tint))
    const isTentacle = smoothstep(0.35, 0.6, tint)
    material.colorNode = mix(
      mix(columnRose, columnJade, pick),
      mix(tentacleRose, tentacleJade, pick),
      isTentacle,
    )
    // The faintest tip glow — alive tissue, kept far below bloom threshold.
    material.emissiveNode = mix(vec3(0.014, 0.006, 0.004), vec3(0.004, 0.014, 0.009), pick)
      .mul(smoothstep(0.86, 1.0, tint))
    this.medium.applyCaustics(material, 1.0)
    return material
  }

  // ── Shells & garden stones ───────────────────────────────────────────

  private buildShellsAndStones(rng: Rng): void {
    const clamFan = createClamShellGeometry()
    const turban = createTurbanShellGeometry()
    const pebbleA = new IcosahedronGeometry(1, 1)
    const pebbleB = new IcosahedronGeometry(1, 1)
    displacePebble(pebbleA, 0.2, 1.9, rng.fork('pebble-a'))
    displacePebble(pebbleB, 0.27, 2.4, rng.fork('pebble-b'))

    const tint = attribute('tint', 'float') as unknown as Node<'float'>
    const shellOrigin = attribute('instanceOrigin', 'vec3') as unknown as Node<'vec3'>
    const shellMaterial = new MeshStandardNodeMaterial()
    shellMaterial.roughness = 0.46
    shellMaterial.metalness = 0.05
    shellMaterial.side = DoubleSide
    shellMaterial.colorNode = mix(vec3(0.45, 0.26, 0.16), vec3(0.85, 0.76, 0.6), tint)
    shellMaterial.positionNode = shellOrigin.add(
      (positionLocal as unknown as Node<'vec3'>).sub(shellOrigin).mul(this.lodFade(shellOrigin, 85)),
    )
    this.medium.applyCaustics(shellMaterial, 1.35)
    const stoneMaterial = new MeshStandardNodeMaterial()
    stoneMaterial.color = new Color(0x6b7268)
    stoneMaterial.roughness = 0.96
    stoneMaterial.positionNode = shellOrigin.add(
      (positionLocal as unknown as Node<'vec3'>).sub(shellOrigin).mul(this.lodFade(shellOrigin, 72)),
    )
    this.medium.applyCaustics(stoneMaterial, 1.1)

    const families = [
      { geometry: clamFan, material: shellMaterial, count: 340, min: 0.18, max: 0.48, y: 0.02, shell: true, name: 'flora-shells' },
      { geometry: turban, material: shellMaterial, count: 250, min: 0.3, max: 0.7, y: 0.01, shell: true, name: 'flora-shells' },
      { geometry: pebbleA, material: stoneMaterial, count: 560, min: 0.12, max: 0.52, y: 0.05, shell: false, name: 'flora-garden-stones' },
      { geometry: pebbleB, material: stoneMaterial, count: 420, min: 0.2, max: 0.8, y: 0.06, shell: false, name: 'flora-garden-stones' },
    ] as const

    for (let familyIndex = 0; familyIndex < families.length; familyIndex++) {
      const family = families[familyIndex]
      const place = rng.fork(`family-${familyIndex}`)
      const instances: PlacedInstance[] = []
      let lastX = 0
      let lastZ = 0
      for (let i = 0; i < family.count; i++) {
        let x = 0
        let z = 0
        let accepted = false
        for (let attempt = 0; attempt < 10; attempt++) {
          // A third of the litter lands on the walking verges (where it
          // gets SEEN); shells also drift into loose tide-sorted rows.
          if (place.next() < 0.34) {
            const spot = sampleParkVergePoint(place, 0.2, 6)
            if (!spot) continue
            x = spot.x
            z = spot.z
            accepted = true
            break
          }
          if (family.shell && instances.length > 0 && place.next() < 0.4) {
            x = lastX + place.range(-1.4, 1.4)
            z = lastZ + place.range(-1.4, 1.4)
          } else {
            x = place.range(-360, 360)
            z = place.range(-205, 390)
          }
          if (z > RIM_Z + 22 && !inParkFootprint(x, z, family.shell ? 0.7 : 1.5)) {
            accepted = true
            break
          }
        }
        if (!accepted) continue
        lastX = x
        lastZ = z
        const size = place.range(family.min, family.max)
        instances.push({
          x, y: terrainHeight(x, z) + family.y * size, z,
          rx: family.shell ? place.range(-0.2, 0.2) : place.range(-0.45, 0.45),
          ry: place.range(0, Math.PI * 2),
          rz: family.shell ? place.range(-0.18, 0.18) : place.range(-0.45, 0.45),
          sx: size * place.range(0.78, 1.3),
          sy: size * (family.shell ? place.range(0.8, 1.1) : place.range(0.45, 0.82)),
          sz: size * place.range(0.78, 1.25),
          phase: place.range(0, Math.PI * 2),
        })
      }
      this.emitFamily(family.geometry, family.material as MeshStandardNodeMaterial, instances, {
        name: family.name,
        castShadow: false,
        withOrigin: true,
        boundsMargin: 0,
        sectors: true,
      })
    }
  }

  // ── Sea treasures: giant clams and sunken amphorae ───────────────────

  private buildSeaTreasures(rng: Rng): void {
    const CLAMS = 8
    const shellGeometry = createGiantClamGeometry(rng.fork('clam-shape'))
    const shellMaterial = new MeshStandardNodeMaterial()
    shellMaterial.side = DoubleSide
    shellMaterial.roughness = 0.62
    const shellTone = fbm2(positionWorld.xz.mul(2.2))
    shellMaterial.colorNode = mix(vec3(0.78, 0.72, 0.6), vec3(0.9, 0.87, 0.78), shellTone)
    this.medium.applyCaustics(shellMaterial, 1.3)

    const mantleGeometry = new TorusGeometry(0.78, 0.15, 9, 42)
    mantleGeometry.scale(1, 1, 0.38)
    mantleGeometry.rotateX(Math.PI / 2 - 0.16)
    mantleGeometry.translate(0, 0.1, 0)
    const mantleMaterial = new MeshStandardNodeMaterial()
    mantleMaterial.roughness = 0.35
    const mantleField = fbm2(positionWorld.xz.mul(7.0).add(positionWorld.y.mul(5.0)))
    mantleMaterial.colorNode = mix(vec3(0.05, 0.2, 0.24), vec3(0.16, 0.42, 0.4), mantleField)
    const spots = smoothstep(float(0.72), float(0.82), mantleField)
    const pulse = sin(this.timeUniform.mul(0.9).add(positionWorld.x.mul(0.7)).add(positionWorld.z))
      .mul(0.5)
      .add(0.5)
    mantleMaterial.emissiveNode = vec3(0.05, 0.5, 0.55).mul(spots).mul(pulse.mul(0.7).add(0.3))
    this.medium.applyCaustics(mantleMaterial, 0.8)

    const pearlGeometry = new SphereGeometry(0.24, 18, 14)
    pearlGeometry.translate(0, 0.2, 0.12)
    const pearlMaterial = new MeshStandardNodeMaterial()
    pearlMaterial.roughness = 0.18
    pearlMaterial.metalness = 0.15
    pearlMaterial.color = new Color(0xf0e8e4)
    pearlMaterial.emissiveNode = vec3(0.045, 0.04, 0.035)
    this.medium.applyCaustics(pearlMaterial, 0.9)

    const shells = new InstancedMesh(shellGeometry, shellMaterial, CLAMS)
    const mantles = new InstancedMesh(mantleGeometry, mantleMaterial, CLAMS)
    const pearls = new InstancedMesh(pearlGeometry, pearlMaterial, CLAMS)
    const matrix = new Matrix4()
    const quaternion = new Quaternion()
    const euler = new Euler()
    const clamRng = rng.fork('clams')
    let placedClams = 0
    for (let attempt = 0; attempt < 120 && placedClams < CLAMS; attempt++) {
      const angle = clamRng.range(0, Math.PI * 2)
      const radius = clamRng.range(60, 260)
      const x = Math.cos(angle) * radius
      const z = Math.sin(angle) * radius * 0.9
      if (z < RIM_Z + 25 || inParkFootprint(x, z, 1.6)) continue
      const y = terrainHeight(x, z)
      const s = clamRng.range(0.55, 1.05)
      quaternion.setFromEuler(euler.set(
        clamRng.range(-0.12, 0.12),
        clamRng.range(0, Math.PI * 2),
        clamRng.range(-0.12, 0.12),
      ))
      matrix.compose(new Vector3(x, y + 0.08 * s, z), quaternion, new Vector3(s, s, s))
      shells.setMatrixAt(placedClams, matrix)
      mantles.setMatrixAt(placedClams, matrix)
      pearls.setMatrixAt(placedClams, matrix)
      placedClams++
    }
    for (const mesh of [shells, mantles, pearls]) {
      mesh.count = placedClams
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = mesh === shells
      mesh.receiveShadow = true
      this.group.add(mesh)
    }
    shells.name = 'flora-clam-shells'
    mantles.name = 'flora-clam-mantles'
    pearls.name = 'flora-clam-pearls'

    // Amphorae: slip bands now ride the baked tint channel (they survive
    // toppled instances by construction), barnacle crust from a world fbm.
    const amphora = createAmphoraGeometry(rng.fork('amphora-shape'))
    const clay = new MeshStandardNodeMaterial()
    clay.roughness = 0.88
    const slip = attribute('tint', 'float') as unknown as Node<'float'>
    const crust = smoothstep(
      float(0.62),
      float(0.8),
      fbm2(positionWorld.xz.mul(3.4).add(positionWorld.y.mul(2.2))),
    )
    clay.colorNode = mix(
      mix(vec3(0.44, 0.24, 0.14), vec3(0.52, 0.31, 0.18), slip),
      vec3(0.74, 0.72, 0.64),
      crust.mul(0.75),
    )
    clay.roughnessNode = float(0.82).add(crust.mul(0.14))
    this.medium.applyCaustics(clay, 1.2)
    const AMPHORAE = 18
    const jars = new InstancedMesh(amphora, clay, AMPHORAE)
    const jarRng = rng.fork('amphorae')
    let placedJars = 0
    const clusters: [number, number][] = []
    for (let c = 0; c < 2 && clusters.length < 2; c++) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const angle = jarRng.range(0, Math.PI * 2)
        const radius = jarRng.range(90, 300)
        const cx = Math.cos(angle) * radius
        const cz = Math.sin(angle) * radius * 0.88
        if (cz > RIM_Z + 30 && !inParkFootprint(cx, cz, 6)) {
          clusters.push([cx, cz])
          break
        }
      }
    }
    for (let attempt = 0; attempt < 200 && placedJars < AMPHORAE; attempt++) {
      let x: number
      let z: number
      if (placedJars < 12 && clusters.length > 0) {
        const [cx, cz] = clusters[placedJars % clusters.length]
        x = cx + jarRng.range(-4.5, 4.5)
        z = cz + jarRng.range(-4.5, 4.5)
      } else {
        x = jarRng.range(-340, 340)
        z = jarRng.range(-190, 380)
      }
      if (z < RIM_Z + 24 || inParkFootprint(x, z, 1.2)) continue
      const y = terrainHeight(x, z)
      const s = jarRng.range(0.7, 1.15)
      const toppled = jarRng.next() < 0.45
      if (toppled) {
        quaternion.setFromEuler(euler.set(
          jarRng.range(-0.2, 0.2),
          jarRng.range(0, Math.PI * 2),
          Math.PI / 2 + jarRng.range(-0.25, 0.25),
        ))
        matrix.compose(new Vector3(x, y + 0.3 * s, z), quaternion, new Vector3(s, s, s))
      } else {
        quaternion.setFromEuler(euler.set(
          jarRng.range(-0.14, 0.14),
          jarRng.range(0, Math.PI * 2),
          jarRng.range(-0.14, 0.14),
        ))
        matrix.compose(new Vector3(x, y - 0.06 * s, z), quaternion, new Vector3(s, s, s))
      }
      jars.setMatrixAt(placedJars, matrix)
      placedJars++
    }
    jars.count = placedJars
    jars.instanceMatrix.needsUpdate = true
    jars.castShadow = false
    jars.receiveShadow = true
    jars.name = 'flora-amphorae'
    this.group.add(jars)
  }
}

/** positionLocal + a world-space offset (instance transform already applied
 *  to positionLocal in the node pipeline — the jelly/seahorse precedent). */
function positionLocalOffset(offset: Node<'vec3'>): Node<'vec3'> {
  return (positionLocal as unknown as Node<'vec3'>).add(offset) as unknown as Node<'vec3'>
}

function smoothstepJs(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Pebble displacement (the only surviving raw-primitive dresser). */
function displacePebble(geometry: IcosahedronGeometry, amount: number, frequency: number, rng: Rng): void {
  const seedX = rng.range(0, 100)
  const seedY = rng.range(0, 100)
  const positions = geometry.getAttribute('position')
  const vertex = new Vector3()
  for (let i = 0; i < positions.count; i++) {
    vertex.fromBufferAttribute(positions, i)
    const noise = fbmCpu(vertex.x * frequency + seedX, (vertex.y + vertex.z) * frequency + seedY, 4, 5) - 0.5
    vertex.multiplyScalar(1 + noise * 2 * amount)
    positions.setXYZ(i, vertex.x, vertex.y, vertex.z)
  }
  positions.needsUpdate = true
  geometry.computeVertexNormals()
}
