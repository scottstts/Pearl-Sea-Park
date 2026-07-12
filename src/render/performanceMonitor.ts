import { TimestampQuery } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

export interface FrameTiming {
  cpuMs: number
  frameIntervalMs: number
  nowMs: number
}

export interface PerformanceSnapshot {
  cpuFrameMs: number
  presentedFrameMs: number
  presentedFps: number
  gpuFrameMs: number | null
  gpuRenderMs: number | null
  gpuComputeMs: number | null
}

/**
 * One retained record per >2-vsync frame, with enough context to name the
 * culprit after the fact: how much was main-thread JS vs presentation gap,
 * whether the dynamic-resolution scale stepped (render-target reallocation),
 * and whether shadow work (static bundle refresh / dynamic caster render)
 * coincided. Surfaced through `canvas.dataset.performance` so a freeze seen
 * in play is attributable without a profiler attached.
 */
export interface HitchRecord {
  /** Park clock (seconds) when the frame landed. */
  at: number
  frameMs: number
  cpuMs: number
  renderScale: number
  scaleChanged: boolean
  staticShadowRefreshes: number
  dynamicShadowRenders: number
}

const EMA = 0.08
const HITCH_THRESHOLD_MS = 40
const HITCH_RING = 24

/** Non-blocking CPU, presentation-cadence, and WebGPU timestamp telemetry. */
export class FramePerformanceMonitor {
  readonly hitches: HitchRecord[] = []

  private cpuFrameMs = 1000 / 60
  private presentedFrameMs = 1000 / 60
  private gpuRenderMs: number | null = null
  private gpuComputeMs: number | null = null
  private resolvePending = false
  private lastRenderScale = 1
  private lastStaticRefreshes = 0
  private lastDynamicRenders = 0
  private readonly renderer: WebGPURenderer

  constructor(renderer: WebGPURenderer) {
    this.renderer = renderer
  }

  sample(timing: FrameTiming, _frame: number): void {
    this.cpuFrameMs += (Math.min(timing.cpuMs, 100) - this.cpuFrameMs) * EMA
    this.presentedFrameMs += (
      Math.min(timing.frameIntervalMs, 100) - this.presentedFrameMs
    ) * EMA
    this.resolveGpu()
  }

  /** Frames longer than two vsyncs get a retained, attributable record. */
  noteFrame(
    timing: FrameTiming,
    atSeconds: number,
    renderScale: number,
    staticShadowRefreshes: number,
    dynamicShadowRenders: number,
  ): void {
    const scaleChanged = renderScale !== this.lastRenderScale
    this.lastRenderScale = renderScale
    const staticDelta = staticShadowRefreshes - this.lastStaticRefreshes
    this.lastStaticRefreshes = staticShadowRefreshes
    const dynamicDelta = dynamicShadowRenders - this.lastDynamicRenders
    this.lastDynamicRenders = dynamicShadowRenders
    if (timing.frameIntervalMs < HITCH_THRESHOLD_MS) return
    this.hitches.push({
      at: Math.round(atSeconds * 10) / 10,
      frameMs: Math.round(timing.frameIntervalMs),
      cpuMs: Math.round(timing.cpuMs * 10) / 10,
      renderScale,
      scaleChanged,
      staticShadowRefreshes: staticDelta,
      dynamicShadowRenders: dynamicDelta,
    })
    if (this.hitches.length > HITCH_RING) this.hitches.shift()
  }

  snapshot(): PerformanceSnapshot {
    const gpuFrameMs = this.gpuRenderMs === null && this.gpuComputeMs === null
      ? null
      : (this.gpuRenderMs ?? 0) + (this.gpuComputeMs ?? 0)
    return {
      cpuFrameMs: this.cpuFrameMs,
      presentedFrameMs: this.presentedFrameMs,
      presentedFps: 1000 / Math.max(this.presentedFrameMs, 0.001),
      gpuFrameMs,
      gpuRenderMs: this.gpuRenderMs,
      gpuComputeMs: this.gpuComputeMs,
    }
  }

  private resolveGpu(): void {
    const backend = this.renderer.backend as { trackTimestamp?: boolean }
    // Resolve continuously (one resolution in flight at a time): every pass
    // in the frame allocates timestamp queries, and the pool overflows in
    // well under 60 frames — three then warns "Maximum number of queries
    // exceeded" and drops samples. Resolution is asynchronous and cheap.
    if (backend.trackTimestamp !== true || this.resolvePending) return

    this.resolvePending = true
    void Promise.all([
      this.renderer.resolveTimestampsAsync(TimestampQuery.RENDER),
      this.renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE),
    ]).then(([renderMs, computeMs]) => {
      if (Number.isFinite(renderMs)) this.gpuRenderMs = renderMs ?? null
      if (Number.isFinite(computeMs)) this.gpuComputeMs = computeMs ?? null
    }).catch(() => {
      // Timestamp queries are optional WebGPU features. Keep the most recent
      // valid readings when an adapter loses or declines query support.
    }).finally(() => {
      this.resolvePending = false
    })
  }
}
