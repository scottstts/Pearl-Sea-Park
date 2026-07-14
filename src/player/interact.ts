import { Vector3 } from 'three'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'

export interface Interactable {
  /** World anchor the prompt distance is measured from. */
  position: Vector3
  radius: number
  prompt: string
  /** KeyboardEvent.code, default KeyE. */
  key?: string
  onInteract: () => void
  /** Optional gate (e.g. ride not boarding right now). */
  enabled?: () => boolean
}

/**
 * Contextual interaction (plan §8/§13 "minimal UI"): nearest eligible
 * interactable within radius + view cone shows one serif caption; its key
 * triggers it. No reticle, no lists, no HUD.
 */
export class InteractionSystem implements GameSystem {
  readonly id = 'interaction'

  /** Modals (the teleport menu) raise this to mute contextual prompts + keys. */
  suspended = false

  /**
   * While set, only this interactable is eligible (prompt and key). A piloted
   * vehicle roams the whole park, so without focus its "step out" prompt
   * would compete with every gate and game it passes — and an E meant for
   * the helm could board a ride. Owners must clear it when focus ends.
   */
  exclusive: Interactable | null = null

  private readonly interactables = new Set<Interactable>()
  private active: Interactable | null = null
  private promptElement: HTMLDivElement | null = null
  private noticeRemaining = 0
  private readonly forward = new Vector3()
  private readonly toTarget = new Vector3()

  register(interactable: Interactable): () => void {
    this.interactables.add(interactable)
    return () => this.interactables.delete(interactable)
  }

  /**
   * A transient caption in the same serif voice, without a key chip — the
   * gentle "not yet" for an action that is present but currently refused
   * (e.g. stepping out of the submarine before it has settled). It borrows
   * the prompt element briefly, then the regular caption re-renders.
   */
  notice(text: string, seconds = 2.8): void {
    const prompt = this.promptElement
    if (!prompt) return
    this.noticeRemaining = seconds
    prompt.textContent = text
    prompt.classList.add('is-visible')
  }

  /** Retire an active notice early (the refused action just succeeded). */
  dismissNotice(): void {
    if (this.noticeRemaining <= 0) return
    this.noticeRemaining = 0
    this.active = null
    this.promptElement?.classList.remove('is-visible')
  }

  init(_ctx: GameContext): void {
    const prompt = document.createElement('div')
    prompt.className = 'prompt'
    document.body.appendChild(prompt)
    this.promptElement = prompt

    window.addEventListener('keydown', (event) => {
      if (this.suspended || !this.active) return
      if (event.code === (this.active.key ?? 'KeyE')) {
        this.active.onInteract()
      }
    })
  }

  update(ctx: GameContext, dt: number): void {
    if (this.suspended) {
      this.noticeRemaining = 0
      if (this.active) {
        this.active = null
        this.promptElement?.classList.remove('is-visible')
      }
      return
    }
    if (this.noticeRemaining > 0) {
      this.noticeRemaining -= dt
      // While the notice holds the caption, the key handler stays live (the
      // active interactable is unchanged) but no re-render may overwrite it.
      if (this.noticeRemaining > 0) return
      this.active = null
      this.promptElement?.classList.remove('is-visible')
    }
    const camera = ctx.camera
    camera.getWorldDirection(this.forward)
    let best: Interactable | null = null
    let bestScore = Infinity

    for (const item of this.interactables) {
      if (this.exclusive && item !== this.exclusive) continue
      if (item.enabled && !item.enabled()) continue
      this.toTarget.copy(item.position).sub(camera.position)
      const distance = this.toTarget.length()
      if (distance > item.radius) continue
      const facing = this.toTarget.normalize().dot(this.forward)
      if (distance > 1.2 && facing < 0.35) continue
      const score = distance - facing
      if (score < bestScore) {
        bestScore = score
        best = item
      }
    }

    if (best !== this.active) {
      this.active = best
      const prompt = this.promptElement
      if (prompt) {
        if (best) {
          const key = (best.key ?? 'KeyE').replace('Key', '')
          prompt.innerHTML = `<span class="key">${key}</span>${best.prompt}`
          prompt.classList.add('is-visible')
        } else {
          prompt.classList.remove('is-visible')
        }
      }
    }
  }

  dispose(): void {
    this.promptElement?.remove()
    this.interactables.clear()
  }
}
