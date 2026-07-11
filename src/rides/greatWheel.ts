import {
  CylinderGeometry,
  DoubleSide,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { float, positionWorld, smoothstep, uniform, vec2, vec3 } from 'three/tsl'
import { ArchKit } from '../archkit/modules'
import { SlotWriter } from '../archkit/writer'
import { registerBookmark } from '../core/debug'
import type { PlayerSystem } from '../player/player'
import { fbm2 } from '../render/tslNoise'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { currentFlowCpu } from '../sea/current'
import type { DistrictServices } from '../world/districts/atrium'
import { PARK_PLAN } from '../world/parkPlan'
import { terrainHeight } from '../world/terrain'
import { VehicleSeatRig } from './vehicleSeat'

const GONDOLAS = 12
const PERIOD = 92 // seconds per revolution
const DWELL_SECONDS = 8
const RADIUS = PARK_PLAN.wheel.radius

/**
 * The Great Wheel (plan §9.2): a 40 m wheel turning in a dredged basin —
 * nautilus-shell gondolas on pendulum pivots, full bulb rigging, and the
 * crest breaching the surface every revolution: foam, seconds of sky, then
 * blue again. Pulse-stops at the pier for boarding.
 */
export class GreatWheelSystem implements GameSystem {
  readonly id = 'great-wheel'

  private readonly services: DistrictServices
  private readonly player: PlayerSystem | null
  private rig: VehicleSeatRig | null = null

  private readonly group = new Object3D()
  private readonly rotor = new Object3D()
  private readonly hub = new Vector3(PARK_PLAN.wheel.x, PARK_PLAN.wheel.hubY, PARK_PLAN.wheel.z)
  private readonly cars: Object3D[] = []
  private readonly pivots: Object3D[] = []
  private readonly swing: { angle: number; velocity: number }[] = []

  private rotorAngle = 0
  private speed = 0
  private dwellTimer = 0
  private pulsedAtAngle = -10
  private ridingCar = -1
  /** Rotor angle that puts gondola 0 at the boarding dock. */
  private boardingAngle = 0

  constructor(services: DistrictServices, player: PlayerSystem | null) {
    this.services = services
    this.player = player
  }

  init(ctx: GameContext): void {
    const lib = this.services.materials.lib
    if (!lib) throw new Error('GreatWheelSystem requires materials')
    const { physics } = this.services
    const kit = new ArchKit(lib)
    const w = new SlotWriter()
    const { x: hx, z: hz } = PARK_PLAN.wheel
    const hy = PARK_PLAN.wheel.hubY

    // ── Static structure: legs, axle, pier ────────────────────────────────
    for (const sideZ of [-1, 1]) {
      for (const sideX of [-1, 1]) {
        const footX = hx + sideX * 11
        const footZ = hz + sideZ * 4.6
        const footY = terrainHeight(footX, footZ)
        const leg = new Mesh(new CylinderGeometry(0.5, 0.75, 1, 14), lib.iron)
        const top = new Vector3(hx + sideX * 1.1, hy, hz + sideZ * 2.5)
        const foot = new Vector3(footX, footY, footZ)
        const mid = foot.clone().add(top).multiplyScalar(0.5)
        const length = foot.distanceTo(top)
        leg.scale.y = length
        leg.position.copy(mid)
        leg.lookAt(top)
        leg.rotateX(Math.PI / 2)
        this.group.add(leg)
      }
      // Bracing beam between the leg pair.
      const brace = new Mesh(new CylinderGeometry(0.22, 0.22, 15, 10), lib.iron)
      brace.rotation.z = Math.PI / 2
      brace.position.set(hx, hy - 12, hz + sideZ * 3.6)
      this.group.add(brace)
    }
    const axle = new Mesh(new CylinderGeometry(0.55, 0.55, 7, 16), lib.brass)
    axle.rotation.x = Math.PI / 2
    axle.position.set(hx, hy, hz)
    this.group.add(axle)

    // The pier: boardwalk from the basin rim to the boarding gate.
    const pierY = terrainHeight(hx - 27, hz) + 0.15
    kit.mosaicPath(w, hx - 27.5, hz, hx - 17.8, hz, pierY, 4.2)
    physics.addStaticBox(hx - 22.6, pierY + 0.08, hz, 4.9, 0.08, 2.1)
    kit.balustrade(w, hx - 27.5, hz - 2.05, hx - 17.8, hz - 2.05, pierY + 0.05)
    kit.balustrade(w, hx - 27.5, hz + 2.05, hx - 17.8, hz + 2.05, pierY + 0.05)
    for (const dz of [-2.4, 2.4]) {
      const globe = this.services.amenities.addLamp(hx - 26.5, pierY, hz + dz)
      physics.addStaticBox(hx - 26.5, pierY + 1.7, hz + dz, 0.12, 1.7, 0.12)
      void globe
    }
    // Pier-head gateway frames the transition from civic park to machinery.
    for (const dz of [-2.05, 2.05]) {
      kit.column(w, hx - 18.4, pierY, hz + dz, 4.2, 0.22)
      physics.addStaticBox(hx - 18.4, pierY + 2.1, hz + dz, 0.28, 2.1, 0.28)
    }
    kit.arch(w, hx - 18.4, hz - 2.05, hx - 18.4, hz + 2.05, pierY + 4.22, 0.9)
    kit.cornice(w, hx - 18.4, hz - 2.05, hx - 18.4, hz + 2.05, pierY + 4.3)

    // ── Rotor: rims, spokes, bulbs, gondola pivots ────────────────────────
    const rotor = this.rotor
    rotor.position.copy(this.hub)
    for (const sideZ of [-1.35, 1.35]) {
      const rimOuter = new Mesh(new TorusGeometry(RADIUS, 0.32, 10, 96), lib.iron)
      rimOuter.position.z = sideZ
      const rimInner = new Mesh(new TorusGeometry(RADIUS - 1.1, 0.14, 8, 96), lib.brass)
      rimInner.position.z = sideZ
      rotor.add(rimOuter, rimInner)
      for (let i = 0; i < 16; i++) {
        const angle = (i / 16) * Math.PI * 2
        const spoke = new Mesh(new CylinderGeometry(0.11, 0.11, RADIUS - 0.4, 8), lib.iron)
        spoke.position.set(
          Math.sin(angle) * (RADIUS / 2),
          Math.cos(angle) * (RADIUS / 2),
          sideZ,
        )
        spoke.rotation.z = -angle
        rotor.add(spoke)
      }
    }
    const drum = new Mesh(new CylinderGeometry(2.1, 2.1, 3.4, 24), lib.verdigris)
    drum.rotation.x = Math.PI / 2
    rotor.add(drum)

    // Bulbs along both rims (instanced, warm emissive).
    const bulbCount = 48 * 2
    const bulbs = new InstancedMesh(new SphereGeometry(0.11, 8, 6), lib.lampGlobe, bulbCount)
    const matrix = new Matrix4()
    let b = 0
    for (const sideZ of [-1.75, 1.75]) {
      for (let i = 0; i < 48; i++) {
        const angle = (i / 48) * Math.PI * 2
        matrix.setPosition(Math.sin(angle) * RADIUS, Math.cos(angle) * RADIUS, sideZ)
        bulbs.setMatrixAt(b++, matrix)
      }
    }
    bulbs.instanceMatrix.needsUpdate = true
    rotor.add(bulbs)

    // Gondolas: shell cup on a pendulum pivot between the rim pair.
    const shellGeometry = new LatheGeometry(
      [
        new Vector2(0.02, 0),
        new Vector2(0.62, 0.06),
        new Vector2(0.95, 0.42),
        new Vector2(1.02, 0.92),
        new Vector2(0.86, 1.28),
        new Vector2(0.52, 1.42),
      ],
      26,
    )
    const ringGeometry = new TorusGeometry(0.68, 0.06, 8, 24)
    const benchGeometry = new CylinderGeometry(0.52, 0.6, 0.16, 16)
    const spiralGeometry = new TorusGeometry(0.42, 0.09, 8, 22, Math.PI * 1.5)
    for (let i = 0; i < GONDOLAS; i++) {
      const angle = (i / GONDOLAS) * Math.PI * 2
      const pivot = new Object3D()
      pivot.position.set(Math.sin(angle) * RADIUS, Math.cos(angle) * RADIUS, 0)
      const car = new Object3D()
      const shell = new Mesh(shellGeometry, lib.nacre)
      shell.position.y = -1.9
      const rim = new Mesh(ringGeometry, lib.brass)
      rim.rotation.x = Math.PI / 2
      rim.position.y = -0.52
      const bench = new Mesh(benchGeometry, lib.woodDark)
      bench.position.y = -1.28
      const spiral = new Mesh(spiralGeometry, lib.brass)
      spiral.position.set(0, -1.35, -0.78)
      spiral.rotation.y = Math.PI / 2
      const armA = new Mesh(new CylinderGeometry(0.05, 0.06, 1.45, 8), lib.brass)
      armA.position.set(0, -0.72, 0.5)
      armA.rotation.x = 0.33
      const armB = armA.clone()
      armB.position.z = -0.5
      armB.rotation.x = -0.33
      car.add(shell, rim, bench, spiral, armA, armB)
      pivot.add(car)
      rotor.add(pivot)
      this.pivots.push(pivot)
      this.cars.push(car)
      this.swing.push({ angle: 0, velocity: 0 })
    }
    this.group.add(rotor)

    // Boarding geometry: gondola 0 docks where the pier deck meets the wheel.
    const dockY = pierY + 0.45 + 1.9 // pivot height that puts the cup at deck level
    const cosDock = Math.min(1, Math.max(-1, (dockY - hy) / RADIUS))
    // West side of the wheel: local x = sin(a) < 0 branch.
    const dockAngle = -Math.acos(cosDock)
    this.boardingAngle = dockAngle // rotor angle placing gondola 0 at dock
    this.rotorAngle = this.boardingAngle
    this.dwellTimer = DWELL_SECONDS

    // ── Breach foam: two shader discs where the rim pierces the surface ──
    const pierce = Math.sqrt(Math.max(0, RADIUS * RADIUS - hy * hy))
    const foamTime = uniform(0)
    this.foamTime = foamTime
    const foamMaterial = new MeshBasicNodeMaterial()
    foamMaterial.transparent = true
    foamMaterial.depthWrite = false
    const foamUv = positionWorld.xz.mul(0.55)
    const churn = fbm2(foamUv.add(vec2(foamTime.mul(0.35), foamTime.mul(-0.22))))
      .mul(fbm2(foamUv.mul(1.9).sub(vec2(foamTime.mul(0.27), 0))))
      .mul(2.2)
    const centerFade = float(1).sub(
      smoothstep(0.6, 2.4, positionWorld.xz.sub(vec2(hx, hz)).length().sub(pierce).abs().add(
        positionWorld.z.sub(hz).abs().mul(0.4),
      )),
    )
    foamMaterial.colorNode = vec3(1.35, 1.42, 1.44)
    foamMaterial.opacityNode = churn.clamp(0, 1).mul(centerFade).clamp(0, 0.85)
    for (const side of [-1, 1]) {
      const foam = new Mesh(new PlaneGeometry(6.5, 5.5), foamMaterial)
      foam.rotation.x = -Math.PI / 2
      foam.position.set(hx + side * pierce, 0.08, hz)
      foam.renderOrder = 5
      ;(foam.material as MeshBasicNodeMaterial).side = DoubleSide
      this.group.add(foam)
    }

    this.group.add(w.compile())
    this.group.traverse((node) => {
      const mesh = node as Mesh
      if (mesh.isMesh && mesh.material !== lib.glass) {
        mesh.castShadow = true
        mesh.receiveShadow = true
      }
    })
    ctx.scene.add(this.group)
    this.updateRotor(0)

    registerBookmark({
      name: 'wheel',
      position: [hx - 26, pierY + 2.2, hz + 13],
      look: [hx, hy + 6, hz],
      note: 'The Great Wheel from the pier',
    })
    registerBookmark({
      name: 'breach',
      position: [hx - 3, 1.4, hz + 9],
      look: [hx + 2, 3.5, hz - 24],
      note: 'The crest breaching the Silver Ceiling',
    })

    // ── Boarding ──────────────────────────────────────────────────────────
    if (this.player && this.services.interaction) {
      const rig = new VehicleSeatRig(this.player)
      this.rig = rig
      const interaction = this.services.interaction
      const gate = new Vector3(hx - 18.6, pierY + 1.2, hz)
      const exit = new Vector3(hx - 21.5, pierY + 0.1, hz)
      const seatEye = new Vector3(0, -0.35, 0)

      interaction.register({
        position: gate,
        radius: 4.2,
        prompt: 'Board the Great Wheel',
        onInteract: () => {
          const car = this.dockedCar()
          if (car === -1 || rig.seated) return
          this.ridingCar = car
          this.dwellTimer = Math.max(this.dwellTimer, 4)
          rig.attach(this.cars[car], seatEye, Math.PI / 2, ctx.camera)
          ctx.events.emit('ticket/punched', { ride: 'great-wheel' })
          ctx.events.emit('ride/wheel-riding', { riding: true })
        },
        enabled: () => !rig.seated && this.dockedCar() !== -1,
      })
      interaction.register({
        position: gate,
        radius: 8,
        prompt: 'Step off the wheel',
        onInteract: () => {
          if (!rig.seated || this.ridingCar === -1) return
          rig.requestExit(exit)
          ctx.events.emit('ride/wheel-riding', { riding: false })
          this.ridingCar = -1
        },
        enabled: () => rig.seated && this.ridingCar !== -1 && this.dockedCar() === this.ridingCar,
      })
    }
  }

  private foamTime: ReturnType<typeof uniform> | null = null

  /** Gondola currently at the dock (rotor stopped there), else −1. */
  private dockedCar(): number {
    if (this.dwellTimer <= 0) return -1
    for (let i = 0; i < GONDOLAS; i++) {
      const a = this.gondolaAngle(i)
      if (Math.abs(angleDelta(a, this.boardingAngle)) < 0.05) return i
    }
    return -1
  }

  private gondolaAngle(i: number): number {
    return this.rotorAngle + (i / GONDOLAS) * Math.PI * 2
  }

  private updateRotor(elapsed: number): void {
    this.rotor.rotation.z = -this.rotorAngle
    for (let i = 0; i < GONDOLAS; i++) {
      // Cars cancel the rotor spin and add their pendulum swing.
      this.cars[i].rotation.z = this.rotorAngle + this.swing[i].angle
    }
    void elapsed
  }

  update(ctx: GameContext, dt: number): void {
    const cruise = (Math.PI * 2) / PERIOD
    let target = cruise
    if (this.dwellTimer > 0) {
      this.dwellTimer -= dt
      target = 0
    } else {
      // Slow into the dock; pulse-stop when a gondola aligns with the gate.
      let nearest = Infinity
      for (let i = 0; i < GONDOLAS; i++) {
        nearest = Math.min(nearest, Math.abs(angleDelta(this.gondolaAngle(i), this.boardingAngle)))
      }
      if (nearest < 0.14) target = Math.max(cruise * 0.28, nearest * 1.4)
      const advanced = Math.abs(angleDelta(this.rotorAngle, this.pulsedAtAngle))
      if (nearest < 0.012 && advanced > 0.18) {
        this.dwellTimer = DWELL_SECONDS
        this.pulsedAtAngle = this.rotorAngle
      }
    }
    this.speed += (target - this.speed) * Math.min(1, dt * 1.2)
    this.rotorAngle += this.speed * dt

    // Pendulum gondolas: tangential drive + gravity + current.
    for (let i = 0; i < GONDOLAS; i++) {
      const s = this.swing[i]
      const pivotWorldX = this.hub.x + Math.sin(this.gondolaAngle(i)) * RADIUS
      const pivotWorldY = this.hub.y + Math.cos(this.gondolaAngle(i)) * RADIUS
      const flow = currentFlowCpu(pivotWorldX, this.hub.z, ctx.time.elapsed)
      const drive = pivotWorldY > 0 ? flow.x * 0.004 : flow.x * 0.012 // air vs water push
      const accel = -(9.81 / 1.9) * Math.sin(s.angle) - s.velocity * 0.55 + drive
      s.velocity += accel * dt
      s.angle += s.velocity * dt
    }
    this.updateRotor(ctx.time.elapsed)
    if (this.foamTime) this.foamTime.value = ctx.time.elapsed

    this.rig?.update(ctx.camera, dt)
    if (this.rig && this.ridingCar !== -1) {
      this.rig.canExit = this.dockedCar() === this.ridingCar
    }
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.group)
  }
}

function angleDelta(a: number, b: number): number {
  const d = (a - b) % (Math.PI * 2)
  return d > Math.PI ? d - Math.PI * 2 : d < -Math.PI ? d + Math.PI * 2 : d
}
