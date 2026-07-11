/**
 * Central event map. Systems add entries as they land; keep names
 * namespaced `domain/event`. (Type alias, not interface — the EventBus
 * constraint needs the implicit index signature.)
 */
export type GameEvents = {
  /** Window or render-scale resize was applied. */
  'render/resized': { width: number; height: number; renderScale: number }
  /** Back-of-ticket pause card changed simulation ownership. */
  'runtime/pause-changed': { paused: boolean }
  /** Pause-card master-volume control, normalized 0..1. */
  'audio/volume-changed': { volume: number }
  /** Player crossed the waterline (rides can breach the surface). */
  'sea/waterline-crossed': { submerged: boolean }
  /** The guest clicked "enter" on the ticket screen. */
  'park/entered': Record<string, never>
  /** The golden ticket got a stamp (ride gates, the atrium machine). */
  'ticket/punched': { ride: string }
  /** All six ride-gate stamps are present on the cardstock ticket. */
  'ticket/completed': { stamps: number }
  /** Park timetable events (chimes, shows, wildlife passages). */
  'schedule/event': { name: string; phase: 'start' | 'end' }
  /** Descent Bell drive state (audio hums + door prompts key off this). */
  'ride/bell-state': { state: 'docked-top' | 'descending' | 'docked-bottom' | 'ascending' }
  /** Guest boarded/left a Pearl Line cabin (cable hum while riding). */
  'ride/pearl-riding': { riding: boolean }
  /** Guest boarded/left a Great Wheel gondola. */
  'ride/wheel-riding': { riding: boolean }
  /** Guest mounted/left the carousel. */
  'ride/carousel-riding': { riding: boolean }
  /** Torrent lap-bar down / raised (rattle + roar while riding). */
  'ride/torrent-riding': { riding: boolean }
  /** Guest boarded/left a Grotto shell boat. */
  'ride/grotto-riding': { riding: boolean }
  /** Camera blend into the Grotto's long cave acoustic. */
  'audio/grotto-interior': { amount: number }
  /** A deterministic ceiling drip struck the simulated channel. */
  'grotto/drip': Record<string, never>
  /** Food or another future prop is attracting the Turtle Lagoon residents. */
  'wildlife/turtle-attractor': { x: number; y: number; z: number; strength: number }
  /** Authored whale passage phases; audio intentionally begins before sight. */
  'wildlife/whale-cue': { phase: 'approach' | 'visible' | 'depart' | 'end' }
  /** A Midway game awarded one of its two physical counter prizes. */
  'games/prize-earned': { prize: 'paper-hat' | 'plush-kraken' }
  /** A penny press finished one of the eight park motifs. */
  'games/penny-pressed': { motif: string }
  /** Physical puck reached the Kraken Bell's top striker. */
  'games/kraken-bell': { power: number; x: number; y: number; z: number }
}
