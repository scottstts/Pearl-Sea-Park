import type { RigidBody } from '@dimforge/rapier3d-compat'
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import { registerBookmark } from '../core/debug'
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
  private hammer: Group | null = null
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
    const plinth = new Mesh(new CylinderGeometry(1.45, 1.6, 0.55, 32), lib.marble)
    plinth.position.set(x, baseY + 0.2, z)
    const narwhal = new Mesh(new SphereGeometry(1, 28, 18), lib.nacre)
    narwhal.scale.set(1.5, 0.68, 0.72)
    narwhal.rotation.x = -0.12
    narwhal.position.set(x, baseY + 1.05, z)
    const tail = new Mesh(new ConeGeometry(0.68, 1.2, 4), lib.nacre)
    tail.rotation.x = Math.PI / 2
    tail.rotation.z = Math.PI / 4
    tail.position.set(x, baseY + 1, z + 1.6)
    const horn = new Mesh(new ConeGeometry(0.16, 1.55, 20), lib.brass)
    horn.position.set(x, baseY + 2.15, z - 0.35)
    this.horn.set(x, baseY + 1.38, z - 0.35)
    const eye = new Mesh(new SphereGeometry(0.065, 12, 8), lib.iron)
    eye.position.set(x - 0.55, baseY + 1.3, z - 0.58)
    this.group.add(counter, plinth, narwhal, tail, horn, eye)
    emitCounterJoinery(this.fixtureWriter, lib, x, ground, z + 1.2, 8, 2.2)
    physics.addStaticBox(x, ground + 0.45, z + 1.2, 4, 0.45, 1.1)
    physics.addStaticCylinder(x, baseY + 0.2, z, 0.28, 1.6)
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
    for (const [offset, height, points] of [
      [-1.45, 2.2, 10],
      [0, 2.85, 50],
      [1.45, 2.2, 20],
    ] as const) {
      const pocket = new Mesh(new TorusGeometry(0.48, 0.075, 10, 32), lib.brass)
      pocket.position.set(x + offset, ground + height, 146.28)
      this.group.add(pocket)
      this.pockets.push({ position: pocket.position.clone(), points })
    }
    const lipLeft = new Mesh(new BoxGeometry(0.15, 0.4, 9.8), lib.brass)
    const lipRight = lipLeft.clone()
    lipLeft.position.set(x - 2.72, ground + 1.08, z)
    lipRight.position.set(x + 2.72, ground + 1.08, z)
    lipLeft.rotation.x = incline
    lipRight.rotation.x = incline
    this.group.add(lipLeft, lipRight)

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
    this.group.add(mesh)
    this.props.push({ body, mesh, age: 0, scored: false, kind: 'pearl' })
    this.trimProps('pearl', 8)
  }

  private buildKrakenBell(ctx: GameContext, ground: number): void {
    const lib = this.services.materials.lib!
    const { physics, interaction } = this.services
    const world = physics.world!
    const rapier = physics.rapier!
    const x = 114
    const z = 146.5
    const restY = ground + 0.72
    const bellY = ground + 6.25

    const tower = new Mesh(new BoxGeometry(2.2, 6.3, 0.45), lib.woodDark)
    tower.position.set(x, ground + 3.2, z)
    const railLeft = new Mesh(new CylinderGeometry(0.055, 0.055, 5.5, 10), lib.brass)
    const railRight = railLeft.clone()
    railLeft.position.set(x - 0.42, ground + 3.35, z - 0.28)
    railRight.position.set(x + 0.42, ground + 3.35, z - 0.28)
    const bell = new Mesh(new ConeGeometry(0.58, 0.7, 24, 1, true), lib.brass)
    bell.position.set(x, bellY, z - 0.32)
    bell.rotation.x = Math.PI
    this.group.add(tower, railLeft, railRight, bell)
    emitHighStrikerTrim(this.fixtureWriter, lib, x, ground, z)
    physics.addStaticBox(x, ground + 3.2, z + 0.15, 1.1, 3.15, 0.23)

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

    const hammer = new Group()
    hammer.position.set(x, ground + 1.2, z + 1.1)
    const handle = new Mesh(new CylinderGeometry(0.055, 0.065, 2.1, 12), lib.woodDark)
    handle.position.y = 0.95
    const head = new Mesh(new CylinderGeometry(0.34, 0.34, 0.72, 20), lib.brass)
    head.rotation.z = Math.PI / 2
    head.position.y = 1.9
    hammer.add(handle, head)
    this.hammer = hammer
    this.group.add(hammer)

    interaction?.register({
      position: new Vector3(x, ground + 1.2, z + 2.2),
      radius: 3.3,
      prompt: 'Swing the Kraken hammer',
      onInteract: () => this.strikeKraken(ctx),
    })
  }

  private strikeKraken(ctx: GameContext): void {
    const puck = this.puck
    if (!puck) return
    const timing = Math.sin(ctx.time.elapsed * 2.6) * 0.5 + 0.5
    const power = 0.35 + timing * 0.65
    puck.body.setTranslation({ x: 114, y: puck.restY, z: 146.15 }, true)
    puck.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    puck.body.setLinvel({ x: 0, y: 7.5 + power * 4.2, z: 0 }, true)
    puck.ringing = false
    this.krakenBest = Math.max(this.krakenBest, power)
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

  update(ctx: GameContext): void {
    for (const prop of this.props) syncDynamicProp(prop)
    const puck = this.puck
    if (puck) {
      const p = puck.body.translation()
      puck.mesh.position.set(p.x, p.y, p.z)
    }
    if (this.hammer) {
      const sweep = Math.sin(ctx.time.elapsed * 2.6)
      this.hammer.rotation.z = -0.8 + sweep * 0.66
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
