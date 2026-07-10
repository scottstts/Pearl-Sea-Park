import { getQualityMode, setQualityMode } from '../core/autoQuality'
import type { PlayerSystem } from '../player/player'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'

const VOLUME_KEY = 'the-pearl:master-volume'

/** Back of the Golden Ticket: the game's only in-play menu. */
export class PauseCardSystem implements GameSystem {
  readonly id = 'pause-card'

  private readonly player: PlayerSystem
  private root: HTMLDivElement | null = null
  private entered = false
  private open = false
  private controlWasEnabled = true

  constructor(player: PlayerSystem) {
    this.player = player
  }

  init(ctx: GameContext): void {
    const root = document.createElement('div')
    root.className = 'pause'
    root.setAttribute('aria-hidden', 'true')
    root.innerHTML = `
      <section class="pause-card" role="dialog" aria-modal="true" aria-label="Pause">
        <div class="pause-eyebrow">Golden Ticket №1 · Reverse</div>
        <h2>The park is waiting</h2>
        <button class="pause-resume" type="button">Return to the gardens</button>
        <div class="pause-rule"></div>
        <fieldset>
          <legend>Quality</legend>
          <div class="pause-tiers" role="group" aria-label="Quality tier">
            <button type="button" data-tier="auto">Auto</button>
            <button type="button" data-tier="0">Gentle</button>
            <button type="button" data-tier="1">Fine</button>
            <button type="button" data-tier="2">Grand</button>
          </div>
          <small>Changing quality reopens the park.</small>
        </fieldset>
        <label class="pause-volume">
          <span>Volume</span>
          <input type="range" min="0" max="1" step="0.01" value="0.55" />
        </label>
      </section>
    `
    document.body.appendChild(root)
    this.root = root

    const resume = root.querySelector<HTMLButtonElement>('.pause-resume')!
    resume.addEventListener('click', () => this.resume(ctx))

    const mode = getQualityMode()
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-tier]')) {
      const raw = button.dataset.tier!
      const active = raw === String(mode)
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', String(active))
      button.addEventListener('click', () => {
        setQualityMode(raw === 'auto' ? 'auto' : Number(raw))
        window.location.reload()
      })
    }

    const volume = root.querySelector<HTMLInputElement>('.pause-volume input')!
    volume.value = String(readVolume())
    volume.addEventListener('input', () => {
      const value = Math.max(0, Math.min(1, volume.valueAsNumber))
      try {
        localStorage.setItem(VOLUME_KEY, String(value))
      } catch {
        // Persistence is optional; the live control still applies.
      }
      ctx.events.emit('audio/volume-changed', { volume: value })
    })

    ctx.events.on('park/entered', () => {
      this.entered = true
      ctx.events.emit('audio/volume-changed', { volume: readVolume() })
    })
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === ctx.renderer.domElement
      if (!this.entered) return
      if (!locked && !this.open) this.pause(ctx)
      else if (locked && this.open) this.close(ctx)
    })
  }

  private pause(ctx: GameContext): void {
    this.open = true
    this.controlWasEnabled = this.player.controlEnabled
    this.player.controlEnabled = false
    ctx.time.paused = true
    this.root?.classList.add('is-open')
    this.root?.setAttribute('aria-hidden', 'false')
    this.root?.querySelector<HTMLButtonElement>('.pause-resume')?.focus()
    ctx.events.emit('runtime/pause-changed', { paused: true })
  }

  private resume(ctx: GameContext): void {
    void ctx.renderer.domElement.requestPointerLock()
  }

  private close(ctx: GameContext): void {
    this.open = false
    ctx.time.paused = false
    this.player.controlEnabled = this.controlWasEnabled
    this.root?.classList.remove('is-open')
    this.root?.setAttribute('aria-hidden', 'true')
    ctx.events.emit('runtime/pause-changed', { paused: false })
  }

  dispose(): void {
    this.root?.remove()
    this.root = null
  }
}

function readVolume(): number {
  try {
    const stored = localStorage.getItem(VOLUME_KEY)
    if (stored === null) return 0.55
    const raw = Number(stored)
    return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.55
  } catch {
    return 0.55
  }
}
