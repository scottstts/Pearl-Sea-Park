import type { PerspectiveCamera, Scene } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import type { EventBus } from '../core/events'
import type { GameEvents } from '../core/gameEvents'
import type { Rng } from '../core/prng'
import type { DebugFlags } from '../core/debug'
import type { QualityState } from '../core/quality'

export interface TimeState {
  /** Wall-clock seconds since boot (render clock). */
  elapsed: number
  /** Accumulated fixed-step simulation seconds. */
  sim: number
  /** Rendered frame counter. */
  frame: number
}

/**
 * Shared context handed to every system. Grows as stages land; systems that
 * need each other are wired explicitly in main.ts, not looked up here.
 */
export interface GameContext {
  readonly renderer: WebGPURenderer
  readonly scene: Scene
  readonly camera: PerspectiveCamera
  readonly events: EventBus<GameEvents>
  readonly rng: Rng
  readonly flags: DebugFlags
  readonly quality: QualityState
  readonly time: TimeState
}
