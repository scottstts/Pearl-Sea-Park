import {
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  TorusGeometry,
  Vector3,
} from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import {
  attribute,
  float,
  mix,
  positionGeometry,
  positionLocal,
  sin,
  uniform,
  vec3,
} from 'three/tsl'
import { ArchKit } from '../archkit/modules'
import { SlotWriter } from '../archkit/writer'
import { registerBookmark } from '../core/debug'
import type { Rng } from '../core/prng'
import type { GameContext } from '../runtime/context'
import { markMainDetail } from '../render/layers'
import { currentFlow } from '../sea/current'
import type { SeaMediumSystem } from '../sea/medium'
import type { DistrictServices } from '../world/districts/atrium'
import { anchorGround, PARK_PLAN } from '../world/parkPlan'
import { terrainHeight } from '../world/terrain'
import {
  createJellyGeometry,
  createRayGeometry,
  createSeahorseGeometry,
  createTurtleGeometry,
  geometryMetrics,
} from './speciesGeometry'
import type { GeometryMetrics } from './speciesGeometry'

interface InstanceDraw {
  mesh: InstancedMesh
  material: MeshStandardNodeMaterial
}

export interface AmbientLifeSnapshot {
  rays: number
  turtles: number
  courtJellies: number
  grottoJellies: number
  seahorses: number
  feedingResponse: number
  geometry: Record<string, GeometryMetrics>
}

/**
 * The authored, low-count wildlife and the Menagerie's habitat staging.
 * Paths are analytic/spline-driven on CPU; all dense motion and body
 * deformation stays in vertex TSL with one draw per population.
 */
export class AmbientLife {
  readonly group = new Object3D()

  private readonly medium: SeaMediumSystem
  private readonly services: DistrictServices
  private readonly timeUniform = uniform(0)
  private readonly smallRayCurves: CatmullRomCurve3[] = []
  private readonly turtleCurve: CatmullRomCurve3
  private readonly smallRayPhases: number[] = []
  private readonly turtlePhases: number[] = []
  private readonly matrices = new Matrix4()
  private readonly orientation = new Matrix4()
  private readonly position = new Vector3()
  private readonly tangent = new Vector3()
  private readonly right = new Vector3()
  private readonly up = new Vector3(0, 1, 0)
  private readonly scale = new Vector3()
  private smallRays: InstanceDraw | null = null
  private manta: Mesh | null = null
  private turtles: InstanceDraw | null = null
  private readonly denseDraws: InstanceDraw[] = []
  private readonly geometries = new Map<string, GeometryMetrics>()
  private feedingPoint: Vector3 | null = null
  private feedingResponse = 0

  constructor(services: DistrictServices, medium: SeaMediumSystem) {
    this.services = services
    this.medium = medium
    this.turtleCurve = createTurtleLagoonCurve()
  }

  init(ctx: GameContext): void {
    const rng = ctx.rng.fork('wildlife-ambient')
    this.buildHabitats(ctx)
    this.buildRays(rng.fork('rays'))
    this.buildTurtles(rng.fork('turtles'))
    this.buildJellies(rng.fork('jellies'))
    this.buildSeahorses(rng.fork('seahorses'))
    ctx.scene.add(this.group)

    ctx.events.on('wildlife/turtle-attractor', ({ x, y, z, strength }) => {
      this.feedingPoint = new Vector3(x, y, z)
      this.feedingResponse = Math.max(this.feedingResponse, Math.max(0, Math.min(1, strength)))
    })

    const jelly = PARK_PLAN.menagerie.jellyCourt
    const jellyY = terrainHeight(jelly.x, jelly.z)
    registerBookmark({
      name: 'jelly-court',
      position: [jelly.x + 18, jellyY + 2.2, jelly.z + 12],
      look: [jelly.x, jellyY + 5.5, jelly.z],
      note: 'Moon-jelly cloister in the Menagerie Gardens',
    })
    const turtles = PARK_PLAN.menagerie.turtleLagoon
    const turtleY = terrainHeight(turtles.x, turtles.z)
    registerBookmark({
      name: 'turtle-lagoon',
      position: [turtles.x + 17, turtleY + 2.1, turtles.z + 10],
      look: [turtles.x, turtleY + 1.5, turtles.z],
      note: 'The Menagerie turtle lagoon and feeding edge',
    })
  }

  private buildHabitats(ctx: GameContext): void {
    const lib = this.services.materials.lib
    if (!lib) throw new Error('AmbientLife requires park materials')
    const kit = new ArchKit(lib)
    const writer = new SlotWriter()
    const { physics } = this.services
    const menagerie = PARK_PLAN.menagerie

    const jelly = menagerie.jellyCourt
    const jellyY = terrainHeight(jelly.x, jelly.z) + 0.08
    kit.mosaicPlaza(writer, jelly.x, jellyY, jelly.z, jelly.radius)
    kit.stepsRing(writer, jelly.x, jellyY - 0.12, jelly.z, jelly.radius)
    physics.addStaticCylinder(jelly.x, jellyY + 0.08, jelly.z, 0.14, jelly.radius + 0.6)
    const courtColumns: { x: number; z: number; gate: boolean }[] = []
    for (let i = 0; i < 14; i++) {
      const angle = (i / 14) * Math.PI * 2
      const gate = i === 3 || i === 4 || i === 10 || i === 11
      const x = jelly.x + Math.sin(angle) * (jelly.radius - 1.4)
      const z = jelly.z + Math.cos(angle) * (jelly.radius - 1.4)
      courtColumns.push({ x, z, gate })
      if (!gate) {
        kit.column(writer, x, jellyY + 0.18, z, 6.2, 0.26)
        physics.addStaticBox(x, jellyY + 3.2, z, 0.32, 3.1, 0.32)
      }
    }
    for (let i = 0; i < courtColumns.length; i++) {
      const a = courtColumns[i]
      const b = courtColumns[(i + 1) % courtColumns.length]
      if (!a.gate && !b.gate) kit.arch(writer, a.x, a.z, b.x, b.z, jellyY + 6.35, 1.25)
    }

    const lagoon = menagerie.turtleLagoon
    const lagoonY = terrainHeight(lagoon.x, lagoon.z) + 0.08
    kit.mosaicPlaza(writer, lagoon.x, lagoonY, lagoon.z, lagoon.radius + 2.2)
    const rim = new TorusGeometry(lagoon.radius, 0.28, 12, 64)
    const rimMesh = new Mesh(rim, lib.marble)
    rimMesh.rotation.x = Math.PI / 2
    rimMesh.position.set(lagoon.x, lagoonY + 0.34, lagoon.z)
    rimMesh.castShadow = true
    rimMesh.receiveShadow = true
    this.group.add(rimMesh)
    physics.addStaticCylinder(lagoon.x, lagoonY + 0.26, lagoon.z, 0.26, lagoon.radius + 0.25)
    const lagoonWater = new MeshStandardNodeMaterial()
    lagoonWater.color = new Color(0x163d46)
    lagoonWater.roughness = 0.12
    lagoonWater.metalness = 0.05
    lagoonWater.transparent = true
    lagoonWater.opacity = 0.82
    this.medium.applyCaustics(lagoonWater, 0.5)
    const water = new Mesh(new CircleGeometry(lagoon.radius - 0.35, 64), lagoonWater)
    water.rotation.x = -Math.PI / 2
    water.position.set(lagoon.x, lagoonY + 0.18, lagoon.z)
    water.receiveShadow = true
    this.group.add(water)

    const sun = menagerie.sunGarden
    const sunY = terrainHeight(sun.x, sun.z) + 0.08
    kit.mosaicPlaza(writer, sun.x, sunY, sun.z, 9)
    kit.dome(writer, sun.x, sunY + 0.2, sun.z, 8.5, 14)
    physics.addStaticCylinder(sun.x, sunY + 0.08, sun.z, 0.14, 9.4)

    // Short grounded links make the three exhibits read as one district.
    const links: readonly [[number, number], [number, number]][] = [
      [[menagerie.x, menagerie.z], [jelly.x + jelly.radius, jelly.z]],
      [[menagerie.x, menagerie.z], [lagoon.x, lagoon.z + lagoon.radius]],
      [[menagerie.x, menagerie.z], [sun.x - 7.5, sun.z - 3]],
    ]
    for (const [[ax, az], [bx, bz]] of links) {
      const segments = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 7))
      for (let i = 0; i < segments; i++) {
        const t0 = i / segments
        const t1 = (i + 1) / segments
        const x0 = ax + (bx - ax) * t0
        const z0 = az + (bz - az) * t0
        const x1 = ax + (bx - ax) * t1
        const z1 = az + (bz - az) * t1
        const y = terrainHeight((x0 + x1) * 0.5, (z0 + z1) * 0.5) + 0.08
        kit.mosaicPath(writer, x0, z0, x1, z1, y, 3.5)
        const half = Math.hypot(x1 - x0, z1 - z0) * 0.5
        physics.addStaticBox(
          (x0 + x1) * 0.5,
          y + 0.08,
          (z0 + z1) * 0.5,
          1.75,
          0.08,
          half,
          Math.atan2(x1 - x0, z1 - z0),
        )
      }
    }

    this.group.add(writer.compile())
    void ctx
  }

  private buildRays(rng: Rng): void {
    const smallGeometry = createRayGeometry(false)
    this.geometries.set('ray', geometryMetrics(smallGeometry))
    const smallMaterial = this.createWingMaterial(vec3(0.18, 0.29, 0.31), 0.14)
    const smallRays = new InstancedMesh(smallGeometry, smallMaterial, 5)
    smallRays.instanceMatrix.setUsage(DynamicDrawUsage)
    smallRays.frustumCulled = true
    smallRays.castShadow = true
    smallRays.receiveShadow = true
    smallRays.name = 'wildlife-rays'
    this.smallRays = { mesh: smallRays, material: smallMaterial }
    this.group.add(smallRays)

    const rayAnchors: readonly [number, number][] = [
      [-105, 155],
      [115, 95],
      [-175, 72],
      [120, -35],
      [30, 260],
    ]
    for (let i = 0; i < 5; i++) {
      const [cx, cz] = rayAnchors[i]
      const radius = rng.range(24, 46)
      const points: Vector3[] = []
      for (let p = 0; p < 7; p++) {
        const angle = (p / 7) * Math.PI * 2
        const x = cx + Math.cos(angle) * radius * rng.range(0.75, 1.15)
        const z = cz + Math.sin(angle) * radius * rng.range(0.7, 1.1)
        const y = Math.min(-7, terrainHeight(x, z) + rng.range(8, 17))
        points.push(new Vector3(x, y, z))
      }
      this.smallRayCurves.push(new CatmullRomCurve3(points, true, 'centripetal', 0.5))
      this.smallRayPhases.push(rng.next())
    }

    const mantaGeometry = createRayGeometry(true)
    this.geometries.set('manta', geometryMetrics(mantaGeometry))
    const mantaMaterial = this.createWingMaterial(vec3(0.1, 0.16, 0.18), 0.24)
    const manta = new Mesh(mantaGeometry, mantaMaterial)
    manta.castShadow = true
    manta.receiveShadow = true
    manta.frustumCulled = true
    manta.name = 'wildlife-manta'
    this.manta = manta
    this.group.add(manta)
  }

  private createWingMaterial(color: Node<'vec3'>, amplitude: number): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial()
    material.side = DoubleSide
    material.roughness = 0.5
    material.metalness = 0.04
    const wing = attribute('morphWeight', 'float') as unknown as Node<'float'>
    const undulation = sin(
      this.timeUniform.mul(1.7).add(wing.abs().mul(2.6)),
    ).mul(wing.abs().pow(1.35)).mul(amplitude)
    material.positionNode = positionLocal.add(vec3(0, undulation, 0))
    material.colorNode = mix(color.mul(0.55), color, positionGeometry.y.add(0.2).clamp(0, 1))
    this.medium.applyCaustics(material, 0.9)
    return material
  }

  private buildTurtles(rng: Rng): void {
    const geometry = createTurtleGeometry()
    this.geometries.set('turtle', geometryMetrics(geometry))
    const material = new MeshStandardNodeMaterial()
    material.side = DoubleSide
    material.roughness = 0.62
    material.metalness = 0.02
    const flipper = attribute('morphWeight', 'float') as unknown as Node<'float'>
    const flap = sin(this.timeUniform.mul(2.1).add(flipper.mul(0.8)))
      .mul(flipper.abs())
      .mul(0.11)
    material.positionNode = positionLocal.add(vec3(0, flap, 0))
    material.colorNode = mix(
      vec3(0.17, 0.3, 0.18),
      vec3(0.48, 0.43, 0.22),
      positionGeometry.y.add(0.3).clamp(0, 1),
    )
    this.medium.applyCaustics(material, 1)
    const turtles = new InstancedMesh(geometry, material, 8)
    turtles.instanceMatrix.setUsage(DynamicDrawUsage)
    turtles.frustumCulled = true
    turtles.castShadow = true
    turtles.receiveShadow = true
    turtles.name = 'wildlife-turtles'
    this.turtles = { mesh: turtles, material }
    this.group.add(turtles)
    for (let i = 0; i < 8; i++) this.turtlePhases.push((i / 8 + rng.range(-0.025, 0.025) + 1) % 1)
  }

  private buildJellies(rng: Rng): void {
    const base = createJellyGeometry()
    this.geometries.set('jelly', geometryMetrics(base))
    const court = PARK_PLAN.menagerie.jellyCourt
    const courtGround = terrainHeight(court.x, court.z)
    this.denseDraws.push(
      this.createJellyDraw(
        base,
        400,
        rng.fork('court'),
        () => {
          const angle = rng.range(0, Math.PI * 2)
          const radius = Math.sqrt(rng.next()) * (court.radius - 2.2)
          return new Vector3(
            court.x + Math.cos(angle) * radius,
            courtGround + rng.range(1.2, 9.5),
            court.z + Math.sin(angle) * radius,
          )
        },
        false,
      ),
    )
    this.denseDraws.push(
      this.createJellyDraw(
        base,
        200,
        rng.fork('grotto'),
        () => {
          const angle = rng.range(0, Math.PI * 2)
          const radius = Math.sqrt(rng.next()) * rng.range(4, 23)
          return new Vector3(
            211 + Math.cos(angle) * radius,
            rng.range(-27, -21.8),
            99 + Math.sin(angle) * radius,
          )
        },
        true,
      ),
    )
    base.dispose()
  }

  private createJellyDraw(
    base: ReturnType<typeof createJellyGeometry>,
    count: number,
    rng: Rng,
    originAt: () => Vector3,
    bioluminescent: boolean,
  ): InstanceDraw {
    const geometry = base.clone()
    const origins = new Float32Array(count * 3)
    const phases = new Float32Array(count)
    const mesh = new InstancedMesh(geometry, new MeshStandardNodeMaterial(), count)
    const quaternion = new Quaternion()
    const scale = new Vector3()
    const matrix = new Matrix4()
    for (let i = 0; i < count; i++) {
      const origin = originAt()
      const s = rng.range(0.38, 1.05)
      origins.set([origin.x, origin.y, origin.z], i * 3)
      phases[i] = rng.range(0, Math.PI * 2)
      quaternion.setFromAxisAngle(this.up, rng.range(0, Math.PI * 2))
      scale.set(s, s * rng.range(0.82, 1.2), s)
      matrix.compose(origin, quaternion, scale)
      mesh.setMatrixAt(i, matrix)
    }
    geometry.setAttribute('instanceOrigin', new InstancedBufferAttribute(origins, 3))
    geometry.setAttribute('instancePhase', new InstancedBufferAttribute(phases, 1))
    const material = mesh.material as MeshStandardNodeMaterial
    material.side = DoubleSide
    material.roughness = 0.18
    material.metalness = 0.02
    material.transparent = true
    material.depthWrite = false
    const origin = attribute('instanceOrigin', 'vec3') as unknown as Node<'vec3'>
    const phase = attribute('instancePhase', 'float') as unknown as Node<'float'>
    const pulseWeight = attribute('morphWeight', 'float') as unknown as Node<'float'>
    const pulse = sin(this.timeUniform.mul(2.05).add(phase))
    const relative = positionLocal.sub(origin)
    const pulseScale = float(1).add(pulse.mul(0.08).mul(pulseWeight))
    const flow = currentFlow(origin, this.timeUniform)
    material.positionNode = origin
      .add(vec3(relative.x.mul(pulseScale), relative.y.mul(float(1).sub(pulse.mul(0.055))), relative.z.mul(pulseScale)))
      .add(flow.mul(vec3(0.85, 0.22, 0.85)))
      .add(vec3(0, sin(this.timeUniform.mul(0.55).add(phase)).mul(0.34), 0))
    material.colorNode = bioluminescent
      ? mix(vec3(0.13, 0.4, 0.48), vec3(0.42, 0.82, 0.78), pulse.mul(0.5).add(0.5))
      : mix(vec3(0.33, 0.47, 0.5), vec3(0.76, 0.68, 0.77), pulse.mul(0.5).add(0.5))
    material.emissiveNode = bioluminescent
      ? vec3(0.08, 0.32, 0.38).mul(pulse.mul(0.5).add(0.8))
      : vec3(0.01, 0.025, 0.03)
    material.opacityNode = float(bioluminescent ? 0.78 : 0.58)
    this.medium.applyCaustics(material, bioluminescent ? 0.2 : 0.65)
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    mesh.frustumCulled = true
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.name = bioluminescent ? 'wildlife-jellies:grotto' : 'wildlife-jellies:court'
    markMainDetail(mesh)
    this.group.add(mesh)
    return { mesh, material }
  }

  private buildSeahorses(rng: Rng): void {
    const geometry = createSeahorseGeometry()
    this.geometries.set('seahorse', geometryMetrics(geometry))
    const count = 40
    const origins = new Float32Array(count * 3)
    const phases = new Float32Array(count)
    const material = new MeshStandardNodeMaterial()
    material.side = DoubleSide
    material.roughness = 0.42
    material.metalness = 0.08
    const mesh = new InstancedMesh(geometry, material, count)
    const matrix = new Matrix4()
    const quaternion = new Quaternion()
    const scale = new Vector3()
    for (let i = 0; i < count; i++) {
      const angle = rng.range(0, Math.PI * 2)
      const radius = rng.range(13.5, 20)
      const x = PARK_PLAN.carousel.x + Math.cos(angle) * radius
      const z = PARK_PLAN.carousel.z + Math.sin(angle) * radius
      const y = terrainHeight(x, z) + rng.range(1.2, 5.6)
      origins.set([x, y, z], i * 3)
      phases[i] = rng.range(0, Math.PI * 2)
      quaternion.setFromAxisAngle(this.up, -angle + Math.PI / 2 + rng.range(-0.45, 0.45))
      const s = rng.range(0.55, 1.05)
      scale.set(s, s, s)
      matrix.compose(new Vector3(x, y, z), quaternion, scale)
      mesh.setMatrixAt(i, matrix)
    }
    geometry.setAttribute('instanceOrigin', new InstancedBufferAttribute(origins, 3))
    geometry.setAttribute('instancePhase', new InstancedBufferAttribute(phases, 1))
    const origin = attribute('instanceOrigin', 'vec3') as unknown as Node<'vec3'>
    const phase = attribute('instancePhase', 'float') as unknown as Node<'float'>
    const swayWeight = attribute('morphWeight', 'float') as unknown as Node<'float'>
    const relative = positionLocal.sub(origin)
    const sway = sin(this.timeUniform.mul(1.35).add(phase)).mul(swayWeight).mul(0.08)
    material.positionNode = origin
      .add(relative)
      .add(vec3(sway, sin(this.timeUniform.mul(0.7).add(phase)).mul(0.14), sway.mul(-0.6)))
      .add(currentFlow(origin, this.timeUniform).mul(vec3(0.28, 0.1, 0.28)))
    material.colorNode = mix(vec3(0.38, 0.18, 0.08), vec3(0.86, 0.54, 0.18), swayWeight)
    this.medium.applyCaustics(material, 1)
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    mesh.frustumCulled = true
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.name = 'wildlife-seahorses'
    markMainDetail(mesh)
    this.group.add(mesh)
    this.denseDraws.push({ mesh, material })
  }

  update(ctx: GameContext, dt: number, mantaAmount: number, mantaPhase: number): void {
    this.timeUniform.value = ctx.time.elapsed
    this.feedingResponse = Math.max(0, this.feedingResponse - dt * 0.035)
    if (this.feedingResponse <= 0) this.feedingPoint = null
    this.updateSmallRays(ctx.time.elapsed)
    this.updateManta(ctx.time.elapsed, mantaAmount, mantaPhase)
    this.updateTurtles(ctx.time.elapsed)
  }

  private updateSmallRays(elapsed: number): void {
    const draw = this.smallRays
    if (!draw) return
    for (let i = 0; i < this.smallRayCurves.length; i++) {
      const curve = this.smallRayCurves[i]
      const u = (this.smallRayPhases[i] + elapsed * (0.009 + i * 0.0007)) % 1
      curve.getPointAt(u, this.position)
      curve.getTangentAt(u, this.tangent).normalize()
      this.composeAlong(this.position, this.tangent, 0.82 + i * 0.07)
      draw.mesh.setMatrixAt(i, this.matrices)
    }
    draw.mesh.instanceMatrix.needsUpdate = true
    draw.mesh.computeBoundingSphere()
  }

  private updateManta(elapsed: number, amount: number, phase: number): void {
    const manta = this.manta
    if (!manta) return
    const idleAngle = elapsed * 0.014
    const idle = new Vector3(
      -70 + Math.cos(idleAngle) * 85,
      -10 + Math.sin(idleAngle * 1.7) * 2,
      90 + Math.sin(idleAngle) * 65,
    )
    const idleTangent = new Vector3(-Math.sin(idleAngle), 0.02, Math.cos(idleAngle)).normalize()
    const hero = new Vector3(
      -8 + Math.sin(phase * Math.PI * 2) * 3,
      -14.5 + Math.sin(phase * Math.PI) * 2,
      242 - phase * 138,
    )
    const heroTangent = new Vector3(0.04, -Math.cos(phase * Math.PI) * 0.08, -1).normalize()
    this.position.copy(idle).lerp(hero, amount)
    this.tangent.copy(idleTangent).lerp(heroTangent, amount).normalize()
    this.composeAlong(this.position, this.tangent, 1)
    manta.matrixAutoUpdate = false
    manta.matrix.copy(this.matrices)
    manta.matrixWorldNeedsUpdate = true
  }

  private updateTurtles(elapsed: number): void {
    const draw = this.turtles
    if (!draw) return
    const attraction = this.feedingPoint
    for (let i = 0; i < 8; i++) {
      const u = (this.turtlePhases[i] + elapsed * (0.005 + i * 0.0002)) % 1
      this.turtleCurve.getPointAt(u, this.position)
      this.turtleCurve.getTangentAt(u, this.tangent).normalize()
      if (attraction && this.feedingResponse > 0) {
        const target = attraction.clone().add(new Vector3(Math.sin(i * 2.4), 0, Math.cos(i * 1.7)).multiplyScalar(1.4))
        this.position.lerp(target, this.feedingResponse * 0.72)
        this.tangent.lerp(target.sub(this.position).normalize(), this.feedingResponse).normalize()
      }
      this.composeAlong(this.position, this.tangent, 0.82 + (i % 3) * 0.08)
      draw.mesh.setMatrixAt(i, this.matrices)
    }
    draw.mesh.instanceMatrix.needsUpdate = true
    draw.mesh.computeBoundingSphere()
  }

  private composeAlong(position: Vector3, tangent: Vector3, uniformScale: number): void {
    this.right.crossVectors(this.up, tangent).normalize()
    const localUp = new Vector3().crossVectors(tangent, this.right).normalize()
    this.orientation.makeBasis(this.right, localUp, tangent)
    this.orientation.setPosition(position)
    this.scale.setScalar(uniformScale)
    this.matrices.copy(this.orientation).scale(this.scale)
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
    for (const draw of [this.smallRays, this.turtles, ...this.denseDraws]) {
      if (!draw) continue
      draw.mesh.geometry.dispose()
      draw.material.dispose()
    }
    if (this.manta) {
      this.manta.geometry.dispose()
      ;(this.manta.material as MeshStandardNodeMaterial).dispose()
    }
  }

  debugSnapshot(): AmbientLifeSnapshot {
    return {
      rays: 6,
      turtles: 8,
      courtJellies: 400,
      grottoJellies: 200,
      seahorses: 40,
      feedingResponse: this.feedingResponse,
      geometry: Object.fromEntries(this.geometries),
    }
  }
}

function createTurtleLagoonCurve(): CatmullRomCurve3 {
  const lagoon = PARK_PLAN.menagerie.turtleLagoon
  const points: Vector3[] = []
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2
    const x = lagoon.x + Math.cos(angle) * lagoon.radius * (0.58 + (i % 2) * 0.08)
    const z = lagoon.z + Math.sin(angle) * lagoon.radius * (0.58 + ((i + 1) % 2) * 0.08)
    points.push(new Vector3(x, anchorGround(lagoon) + 0.58 + Math.sin(angle * 2) * 0.18, z))
  }
  return new CatmullRomCurve3(points, true, 'centripetal', 0.5)
}
