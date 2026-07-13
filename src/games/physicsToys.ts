import type { RigidBody } from '@dimforge/rapier3d-compat'
import {
  BoxGeometry,
  CatmullRomCurve3,
  ConeGeometry,
  CylinderGeometry,
  LatheGeometry,
  Mesh,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { registerBookmark } from '../core/debug'
import { markDynamicShadowCasters } from '../render/layers'
import { SlotWriter } from '../archkit/writer'
import type { GameContext } from '../runtime/context'
import type { DistrictServices } from '../world/districts/atrium'
import { PARK_PLAN } from '../world/parkPlan'
import { terrainHeight } from '../world/terrain'
import type { ArmThrow, DynamicProp } from './types'
import { syncDynamicProp } from './types'
import { emitBackboardFrame, emitCounterJoinery, emitHighStrikerTrim } from './fixtureDetails'

interface ScoredProp extends DynamicProp {
  kind: 'ring' | 'pearl'
}

/** Three physical Midway toys sharing one prize ledger. */
export class PhysicsToys {
  readonly group = new Object3D()

  private readonly services: DistrictServices
  private readonly armThrow: ArmThrow
  private readonly props: ScoredProp[] = []
  private readonly horn = new Vector3()
  private readonly pockets: { position: Vector3; points: number }[] = []
  private puck: { body: RigidBody; mesh: Mesh; restY: number; bellY: number; ringing: boolean } | null = null
  private wins = 0
  private hatAwarded = false
  private plushAwarded = false
  private ringScore = 0
  private pearlScore = 0
  private krakenBest = 0
  private readonly fixtureWriter = new SlotWriter(72)

  constructor(services: DistrictServices, armThrow: ArmThrow) {
    this.services = services
    this.armThrow = armThrow
  }

  init(ctx: GameContext): void {
    const lib = this.services.materials.lib
    const physics = this.services.physics
    if (!lib || !physics.world || !physics.rapier) throw new Error('PhysicsToys requires materials and Rapier')
    const ground = terrainHeight(PARK_PLAN.midway.x, PARK_PLAN.midway.z)
    this.buildNarwhal(ctx, ground)
    this.buildPearlDiver(ctx, ground)
    this.buildKrakenBell(ctx, ground)
    this.group.add(this.fixtureWriter.compile())
    ctx.scene.add(this.group)

    registerBookmark({
      name: 'midway-games',
      position: [100, ground + 1.8, 162],
      look: [100, ground + 1.8, 146],
      note: 'Ring the Narwhal, Pearl Diver, and the Kraken Bell',
    })
  }

  private buildNarwhal(ctx: GameContext, ground: number): void {
    const lib = this.services.materials.lib!
    const { physics, interaction } = this.services
    const world = physics.world!
    const rapier = physics.rapier!
    const x = 86
    const z = 146
    const baseY = ground + 0.45

    const counter = new Mesh(new BoxGeometry(8, 0.9, 2.2), lib.woodDark)
    counter.position.set(x, ground + 0.45, z + 1.2)

    // Marble splash collar the bust breaches out of — a closed clockwise
    // lathe with a real interior, replacing the plain plinth cylinder.
    const collar = new Mesh(
      new LatheGeometry(
        [
          new Vector2(0.2, 0),
          new Vector2(1.6, 0),
          new Vector2(1.66, 0.14),
          new Vector2(1.52, 0.28),
          new Vector2(1.18, 0.38),
          new Vector2(0.95, 0.5),
          new Vector2(0.84, 0.62),
          new Vector2(0.74, 0.6),
          new Vector2(0.66, 0.44),
          new Vector2(0.4, 0.36),
          new Vector2(0.2, 0.34),
          new Vector2(0.2, 0),
        ],
        36,
      ),
      lib.marble,
    )
    collar.position.set(x, baseY - 0.05, z)

    // The narwhal itself: a plump breaching torpedo (closed lathe — belly,
    // shoulders, melon swell, tapering snout), tilted so the snout tip lands
    // exactly under the tusk axis at (x, baseY+1.54, z−0.35). The physics
    // cone and ring-scoring cylinder are untouched.
    const body = new Mesh(
      new LatheGeometry(
        [
          new Vector2(0.02, 0),
          new Vector2(0.34, 0.02),
          new Vector2(0.5, 0.14),
          new Vector2(0.585, 0.38),
          new Vector2(0.6, 0.62),
          new Vector2(0.54, 0.9),
          new Vector2(0.44, 1.1),
          new Vector2(0.36, 1.22),
          new Vector2(0.315, 1.3),
          new Vector2(0.24, 1.38),
          new Vector2(0.12, 1.46),
          new Vector2(0.02, 1.5),
        ],
        28,
      ),
      lib.nacre,
    )
    body.scale.set(0.92, 1, 1) // subtle oval cross-section
    body.rotation.x = -0.32
    body.position.set(x, baseY + 0.12, z + 0.12)

    // Spiral tusk: the visual cone matches the fixed physics cone, and a
    // shrinking helix wrap gives the signature left-hand twist.
    const horn = new Mesh(new ConeGeometry(0.145, 1.55, 18), lib.brass)
    horn.position.set(x, baseY + 2.15, z - 0.35)
    const helixPoints: Vector3[] = []
    for (let i = 0; i <= 36; i++) {
      const t = i / 36
      const angle = t * Math.PI * 6
      const radius = 0.15 * (1 - t) + 0.012
      helixPoints.push(new Vector3(Math.cos(angle) * radius, -0.775 + 1.55 * t, Math.sin(angle) * radius))
    }
    const spiral = new Mesh(
      new TubeGeometry(new CatmullRomCurve3(helixPoints), 72, 0.021, 6),
      lib.brass,
    )
    spiral.position.copy(horn.position)
    this.horn.set(x, baseY + 1.38, z - 0.35)

    this.group.add(counter, collar, body, horn, spiral)

    // Pectoral paddles and both eyes, seated on the tilted body's surface.
    for (const side of [-1, 1]) {
      const fin = new Mesh(new SphereGeometry(1, 14, 10), lib.nacre)
      fin.scale.set(0.4, 0.09, 0.2)
      fin.rotation.y = side * 0.35
      fin.rotation.z = side * -0.55
      fin.position.set(x + side * 0.5, baseY + 0.78, z - 0.02)
      const eye = new Mesh(new SphereGeometry(0.05, 12, 8), lib.iron)
      eye.position.set(x + side * 0.265, baseY + 1.275, z - 0.4)
      this.group.add(fin, eye)
    }

    // Sculpted splash: two carved marble ripple rings breaking around the
    // breaching body, and a pair of little bronze companions leaping the
    // wake (crescent fish — torus-arc bodies with head/tail closing both
    // open ends). Set dressing only; the collider frame is untouched.
    for (const [rippleRadius, rippleY, tube] of [
      [0.78, 0.42, 0.055],
      [1.08, 0.32, 0.042],
    ] as const) {
      const ripple = new Mesh(new TorusGeometry(rippleRadius, tube, 8, 40), lib.marble)
      ripple.rotation.x = Math.PI / 2
      ripple.position.set(x, baseY + rippleY, z + 0.1)
      this.group.add(ripple)
    }
    const companionParts: Array<TorusGeometry | SphereGeometry | ConeGeometry> = []
    const companionBody = new TorusGeometry(0.2, 0.06, 8, 16, Math.PI * 0.85)
    companionParts.push(companionBody)
    const companionHead = new SphereGeometry(0.072, 10, 8)
    companionHead.scale(1, 0.85, 0.7)
    companionHead.translate(Math.cos(Math.PI * 0.85) * 0.2, Math.sin(Math.PI * 0.85) * 0.2, 0)
    companionParts.push(companionHead)
    const companionTail = new ConeGeometry(0.055, 0.16, 7)
    companionTail.rotateZ(-Math.PI / 2)
    companionTail.scale(1, 1, 0.4)
    companionTail.translate(0.27, -0.015, 0)
    companionParts.push(companionTail)
    const companionGeometry = mergeGeometries(companionParts, false)!
    for (const part of companionParts) part.dispose()
    for (const side of [-1, 1]) {
      const companion = new Mesh(companionGeometry, lib.verdigris)
      companion.position.set(x + side * 1.12, baseY + 0.52, z + side * 0.3)
      companion.rotation.y = side * 0.9 + Math.PI / 2
      companion.rotation.z = side * 0.15
      this.group.add(companion)
    }

    emitCounterJoinery(this.fixtureWriter, lib, x, ground, z + 1.2, 8, 2.2)
    physics.addStaticBox(x, ground + 0.45, z + 1.2, 4, 0.45, 1.1)
    physics.addStaticCylinder(x, baseY + 0.2, z, 0.28, 1.7)
    const hornBody = world.createRigidBody(
      rapier.RigidBodyDesc.fixed().setTranslation(x, baseY + 2.15, z - 0.35),
    )
    world.createCollider(rapier.ColliderDesc.cone(0.775, 0.16).setFriction(0.45), hornBody)

    interaction?.register({
      position: new Vector3(x, ground + 1.05, z + 2.7),
      radius: 3.4,
      prompt: 'Take a ring — click to throw',
      onInteract: () =>
        this.armThrow({
          kind: 'ring',
          remaining: 1,
          spawn: (origin, direction) => this.throwRing(origin, direction),
        }),
    })
    void ctx
  }

  private throwRing(origin: Vector3, direction: Vector3): void {
    const { world, rapier } = this.services.physics
    const lib = this.services.materials.lib
    if (!world || !rapier || !lib) return
    const body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(origin.x, origin.y, origin.z)
        .setRotation({ x: 0, y: 0, z: 0, w: 1 })
        .setLinvel(direction.x * 8.5, direction.y * 8.5, direction.z * 8.5)
        .setAngvel({ x: 4.2, y: 1.1, z: -2.8 })
        .setLinearDamping(0.08)
        .setAngularDamping(0.12)
        .setCcdEnabled(true),
    )
    for (let i = 0; i < 14; i++) {
      const angle = (i / 14) * Math.PI * 2
      world.createCollider(
        rapier.ColliderDesc.ball(0.045)
          .setTranslation(Math.cos(angle) * 0.38, 0, Math.sin(angle) * 0.38)
          .setRestitution(0.18)
          .setFriction(0.5)
          .setDensity(1.1),
        body,
      )
    }
    const ringGeometry = new TorusGeometry(0.38, 0.045, 10, 40)
    ringGeometry.rotateX(Math.PI / 2)
    const mesh = new Mesh(ringGeometry, lib.brass)
    mesh.castShadow = true
    mesh.receiveShadow = true
    markDynamicShadowCasters(mesh)
    this.group.add(mesh)
    this.props.push({ body, mesh, age: 0, scored: false, kind: 'ring' })
    this.trimProps('ring', 8)
  }

  private buildPearlDiver(ctx: GameContext, ground: number): void {
    const lib = this.services.materials.lib!
    const { physics, interaction } = this.services
    const world = physics.world!
    const rapier = physics.rapier!
    const x = 100
    const z = 151.5
    const incline = 0.2
    const ramp = new Mesh(new BoxGeometry(5.4, 0.28, 9.6), lib.woodDark)
    ramp.rotation.x = incline
    ramp.position.set(x, ground + 0.95, z)
    ramp.castShadow = true
    ramp.receiveShadow = true
    this.group.add(ramp)
    const rampBody = world.createRigidBody(
      rapier.RigidBodyDesc.fixed()
        .setTranslation(x, ground + 0.95, z)
        .setRotation({ x: Math.sin(incline / 2), y: 0, z: 0, w: Math.cos(incline / 2) }),
    )
    world.createCollider(rapier.ColliderDesc.cuboid(2.7, 0.14, 4.8).setFriction(0.46), rampBody)
    for (const side of [-1, 1]) {
      const lipBody = world.createRigidBody(
        rapier.RigidBodyDesc.fixed()
          .setTranslation(x + side * 2.72, ground + 1.08, z)
          .setRotation({ x: Math.sin(incline / 2), y: 0, z: 0, w: Math.cos(incline / 2) }),
      )
      world.createCollider(rapier.ColliderDesc.cuboid(0.075, 0.2, 4.9).setFriction(0.45), lipBody)
    }
    physics.addStaticBox(x, ground + 2.6, 146.5, 2.9, 1.7, 0.16)

    const backboard = new Mesh(new BoxGeometry(5.8, 3.4, 0.3), lib.canvasCream)
    backboard.position.set(x, ground + 2.6, 146.5)
    this.group.add(backboard)
    emitBackboardFrame(this.fixtureWriter, lib, x, ground + 2.6, 146.27, 5.8, 3.4)

    // Each pocket is a real recessed funnel, not a torus stuck on a flat
    // board: an inward-wound lathe throat (visible interior — the winding
    // faces the axis) capped by a nacre gate disc, behind the brass rim.
    const funnelProfile = new LatheGeometry(
      [
        new Vector2(0.46, 0),
        new Vector2(0.3, -0.18),
        new Vector2(0.16, -0.28),
        new Vector2(0.145, -0.32),
      ],
      24,
    )
    funnelProfile.rotateX(-Math.PI / 2) // throat recedes into the board (+z)
    for (const [offset, height, points] of [
      [-1.45, 2.2, 10],
      [0, 2.85, 50],
      [1.45, 2.2, 20],
    ] as const) {
      const pocket = new Mesh(new TorusGeometry(0.48, 0.075, 10, 32), lib.brass)
      pocket.position.set(x + offset, ground + height, 146.28)
      const funnel = new Mesh(funnelProfile, lib.woodDark)
      funnel.position.copy(pocket.position)
      const gate = new Mesh(new CylinderGeometry(0.15, 0.15, 0.04, 18), lib.nacre)
      gate.rotation.x = Math.PI / 2
      gate.position.set(x + offset, ground + height, 146.58)
      // Brass score lozenge under each pocket mouth.
      const plaque = new Mesh(new BoxGeometry(0.34, 0.34, 0.05), lib.brass)
      plaque.rotation.z = Math.PI / 4
      plaque.position.set(x + offset, ground + height - 0.78, 146.32)
      this.group.add(pocket, funnel, gate, plaque)
      this.pockets.push({ position: pocket.position.clone(), points })
    }

    // Crest and side wings finish the fixture: a scalloped crown rail with
    // a pearl medallion, and two angled return wings tying the board to the
    // ramp so it no longer floats as a lone slab.
    const crownRail = new Mesh(new BoxGeometry(6.1, 0.22, 0.24), lib.woodDark)
    crownRail.position.set(x, ground + 4.42, 146.5)
    const medallionRing = new Mesh(new TorusGeometry(0.3, 0.055, 10, 26), lib.brass)
    medallionRing.position.set(x, ground + 4.75, 146.48)
    const medallion = new Mesh(new SphereGeometry(0.21, 16, 12), lib.nacre)
    medallion.position.set(x, ground + 4.75, 146.48)
    this.group.add(crownRail, medallionRing, medallion)
    for (const side of [-1, 1]) {
      const finial = new Mesh(new SphereGeometry(0.12, 12, 9), lib.brass)
      finial.position.set(x + side * 2.95, ground + 4.42, 146.5)
      const wing = new Mesh(new BoxGeometry(0.16, 3.0, 1.5), lib.woodDark)
      wing.rotation.y = side * 0.42
      wing.position.set(x + side * 3.16, ground + 2.4, 147.15)
      this.group.add(finial, wing)
      physics.addStaticBox(x + side * 3.16, ground + 2.4, 147.15, 0.12, 1.5, 0.78, side * 0.42)
    }
    const lipLeft = new Mesh(new BoxGeometry(0.15, 0.4, 9.8), lib.brass)
    const lipRight = lipLeft.clone()
    lipLeft.position.set(x - 2.72, ground + 1.08, z)
    lipRight.position.set(x + 2.72, ground + 1.08, z)
    lipLeft.rotation.x = incline
    lipRight.rotation.x = incline
    this.group.add(lipLeft, lipRight)
    // Lane rails divide the ramp into three visible rolling lanes aimed at
    // the three pockets — flush on the inclined surface (offset along the
    // ramp's rotated up-axis), purely visual: pearls hop them freely.
    for (const railX of [-0.9, 0.9]) {
      const laneRail = new Mesh(new BoxGeometry(0.05, 0.045, 9.3), lib.brass)
      laneRail.rotation.x = incline
      laneRail.position.set(
        x + railX,
        ground + 0.95 + Math.cos(incline) * 0.165,
        z + Math.sin(incline) * 0.165,
      )
      this.group.add(laneRail)
    }

    interaction?.register({
      position: new Vector3(x, ground + 1.05, 157.2),
      radius: 3.4,
      prompt: 'Take a pearl — click to roll',
      onInteract: () =>
        this.armThrow({
          kind: 'pearl',
          remaining: 1,
          spawn: (origin, direction) => this.throwPearl(origin, direction),
        }),
    })
    void ctx
  }

  private throwPearl(origin: Vector3, direction: Vector3): void {
    const { world, rapier } = this.services.physics
    const lib = this.services.materials.lib
    if (!world || !rapier || !lib) return
    const body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(origin.x, origin.y, origin.z)
        .setLinvel(direction.x * 9.2, direction.y * 9.2, direction.z * 9.2)
        .setLinearDamping(0.035)
        .setAngularDamping(0.04)
        .setCcdEnabled(true),
    )
    world.createCollider(
      rapier.ColliderDesc.ball(0.14).setRestitution(0.3).setFriction(0.38).setDensity(1.4),
      body,
    )
    const mesh = new Mesh(new SphereGeometry(0.14, 22, 14), lib.nacre)
    mesh.castShadow = true
    markDynamicShadowCasters(mesh)
    this.group.add(mesh)
    this.props.push({ body, mesh, age: 0, scored: false, kind: 'pearl' })
    this.trimProps('pearl', 8)
  }

  private buildKrakenBell(ctx: GameContext, ground: number): void {
    const lib = this.services.materials.lib!
    const { physics } = this.services
    const world = physics.world!
    const rapier = physics.rapier!
    const x = 114
    const z = 146.5
    const restY = ground + 0.72
    const bellY = ground + 6.25

    // Tapered tower board: a flattened four-sided frustum instead of the old
    // plain slab, with graduation rungs mounted BETWEEN the two brass rails.
    const towerGeometry = new CylinderGeometry(0.58, 1.02, 6.1, 4, 1)
    towerGeometry.rotateY(Math.PI / 4)
    towerGeometry.scale(1, 1, 0.3)
    const tower = new Mesh(towerGeometry, lib.woodDark)
    tower.position.set(x, ground + 3.1, z)
    const railLeft = new Mesh(new CylinderGeometry(0.055, 0.055, 5.5, 10), lib.brass)
    const railRight = railLeft.clone()
    railLeft.position.set(x - 0.42, ground + 3.35, z - 0.28)
    railRight.position.set(x + 0.42, ground + 3.35, z - 0.28)
    this.group.add(tower, railLeft, railRight)
    const rungGeometry = new CylinderGeometry(0.022, 0.022, 0.84, 8)
    rungGeometry.rotateZ(Math.PI / 2)
    for (let i = 0; i < 8; i++) {
      const rung = new Mesh(rungGeometry, lib.brass)
      rung.position.set(x, ground + 1.35 + i * 0.62, z - 0.28)
      this.group.add(rung)
    }

    // The bell proper: a closed clockwise lathe (lip, waist, shoulder, then
    // the interior you can see from below), a clapper on a hanger rod, hung
    // from the yoke crossbar that emitHighStrikerTrim raises over the tower.
    const bell = new Mesh(
      new LatheGeometry(
        [
          new Vector2(0.5, 0),
          new Vector2(0.585, 0.03),
          new Vector2(0.57, 0.1),
          new Vector2(0.47, 0.28),
          new Vector2(0.33, 0.46),
          new Vector2(0.18, 0.58),
          new Vector2(0.05, 0.63),
          new Vector2(0.04, 0.6),
          new Vector2(0.16, 0.52),
          new Vector2(0.3, 0.4),
          new Vector2(0.42, 0.22),
          new Vector2(0.46, 0.06),
          new Vector2(0.5, 0),
        ],
        30,
      ),
      lib.brass,
    )
    bell.position.set(x, bellY - 0.12, z - 0.32)
    const hangerRod = new Mesh(new CylinderGeometry(0.012, 0.012, 0.26, 8), lib.iron)
    hangerRod.position.set(x, bellY + 0.28, z - 0.32)
    const link = new Mesh(new CylinderGeometry(0.02, 0.02, 0.5, 8), lib.brass)
    link.position.set(x, bellY + 0.72, z - 0.32)
    const clapper = new Mesh(new SphereGeometry(0.07, 12, 9), lib.iron)
    clapper.position.set(x, bellY + 0.05, z - 0.32)
    this.group.add(bell, hangerRod, link, clapper)

    emitHighStrikerTrim(this.fixtureWriter, lib, x, ground, z)
    physics.addStaticBox(x, ground + 3.2, z + 0.15, 1.1, 3.15, 0.23)

    // The kraken's eye watches from the tower face above the graduation
    // rungs: nacre sclera in the flattened board, iron pupil, and a brass
    // lid arc — the carnival wink that names the game.
    const sclera = new Mesh(new CylinderGeometry(0.16, 0.16, 0.035, 20), lib.nacre)
    sclera.rotation.x = Math.PI / 2
    sclera.position.set(x, ground + 5.38, z - 0.21)
    const pupil = new Mesh(new SphereGeometry(0.058, 12, 9), lib.iron)
    pupil.scale.set(1, 1, 0.5)
    pupil.position.set(x, ground + 5.38, z - 0.225)
    const lid = new Mesh(new TorusGeometry(0.175, 0.02, 7, 20, Math.PI), lib.brass)
    lid.position.set(x, ground + 5.38, z - 0.215)
    this.group.add(sclera, pupil, lid)

    // Two verdigris kraken tentacles coil up the tower flanks, rooted in the
    // marble foot — chains of tapering members with knuckles, tips curling.
    for (const side of [-1, 1]) {
      this.buildTentacle(
        [
          new Vector3(x + side * 1.05, ground + 0.05, z + 0.1),
          new Vector3(x + side * 1.42, ground + 0.95, z + 0.02),
          new Vector3(x + side * 1.28, ground + 1.85, z - 0.08),
          new Vector3(x + side * 0.92, ground + 2.45, z - 0.05),
          new Vector3(x + side * 0.78, ground + 2.72, z + 0.12),
        ],
        [0.15, 0.11, 0.075, 0.045],
        lib.verdigris,
      )
    }

    const puckBody = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(x, restY, z - 0.35)
        .setLinearDamping(0.08)
        .lockRotations(),
    )
    puckBody.setEnabledTranslations(false, true, false, true)
    world.createCollider(
      rapier.ColliderDesc.cylinder(0.1, 0.32).setDensity(2.2).setRestitution(0.05),
      puckBody,
    )
    const puckMesh = new Mesh(new CylinderGeometry(0.32, 0.32, 0.2, 24), lib.verdigris)
    this.group.add(puckMesh)
    this.puck = { body: puckBody, mesh: puckMesh, restY, bellY, ringing: false }
    physics.addStaticBox(x, ground + 0.42, z - 0.35, 0.45, 0.2, 0.3)

    // The hammer is a static prop now (no interaction, no swing): laid down
    // beside the strike pad as if just set there — head flat on the ground,
    // striking face toward the board, handle resting back toward the hall.
    const head = new Mesh(new CylinderGeometry(0.34, 0.34, 0.72, 20), lib.brass)
    head.position.set(x - 0.85, ground + 0.36, z - 0.15)
    const handleFrom = new Vector3(x - 0.62, ground + 0.4, z + 0.05)
    const handleTo = new Vector3(x - 0.1, ground + 0.09, z + 2.0)
    const handleDirection = new Vector3().subVectors(handleTo, handleFrom)
    const handle = new Mesh(
      new CylinderGeometry(0.05, 0.062, handleDirection.length(), 12),
      lib.woodDark,
    )
    handle.position.copy(handleFrom).add(handleTo).multiplyScalar(0.5)
    handle.quaternion.setFromUnitVectors(
      new Vector3(0, 1, 0),
      handleDirection.clone().normalize(),
    )
    const buttCap = new Mesh(new SphereGeometry(0.07, 10, 8), lib.brass)
    buttCap.position.copy(handleTo)
    this.group.add(head, handle, buttCap)
    physics.addStaticCylinder(x - 0.85, ground + 0.36, z - 0.15, 0.36, 0.34)
    void ctx
  }

  /** A tapering organic limb: capped cylinder segments with sphere knuckles. */
  private buildTentacle(
    spine: Vector3[],
    radii: number[],
    material: Parameters<SlotWriter['place']>[0],
  ): void {
    const up = new Vector3(0, 1, 0)
    for (let i = 0; i < spine.length - 1; i++) {
      const a = spine[i]
      const b = spine[i + 1]
      const radius = radii[Math.min(i, radii.length - 1)]
      const direction = new Vector3().subVectors(b, a)
      const segment = new Mesh(
        new CylinderGeometry(radius * 0.78, radius, direction.length(), 10),
        material,
      )
      segment.position.copy(a).add(b).multiplyScalar(0.5)
      segment.quaternion.setFromUnitVectors(up, direction.clone().normalize())
      this.group.add(segment)
      if (i > 0) {
        const knuckle = new Mesh(new SphereGeometry(radius * 1.08, 10, 8), material)
        knuckle.position.copy(a)
        this.group.add(knuckle)
      }
    }
    const tip = new Mesh(new SphereGeometry(radii[radii.length - 1] * 0.85, 10, 8), material)
    tip.position.copy(spine[spine.length - 1])
    this.group.add(tip)
  }

  fixedUpdate(ctx: GameContext, dt: number): void {
    const hornBase = this.horn.y
    for (const prop of this.props) {
      prop.age += dt
      if (prop.scored) continue
      const p = prop.body.translation()
      if (prop.kind === 'ring') {
        const radial = Math.hypot(p.x - this.horn.x, p.z - this.horn.z)
        if (radial < 0.4 && p.y > hornBase && p.y < hornBase + 1.55) {
          prop.scored = true
          this.ringScore++
          this.recordWin(ctx)
        }
      } else {
        for (const pocket of this.pockets) {
          const distance = Math.hypot(
            p.x - pocket.position.x,
            p.y - pocket.position.y,
            p.z - pocket.position.z,
          )
          if (distance < 0.56) {
            prop.scored = true
            this.pearlScore += pocket.points
            this.recordWin(ctx)
            break
          }
        }
      }
    }

    const puck = this.puck
    if (puck) {
      const y = puck.body.translation().y
      if (!puck.ringing && y >= puck.bellY - 0.5) {
        puck.ringing = true
        ctx.events.emit('games/kraken-bell', {
          power: this.krakenBest,
          x: 114,
          y: puck.bellY,
          z: 146.2,
        })
        this.recordWin(ctx)
      }
      if (y < puck.restY - 0.25 || y > puck.bellY + 1.5) {
        puck.body.setTranslation({ x: 114, y: puck.restY, z: 146.15 }, false)
        puck.body.setLinvel({ x: 0, y: 0, z: 0 }, false)
      }
    }
  }

  update(): void {
    for (const prop of this.props) syncDynamicProp(prop)
    const puck = this.puck
    if (puck) {
      const p = puck.body.translation()
      puck.mesh.position.set(p.x, p.y, p.z)
    }
  }

  private recordWin(ctx: GameContext): void {
    this.wins++
    if (!this.hatAwarded) {
      this.hatAwarded = true
      ctx.events.emit('games/prize-earned', { prize: 'paper-hat' })
    } else if (!this.plushAwarded && this.wins >= 3) {
      this.plushAwarded = true
      ctx.events.emit('games/prize-earned', { prize: 'plush-kraken' })
    }
  }

  private trimProps(kind: ScoredProp['kind'], limit: number): void {
    const matching = this.props.filter((prop) => prop.kind === kind)
    if (matching.length <= limit) return
    const remove = matching[0]
    this.services.physics.world?.removeRigidBody(remove.body)
    this.group.remove(remove.mesh)
    this.props.splice(this.props.indexOf(remove), 1)
  }

  dispose(ctx: GameContext): void {
    const world = this.services.physics.world
    for (const prop of this.props) world?.removeRigidBody(prop.body)
    if (this.puck) world?.removeRigidBody(this.puck.body)
    ctx.scene.remove(this.group)
  }

  debugSnapshot(): {
    rings: number
    pearls: number
    ringScore: number
    pearlScore: number
    krakenBest: number
    wins: number
  } {
    return {
      rings: this.props.filter((prop) => prop.kind === 'ring').length,
      pearls: this.props.filter((prop) => prop.kind === 'pearl').length,
      ringScore: this.ringScore,
      pearlScore: this.pearlScore,
      krakenBest: this.krakenBest,
      wins: this.wins,
    }
  }
}
