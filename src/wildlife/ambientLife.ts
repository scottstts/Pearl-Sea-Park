import {
  CatmullRomCurve3,
  CircleGeometry,
  ConeGeometry,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  Object3D,
  PointLight,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { Node } from 'three/webgpu'
import {
  attribute,
  cameraPosition,
  float,
  mix,
  normalGeometry,
  normalize,
  positionGeometry,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'
import { fbm2 } from '../render/tslNoise'
import { ArchKit, frondGeometry } from '../archkit/modules'
import { SlotWriter } from '../archkit/writer'
import { registerBookmark } from '../core/debug'
import type { Rng } from '../core/prng'
import type { GameContext } from '../runtime/context'
import { markDynamicShadowCasters, markMainDetail } from '../render/layers'
import { currentFlow } from '../sea/current'
import type { SeaMediumSystem } from '../sea/medium'
import type { DistrictServices } from '../world/districts/atrium'
import { anchorGround, PARK_PLAN } from '../world/parkPlan'
import { terrainHeight } from '../world/terrain'
import {
  createJellyGeometry,
  createRayGeometry,
  createSeahorseGeometry,
  createSunButterflyGeometry,
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
  seahorses: number
  sunButterflies: number
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
    this.buildSunButterflies(rng.fork('sun-butterflies'))
    ctx.scene.add(this.group)

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
      note: 'The Menagerie turtle lagoon',
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
      if (!a.gate && !b.gate) {
        kit.arch(writer, a.x, a.z, b.x, b.z, jellyY + 6.35, 1.25)
        kit.cornice(writer, a.x, a.z, b.x, b.z, jellyY + 6.42)
      }
    }
    // Planters on the court diagonals — the old pair stood dead-center in
    // the two gate openings. Diagonals decorate without blocking a lane.
    for (const [sx, sz] of [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ] as const) {
      const ux = jelly.x + sx * 7.4
      const uz = jelly.z + sz * 7.4
      kit.urn(writer, ux, jellyY + 0.18, uz, 0.95)
      physics.addStaticCylinder(ux, jellyY + 0.18 + 0.57, uz, 0.57, 0.44)
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

    // Lagoon water. The old disc sat EXACTLY on the plaza plate top (both
    // at lagoonY+0.18): coplanar z-fighting through CircleGeometry's
    // triangle fan — the reported star-shaped flicker radiating from the
    // center. The pool now has a real section: a dark sandy basin floor
    // 4 cm above the plaza, and the water surface up at the rim's throat.
    const basinFloor = new MeshStandardNodeMaterial()
    basinFloor.roughness = 0.95
    const floorRadial = positionWorld.xz.sub(vec2(lagoon.x, lagoon.z)).length()
    basinFloor.colorNode = mix(
      vec3(0.2, 0.23, 0.19),
      vec3(0.34, 0.33, 0.24),
      fbm2(positionWorld.xz.mul(1.4)),
    ).mul(float(1).sub(floorRadial.div(lagoon.radius).pow(3).mul(0.4)))
    this.medium.applyCaustics(basinFloor, 1.3)
    const bed = new Mesh(new CircleGeometry(lagoon.radius - 0.05, 48), basinFloor)
    bed.rotation.x = -Math.PI / 2
    bed.position.set(lagoon.x, lagoonY + 0.22, lagoon.z)
    bed.receiveShadow = true
    this.group.add(bed)

    // The surface: turquoise over the shallows deepening toward the middle,
    // slow crossing swell plus concentric turtle-wake rings, a bright foam
    // thread hugging the marble rim, and grazing-angle sky sheen. One draw.
    const lagoonWater = new MeshStandardNodeMaterial()
    lagoonWater.roughness = 0.1
    lagoonWater.metalness = 0.08
    lagoonWater.transparent = true
    lagoonWater.envMapIntensity = 0.9
    const radial = positionWorld.xz.sub(vec2(lagoon.x, lagoon.z)).length()
    const rings = sin(radial.mul(5.2).sub(this.timeUniform.mul(1.6)))
      .mul(float(1).sub(radial.div(lagoon.radius)).clamp(0, 1))
      .mul(0.35)
    const swellA = sin(positionWorld.x.mul(2.1).add(positionWorld.z.mul(1.3)).add(this.timeUniform.mul(0.8)))
    const swellB = sin(positionWorld.z.mul(3.1).sub(positionWorld.x.mul(1.7)).add(this.timeUniform.mul(1.15)))
    lagoonWater.normalNode = normalize(
      normalGeometry.add(vec3(swellA.mul(0.07).add(rings.mul(0.05)), 0, swellB.mul(0.07))),
    )
    const depthBlend = radial.div(lagoon.radius).oneMinus().pow(1.4)
    const shallow = vec3(0.16, 0.42, 0.42)
    const deep = vec3(0.035, 0.16, 0.2)
    const facing = cameraPosition.sub(positionWorld).normalize().y.abs().clamp(0, 1)
    const sheen = float(1).sub(facing).pow(3)
    const foamEdge = smoothstep(0.4, 0.05, radial.sub(lagoon.radius - 0.75).abs())
      .mul(fbm2(positionWorld.xz.mul(3.2).add(this.timeUniform.mul(0.25))).mul(0.5).add(0.5))
    lagoonWater.colorNode = mix(mix(deep, shallow, depthBlend), vec3(0.32, 0.44, 0.45), sheen)
      .add(vec3(0.5, 0.55, 0.52).mul(foamEdge.mul(0.35)))
    lagoonWater.opacityNode = float(0.82).add(sheen.mul(0.12)).add(foamEdge.mul(0.1))
    lagoonWater.emissiveNode = vec3(0.004, 0.014, 0.016)
    this.medium.applyCaustics(lagoonWater, 0.5)
    const water = new Mesh(new CircleGeometry(lagoon.radius - 0.12, 64), lagoonWater)
    water.rotation.x = -Math.PI / 2
    water.position.set(lagoon.x, lagoonY + 0.46, lagoon.z)
    water.receiveShadow = true
    this.group.add(water)
    // Four open balustrade quadrants give the lagoon a finished feeding edge
    // while preserving broad access gaps and clear views to the turtles.
    for (let quadrant = 0; quadrant < 4; quadrant++) {
      const start = quadrant * Math.PI / 2 + 0.22
      const end = (quadrant + 1) * Math.PI / 2 - 0.22
      const segments = 5
      for (let i = 0; i < segments; i++) {
        const a = start + (end - start) * (i / segments)
        const b = start + (end - start) * ((i + 1) / segments)
        kit.balustrade(
          writer,
          lagoon.x + Math.sin(a) * (lagoon.radius + 0.05),
          lagoon.z + Math.cos(a) * (lagoon.radius + 0.05),
          lagoon.x + Math.sin(b) * (lagoon.radius + 0.05),
          lagoon.z + Math.cos(b) * (lagoon.radius + 0.05),
          lagoonY + 0.3,
        )
      }
    }

    const sun = menagerie.sunGarden
    const sunY = terrainHeight(sun.x, sun.z) + 0.08
    kit.mosaicPlaza(writer, sun.x, sunY, sun.z, 9)
    const sunStations: { x: number; z: number }[] = []
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2
      const x = sun.x + Math.sin(angle) * 8
      const z = sun.z + Math.cos(angle) * 8
      sunStations.push({ x, z })
      kit.column(writer, x, sunY + 0.18, z, 4.8, 0.23)
      physics.addStaticBox(x, sunY + 2.5, z, 0.29, 2.4, 0.29)
    }
    for (let i = 0; i < sunStations.length; i++) {
      const a = sunStations[i]
      const b = sunStations[(i + 1) % sunStations.length]
      kit.arch(writer, a.x, a.z, b.x, b.z, sunY + 4.98, 0.9)
      kit.cornice(writer, a.x, a.z, b.x, b.z, sunY + 5.04)
    }
    kit.dome(writer, sun.x, sunY + 5.15, sun.z, 8.5, 14)
    physics.addStaticCylinder(sun.x, sunY + 0.08, sun.z, 0.14, 9.4)
    this.buildSunGardenInterior(kit, writer, sun.x, sunY, sun.z)

    // ── The gardens junction: a proper court, not five paths colliding ────
    // The hub road, the overlook road, and all three garden spokes used to
    // meet at bare crossing plates. A small roundabout plaza owns the node;
    // every spoke now starts at its rim.
    const junctionY = terrainHeight(menagerie.x, menagerie.z)
    kit.mosaicPlaza(writer, menagerie.x, junctionY, menagerie.z, 6.5)
    physics.addStaticCylinder(menagerie.x, junctionY + 0.09, menagerie.z, 0.16, 6.8)
    for (const [lx, lz] of [
      [menagerie.x - 4.6, menagerie.z - 4.2],
      [menagerie.x + 4.6, menagerie.z + 4.2],
    ] as const) {
      this.services.amenities.addLamp(lx, junctionY + 0.18, lz)
      physics.addStaticBox(lx, junctionY + 1.88, lz, 0.12, 1.7, 0.12)
    }

    // Short grounded links make the three exhibits read as one district.
    const spokeStart = (endX: number, endZ: number): [number, number] => {
      const dx = endX - menagerie.x
      const dz = endZ - menagerie.z
      const inv = 6.5 / Math.max(0.001, Math.hypot(dx, dz))
      return [menagerie.x + dx * inv, menagerie.z + dz * inv]
    }
    const links: readonly [[number, number], [number, number]][] = [
      [spokeStart(jelly.x + jelly.radius, jelly.z), [jelly.x + jelly.radius, jelly.z]],
      [spokeStart(lagoon.x, lagoon.z + lagoon.radius), [lagoon.x, lagoon.z + lagoon.radius]],
      [spokeStart(sun.x - 7.5, sun.z - 3), [sun.x - 7.5, sun.z - 3]],
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

  /**
   * The Sun Garden's living interior (design §7: "a greenhouse of flowers
   * and butterflies"; the sign reads LIVING CORAL COURT). A brass sun
   * lantern is the garden's own sun; a raised parterre ring blooms with
   * golden anemones and sea-fern fronds; planters, benches, and a warm
   * light fill the dome. The butterflies themselves are built separately
   * (GPU-fluttered instances).
   */
  private buildSunGardenInterior(
    kit: ArchKit,
    writer: SlotWriter,
    x: number,
    floorY: number,
    z: number,
  ): void {
    const lib = this.services.materials.lib!
    const { physics } = this.services

    // The sun lantern: marble pedestal, brass calyx, glowing globe, rays.
    const pedestal = new LatheGeometry(
      [
        new Vector2(0.06, 0),
        new Vector2(0.85, 0),
        new Vector2(0.9, 0.1),
        new Vector2(0.6, 0.24),
        new Vector2(0.42, 0.42),
        new Vector2(0.36, 1.0),
        new Vector2(0.44, 1.2),
        new Vector2(0.56, 1.28),
        new Vector2(0.6, 1.36),
        new Vector2(0.06, 1.38),
        new Vector2(0.06, 0),
      ],
      22,
    )
    writer.place(lib.marble, pedestal, x, floorY + 0.18, z)
    pedestal.dispose()
    const sunGlobe = new SphereGeometry(0.55, 22, 16)
    writer.place(lib.lampGlobe, sunGlobe, x, floorY + 2.25, z)
    sunGlobe.dispose()
    const ray = new ConeGeometry(0.07, 0.5, 8)
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2
      const direction = new Vector3(Math.sin(angle), Math.cos(angle) * 0.35 + 0.12, Math.cos(angle))
      // Rays radiate in a tilted fan around the globe, tips outward.
      const flat = new Vector3(Math.sin(angle), 0.15, Math.cos(angle)).normalize()
      const from = new Vector3(x, floorY + 2.25, z).addScaledVector(flat, 0.5)
      const matrix = new Matrix4().compose(
        from.clone().addScaledVector(flat, 0.22),
        new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), flat),
        new Vector3(1, 1, 1),
      )
      writer.emit(lib.brass, ray, matrix)
      void direction
    }
    ray.dispose()
    physics.addStaticCylinder(x, floorY + 0.85, z, 0.85, 0.92)
    const glow = new PointLight(0xffd9a0, 8.5, 17, 1.7)
    glow.position.set(x, floorY + 2.3, z)
    this.group.add(glow)

    // Parterre: an annular raised bed around the pedestal — closed marble
    // curb ring, soil fill, golden anemone blooms, and arcing fronds.
    const curb = new LatheGeometry(
      [
        new Vector2(2.1, 0),
        new Vector2(3.45, 0),
        new Vector2(3.5, 0.14),
        new Vector2(3.42, 0.34),
        new Vector2(3.28, 0.38),
        new Vector2(3.22, 0.3),
        new Vector2(2.32, 0.3),
        new Vector2(2.26, 0.38),
        new Vector2(2.12, 0.34),
        new Vector2(2.05, 0.14),
        new Vector2(2.1, 0),
      ],
      48,
    )
    writer.place(lib.marble, curb, x, floorY + 0.18, z)
    curb.dispose()
    const soilRing = new LatheGeometry(
      [
        new Vector2(2.25, 0.24),
        new Vector2(3.28, 0.24),
        new Vector2(3.2, 0.32),
        new Vector2(2.76, 0.36),
        new Vector2(2.32, 0.32),
        new Vector2(2.25, 0.24),
      ],
      48,
    )
    writer.place(lib.soil, soilRing, x, floorY + 0.18, z)
    soilRing.dispose()
    physics.addStaticCylinder(x, floorY + 0.36, z, 0.18, 3.5)

    // Golden anemones: fluted stalk, petal crown, nacre heart.
    const stalk = new LatheGeometry(
      [
        new Vector2(0.09, 0),
        new Vector2(0.05, 0.08),
        new Vector2(0.04, 0.2),
        new Vector2(0.07, 0.26),
        new Vector2(0.1, 0.3),
        new Vector2(0.02, 0.33),
      ],
      10,
    )
    const petal = new ConeGeometry(0.035, 0.16, 6)
    const heart = new SphereGeometry(0.05, 10, 8)
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2 + 0.31
      const radius = 2.5 + (i % 2) * 0.55
      const ax = x + Math.sin(angle) * radius
      const az = z + Math.cos(angle) * radius
      const ay = floorY + 0.5
      writer.place(lib.verdigris, stalk, ax, ay, az)
      for (let p = 0; p < 6; p++) {
        const petalAngle = (p / 6) * Math.PI * 2
        const lean = new Vector3(Math.sin(petalAngle), 1.15, Math.cos(petalAngle)).normalize()
        const matrix = new Matrix4().compose(
          new Vector3(ax + lean.x * 0.09, ay + 0.36, az + lean.z * 0.09),
          new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), lean),
          new Vector3(1, 1, 1),
        )
        writer.emit(lib.brass, petal, matrix)
      }
      writer.place(lib.nacre, heart, ax, ay + 0.35, az)
    }
    stalk.dispose()
    petal.dispose()
    heart.dispose()
    // Fronds arc outward from the bed between the blooms.
    const bedFrond = frondGeometry([
      new Vector3(0.04, 0.4, 0),
      new Vector3(0.14, 0.72, 0),
      new Vector3(0.3, 0.94, 0),
      new Vector3(0.46, 1.02, 0),
    ])
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2
      const ax = x + Math.sin(angle) * 2.85
      const az = z + Math.cos(angle) * 2.85
      writer.place(lib.foliage, bedFrond, ax, floorY + 0.18, az, angle + 0.35)
    }
    bedFrond.dispose()

    // Corner planters and two benches facing the sun.
    for (const [px, pz] of [
      [x - 5.6, z - 3.4],
      [x + 5.6, z + 3.4],
      [x - 3.4, z + 5.6],
      [x + 3.4, z - 5.6],
    ] as const) {
      kit.urn(writer, px, floorY + 0.18, pz, 0.95)
      physics.addStaticCylinder(px, floorY + 0.18 + 0.57, pz, 0.57, 0.44)
    }
    for (const side of [-1, 1]) {
      const bx = x + side * 5.4
      const bz = z - side * 1.6
      this.services.amenities.addBenchFacing(bx, floorY + 0.26, bz, x, z)
      const yaw = Math.atan2(bx - x, bz - z) + Math.PI
      physics.addStaticBox(bx, floorY + 0.58, bz, 0.9, 0.34, 0.3, yaw)
    }

    registerBookmark({
      name: 'sun-garden',
      position: [x + 11, floorY + 2.4, z + 9],
      look: [x, floorY + 2.2, z],
      note: 'The Sun Garden — blooms and butterflies under glass',
    })
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
    markDynamicShadowCasters(smallRays)
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
    markDynamicShadowCasters(manta)
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
    markDynamicShadowCasters(turtles)
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
    // Livelier medusae: the bell contraction carries a second harmonic
    // shimmer, each contraction DARTS the animal upward (asymmetric — jets
    // rise on the squeeze, then sink), and the tentacle strands billow
    // behind the sway instead of hanging rigid.
    const shimmer = sin(this.timeUniform.mul(4.35).add(phase.mul(1.3))).mul(0.03)
    const pulseScale = float(1).add(pulse.mul(0.11).add(shimmer).mul(pulseWeight))
    const dart = pulse.max(0).pow(1.6).mul(0.42)
    const billow = sin(this.timeUniform.mul(0.8).add(phase.mul(1.9)))
      .mul(pulseWeight)
      .mul(0.28)
    const flow = currentFlow(origin, this.timeUniform)
    material.positionNode = origin
      .add(vec3(
        relative.x.mul(pulseScale).add(billow),
        relative.y.mul(float(1).sub(pulse.mul(0.07))),
        relative.z.mul(pulseScale).add(billow.mul(-0.6)),
      ))
      .add(flow.mul(vec3(0.85, 0.22, 0.85)))
      .add(vec3(0, sin(this.timeUniform.mul(0.55).add(phase)).mul(0.34).add(dart), 0))
    material.colorNode = bioluminescent
      ? mix(vec3(0.13, 0.4, 0.48), vec3(0.42, 0.82, 0.78), pulse.mul(0.5).add(0.5))
      : mix(vec3(0.33, 0.47, 0.5), vec3(0.76, 0.68, 0.77), pulse.mul(0.5).add(0.5))
    material.emissiveNode = bioluminescent
      ? vec3(0.08, 0.32, 0.38).mul(pulse.mul(0.5).add(0.8))
      : vec3(0.012, 0.03, 0.036).mul(pulse.mul(0.35).add(0.85))
    material.opacityNode = float(bioluminescent ? 0.78 : 0.58)
    this.medium.applyCaustics(material, bioluminescent ? 0.2 : 0.65)
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    mesh.frustumCulled = true
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.name = bioluminescent ? 'wildlife-jellies:bioluminescent' : 'wildlife-jellies:court'
    markMainDetail(mesh)
    this.group.add(mesh)
    return { mesh, material }
  }

  /**
   * Sun Garden sea butterflies: 44 pteropods drifting under the dome. All
   * motion is vertex TSL against instanceOrigin/instancePhase (the jelly
   * pattern) — drift bob, gentle orbit sway, and wingbeats through the
   * morphWeight flutter channel. Zero per-frame CPU.
   */
  private buildSunButterflies(rng: Rng): void {
    const geometry = createSunButterflyGeometry()
    this.geometries.set('sun-butterfly', geometryMetrics(geometry))
    const sun = PARK_PLAN.menagerie.sunGarden
    const sunY = terrainHeight(sun.x, sun.z) + 0.08
    const count = 44
    const origins = new Float32Array(count * 3)
    const phases = new Float32Array(count)
    const material = new MeshStandardNodeMaterial()
    material.roughness = 0.45
    material.metalness = 0.12
    const mesh = new InstancedMesh(geometry, material, count)
    const matrix = new Matrix4()
    const quaternion = new Quaternion()
    const scaleVector = new Vector3()
    for (let i = 0; i < count; i++) {
      const angle = rng.range(0, Math.PI * 2)
      const radius = Math.sqrt(rng.next()) * 6.4
      const x = sun.x + Math.cos(angle) * radius
      const z = sun.z + Math.sin(angle) * radius
      const y = sunY + rng.range(1.0, 4.2)
      origins.set([x, y, z], i * 3)
      phases[i] = rng.range(0, Math.PI * 2)
      quaternion.setFromAxisAngle(this.up, rng.range(0, Math.PI * 2))
      const s = rng.range(0.75, 1.35)
      scaleVector.set(s, s, s)
      matrix.compose(new Vector3(x, y, z), quaternion, scaleVector)
      mesh.setMatrixAt(i, matrix)
    }
    geometry.setAttribute('instanceOrigin', new InstancedBufferAttribute(origins, 3))
    geometry.setAttribute('instancePhase', new InstancedBufferAttribute(phases, 1))
    const origin = attribute('instanceOrigin', 'vec3') as unknown as Node<'vec3'>
    const phase = attribute('instancePhase', 'float') as unknown as Node<'float'>
    const flutter = attribute('morphWeight', 'float') as unknown as Node<'float'>
    const relative = positionLocal.sub(origin)
    // Wingbeats: quick sine on the flutter channel; drift: slow lissajous
    // around the home point, rising and sinking like blossom on a draught.
    const beat = sin(this.timeUniform.mul(9.5).add(phase.mul(3)))
    const driftX = sin(this.timeUniform.mul(0.31).add(phase)).mul(1.1)
    const driftY = sin(this.timeUniform.mul(0.45).add(phase.mul(1.7))).mul(0.55)
    const driftZ = sin(this.timeUniform.mul(0.26).add(phase.mul(2.3))).mul(1.1)
    material.positionNode = origin
      .add(relative)
      .add(vec3(0, beat.mul(flutter).mul(0.045), 0))
      .add(vec3(driftX, driftY, driftZ))
    // Warm garden palette: gold through rose, pearled bellies, a soft glow
    // so they read against the dome's shade.
    const hue = sin(phase.mul(2.1)).mul(0.5).add(0.5)
    const goldWing = vec3(0.92, 0.62, 0.22)
    const roseWing = vec3(0.85, 0.4, 0.38)
    material.colorNode = mix(
      mix(goldWing, roseWing, hue),
      vec3(0.95, 0.9, 0.82),
      positionGeometry.y.mul(8).clamp(0, 0.5),
    )
    material.emissiveNode = mix(goldWing, roseWing, hue).mul(0.06)
    this.medium.applyCaustics(material, 0.8)
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    mesh.frustumCulled = true
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.name = 'wildlife-sun-butterflies'
    markMainDetail(mesh)
    this.group.add(mesh)
    this.denseDraws.push({ mesh, material })
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
    void dt
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
    for (let i = 0; i < 8; i++) {
      const u = (this.turtlePhases[i] + elapsed * (0.005 + i * 0.0002)) % 1
      this.turtleCurve.getPointAt(u, this.position)
      this.turtleCurve.getTangentAt(u, this.tangent).normalize()
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
      seahorses: 40,
      sunButterflies: 44,
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
