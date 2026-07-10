import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import type { SeaMediumSystem } from '../sea/medium'
import { ParkMaterials } from './library'

/**
 * Owns the shared ParkMaterials instance. Constructed at init time because
 * the caustic sampler must exist first (medium inits earlier in the order).
 */
export class MaterialsSystem implements GameSystem {
  readonly id = 'materials'
  lib: ParkMaterials | null = null
  private readonly medium: SeaMediumSystem

  constructor(medium: SeaMediumSystem) {
    this.medium = medium
  }

  init(_ctx: GameContext): void {
    this.lib = new ParkMaterials(this.medium)
  }
}
