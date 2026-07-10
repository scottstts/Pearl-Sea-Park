/**
 * Central event map. Systems add entries as they land; keep names
 * namespaced `domain/event`. (Type alias, not interface — the EventBus
 * constraint needs the implicit index signature.)
 */
export type GameEvents = {
  /** Window or render-scale resize was applied. */
  'render/resized': { width: number; height: number; renderScale: number }
  /** Quality tier changed (pause menu or auto-benchmark). */
  'quality/tier-changed': { tier: number }
  /** Player crossed the waterline (rides can breach the surface). */
  'sea/waterline-crossed': { submerged: boolean }
  /** The guest clicked "enter" on the ticket screen. */
  'park/entered': Record<string, never>
  /** The golden ticket got a stamp (ride gates, the atrium machine). */
  'ticket/punched': { ride: string }
  /** Park timetable events (chimes, shows, wildlife passages). */
  'schedule/event': { name: string; phase: 'start' | 'end' }
}

