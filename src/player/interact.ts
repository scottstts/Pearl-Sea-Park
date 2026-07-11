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

  private readonly interactables = new Set<Interactable>()
  private active: Interactable | null = null
  private promptElement: HTMLDivElement | null = null
  private readonly forward = new Vector3()
  private readonly toTarget = new Vector3()

  register(interactable: Interactable): () => void {
    this.interactables.add(interactable)
    return () => this.interactables.delete(interactable)
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

  update(ctx: GameContext): void {
    if (this.suspended) {
      if (this.active) {
        this.active = null
        this.promptElement?.classList.remove('is-visible')
      }
      return
    }
    const camera = ctx.camera
    camera.getWorldDirection(this.forward)
    let best: Interactable | null = null
    let bestScore = Infinity

    for (const item of this.interactables) {
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
