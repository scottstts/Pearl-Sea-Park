import { Vector3 } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'

/**
 * Inspection camera for fixed postcard and diagnostic views.
 * Picks up whatever pose the start bookmark set.
 */
export class DevOrbitSystem implements GameSystem {
  readonly id = 'dev-orbit'
  private controls: OrbitControls | null = null
  private targeted = false

  init(ctx: GameContext): void {
    this.controls = new OrbitControls(ctx.camera, ctx.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.maxDistance = 400
  }

  update(ctx: GameContext): void {
    if (!this.controls) return
    if (!this.targeted) {
      this.targeted = true
      const forward = new Vector3(0, 0, -1).applyQuaternion(ctx.camera.quaternion)
      this.controls.target.copy(ctx.camera.position).addScaledVector(forward, 18)
    }
    this.controls.update()
  }

  dispose(): void {
    this.controls?.dispose()
    this.controls = null
  }
}
