/**
 * The ticket screen — entry overlay, loading progress, and the WebGPU-required
 * notice. The only full-screen UI in the game.
 */
export const TICKET_REVEAL_SECONDS = 1.6

export interface TicketScreen {
  setProgress(label: string, fraction: number): void
  /** Swap progress for the enter button; resolves when the guest clicks. */
  showEnter(): Promise<void>
  showError(title: string, body: string): void
  hide(): void
}

export function createTicketScreen(parent: HTMLElement): TicketScreen {
  const root = document.createElement('div')
  root.className = 'ticket'
  root.innerHTML = `
    <div class="ticket-card">
      <div class="ticket-eyebrow">Royal Pleasure Gardens Beneath the Sea</div>
      <h1 class="ticket-title">The Pearl</h1>
      <div class="ticket-sub">Admit one · Golden Ticket №1 · Preview Day</div>
      <div class="ticket-rule"></div>
      <div class="ticket-status">
        <div class="ticket-progress-label">Waking the machinery…</div>
        <div class="ticket-progress"><i></i></div>
      </div>
    </div>
  `
  parent.appendChild(root)
  root.style.setProperty('--ticket-reveal-duration', `${TICKET_REVEAL_SECONDS}s`)

  const status = root.querySelector<HTMLElement>('.ticket-status')!
  const label = root.querySelector<HTMLElement>('.ticket-progress-label')!
  const bar = root.querySelector<HTMLElement>('.ticket-progress > i')!

  const labels: Record<string, string> = {
    'render-pipeline': 'Polishing the lenses',
    'quality-benchmark': 'Measuring the machinery',
    'ocean-sky': 'Painting the afternoon',
    'ocean-surface': 'Calming the surface',
    'arrival-pavilion': 'Mooring the buoy',
    'dev-orbit': 'Adjusting the tripod',
    'sea-medium': 'Letting in the light',
    seabed: 'Raking the sand',
    flora: 'Planting the gardens',
    physics: 'Winding the gears',
    player: 'Pressing your ticket',
    'pause-card': 'Printing the ticket reverse',
    interaction: 'Polishing the levers',
    teleport: 'Charting the tide-lines',
    'held-items': 'Gilding the ticket',
    materials: 'Mixing the lacquers',
    atrium: 'Raising the colonnades',
    park: 'Opening the gates',
    'descent-bell': 'Oiling the winch',
    'pearl-line': 'Stringing the cable',
    'great-wheel': 'Turning the great wheel',
    carousel: 'Winding the music box',
    torrent: 'Priming the torrent',
    scheduler: 'Winding the timetable',
    wildlife: 'Waking the wildlife',
    'bubble-fountain': 'Teaching the bubbles to dance',
    'schedule-boards': 'Setting the performance boards',
    audio: 'Tuning the music boxes',
    'debug-overlay': 'Hanging the gauges',
    'test-gallery': 'Arranging the gallery',
    ready: 'Ready',
  }

  return {
    setProgress(key, fraction) {
      label.textContent = labels[key] ?? key.replace(/-/g, ' ')
      bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`
    },

    showEnter() {
      return new Promise((resolve) => {
        status.innerHTML = ''
        const button = document.createElement('button')
        button.className = 'ticket-enter'
        button.textContent = 'Enter the Park'
        status.appendChild(button)
        button.addEventListener(
          'click',
          () => {
            resolve()
          },
          { once: true },
        )
        button.focus()
      })
    },

    showError(title, body) {
      status.innerHTML = ''
      const el = document.createElement('div')
      el.className = 'ticket-error'
      const strong = document.createElement('strong')
      strong.textContent = title
      el.appendChild(strong)
      el.appendChild(document.createTextNode(body))
      status.appendChild(el)
    },

    hide() {
      root.classList.add('is-hidden')
      window.setTimeout(() => root.remove(), 1800)
    },
  }
}
