import { Vector3 } from 'three'
import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'
import { FACILITY_ENTRANCE_SIGNS } from '../world/parkLayout'
import type { InteractionSystem } from './interact'
import type { PlayerSystem } from './player'

/** Metres in front of a marker (toward its approach) the guest lands, facing it. */
const SPAWN_DIST = 3.6
/** How near a marker the "Teleport" prompt lights up. */
const NODE_RADIUS = 5.5
/** Marker ground lift; mirrors FacilitySignsSystem so the anchor tracks the board. */
const SIGN_GROUND_LIFT = 0.08
/** Fade envelope (seconds): dim to deep blue, hold the notice, rise on the new site. */
const FADE_OUT = 0.55
const HOLD = 0.5
const FADE_IN = 0.75

type Destination = {
  id: string
  title: string
  subtitle?: string
  spawnX: number
  spawnZ: number
  spawnGroundY: number
  yaw: number
  anchor: Vector3
}

type Phase = 'idle' | 'menu' | 'out' | 'hold' | 'in'

/**
 * The teleport network (guest-facing wayfinding taken literally): every
 * facility marker is a node. Approaching one offers "Teleport"; the menu lists
 * every site, arrows choose, Enter travels. The move happens under a deep-blue
 * fade — the same field the visit opens on — so the cut between sites is a
 * dissolve, never a snap.
 *
 * Modality rides on the player's `inputFrozen`, never `controlEnabled`: the
 * pause card and rides own the latter, so Esc-out (which also releases the
 * pointer and raises the pause card) cannot strand control on a value this
 * system borrowed.
 */
export class TeleportSystem implements GameSystem {
  readonly id = 'teleport'

  private readonly player: PlayerSystem
  private readonly interaction: InteractionSystem
  private readonly groundHeight: (x: number, z: number) => number
  private readonly destinations: Destination[] = []
  private readonly unregister: (() => void)[] = []

  private phase: Phase = 'idle'
  private timer = 0
  private selected = 0
  private pending = 0

  private root: HTMLDivElement | null = null
  private listEl: HTMLUListElement | null = null
  private itemEls: HTMLLIElement[] = []
  private fade: HTMLDivElement | null = null
  private keyListener: ((event: KeyboardEvent) => void) | null = null

  constructor(
    player: PlayerSystem,
    interaction: InteractionSystem,
    groundHeight: (x: number, z: number) => number,
  ) {
    this.player = player
    this.interaction = interaction
    this.groundHeight = groundHeight
  }

  init(_ctx: GameContext): void {
    for (const sign of FACILITY_ENTRANCE_SIGNS) {
      const dx = sign.approachX - sign.x
      const dz = sign.approachZ - sign.z
      const len = Math.hypot(dx, dz) || 1
      // The marker's readable face points toward its approach; land a few
      // metres out along that ray and turn back so the board fills the view.
      const fx = dx / len
      const fz = dz / len
      const spawnX = sign.x + fx * SPAWN_DIST
      const spawnZ = sign.z + fz * SPAWN_DIST
      this.destinations.push({
        id: sign.id,
        title: sign.title,
        subtitle: sign.subtitle,
        spawnX,
        spawnZ,
        spawnGroundY: this.groundHeight(spawnX, spawnZ),
        yaw: Math.atan2(fx, fz),
        anchor: new Vector3(sign.x, this.groundHeight(sign.x, sign.z) + SIGN_GROUND_LIFT + 2.05, sign.z),
      })
    }
    // Home node (the park entrance) leads the list; the rest keep roster order.
    this.destinations.sort((a, b) =>
      a.id === 'park-entrance' ? -1 : b.id === 'park-entrance' ? 1 : 0,
    )

    for (const dest of this.destinations) {
      this.unregister.push(
        this.interaction.register({
          position: dest.anchor,
          radius: NODE_RADIUS,
          prompt: 'Teleport',
          onInteract: () => this.openMenu(),
          enabled: () => this.player.controlEnabled && this.phase === 'idle',
        }),
      )
    }

    this.buildDom()
    this.keyListener = (event) => this.onKey(event)
    window.addEventListener('keydown', this.keyListener)
  }

  update(_ctx: GameContext, dt: number): void {
    if (this.phase === 'out') {
      this.timer += dt
      const t = Math.min(1, this.timer / FADE_OUT)
      this.setFadeOpacity(t)
      if (t >= 1) {
        // Move under full cover: the overlay is opaque, so the camera cut is
        // unseen. `inputFrozen` keeps the frame still through the rise.
        const dest = this.destinations[this.pending]
        this.player.setLook(dest.yaw, 0)
        this.player.placeAt(dest.spawnX, dest.spawnGroundY, dest.spawnZ)
        this.phase = 'hold'
        this.timer = 0
      }
    } else if (this.phase === 'hold') {
      this.timer += dt
      this.setFadeOpacity(1)
      if (this.timer >= HOLD) {
        this.phase = 'in'
        this.timer = 0
      }
    } else if (this.phase === 'in') {
      this.timer += dt
      const t = Math.min(1, this.timer / FADE_IN)
      this.setFadeOpacity(1 - t)
      if (t >= 1) {
        this.phase = 'idle'
        this.player.inputFrozen = false
        this.interaction.suspended = false
        this.showFade(false)
      }
    }
  }

  private openMenu(): void {
    if (this.phase !== 'idle') return
    this.phase = 'menu'
    this.selected = 0
    this.player.inputFrozen = true
    // Mute contextual prompts/keys so a nearby bench or gate cannot fire from
    // an E press meant for the (now open) menu.
    this.interaction.suspended = true
    this.updateHighlight()
    this.root?.classList.add('is-open')
    this.root?.setAttribute('aria-hidden', 'false')
  }

  private onKey(event: KeyboardEvent): void {
    if (this.phase !== 'menu') return
    const count = this.destinations.length
    switch (event.code) {
      case 'ArrowUp':
        this.selected = (this.selected - 1 + count) % count
        this.updateHighlight()
        event.preventDefault()
        break
      case 'ArrowDown':
        this.selected = (this.selected + 1) % count
        this.updateHighlight()
        event.preventDefault()
        break
      case 'Enter':
      case 'NumpadEnter':
        event.preventDefault()
        this.confirm()
        break
      case 'KeyQ':
        // Q is the menu's own "back" (Esc belongs to the pause card).
        event.preventDefault()
        this.cancel()
        break
      case 'Escape':
        // Esc still closes the menu silently before it cascades: the browser
        // releases the pointer and the pause card rises, and it must capture a
        // live control state — never one this menu froze.
        this.cancel()
        break
    }
  }

  private confirm(): void {
    this.pending = this.selected
    this.phase = 'out'
    this.timer = 0
    this.root?.classList.remove('is-open')
    this.root?.setAttribute('aria-hidden', 'true')
    this.showFade(true)
  }

  private cancel(): void {
    this.phase = 'idle'
    this.player.inputFrozen = false
    this.interaction.suspended = false
    this.root?.classList.remove('is-open')
    this.root?.setAttribute('aria-hidden', 'true')
  }

  private updateHighlight(): void {
    this.itemEls.forEach((li, index) => {
      const active = index === this.selected
      li.classList.toggle('is-active', active)
      if (active) li.scrollIntoView({ block: 'nearest' })
    })
  }

  private setFadeOpacity(value: number): void {
    if (this.fade) this.fade.style.opacity = String(value)
  }

  private showFade(on: boolean): void {
    if (!this.fade) return
    this.fade.classList.toggle('is-active', on)
    this.fade.style.opacity = '0'
  }

  private buildDom(): void {
    const root = document.createElement('div')
    root.className = 'teleport'
    root.setAttribute('aria-hidden', 'true')
    root.innerHTML = `
      <div class="teleport-panel" role="dialog" aria-modal="true" aria-label="Teleport">
        <div class="teleport-eyebrow">Teleportation Node</div>
        <h2 class="teleport-heading">Where to?</h2>
        <ul class="teleport-list"></ul>
        <div class="teleport-hint">
          <span><b>↑ ↓</b> choose</span><span><b>Enter</b> travel</span><span><b>Q</b> back</span>
        </div>
      </div>
    `
    document.body.appendChild(root)
    this.root = root
    this.listEl = root.querySelector<HTMLUListElement>('.teleport-list')
    this.itemEls = this.destinations.map((dest) => {
      const li = document.createElement('li')
      li.className = 'teleport-item'
      const title = document.createElement('span')
      title.className = 'teleport-item-title'
      title.textContent = dest.title
      li.appendChild(title)
      if (dest.subtitle) {
        const sub = document.createElement('span')
        sub.className = 'teleport-item-sub'
        sub.textContent = dest.subtitle
        li.appendChild(sub)
      }
      this.listEl?.appendChild(li)
      return li
    })

    const fade = document.createElement('div')
    fade.className = 'teleport-fade'
    fade.innerHTML = `
      <div class="teleport-fade-inner">
        <div class="teleport-fade-title">Teleporting</div>
        <div class="teleport-fade-sub">drifting through the deep…</div>
      </div>
    `
    document.body.appendChild(fade)
    this.fade = fade
  }

  dispose(): void {
    for (const off of this.unregister) off()
    this.unregister.length = 0
    if (this.keyListener) window.removeEventListener('keydown', this.keyListener)
    this.root?.remove()
    this.fade?.remove()
    this.root = null
    this.fade = null
  }
}
