import {
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  LatheGeometry,
  Mesh,
  Object3D,
  PlaneGeometry,
  Vector2,
  Vector3,
} from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  abs,
  float,
  mix,
  normalize,
  positionLocal,
  smoothstep,
  uv,
  vec2,
  vec3,
} from 'three/tsl'
import { registerBookmark } from '../core/debug'
import { markDynamicShadowCasters } from '../render/layers'
import type { GameContext } from '../runtime/context'
import type { SeaMediumSystem } from '../sea/medium'
import type { DistrictServices } from '../world/districts/atrium'
import { terrainHeight } from '../world/terrain'
import { CHANNEL_HEAVE_SCALE, ChannelSim } from '../sea/channelSim'
import type { ArmThrow, DynamicProp } from './types'
import { syncDynamicProp } from './types'

const CENTER = new Vector3(-142, 0, 72)
const SIZE = 4.8

interface WellCoin extends DynamicProp {
  previousY: number
  splashed: boolean
}

/** A circular 64² bounded-water heightfield, driven by real coins. */
export class WishingWell {
  readonly group = new Object3D()

  private readonly services: DistrictServices
  private readonly medium: SeaMediumSystem
  private readonly armThrow: ArmThrow
  private readonly coins: WellCoin[] = []
  private sim: ChannelSim | null = null
  private waterLevel = 0

  constructor(services: DistrictServices, medium: SeaMediumSystem, armThrow: ArmThrow) {
    this.services = services
    this.medium = medium
    this.armThrow = armThrow
  }

  init(ctx: GameContext): void {
    const lib = this.services.materials.lib
    const { physics, interaction } = this.services
    if (!lib || !physics.world || !physics.rapier) throw new Error('WishingWell requires materials and Rapier')
    const ground = terrainHeight(CENTER.x, CENTER.z)
    CENTER.y = ground
    this.waterLevel = ground + 0.72
    const bounds = {
      minX: CENTER.x - SIZE / 2,
      minZ: CENTER.z - SIZE / 2,
      width: SIZE,
      depth: SIZE,
    }
    const sim = new ChannelSim(
      ctx.renderer,
      64,
      bounds,
      (x, z) => {
        const d = Math.hypot(x - CENTER.x, z - CENTER.z)
        return d < 1.55 ? 1 : d < 1.78 ? (1.78 - d) / 0.23 : 0
      },
    )
    this.sim = sim

    const stone = new LatheGeometry(
      [
        new Vector2(1.45, 0),
        new Vector2(2.05, 0),
        new Vector2(2.12, 0.26),
        new Vector2(1.82, 0.48),
        new Vector2(1.75, 1.02),
        new Vector2(1.48, 1.02),
        new Vector2(1.45, 0),
      ],
      48,
    )
    const well = new Mesh(stone, lib.marble)
    well.position.set(CENTER.x, ground, CENTER.z)
    well.castShadow = true
    well.receiveShadow = true
    this.group.add(well)
    for (let i = 0; i < 14; i++) {
      const angle = (i / 14) * Math.PI * 2
      const x = CENTER.x + Math.cos(angle) * 1.78
      const z = CENTER.z + Math.sin(angle) * 1.78
      physics.addStaticBox(x, ground + 0.52, z, 0.38, 0.52, 0.18, -angle - Math.PI / 2)
    }
    physics.addStaticCylinder(CENTER.x, ground + 0.12, CENTER.z, 0.12, 1.7)

    const surfaceUv = vec2(uv().x, float(1).sub(uv().y))
    const sample = (dx: number, dz: number) =>
      sim.heightNode.sample(surfaceUv.add(vec2(dx, dz))).r.mul(CHANNEL_HEAVE_SCALE)
    const height = sample(0, 0)
    const texel = 1 / sim.size
    const hX = sample(texel, 0).sub(sample(-texel, 0))
    const hZ = sample(0, texel).sub(sample(0, -texel))
    const gradientScale = sim.size / (SIZE * 2)
    const normal = normalize(vec3(hX.mul(-gradientScale), 1, hZ.mul(-gradientScale)))
    const mask = sim.maskNode.sample(surfaceUv).r

    const waterMaterial = new MeshStandardNodeMaterial()
    waterMaterial.side = DoubleSide
    waterMaterial.transparent = true
    waterMaterial.depthWrite = false
    waterMaterial.roughness = 0.055
    waterMaterial.metalness = 0
    waterMaterial.envMapIntensity = 0.55
    waterMaterial.positionNode = positionLocal.add(vec3(0, height, 0))
    waterMaterial.normalNode = normal
    waterMaterial.opacityNode = mask.mul(0.86)
    waterMaterial.emissiveNode = vec3(0.008, 0.035, 0.04).mul(mask)
    switch (ctx.flags.pass) {
      case 'well-height':
        waterMaterial.colorNode = mix(vec3(0.02, 0.08, 0.16), vec3(0.9, 0.2, 0.04), smoothstep(-0.2, 0.2, height))
        break
      case 'well-normal':
        waterMaterial.colorNode = normal.mul(0.5).add(0.5)
        break
      default:
        waterMaterial.colorNode = vec3(0.018, 0.11, 0.13)
    }
    const waterGeometry = new PlaneGeometry(SIZE, SIZE, 64, 64)
    waterGeometry.rotateX(-Math.PI / 2)
    const water = new Mesh(waterGeometry, waterMaterial)
    water.position.set(CENTER.x, this.waterLevel, CENTER.z)
    water.renderOrder = 4
    this.group.add(water)

    // Bottom caustic is derived from simulated curvature (second difference),
    // so it moves only when real surface energy focuses/defocuses light.
    const curvature = abs(
      sample(texel, 0)
        .add(sample(-texel, 0))
        .add(sample(0, texel))
        .add(sample(0, -texel))
        .sub(height.mul(4)),
    )
    const bottomMaterial = new MeshStandardNodeMaterial()
    bottomMaterial.color = new Color(0x6a786d)
    bottomMaterial.roughness = 0.86
    bottomMaterial.emissiveNode = ctx.flags.pass === 'well-caustic'
      ? vec3(curvature.mul(32))
      : vec3(0.11, 0.16, 0.12).mul(curvature.mul(18).clamp(0, 1))
    this.medium.applyCaustics(bottomMaterial, 0.75)
    const bottom = new Mesh(new CircleGeometry(1.62, 48), bottomMaterial)
    bottom.rotation.x = -Math.PI / 2
    bottom.position.set(CENTER.x, ground + 0.26, CENTER.z)
    bottom.receiveShadow = true
    this.group.add(bottom)

    interaction?.register({
      position: new Vector3(CENTER.x, ground + 1, CENTER.z + 2.3),
      radius: 3.4,
      prompt: 'Take a wishing coin — click to toss',
      onInteract: () =>
        this.armThrow({
          kind: 'coin',
          remaining: 1,
          spawn: (origin, direction) => this.throwCoin(origin, direction),
        }),
    })

    ctx.scene.add(this.group)
    registerBookmark({
      name: 'wishing-well',
      position: [CENTER.x + 5, ground + 2.1, CENTER.z + 5],
      look: [CENTER.x, this.waterLevel, CENTER.z],
      note: 'Coin-driven bounded ripples and curvature-linked caustics',
    })
  }

  private throwCoin(origin: Vector3, direction: Vector3): void {
    const { world, rapier } = this.services.physics
    const lib = this.services.materials.lib
    if (!world || !rapier || !lib) return
    const body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(origin.x, origin.y, origin.z)
        .setLinvel(direction.x * 7.2, direction.y * 7.2, direction.z * 7.2)
        .setAngvel({ x: 8, y: 2, z: -5 })
        .setLinearDamping(0.04)
        .setAngularDamping(0.08)
        .setCcdEnabled(true),
    )
    world.createCollider(
      rapier.ColliderDesc.cylinder(0.018, 0.12)
        .setDensity(3.6)
        .setFriction(0.52)
        .setRestitution(0.22),
      body,
    )
    const mesh = new Mesh(new CylinderGeometry(0.12, 0.12, 0.036, 28), lib.brass)
    mesh.castShadow = true
    markDynamicShadowCasters(mesh)
    this.group.add(mesh)
    this.coins.push({ body, mesh, age: 0, scored: false, previousY: origin.y, splashed: false })
    if (this.coins.length > 18) {
      const remove = this.coins.shift()!
      world.removeRigidBody(remove.body)
      this.group.remove(remove.mesh)
    }
  }

  fixedUpdate(_ctx: GameContext, dt: number): void {
    for (const coin of this.coins) {
      coin.age += dt
      const position = coin.body.translation()
      const radial = Math.hypot(position.x - CENTER.x, position.z - CENTER.z)
      if (!coin.splashed && radial < 1.62 && coin.previousY > this.waterLevel && position.y <= this.waterLevel) {
        coin.splashed = true
        this.sim?.addImpulse(position.x, position.z, 0.26, 0.12)
      }
      coin.previousY = position.y
    }
  }

  update(_ctx: GameContext, dt: number): void {
    this.sim?.update(dt)
    for (const coin of this.coins) syncDynamicProp(coin)
  }

  dispose(ctx: GameContext): void {
    for (const coin of this.coins) this.services.physics.world?.removeRigidBody(coin.body)
    this.sim?.dispose()
    ctx.scene.remove(this.group)
  }

  debugSnapshot(): {
    coins: number
    splashes: number
    water: ReturnType<ChannelSim['debugSnapshot']> | null
  } {
    return {
      coins: this.coins.length,
      splashes: this.coins.filter((coin) => coin.splashed).length,
      water: this.sim?.debugSnapshot() ?? null,
    }
  }
}
