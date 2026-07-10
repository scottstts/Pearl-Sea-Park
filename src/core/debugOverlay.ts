import type { GameContext } from '../runtime/context'
import type { GameSystem } from '../runtime/system'

interface StatsLike {
  update(): void
  init(renderer: unknown): unknown
  dom: HTMLElement
}

interface PaneLike {
  addBinding(target: object, key: string, options?: object): unknown
  addFolder(options: { title: string; expanded?: boolean }): PaneLike
  dispose(): void
}

let paneSingleton: PaneLike | null = null

/** Systems attach tuning folders here; no-op (null) outside ?debug. */
export function getDebugPane(): PaneLike | null {
  return paneSingleton
}

/**
 * Dev-only overlay behind `?debug`: stats-gl frame meter + a tweakpane for
 * live tuning. Loaded dynamically so the shipped path never pays for it.
 */
export class DebugOverlaySystem implements GameSystem {
  readonly id = 'debug-overlay'
  private stats: StatsLike | null = null

  async init(ctx: GameContext): Promise<void> {
    const [statsModule, tweakpane] = await Promise.all([import('stats-gl'), import('tweakpane')])
    const Stats = statsModule.default
    const stats = new Stats({ horizontal: true, trackGPU: true }) as unknown as StatsLike
    document.body.appendChild(stats.dom)
    await stats.init(ctx.renderer)
    this.stats = stats

    const pane = new tweakpane.Pane({ title: 'The Pearl — debug' }) as unknown as PaneLike
    paneSingleton = pane
    const info = pane.addFolder({ title: 'session', expanded: true })
    info.addBinding(ctx.rng, 'seed', { readonly: true })
    info.addBinding(ctx.quality, 'tier', { readonly: true })
    info.addBinding(ctx.quality, 'renderScale', { readonly: true })
  }

  update(): void {
    this.stats?.update()
  }

  dispose(): void {
    this.stats?.dom.remove()
    paneSingleton?.dispose()
    paneSingleton = null
  }
}
