/**
 * Debug harness (plan §3/§15). URL flags:
 *   ?debug          — tweakpane + stats overlay (dev tooling, dynamic import)
 *   ?view=<name>    — jump camera to a registered bookmark (postcard cameras)
 *   ?pass=<name>    — isolate a render pass (ao, ao-filtered/applied/mask/footprint, bloom, caustics, rays, haze, depth, normal, no-post) or a wake diagnostic (wake-layers/age/flow)
 *   ?tier=<0|1|2>   — force a quality tier
 *   ?seed=<n>       — override the world seed
 *   ?time=<seconds>  — freeze authored time for deterministic captures
 */

export interface DebugFlags {
  debug: boolean
  view: string | null
  pass: string
  tier: number | null
  seed: number | null
  fixedTime: number | null
}

export function parseFlags(search: string = window.location.search): DebugFlags {
  const q = new URLSearchParams(search)
  const tierRaw = q.get('tier')
  const seedRaw = q.get('seed')
  const timeRaw = q.get('time')
  return {
    debug: q.has('debug'),
    view: q.get('view'),
    pass: q.get('pass') ?? 'final',
    tier: tierRaw === null ? null : Math.max(0, Math.min(2, Number(tierRaw) | 0)),
    seed: seedRaw === null ? null : Number(seedRaw) >>> 0,
    fixedTime: timeRaw === null ? null : Math.max(0, Number(timeRaw) || 0),
  }
}

/** Fixed validation cameras — the ten postcards land here as stages complete. */
export interface CameraBookmark {
  name: string
  position: [number, number, number]
  look: [number, number, number]
  note?: string
}

const bookmarks = new Map<string, CameraBookmark>()

export function registerBookmark(bookmark: CameraBookmark): void {
  bookmarks.set(bookmark.name, bookmark)
}

export function getBookmark(name: string): CameraBookmark | undefined {
  return bookmarks.get(name)
}

export function listBookmarks(): string[] {
  return [...bookmarks.keys()]
}
