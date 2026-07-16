import type { PlayerSystem } from '../player/player'
import type { SeaSystem } from '../sea/seaSystem'
import type { SubmarineSystem } from '../vehicles/submarine'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'

type ControlMode = 'hidden' | 'arrival' | 'park' | 'submarine'

interface ControlHint {
  keys: string
  action: string
}

const CONTROL_HINTS: Record<Exclude<ControlMode, 'hidden'>, readonly ControlHint[]> = {
  arrival: [
    { keys: 'W A S D', action: 'Walk' },
    { keys: 'Shift', action: 'Brisk pace' },
  ],
  park: [
    { keys: 'W A S D', action: 'Move' },
    { keys: 'Shift', action: 'Brisk pace' },
    { keys: 'Space', action: 'Jump' },
  ],
  submarine: [
    { keys: 'W A S D', action: 'Pilot' },
    { keys: 'Shift', action: 'Dive' },
    { keys: 'Space', action: 'Rise' },
  ],
}

const FPS_SMOOTHING_MS = 350
const FPS_REFRESH_MS = 400

/**
 * The deliberately sparse in-play HUD: control reminders which follow the
 * active movement owner, plus a low-frequency FPS readout. Neither surface
 * owns input or game state; both only describe existing systems.
 */
export class GameHudSystem implements GameSystem {
  readonly id = 'game-hud'

  private readonly player: PlayerSystem
  private readonly sea: SeaSystem
  private readonly submarine: SubmarineSystem
  private root: HTMLDivElement | null = null
  private controlHints: HTMLDivElement | null = null
  private fpsCounter: HTMLDivElement | null = null
  private controlMode: ControlMode = 'hidden'
  private entered = false
  private paused = false
  private reduceMotion = false
  private smoothedFrameMs = 1000 / 60
  private fpsElapsedMs = 0
  private readonly cleanups: Array<() => void> = []

  constructor(player: PlayerSystem, sea: SeaSystem, submarine: SubmarineSystem) {
    this.player = player
    this.sea = sea
    this.submarine = submarine
  }

  init(ctx: GameContext): void {
    const root = document.createElement('div')
    root.className = 'game-hud'
    root.innerHTML = `
      <div class="fps-counter" aria-hidden="true">60 fps</div>
      <div class="control-hints" aria-label="Movement controls" aria-hidden="true"></div>
    `
    document.body.appendChild(root)

    this.root = root
    this.controlHints = root.querySelector<HTMLDivElement>('.control-hints')
    this.fpsCounter = root.querySelector<HTMLDivElement>('.fps-counter')
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    this.cleanups.push(
      ctx.events.on('park/entered', () => {
        this.entered = true
        root.classList.add('is-entered')
        this.syncControlHints(ctx)
      }),
      ctx.events.on('runtime/pause-changed', ({ paused }) => {
        this.paused = paused
        this.syncControlHints(ctx)
      }),
    )
  }

  update(ctx: GameContext): void {
    this.syncControlHints(ctx)
  }

  /** Receives the loop's real presentation interval, including GPU stalls. */
  sampleFrame(frameIntervalMs: number): void {
    if (!Number.isFinite(frameIntervalMs) || frameIntervalMs <= 0) return

    const sample = Math.min(frameIntervalMs, 250)
    const smoothing = 1 - Math.exp(-sample / FPS_SMOOTHING_MS)
    this.smoothedFrameMs += (sample - this.smoothedFrameMs) * smoothing
    this.fpsElapsedMs += sample
    if (this.fpsElapsedMs < FPS_REFRESH_MS) return

    this.fpsElapsedMs %= FPS_REFRESH_MS
    if (this.fpsCounter) {
      this.fpsCounter.textContent = `${Math.round(1000 / this.smoothedFrameMs)} fps`
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.root?.remove()
    this.root = null
    this.controlHints = null
    this.fpsCounter = null
  }

  private syncControlHints(ctx: GameContext): void {
    const controlHints = this.controlHints
    if (!controlHints) return

    const mode = this.resolveControlMode(ctx)
    if (mode === this.controlMode) return

    const previousMode = this.controlMode
    this.controlMode = mode
    if (mode === 'hidden') {
      controlHints.classList.remove('is-visible')
      controlHints.setAttribute('aria-hidden', 'true')
      return
    }

    const rows = CONTROL_HINTS[mode].map(({ keys, action }) => {
      const row = document.createElement('div')
      row.className = 'control-hint'

      const key = document.createElement('span')
      key.className = 'control-hint-key'
      key.textContent = keys

      const label = document.createElement('span')
      label.className = 'control-hint-label'
      label.textContent = action

      row.append(key, label)
      return row
    })
    controlHints.replaceChildren(...rows)
    controlHints.classList.add('is-visible')
    controlHints.setAttribute('aria-hidden', 'false')

    if (previousMode !== 'hidden' && !this.reduceMotion) {
      controlHints.getAnimations().forEach((animation) => animation.cancel())
      controlHints.animate(
        [
          { opacity: 0, transform: 'translateY(5px)' },
          { opacity: 0.84, transform: 'translateY(0)' },
        ],
        { duration: 280, easing: 'ease-out' },
      )
    }
  }

  private resolveControlMode(ctx: GameContext): ControlMode {
    if (!this.entered || this.paused || ctx.time.paused || this.player.inputFrozen) return 'hidden'
    if (this.submarine.isAboard) return 'submarine'
    if (!this.player.controlEnabled) return 'hidden'
    return this.sea.isSubmerged ? 'park' : 'arrival'
  }
}
