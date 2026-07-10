import {
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  Object3D,
  Vector3,
} from 'three'
import {
  MeshStandardNodeMaterial,
  StorageBufferAttribute,
  StorageInstancedBufferAttribute,
} from 'three/webgpu'
import type { ComputeNode, Node, StorageBufferNode } from 'three/webgpu'
import {
  Fn,
  attribute,
  clamp,
  cross,
  float,
  hash,
  instanceIndex,
  max,
  mix,
  normalLocal,
  normalize,
  positionGeometry,
  positionLocal,
  select,
  smoothstep,
  storage,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Rng } from '../core/prng'
import type { GameContext } from '../runtime/context'
import { currentFlow } from '../sea/current'
import type { SeaMediumSystem } from '../sea/medium'
import { parkFootprintSignedDistance } from '../world/parkPlan'
import { terrainHeight } from '../world/terrain'
import { createFishGeometry, geometryMetrics } from './speciesGeometry'
import type { FishSpecies, GeometryMetrics } from './speciesGeometry'
import { createWildlifeFieldMaps, WILDLIFE_FIELD } from './wildlifeField'

const SCHOOL_SIZE = 500
const NEIGHBOR_OFFSETS = [1, 7, 19, 43, 89, 157, 271, 389] as const

interface SpeciesDraw {
  species: FishSpecies
  offset: number
  count: number
  mesh: InstancedMesh
  material: MeshStandardNodeMaterial
  metrics: GeometryMetrics
}

export interface FishSchoolSnapshot {
  fish: number
  schools: number
  species: Record<FishSpecies, number>
  sampledNeighbors: number
  computeSteps: number
  heroAmount: number
  heroPhase: number
  drawCalls: number
  geometry: Record<FishSpecies, GeometryMetrics>
}

/**
 * Park-scale schooling fish. The simulation is O(N × 8): every fish samples
 * a stable, well-spread cohort inside its 500-member school. That preserves
 * separation/alignment/cohesion behavior at 15k without an O(N²) neighbor
 * pass or atomic grid contention. Positions and velocities ping-pong in GPU
 * storage buffers and feed three species draws directly.
 */
export class FishSchoolSystem {
  readonly group = new Object3D()

  private readonly medium: SeaMediumSystem
  private readonly count: number
  private readonly schoolCount: number
  private readonly speciesCounts: Record<FishSpecies, number>
  private readonly positions: [StorageInstancedBufferAttribute, StorageInstancedBufferAttribute]
  private readonly velocities: [StorageInstancedBufferAttribute, StorageInstancedBufferAttribute]
  private readonly positionNodes: [StorageBufferNode<'vec4'>, StorageBufferNode<'vec4'>]
  private readonly velocityNodes: [StorageBufferNode<'vec4'>, StorageBufferNode<'vec4'>]
  private readonly groupCenters: StorageBufferNode<'vec4'>
  private readonly computeSteps: [ComputeNode, ComputeNode]
  private readonly draws: SpeciesDraw[] = []
  private readonly fields = createWildlifeFieldMaps()
  private readonly timeUniform = uniform(0)
  private readonly dtUniform = uniform(1 / 60)
  private readonly readBufferUniform = uniform(0)
  private readonly playerUniform = uniform(new Vector3(10_000, 10_000, 10_000))
  private readonly heroAmountUniform = uniform(0)
  private readonly heroPhaseUniform = uniform(0)
  private readonly attractorPositionUniform = uniform(new Vector3(10_000, 10_000, 10_000))
  private readonly attractorStrengthUniform = uniform(0)
  private readonly attractorRadiusUniform = uniform(1)
  private ping = 0
  private stepCount = 0

  constructor(ctx: GameContext, medium: SeaMediumSystem) {
    this.medium = medium
    this.count = Math.max(SCHOOL_SIZE, Math.floor(ctx.quality.params.boidBudget / SCHOOL_SIZE) * SCHOOL_SIZE)
    this.schoolCount = this.count / SCHOOL_SIZE
    const speciesGroups = distributeGroups(this.schoolCount)
    this.speciesCounts = {
      silverside: speciesGroups[0] * SCHOOL_SIZE,
      trevally: speciesGroups[1] * SCHOOL_SIZE,
      'candy-stripe': speciesGroups[2] * SCHOOL_SIZE,
    }

    const initialized = createInitialState(ctx.rng.fork('wildlife-fish'), this.schoolCount)
    this.positions = [
      new StorageInstancedBufferAttribute(initialized.positions.slice(), 4),
      new StorageInstancedBufferAttribute(initialized.positions.slice(), 4),
    ]
    this.velocities = [
      new StorageInstancedBufferAttribute(initialized.velocities.slice(), 4),
      new StorageInstancedBufferAttribute(initialized.velocities.slice(), 4),
    ]
    this.positionNodes = [
      storage(this.positions[0], 'vec4', this.count),
      storage(this.positions[1], 'vec4', this.count),
    ]
    this.velocityNodes = [
      storage(this.velocities[0], 'vec4', this.count),
      storage(this.velocities[1], 'vec4', this.count),
    ]
    const centerAttribute = new StorageBufferAttribute(initialized.centers, 4)
    this.groupCenters = storage(centerAttribute, 'vec4', this.schoolCount).toReadOnly()
    this.computeSteps = [
      this.createComputeStep(0, 1),
      this.createComputeStep(1, 0),
    ]
    this.buildDraws()
  }

  private createComputeStep(source: 0 | 1, target: 0 | 1): ComputeNode {
    const sourcePositions = this.positionNodes[source]
    const sourceVelocities = this.velocityNodes[source]
    const targetPositions = this.positionNodes[target]
    const targetVelocities = this.velocityNodes[target]
    const parkSdf = texture(this.fields.parkSdf)
    const groundField = texture(this.fields.terrain)
    const texel = 1 / WILDLIFE_FIELD.resolution

    return Fn(() => {
      const sourcePosition = sourcePositions.element(instanceIndex)
      const sourceVelocity = sourceVelocities.element(instanceIndex)
      const position = sourcePosition.xyz.toVar()
      const velocity = sourceVelocity.xyz.toVar()
      const schoolId = instanceIndex.div(SCHOOL_SIZE)
      const schoolStart = schoolId.mul(SCHOOL_SIZE)
      const localIndex = instanceIndex.mod(SCHOOL_SIZE)

      const centerSum = vec3(0).toVar()
      const alignmentSum = vec3(0).toVar()
      const separation = vec3(0).toVar()
      for (const offset of NEIGHBOR_OFFSETS) {
        const neighborIndex = schoolStart.add(localIndex.add(offset).mod(SCHOOL_SIZE))
        const neighborPosition = sourcePositions.element(neighborIndex).xyz
        const neighborVelocity = sourceVelocities.element(neighborIndex).xyz
        const delta = neighborPosition.sub(position)
        const distance = max(delta.length(), 0.08)
        centerSum.addAssign(neighborPosition)
        alignmentSum.addAssign(neighborVelocity)
        const separationWeight = float(1).sub(smoothstep(0.8, 4.6, distance))
        separation.subAssign(delta.div(distance.mul(distance)).mul(separationWeight))
      }

      const inverseNeighbors = 1 / NEIGHBOR_OFFSETS.length
      const cohesion = centerSum.mul(inverseNeighbors).sub(position)
      const alignment = alignmentSum.mul(inverseNeighbors).sub(velocity)
      const home = this.groupCenters.element(schoolId).xyz
      const schoolPhase = this.groupCenters.element(schoolId).w
      const orbit = vec3(
        this.timeUniform.mul(0.075).add(schoolPhase).sin().mul(7),
        this.timeUniform.mul(0.11).add(schoolPhase.mul(1.7)).sin().mul(1.8),
        this.timeUniform.mul(0.063).add(schoolPhase.mul(0.8)).cos().mul(7),
      )
      const ordinaryTarget = home.add(orbit)

      // Every fifth school is a hero school. During the scheduled manta cue
      // it streams down the Esplanade; the same player sphere opens a clean
      // aisle through the school rather than teleporting any fish.
      const heroSchool = schoolId.mod(5).equal(0)
      const heroAmount = select(heroSchool, this.heroAmountUniform, float(0))
      const heroLane = float(schoolId.mod(3)).sub(1).mul(4.2)
      const heroTarget = vec3(
        heroLane.add(this.heroPhaseUniform.mul(Math.PI * 4).add(schoolPhase).sin().mul(1.4)),
        float(-18.2).add(this.heroPhaseUniform.mul(Math.PI * 2).add(schoolPhase).sin().mul(1.2)),
        float(236).sub(this.heroPhaseUniform.mul(126)),
      )
      const targetPoint = mix(ordinaryTarget, heroTarget, heroAmount)

      const fieldUv = position.xz
        .sub(vec2(WILDLIFE_FIELD.minX, WILDLIFE_FIELD.minZ))
        .div(vec2(WILDLIFE_FIELD.width, WILDLIFE_FIELD.depth))
        .clamp(0.002, 0.998)
      const sdf = parkSdf.sample(fieldUv).r
      const gradient = vec2(
        parkSdf.sample(fieldUv.add(vec2(texel, 0))).r.sub(
          parkSdf.sample(fieldUv.sub(vec2(texel, 0))).r,
        ),
        parkSdf.sample(fieldUv.add(vec2(0, texel))).r.sub(
          parkSdf.sample(fieldUv.sub(vec2(0, texel))).r,
        ),
      )
      const obstacleDirection = gradient.add(vec2(0.0001)).normalize()
      const obstacleWeight = float(1)
        .sub(smoothstep(3, 18, sdf))
        .mul(float(1).sub(heroAmount.mul(0.88)))
      const obstacleForce = vec3(obstacleDirection.x, 0, obstacleDirection.y)
        .mul(obstacleWeight)
        .mul(7.5)

      const ground = groundField.sample(fieldUv).r
      const floorClearance = position.y.sub(ground)
      const floorLift = float(1).sub(smoothstep(2.2, 7.5, floorClearance)).mul(5.5)
      const ceilingDrop = smoothstep(-7, -2.5, position.y).mul(4.2)

      const playerDelta = position.sub(this.playerUniform)
      const playerDistance = max(playerDelta.length(), 0.15)
      const playerWeight = float(1).sub(smoothstep(2.4, 13.5, playerDistance))
      const playerForce = playerDelta.div(playerDistance).mul(playerWeight.mul(11))

      const attractionDelta = this.attractorPositionUniform.sub(position)
      const attractionDistance = max(attractionDelta.length(), 0.2)
      const attractionWeight = float(1)
        .sub(smoothstep(this.attractorRadiusUniform.mul(0.18), this.attractorRadiusUniform, attractionDistance))
        .mul(this.attractorStrengthUniform)
      const attractionForce = attractionDelta
        .div(attractionDistance)
        .mul(attractionWeight.mul(2.8))

      // Permanent low-strength hooks: schools near the carousel bulbs and
      // hub lamps gather loosely, without pulling distant park populations.
      const carouselDelta = vec3(100, -18, 182).sub(position)
      const carouselDistance = max(carouselDelta.length(), 0.2)
      const carouselWeight = float(1)
        .sub(smoothstep(16, 58, carouselDistance))
        .mul(this.timeUniform.mul(0.8).sin().mul(0.15).add(0.45))
      const hubDelta = vec3(0, -18, 78).sub(position)
      const hubDistance = max(hubDelta.length(), 0.2)
      const hubWeight = float(1).sub(smoothstep(14, 52, hubDistance)).mul(0.32)
      const lightAttraction = carouselDelta
        .div(carouselDistance)
        .mul(carouselWeight)
        .add(hubDelta.div(hubDistance).mul(hubWeight))

      const flow = currentFlow(position, this.timeUniform)
      const acceleration = cohesion
        .mul(0.19)
        .add(alignment.mul(0.34))
        .add(separation.mul(3.4))
        .add(targetPoint.sub(position).mul(float(0.055).add(heroAmount.mul(0.24))))
        .add(obstacleForce)
        .add(playerForce)
        .add(attractionForce)
        .add(lightAttraction)
        .add(flow.mul(0.5))
        .add(vec3(0, floorLift.sub(ceilingDrop), 0))

      const nextVelocity = velocity.add(acceleration.mul(this.dtUniform)).toVar()
      const speed = max(nextVelocity.length(), 0.001)
      const targetSpeed = clamp(speed, 0.72, float(3.4).add(heroAmount.mul(1.5)))
      nextVelocity.mulAssign(targetSpeed.div(speed))
      const nextPosition = position.add(nextVelocity.mul(this.dtUniform))

      targetPositions.element(instanceIndex).assign(vec4(nextPosition, sourcePosition.w))
      targetVelocities.element(instanceIndex).assign(vec4(nextVelocity, sourceVelocity.w))
    })().compute(this.count)
  }

  private buildDraws(): void {
    const colors: Record<FishSpecies, [number, number, number]> = {
      silverside: [0.62, 0.76, 0.82],
      trevally: [0.88, 0.62, 0.17],
      'candy-stripe': [0.82, 0.2, 0.22],
    }
    const species: FishSpecies[] = ['silverside', 'trevally', 'candy-stripe']
    let offset = 0
    for (const name of species) {
      const count = this.speciesCounts[name]
      const geometry = createFishGeometry(name)
      const material = new MeshStandardNodeMaterial()
      material.side = DoubleSide
      material.roughness = name === 'silverside' ? 0.22 : 0.38
      material.metalness = name === 'silverside' ? 0.58 : 0.14
      material.envMapIntensity = 0.8
      material.color = new Color(0xffffff)
      const globalIndex = instanceIndex.add(offset)
      const activePosition = mix(
        this.positionNodes[0].element(globalIndex),
        this.positionNodes[1].element(globalIndex),
        this.readBufferUniform,
      ).xyz
      const activeVelocity = mix(
        this.velocityNodes[0].element(globalIndex),
        this.velocityNodes[1].element(globalIndex),
        this.readBufferUniform,
      ).xyz
      const morphWeight = attribute('morphWeight', 'float') as unknown as Node<'float'>
      const phase = hash(globalIndex.add(1031)).mul(Math.PI * 2)
      const tail = this.timeUniform.mul(name === 'silverside' ? 10.5 : 8.2).add(phase).sin()
      const local = positionLocal
        .add(vec3(tail.mul(morphWeight).mul(0.16), 0, 0))
        .toVar()
      const forward = normalize(activeVelocity.add(vec3(0.0001, 0, 0.0001)))
      const right = normalize(cross(vec3(0, 1, 0), forward).add(vec3(0.0001, 0, 0)))
      const up = normalize(cross(forward, right))
      material.positionNode = activePosition
        .add(right.mul(local.x))
        .add(up.mul(local.y))
        .add(forward.mul(local.z))
      material.normalNode = varying(
        normalize(right.mul(normalLocal.x).add(up.mul(normalLocal.y)).add(forward.mul(normalLocal.z))),
      )

      const base = vec3(...colors[name])
      if (name === 'candy-stripe') {
        const stripe = positionGeometry.z.mul(22).sin().mul(0.5).add(0.5).smoothstep(0.42, 0.58)
        material.colorNode = mix(base, vec3(0.94, 0.82, 0.58), stripe)
      } else if (name === 'silverside') {
        const flash = varying(
          forward.dot(vec3(0.35, 0.2, 0.91).normalize()).abs().mul(0.22).add(0.82),
        )
        material.colorNode = base.mul(flash)
      } else {
        material.colorNode = mix(base.mul(0.68), base, positionGeometry.y.add(0.3).clamp(0, 1))
      }
      this.medium.applyCaustics(material, 1.05)

      const mesh = new InstancedMesh(geometry, material, count)
      const identity = new Matrix4()
      for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity)
      mesh.instanceMatrix.needsUpdate = true
      mesh.frustumCulled = false
      mesh.castShadow = false
      mesh.receiveShadow = false
      mesh.name = `wildlife-fish:${name}`
      this.group.add(mesh)
      this.draws.push({
        species: name,
        offset,
        count,
        mesh,
        material,
        metrics: geometryMetrics(geometry),
      })
      offset += count
    }
  }

  update(ctx: GameContext, dt: number, heroAmount: number, heroPhase: number): void {
    this.timeUniform.value = ctx.time.elapsed
    this.dtUniform.value = Math.min(dt, 1 / 30)
    this.playerUniform.value.copy(ctx.camera.position)
    this.heroAmountUniform.value = heroAmount
    this.heroPhaseUniform.value = heroPhase
    ctx.renderer.compute(this.computeSteps[this.ping])
    this.ping = this.ping === 0 ? 1 : 0
    this.readBufferUniform.value = this.ping
    this.stepCount++
  }

  setAttractor(position: Vector3, strength: number, radius: number): void {
    this.attractorPositionUniform.value.copy(position)
    this.attractorStrengthUniform.value = Math.max(0, Math.min(1, strength))
    this.attractorRadiusUniform.value = Math.max(1, radius)
  }

  clearAttractor(): void {
    this.attractorStrengthUniform.value = 0
  }

  dispose(): void {
    for (const draw of this.draws) {
      draw.mesh.geometry.dispose()
      draw.material.dispose()
    }
    this.fields.dispose()
  }

  debugSnapshot(): FishSchoolSnapshot {
    return {
      fish: this.count,
      schools: this.schoolCount,
      species: { ...this.speciesCounts },
      sampledNeighbors: NEIGHBOR_OFFSETS.length,
      computeSteps: this.stepCount,
      heroAmount: this.heroAmountUniform.value,
      heroPhase: this.heroPhaseUniform.value,
      drawCalls: this.draws.length,
      geometry: Object.fromEntries(
        this.draws.map((draw) => [draw.species, draw.metrics]),
      ) as Record<FishSpecies, GeometryMetrics>,
    }
  }
}

function distributeGroups(total: number): [number, number, number] {
  const base = Math.floor(total / 3)
  const remainder = total - base * 3
  return [base + (remainder > 0 ? 1 : 0), base + (remainder > 1 ? 1 : 0), base]
}

function createInitialState(
  rng: Rng,
  schoolCount: number,
): { positions: Float32Array; velocities: Float32Array; centers: Float32Array } {
  const positions = new Float32Array(schoolCount * SCHOOL_SIZE * 4)
  const velocities = new Float32Array(schoolCount * SCHOOL_SIZE * 4)
  const centers = new Float32Array(schoolCount * 4)
  const anchors: readonly [number, number][] = [
    [-54, 195],
    [42, 175],
    [-72, 116],
    [72, 92],
    [-132, 58],
    [-210, 78],
    [138, 145],
    [152, 5],
    [36, -82],
    [-62, -118],
    [205, 172],
    [-20, 286],
  ]

  for (let school = 0; school < schoolCount; school++) {
    const hero = school % 5 === 0
    const anchor = anchors[school % anchors.length]
    let centerX = hero ? rng.range(-5, 5) : anchor[0] + rng.range(-22, 22)
    let centerZ = hero ? rng.range(164, 214) : anchor[1] + rng.range(-20, 20)
    for (let attempt = 0; attempt < 16 && !hero; attempt++) {
      if (parkFootprintSignedDistance(centerX, centerZ) > 16) break
      centerX = anchor[0] + rng.range(-35, 35)
      centerZ = anchor[1] + rng.range(-32, 32)
    }
    const centerY = Math.min(-5, terrainHeight(centerX, centerZ) + rng.range(7, 16))
    centers[school * 4] = centerX
    centers[school * 4 + 1] = centerY
    centers[school * 4 + 2] = centerZ
    centers[school * 4 + 3] = rng.range(0, Math.PI * 2)

    for (let local = 0; local < SCHOOL_SIZE; local++) {
      const index = school * SCHOOL_SIZE + local
      let x = centerX
      let z = centerZ
      for (let attempt = 0; attempt < 12; attempt++) {
        const angle = rng.range(0, Math.PI * 2)
        const radius = Math.sqrt(rng.next()) * rng.range(5, 16)
        x = centerX + Math.cos(angle) * radius
        z = centerZ + Math.sin(angle) * radius
        if (hero || parkFootprintSignedDistance(x, z) > 2) break
      }
      const ground = terrainHeight(x, z)
      const y = Math.max(ground + 2.5, Math.min(-3.5, centerY + rng.range(-3.2, 3.2)))
      const angle = rng.range(0, Math.PI * 2)
      const speed = rng.range(0.8, 1.8)
      positions[index * 4] = x
      positions[index * 4 + 1] = y
      positions[index * 4 + 2] = z
      positions[index * 4 + 3] = rng.next()
      velocities[index * 4] = Math.sin(angle) * speed
      velocities[index * 4 + 1] = rng.range(-0.16, 0.16)
      velocities[index * 4 + 2] = Math.cos(angle) * speed
      velocities[index * 4 + 3] = school
    }
  }
  return { positions, velocities, centers }
}
