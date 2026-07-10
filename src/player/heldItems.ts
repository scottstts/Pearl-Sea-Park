import { Group, Mesh, PlaneGeometry, Quaternion } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { abs, mix, positionGeometry, smoothstep, vec3, vec4 } from 'three/tsl'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'

/**
 * Held items rig (plan §8): finely made props floating at hand position with
 * inertial sway — no arm mesh, by design (dreamlike, and no uncanny gloves).
 * S5 ships the rig + the golden ticket; later stages add map, cone, prizes.
 */
export class HeldItemSystem implements GameSystem {
  readonly id = 'held-items'

  private rig: Group | null = null
  private ticket: Mesh | null = null
  private readonly lastCameraQuaternion = new Quaternion()
  private swayX = 0
  private swayY = 0
  private ticketVisible = true

  init(ctx: GameContext): void {
    // Camera children render only if the camera is in the scene graph.
    ctx.scene.add(ctx.camera)

    const rig = new Group()
    rig.position.set(0.27, -0.22, -0.52)
    ctx.camera.add(rig)
    this.rig = rig

    // Golden Ticket №1 — cardstock with a gilt border, TSL-drawn.
    const material = new MeshBasicNodeMaterial()
    const uv = positionGeometry.xy
    const edge = smoothstep(0.062, 0.058, abs(uv.x).max(abs(uv.y).mul(1.78)))
    const border = smoothstep(0.052, 0.05, abs(uv.x).max(abs(uv.y).mul(1.78)))
    const gold = vec3(0.85, 0.68, 0.32)
    const card = vec3(0.93, 0.88, 0.78)
    const face = mix(gold, mix(card, gold.mul(0.85), border.sub(edge).abs()), edge)
    material.colorNode = vec4(face, 1)

    const ticket = new Mesh(new PlaneGeometry(0.13, 0.073), material)
    ticket.rotation.set(-0.5, 0.22, 0.12)
    rig.add(ticket)
    this.ticket = ticket

    this.lastCameraQuaternion.copy(ctx.camera.quaternion)
    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyT') {
        this.ticketVisible = !this.ticketVisible
      }
    })
  }

  update(ctx: GameContext, dt: number): void {
    const rig = this.rig
    if (!rig) return

    // Inertial sway from camera rotation delta.
    const current = ctx.camera.quaternion
    const dx = current.x - this.lastCameraQuaternion.x
    const dy = current.y - this.lastCameraQuaternion.y
    this.lastCameraQuaternion.copy(current)
    this.swayX += (-dy * 2.4 - this.swayX) * Math.min(1, dt * 7)
    this.swayY += (dx * 2.0 - this.swayY) * Math.min(1, dt * 7)
    rig.position.x = 0.27 + this.swayX * 0.15
    rig.position.y = -0.22 + this.swayY * 0.12 + Math.sin(ctx.time.elapsed * 1.1) * 0.0035
    rig.rotation.z = this.swayX * 0.35
    rig.rotation.x = this.swayY * 0.3

    if (this.ticket) {
      const target = this.ticketVisible ? 1 : 0
      const s = this.ticket.scale.x + (target - this.ticket.scale.x) * Math.min(1, dt * 9)
      this.ticket.scale.setScalar(Math.max(0.0001, s))
    }
  }

  dispose(ctx: GameContext): void {
    if (this.rig) ctx.camera.remove(this.rig)
  }
}
