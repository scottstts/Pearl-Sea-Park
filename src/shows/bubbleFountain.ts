import {
  AdditiveBlending,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import {
  abs,
  cameraPosition,
  cos,
  float,
  fract,
  hash,
  instanceIndex,
  mix,
  normalGeometry,
  normalView,
  normalize,
  positionGeometry,
  positionViewDirection,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { SlotWriter } from '../archkit/writer'
import { registerBookmark } from '../core/debug'
import { markMainDetail } from '../render/layers'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { SeaMediumSystem } from '../sea/medium'
import type { DistrictServices } from '../world/districts/atrium'
import { PARK_PLAN, anchorGround } from '../world/parkPlan'

const JET_COUNT = 32 // 8 crown + 8 mid-tier + 16 outer ring
const SHOW_SECONDS = 180
const OUTER_RING_RADIUS = 17
const CROWN_RING_RADIUS = 0.92
const MID_RING_RADIUS = 4.15
// Sculpture-relative jet mouth heights (above the pool floor).
const CROWN_MOUTH = 3.62
const MID_MOUTH = 1.24

export interface FountainSnapshot {
  active: boolean
  validation: boolean
  localTime: number
  section: string
  envelope: number
  heightMeters: number
  ringRadiusMeters: number
  bubbles: number
  drawCalls: number
}

interface FountainCue {
  section: string
  envelope: number
  crown: number
  mid: number
  outer: number
  lean: number
  spiral: number
  chase: number
  burst: number
  warmth: number
}

/**
 * Tidal Court's Bubble Fountain — "the Bellagio inverted" (design §places 4,
 * postcard 10). A permanent tiered marble/verdigris centerpiece carries three
 * fixed rings of brass jet mouths; choreographed columns of light-threaded
 * air fire from those real nozzles, dissolving just under the Silver Ceiling.
 * Between shows the fountain never dies: a gentle crown-and-tier breathing
 * keeps the court alive, with the full outer ring reserved for the show.
 *
 * Perf shape: one static slot-compiled sculpture, one small always-on ambient
 * bubble pool (crown+mid jets only), one show-only bubble pool that is fully
 * hidden between shows, and one 32-instance light-thread pool. Instances
 * recycle by age; choreography never allocates during play.
 */
export class BubbleFountainSystem implements GameSystem {
  readonly id = 'bubble-fountain'

  private readonly services: DistrictServices
  private readonly medium: SeaMediumSystem
  private readonly group = new Object3D()
  private readonly timeUniform = uniform(0)
  private readonly envelopeUniform = uniform(0.3)
  private readonly crownUniform = uniform(4.2)
  private readonly midUniform = uniform(2.2)
  private readonly outerUniform = uniform(0)
  private readonly leanUniform = uniform(0.05)
  private readonly spiralUniform = uniform(0.1)
  private readonly chaseUniform = uniform(0)
  private readonly burstUniform = uniform(0.9)
  private readonly warmthUniform = uniform(0)
  private readonly lights: PointLight[] = []
  private showPool: InstancedMesh | null = null
  private bubbleCount = 0
  private active = false
  private validation = false
  private startTime = 0
  private localTime = 0
  private endFade = 0
  private section = 'idle'
  private debugCanvas: HTMLCanvasElement | null = null
  private readonly effectMaterials: (MeshStandardNodeMaterial | MeshBasicNodeMaterial)[] = []

  constructor(services: DistrictServices, medium: SeaMediumSystem) {
    this.services = services
    this.medium = medium
  }

  init(ctx: GameContext): void {
    const { x, z } = PARK_PLAN.tidalCourt
    const floorY = anchorGround(PARK_PLAN.tidalCourt) + 0.1 // pool basin floor (parkAssembly)
    const waterY = floorY + 0.42 // the reflecting pool's water disc
    this.validation = ctx.flags.view === 'fountain'
    this.bubbleCount = ctx.quality.params.bubbleBudget

    this.buildCenterpiece(x, floorY, waterY, z)

    const ambientCount = Math.max(96, Math.round(this.bubbleCount * 0.3))
    const showCount = Math.max(128, this.bubbleCount - ambientCount)
    const bubbleGeometry = new SphereGeometry(1, 10, 7)
    // The pools share instanceIndex space — distinct seed offsets keep a
    // show bubble from duplicating its ambient twin at the same jet.
    const ambient = new InstancedMesh(
      bubbleGeometry,
      this.buildBubbleMaterial(ctx, x, floorY, waterY, z, 16, 0),
      ambientCount,
    )
    const show = new InstancedMesh(
      bubbleGeometry,
      this.buildBubbleMaterial(ctx, x, floorY, waterY, z, JET_COUNT, 977),
      showCount,
    )
    for (const pool of [ambient, show]) {
      fillIdentityInstances(pool)
      pool.frustumCulled = false
      pool.castShadow = false
      pool.receiveShadow = false
      markMainDetail(pool)
    }
    ambient.name = 'show:bubble-ambient'
    show.name = 'show:bubble-show'
    show.visible = false
    this.showPool = show
    this.group.add(ambient, show)

    this.buildLightThreads(ctx, x, floorY, waterY, z)
    this.buildLights(x, waterY, z)
    ctx.scene.add(this.group)
    if (ctx.flags.debug) this.debugCanvas = ctx.renderer.domElement

    ctx.events.on('schedule/event', ({ name, phase }) => {
      if (name !== 'fountain-show' || this.validation) return
      if (phase === 'start') {
        this.active = true
        this.startTime = ctx.time.elapsed
      } else {
        this.active = false
      }
    })

    registerBookmark({
      name: 'fountain',
      position: [x + 45, waterY + 4.1, z + 51],
      look: [x, waterY + 13, z],
      note: 'Postcard 10 — the Bubble Fountain crown over Tidal Court',
    })
  }

  update(ctx: GameContext, dt: number): void {
    // The clock NEVER resets — bubble recycling reads absolute time, and a
    // reset would teleport every airborne bubble at show start.
    this.timeUniform.value = ctx.time.elapsed

    if (this.validation) {
      this.active = true
      this.localTime = 126 + Math.sin(ctx.time.elapsed * 0.08) * 2.5
    } else if (this.active) {
      this.localTime = Math.max(0, ctx.time.elapsed - this.startTime)
      if (this.localTime >= SHOW_SECONDS) this.active = false
    }

    const cue = this.active ? showCue(this.localTime) : idleCue()
    // Six-second glide back to the idle breathing after the finale cuts out.
    if (!this.active && !this.validation) {
      this.endFade = Math.min(1, this.endFade + dt / 6)
    } else {
      this.endFade = 0
    }
    const idle = idleCue()
    const blend = this.active || this.validation ? 0 : this.endFade
    const mixCue = (a: number, b: number) => a + (b - a) * blend
    this.section = blend >= 1 ? 'idle' : cue.section
    this.envelopeUniform.value = mixCue(cue.envelope, idle.envelope)
    this.crownUniform.value = mixCue(cue.crown, idle.crown)
    this.midUniform.value = mixCue(cue.mid, idle.mid)
    this.outerUniform.value = mixCue(cue.outer, idle.outer)
    this.leanUniform.value = mixCue(cue.lean, idle.lean)
    this.spiralUniform.value = mixCue(cue.spiral, idle.spiral)
    this.chaseUniform.value = mixCue(cue.chase, idle.chase)
    this.burstUniform.value = mixCue(cue.burst, idle.burst)
    this.warmthUniform.value = mixCue(cue.warmth, idle.warmth)

    // The show pool only exists on stage during (and briefly after) a show.
    if (this.showPool) {
      this.showPool.visible = this.active || this.validation || blend < 1
    }

    const showGlow = this.active || this.validation ? 1 : 1 - blend
    for (let index = 0; index < this.lights.length; index++) {
      const pulse = 0.72 + 0.28 * Math.sin(this.localTime * 2.1 + index * 1.7)
      this.lights[index].intensity =
        this.envelopeUniform.value * pulse * (this.warmthUniform.value > 0.5 ? 19 : 13) * showGlow
      this.lights[index].visible = showGlow > 0.02
    }

    if (this.debugCanvas && ctx.time.frame % 30 === 0) {
      this.debugCanvas.dataset.fountainState = JSON.stringify(this.debugSnapshot())
    }
  }

  debugSnapshot(): FountainSnapshot {
    return {
      active: this.active,
      validation: this.validation,
      localTime: this.localTime,
      section: this.section,
      envelope: Number(this.envelopeUniform.value),
      heightMeters: Number(this.crownUniform.value),
      ringRadiusMeters: OUTER_RING_RADIUS,
      bubbles: this.bubbleCount,
      drawCalls: 4,
    }
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
    this.group.traverse((object) => {
      if (object instanceof Mesh || object instanceof InstancedMesh) {
        object.geometry.dispose()
      }
    })
    for (const material of this.effectMaterials) material.dispose()
    if (this.debugCanvas) delete this.debugCanvas.dataset.fountainState
  }

  // ── The permanent centerpiece: tiers, calyx, pearl, and jet mouths ──────
  private buildCenterpiece(x: number, floorY: number, waterY: number, z: number): void {
    const lib = this.services.materials.lib
    if (!lib) throw new Error('BubbleFountainSystem requires park materials')
    const w = new SlotWriter()

    // The tier lathes are sculpted with concave scallop pockets, so their far
    // interior wall faces the camera through the openings and single-sided
    // culling reads as see-through incisions. Double-sided CLONES (own slot,
    // one extra draw each — centerpiece only) render those inner walls while
    // the park-wide marble/verdigris/brass stay FrontSide.
    const twoSided = (m: MeshStandardNodeMaterial) => {
      const clone = m.clone()
      clone.side = DoubleSide
      return clone
    }
    const marbleTwoSided = twoSided(lib.marble)
    const verdigrisTwoSided = twoSided(lib.verdigris)
    const brassTwoSided = twoSided(lib.brass)

    // Tier 1: marble basin drum. Closed clockwise lathe — underside, plinth,
    // fluted drum, projecting rolled rim, then the interior dish that the
    // mid-ring nozzles stand in. Watertight; no culled backfaces from deck.
    const tierOne = new LatheGeometry(
      [
        new Vector2(0.2, 0),
        new Vector2(4.95, 0),
        new Vector2(5.1, 0.12),
        new Vector2(5.05, 0.3),
        new Vector2(4.6, 0.42),
        new Vector2(4.55, 0.78),
        new Vector2(4.85, 0.9),
        new Vector2(5.0, 1.02),
        new Vector2(4.95, 1.15),
        new Vector2(4.35, 1.18),
        new Vector2(4.25, 0.95),
        new Vector2(1.05, 0.82),
        new Vector2(0.2, 0.8),
        new Vector2(0.2, 0),
      ],
      56,
    )
    w.emit(marbleTwoSided, tierOne, new Matrix4().setPosition(x, floorY, z))

    // Tier 2: verdigris stem and scallop bowl, closed with interior — and
    // now genuinely scalloped: sixteen gadroon lobes carved into the flare
    // (y 2.1–2.9, fading at both ends) so the "scallop bowl" earns its name.
    const tierTwo = new LatheGeometry(
      [
        new Vector2(0.16, 0.8),
        new Vector2(0.92, 0.8),
        new Vector2(0.98, 0.9),
        new Vector2(0.72, 1.05),
        new Vector2(0.6, 1.3),
        new Vector2(0.58, 1.75),
        new Vector2(0.75, 1.95),
        new Vector2(1.5, 2.2),
        new Vector2(2.0, 2.36),
        new Vector2(2.4, 2.5),
        new Vector2(2.72, 2.64),
        new Vector2(2.95, 2.78),
        new Vector2(3.05, 2.9),
        new Vector2(2.98, 3.0),
        new Vector2(2.55, 2.98),
        new Vector2(2.4, 2.82),
        new Vector2(1.35, 2.6),
        new Vector2(0.5, 2.52),
        new Vector2(0.16, 2.5),
        new Vector2(0.16, 0.8),
      ],
      64,
    )
    {
      const position = tierTwo.getAttribute('position')
      const vertex = new Vector3()
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i)
        const radial = Math.hypot(vertex.x, vertex.z)
        if (radial < 0.7) continue
        const zone =
          Math.max(0, Math.min(1, (vertex.y - 2.05) / 0.25)) *
          Math.max(0, Math.min(1, (2.98 - vertex.y) / 0.12))
        if (zone <= 0) continue
        const angle = Math.atan2(vertex.x, vertex.z)
        const lobe = Math.abs(Math.sin(angle * 8))
        const scale = 1 + 0.05 * lobe * zone
        position.setX(i, vertex.x * scale)
        position.setZ(i, vertex.z * scale)
      }
      position.needsUpdate = true
      tierTwo.computeVertexNormals()
    }
    w.emit(verdigrisTwoSided, tierTwo, new Matrix4().setPosition(x, floorY, z))

    // Tier 3: brass calyx cradling the hero pearl.
    const calyx = new LatheGeometry(
      [
        new Vector2(0.14, 2.5),
        new Vector2(0.52, 2.52),
        new Vector2(0.6, 2.62),
        new Vector2(0.5, 2.8),
        new Vector2(0.55, 3.1),
        new Vector2(0.85, 3.38),
        new Vector2(1.0, 3.52),
        new Vector2(1.02, 3.6),
        new Vector2(0.92, 3.62),
        new Vector2(0.72, 3.5),
        new Vector2(0.55, 3.3),
        new Vector2(0.2, 3.2),
        new Vector2(0.14, 3.18),
        new Vector2(0.14, 2.5),
      ],
      36,
    )
    w.emit(brassTwoSided, calyx, new Matrix4().setPosition(x, floorY, z))
    const pearl = new SphereGeometry(0.85, 28, 20)
    w.emit(lib.nacre, pearl, new Matrix4().setPosition(x, floorY + 3.9, z))

    // Eight brass scroll struts tie the bowl's underside to the tier-one
    // dish — point-to-point members with sphere knuckles, never floating.
    const strutProto = new CylinderGeometry(1, 1, 1, 8)
    const knuckle = new SphereGeometry(0.085, 10, 8)
    const up = new Vector3(0, 1, 0)
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + Math.PI / 8
      const sinA = Math.sin(angle)
      const cosA = Math.cos(angle)
      const a = new Vector3(x + sinA * 1.55, floorY + 0.84, z + cosA * 1.55)
      const b = new Vector3(x + sinA * 2.62, floorY + 2.52, z + cosA * 2.62)
      const direction = new Vector3().subVectors(b, a)
      const transform = new Matrix4().compose(
        new Vector3().addVectors(a, b).multiplyScalar(0.5),
        new Quaternion().setFromUnitVectors(up, direction.clone().normalize()),
        new Vector3(0.06, direction.length(), 0.06),
      )
      w.emit(lib.brass, strutProto, transform)
      const knuckleLow = new Matrix4().setPosition(a.x, a.y, a.z)
      const knuckleHigh = new Matrix4().setPosition(b.x, b.y, b.z)
      w.emit(lib.brass, knuckle, knuckleLow)
      w.emit(lib.brass, knuckle, knuckleHigh)
    }

    // Crown jet mouths: eight brass horns around the calyx lip.
    const crownNozzle = new CylinderGeometry(0.05, 0.085, 0.26, 10)
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2
      const m = new Matrix4().setPosition(
        x + Math.sin(angle) * CROWN_RING_RADIUS,
        floorY + CROWN_MOUTH - 0.1,
        z + Math.cos(angle) * CROWN_RING_RADIUS,
      )
      w.emit(lib.brass, crownNozzle, m)
    }
    // Mid jet mouths: eight tilted horns in the tier-one dish.
    const midNozzle = new CylinderGeometry(0.06, 0.11, 0.34, 10)
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + Math.PI / 8
      const sinA = Math.sin(angle)
      const cosA = Math.cos(angle)
      const tilt = new Matrix4().makeRotationAxis(
        new Vector3(cosA, 0, -sinA),
        0.21,
      )
      tilt.setPosition(x + sinA * MID_RING_RADIUS, floorY + MID_MOUTH - 0.12, z + cosA * MID_RING_RADIUS)
      w.emit(lib.brass, midNozzle, tilt)
    }

    // Outer ring: sixteen verdigris lily nozzles rising from the pool floor
    // through the water, brass throats just proud of the surface. Closed
    // lathes (the flare has a real interior).
    const lilyHeight = waterY - floorY + 0.24
    const lily = new LatheGeometry(
      [
        new Vector2(0.04, 0),
        new Vector2(0.3, 0),
        new Vector2(0.32, 0.05),
        new Vector2(0.14, 0.14),
        new Vector2(0.085, lilyHeight - 0.3),
        new Vector2(0.15, lilyHeight - 0.08),
        new Vector2(0.175, lilyHeight),
        new Vector2(0.12, lilyHeight - 0.02),
        new Vector2(0.055, lilyHeight - 0.14),
        new Vector2(0.04, 0),
      ],
      18,
    )
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2
      const m = new Matrix4().setPosition(
        x + Math.sin(angle) * OUTER_RING_RADIUS,
        floorY,
        z + Math.cos(angle) * OUTER_RING_RADIUS,
      )
      w.emit(lib.verdigris, lily, m)
    }

    // Eight bronze fish leap around the tier-one dish, arcing over its
    // water — Belle Époque fountain fauna. One merged crescent (torus-arc
    // body with BOTH open ends finished: head sphere one end, tail cone the
    // other — the banquette rule), emitted per fish into the verdigris slot.
    const fishParts: Array<TorusGeometry | SphereGeometry | ConeGeometry> = []
    const fishBody = new TorusGeometry(0.4, 0.115, 9, 20, Math.PI * 0.8)
    fishParts.push(fishBody)
    const headTheta = Math.PI * 0.8
    const head = new SphereGeometry(0.14, 12, 9)
    head.scale(1.05, 0.9, 0.72)
    head.translate(Math.cos(headTheta) * 0.4, Math.sin(headTheta) * 0.4, 0)
    fishParts.push(head)
    const tail = new ConeGeometry(0.11, 0.3, 8)
    tail.rotateZ(-Math.PI / 2)
    tail.scale(1, 1, 0.42)
    tail.translate(0.53, -0.03, 0)
    fishParts.push(tail)
    const dorsal = new SphereGeometry(1, 8, 6)
    dorsal.scale(0.1, 0.15, 0.022)
    const dorsalTheta = Math.PI * 0.42
    dorsal.translate(Math.cos(dorsalTheta) * 0.5, Math.sin(dorsalTheta) * 0.5, 0)
    fishParts.push(dorsal)
    const fishGeometry = mergeGeometries(fishParts, false)!
    for (const part of fishParts) part.dispose()
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + Math.PI / 16
      const lean = i % 2 === 0 ? 0.18 : -0.14
      const pose = new Matrix4()
        .makeRotationZ(lean)
        .premultiply(new Matrix4().makeRotationY(angle + Math.PI / 2))
      pose.setPosition(
        x + Math.sin(angle) * 3.45,
        floorY + 0.98,
        z + Math.cos(angle) * 3.45,
      )
      w.emit(lib.verdigris, fishGeometry, pose)
    }
    fishGeometry.dispose()

    // Pearl swags: strings of nacre beads sag between the crown horns —
    // the calyx wears its jewellery. Seven beads per span on a catenary.
    const swagBead = new SphereGeometry(0.032, 8, 6)
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2
      const a1 = ((i + 1) / 8) * Math.PI * 2
      const from = new Vector3(
        x + Math.sin(a0) * CROWN_RING_RADIUS,
        floorY + CROWN_MOUTH - 0.16,
        z + Math.cos(a0) * CROWN_RING_RADIUS,
      )
      const to = new Vector3(
        x + Math.sin(a1) * CROWN_RING_RADIUS,
        floorY + CROWN_MOUTH - 0.16,
        z + Math.cos(a1) * CROWN_RING_RADIUS,
      )
      for (let bead = 1; bead <= 7; bead++) {
        const t = bead / 8
        const at = from.clone().lerp(to, t)
        at.y -= Math.sin(Math.PI * t) * 0.11
        const bm = new Matrix4().setPosition(at.x, at.y, at.z)
        w.emit(lib.nacre, swagBead, bm)
      }
    }
    swagBead.dispose()

    this.group.add(w.compile())

    // Standing water fills both raised tiers (the mouths fire out of real
    // pools, not dry marble): two one-draw glossy discs sharing a ripple
    // material — the reflecting-pool recipe, never a reflector.
    const tierWater = new MeshStandardNodeMaterial()
    tierWater.roughness = 0.12
    tierWater.metalness = 0.1
    tierWater.envMapIntensity = 0.8
    const ripplePhase = this.timeUniform.mul(0.9)
    tierWater.normalNode = normalize(
      normalGeometry.add(
        vec3(
          sin(positionWorld.x.mul(4.2).add(positionWorld.z.mul(2.6)).add(ripplePhase)).mul(0.07),
          0,
          sin(positionWorld.z.mul(3.8).sub(positionWorld.x.mul(2.2)).add(ripplePhase.mul(1.3))).mul(0.07),
        ),
      ),
    )
    const tierFacing = cameraPosition.sub(positionWorld).normalize().y.abs().clamp(0, 1)
    const tierGrazing = float(1).sub(tierFacing).pow(3)
    tierWater.colorNode = mix(vec3(0.02, 0.1, 0.115), vec3(0.17, 0.3, 0.32), tierGrazing)
    tierWater.emissiveNode = vec3(0.004, 0.016, 0.019)
    this.medium.applyCaustics(tierWater, 0.5)
    this.effectMaterials.push(tierWater)
    for (const [radius, height] of [
      [4.05, 0.93],
      [2.1, 2.68],
    ] as const) {
      const disc = new Mesh(new CircleGeometry(radius, 48), tierWater)
      disc.rotation.x = -Math.PI / 2
      disc.position.set(x, floorY + height, z)
      disc.receiveShadow = true
      this.group.add(disc)
    }
  }

  // ── Shared per-jet frame: fixed mouths, ring-keyed heights and phases ───
  private jetFrame(floorY: number, waterY: number, jetModulo: number) {
    const jet = float(instanceIndex.mod(jetModulo))
    const isCrown = jet.lessThan(8)
    const isMid = jet.greaterThanEqual(8).and(jet.lessThan(16))
    const angle = isCrown
      .select(jet.div(8).mul(Math.PI * 2), isMid.select(
        jet.sub(8).div(8).mul(Math.PI * 2).add(Math.PI / 8),
        jet.sub(16).div(16).mul(Math.PI * 2),
      ))
    const baseRadius = isCrown.select(
      float(CROWN_RING_RADIUS),
      isMid.select(float(MID_RING_RADIUS), float(OUTER_RING_RADIUS)),
    )
    const baseY = isCrown.select(
      float(floorY + CROWN_MOUTH),
      isMid.select(float(floorY + MID_MOUTH), float(waterY + 0.18)),
    )
    const ringHeight = isCrown.select(
      this.crownUniform as unknown as Node<'float'>,
      isMid.select(
        this.midUniform as unknown as Node<'float'>,
        this.outerUniform as unknown as Node<'float'>,
      ),
    )
    const lean = isCrown.select(
      float(0.02),
      isMid.select(
        (this.leanUniform as unknown as Node<'float'>).mul(0.3).add(0.14),
        (this.leanUniform as unknown as Node<'float'>).mul(0.85),
      ),
    )
    const jetPhase = isCrown
      .select(float(0), isMid.select(jet.sub(8).div(8), jet.sub(16).div(16)))
      .mul(this.chaseUniform)
    const radial = vec3(sin(angle), 0, cos(angle))
    const tangent = vec3(radial.z, 0, radial.x.negate())
    return { jet, angle, baseRadius, baseY, ringHeight, lean, jetPhase, radial, tangent }
  }

  private buildBubbleMaterial(
    ctx: GameContext,
    x: number,
    floorY: number,
    waterY: number,
    z: number,
    jetModulo: number,
    seedOffset: number,
  ): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial()
    material.transparent = true
    material.depthWrite = false
    material.side = DoubleSide
    material.roughness = 0.07
    material.metalness = 0.16
    material.envMapIntensity = 1.35

    const frame = this.jetFrame(floorY, waterY, jetModulo)
    const seed = hash(instanceIndex.add(17 + seedOffset))
    const speedJitter = hash(instanceIndex.add(53 + seedOffset)).mul(0.5).add(0.78)
    // Bubbles ride each plume at ~2.3 m/s; age recycles against absolute time.
    const riseTime = frame.ringHeight.div(2.3).max(0.6)
    const age = fract(this.timeUniform.div(riseTime).mul(speedJitter).add(seed))
    // Packet gate: bubbles inherit the firing window of their LAUNCH moment,
    // so a burst travels up the column as a coherent slug of air.
    const launch = this.timeUniform.sub(age.mul(riseTime))
    const packetPhase = fract(launch.mul(0.42).add(frame.jetPhase).add(seed.mul(0.04)))
    const gate = smoothstep(0, 0.12, packetPhase).mul(
      float(1).sub(smoothstep(this.burstUniform, this.burstUniform.add(0.14), packetPhase)),
    )

    const climb = frame.ringHeight.mul(age)
    const drift = frame.radial.mul(frame.lean.mul(climb))
    const swirl = frame.tangent.mul(
      sin(age.mul(9).add(seed.mul(12)).add(this.timeUniform.mul(0.7)))
        .mul(this.spiralUniform)
        .mul(age)
        .mul(0.9),
    )
    // Entrainment cone: tight at the mouth, dispersing near the top.
    const spread = age.pow(1.6).mul(0.55).add(0.04)
    const scatterAngle = hash(instanceIndex.add(211 + seedOffset)).mul(Math.PI * 2)
    const scatter = vec3(sin(scatterAngle), 0, cos(scatterAngle))
      .mul(spread)
      .mul(hash(instanceIndex.add(97 + seedOffset)))
    const wobble = vec3(
      sin(age.mul(23).add(seed.mul(31))),
      0,
      cos(age.mul(19).add(seed.mul(41))),
    ).mul(age.add(0.2).mul(0.06))
    const center = vec3(x, 0, z)
      .add(vec3(0, frame.baseY, 0))
      .add(frame.radial.mul(frame.baseRadius))
      .add(vec3(0, climb, 0))
      .add(drift)
      .add(swirl)
      .add(scatter)
      .add(wobble)

    // Columns dissolve just under the Silver Ceiling — air rejoins the sky.
    const ceilingFade = float(1).sub(smoothstep(-1.8, -0.4, center.y))
    const ageFade = smoothstep(0, 0.08, age).mul(float(1).sub(smoothstep(0.8, 1, age)))
    const visible = ageFade
      .mul(this.envelopeUniform)
      .mul(gate)
      .mul(ceilingFade)

    // Rising bubbles decompress: they grow on the way up.
    const size = mix(0.035, 0.16, hash(instanceIndex.add(131 + seedOffset)).pow(2))
      .mul(mix(0.7, 1.4, age))
      .mul(smoothstep(0.015, 0.1, visible)) // gated bubbles collapse to points
    material.positionNode = center.add(positionGeometry.mul(size))

    const rim = float(1)
      .sub(abs(normalView.dot(positionViewDirection)))
      .pow(2.25)
    const cool = vec3(0.16, 0.72, 1.05)
    const warm = vec3(1.18, 0.52, 0.12)
    const lightColor = mix(cool, warm, this.warmthUniform)
    material.colorNode = mix(vec3(0.04, 0.15, 0.2), lightColor, rim)
    material.emissiveNode = lightColor.mul(rim.pow(3).mul(1.35).mul(visible))
    material.opacityNode = rim.mul(0.68).add(0.025).mul(visible)
    this.medium.applyCaustics(material, 0.18)

    if (ctx.flags.pass === 'fountain-age') {
      material.colorNode = vec3(age)
      material.emissiveNode = vec3(age)
    } else if (ctx.flags.pass === 'fountain-envelope') {
      material.colorNode = vec3(this.envelopeUniform)
      material.emissiveNode = vec3(this.envelopeUniform)
    }

    this.effectMaterials.push(material)
    return material
  }

  // ── Light threads: soft glow cores hugging each plume ───────────────────
  private buildLightThreads(
    ctx: GameContext,
    x: number,
    floorY: number,
    waterY: number,
    z: number,
  ): void {
    const material = new MeshBasicNodeMaterial()
    material.transparent = true
    material.depthWrite = false
    material.side = DoubleSide
    material.blending = AdditiveBlending

    const frame = this.jetFrame(floorY, waterY, JET_COUNT)
    const localHeight = positionGeometry.y.add(0.5)
    // The thread swells with the plume's entrainment cone rather than being
    // a rigid sabre; light lingers slightly longer than the air packet.
    const packetPhase = fract(this.timeUniform.mul(0.42).add(frame.jetPhase))
    const lightGate = smoothstep(0, 0.3, packetPhase).mul(
      float(1).sub(smoothstep(this.burstUniform.add(0.18), this.burstUniform.add(0.4), packetPhase)),
    )
    const climb = frame.ringHeight.mul(localHeight)
    const threadRadius = localHeight.pow(1.5).mul(0.55).add(0.14)
    const center = vec3(x, 0, z)
      .add(vec3(0, frame.baseY, 0))
      .add(frame.radial.mul(frame.baseRadius))
      .add(vec3(0, climb, 0))
      .add(frame.radial.mul(frame.lean.mul(climb)))
      .add(
        frame.tangent.mul(
          sin(localHeight.mul(Math.PI * 2).add(this.timeUniform.mul(0.7)))
            .mul(this.spiralUniform)
            .mul(localHeight)
            .mul(0.9),
        ),
      )
    const shaped = vec3(
      positionGeometry.x.mul(threadRadius),
      0,
      positionGeometry.z.mul(threadRadius),
    )
    material.positionNode = center.add(shaped)

    const ceilingFade = float(1).sub(smoothstep(-1.8, -0.4, center.y))
    const verticalFade = sin(localHeight.mul(Math.PI)).pow(0.8)
    const pulse = sin(this.timeUniform.mul(2.4).add(frame.jet.mul(0.61))).mul(0.2).add(0.8)
    const alive = smoothstep(0.5, 2, frame.ringHeight)
    const cool = vec3(0.08, 0.7, 1.18)
    const warm = vec3(1.42, 0.56, 0.08)
    material.colorNode = vec4(mix(cool, warm, this.warmthUniform).mul(1.15), 1)
    material.opacityNode = verticalFade
      .mul(pulse)
      .mul(this.envelopeUniform)
      .mul(lightGate)
      .mul(alive)
      .mul(ceilingFade)
      .mul(0.2)

    if (ctx.flags.pass === 'fountain-envelope') {
      material.colorNode = vec4(vec3(this.envelopeUniform), 1)
      material.opacityNode = float(1)
    }

    const threads = new InstancedMesh(
      new CylinderGeometry(1, 1, 1, 10, 1, true),
      material,
      JET_COUNT,
    )
    fillIdentityInstances(threads)
    threads.frustumCulled = false
    threads.castShadow = false
    threads.receiveShadow = false
    markMainDetail(threads)
    threads.name = 'show:light-threads'
    this.effectMaterials.push(material)
    this.group.add(threads)
  }

  private buildLights(x: number, y: number, z: number): void {
    for (let index = 0; index < 4; index++) {
      const angle = (index / 4) * Math.PI * 2 + Math.PI / 4
      const light = new PointLight(index % 2 === 0 ? 0x4ad9ff : 0xffb347, 0, 42, 1.45)
      light.position.set(x + Math.sin(angle) * 17, y + 1.1, z + Math.cos(angle) * 17)
      light.visible = false
      this.group.add(light)
      this.lights.push(light)
    }
  }
}

function fillIdentityInstances(mesh: InstancedMesh): void {
  const identity = new Matrix4()
  for (let index = 0; index < mesh.count; index++) mesh.setMatrixAt(index, identity)
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  mesh.instanceMatrix.needsUpdate = true
}

/** The between-shows breathing: crown and tiers alive, outer ring at rest. */
function idleCue(): FountainCue {
  return {
    section: 'idle',
    envelope: 0.32,
    crown: 4.2,
    mid: 2.2,
    outer: 0,
    lean: 0.05,
    spiral: 0.1,
    chase: 0,
    burst: 0.9,
    warmth: 0,
  }
}

/**
 * The 180 s grand show. Sections choreograph ring heights, outward lean,
 * swirl, traveling chase, and burst tightness. Heights stay under the local
 * ceiling budget — the finale crown column dissolves INTO the Silver Ceiling
 * (the shader's ceiling fade owns that dissolve at every depth).
 */
function showCue(time: number): FountainCue {
  const whole = smoothCpu(0, 4, time) * (1 - smoothCpu(174, 180, time))
  if (time < 18) {
    const p = smoothCpu(0, 18, time)
    return {
      section: 'overture',
      envelope: 0.32 + whole * 0.33,
      crown: 4.2 + p * 4.8,
      mid: 2.2 + p * 1.8,
      outer: p * 5,
      lean: 0.05 + p * 0.1,
      spiral: 0.1,
      chase: p * 0.15,
      burst: 0.85,
      warmth: 0.08 * p,
    }
  }
  if (time < 55) {
    const p = smoothCpu(18, 55, time)
    return {
      section: 'fans',
      envelope: whole * 0.78,
      crown: 8 - p,
      mid: 4 + p,
      outer: 5 + p * 8,
      lean: 0.15 + p * 0.4,
      spiral: 0.12,
      chase: 0.15 + p * 0.3,
      burst: 0.5,
      warmth: 0.18,
    }
  }
  if (time < 96) {
    const p = smoothCpu(55, 96, time)
    return {
      section: 'spiral',
      envelope: whole * 0.88,
      crown: 7 + Math.sin(p * Math.PI) * 4,
      mid: 5 + p * 2,
      outer: 13 - p * 3,
      lean: 0.25,
      spiral: 0.4 + p * 0.6,
      chase: 0.7,
      burst: 0.45,
      warmth: 0.18 + p * 0.22,
    }
  }
  if (time < 138) {
    const p = smoothCpu(96, 138, time)
    return {
      section: 'crown',
      envelope: whole,
      crown: 11 + p * 7,
      mid: 7 + Math.sin(p * Math.PI * 2) * 1.5,
      outer: 10 + p * 2,
      lean: 0.3,
      spiral: 0.6,
      chase: 0.5,
      burst: 0.35,
      warmth: 0.4 + p * 0.35,
    }
  }
  if (time < 170) {
    const beat = 0.86 + 0.14 * Math.sin(time * Math.PI * 0.8) ** 2
    return {
      section: 'chorus',
      envelope: whole * beat,
      crown: 16 + beat * 4,
      mid: 8,
      outer: 12 + beat * 3,
      lean: 0.55 + beat * 0.25,
      spiral: 0.55,
      chase: 1,
      burst: 0.3,
      warmth: 0.85,
    }
  }
  const finale = smoothCpu(170, 176, time)
  return {
    section: 'finale',
    envelope: whole,
    crown: 20 + finale * 2,
    mid: 9,
    outer: 14 + finale * 2,
    lean: 0.7 + finale * 0.2,
    spiral: 1,
    chase: 0.8,
    burst: 0.6 + finale * 0.15,
    warmth: 1,
  }
}

function smoothCpu(edge0: number, edge1: number, value: number): number {
  const x = Math.max(0, Math.min(1, (value - edge0) / Math.max(1e-6, edge1 - edge0)))
  return x * x * (3 - 2 * x)
}
