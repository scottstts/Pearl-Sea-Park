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

const EMA = 0.08
const GPU_RESOLVE_INTERVAL = 60

/** Non-blocking CPU, presentation-cadence, and WebGPU timestamp telemetry. */
export class FramePerformanceMonitor {
  private cpuFrameMs = 1000 / 60
  private presentedFrameMs = 1000 / 60
  private gpuRenderMs: number | null = null
  private gpuComputeMs: number | null = null
  private resolvePending = false
  private lastResolveFrame = -GPU_RESOLVE_INTERVAL
  private readonly renderer: WebGPURenderer

  constructor(renderer: WebGPURenderer) {
    this.renderer = renderer
  }

  sample(timing: FrameTiming, frame: number): void {
    this.cpuFrameMs += (Math.min(timing.cpuMs, 100) - this.cpuFrameMs) * EMA
    this.presentedFrameMs += (
      Math.min(timing.frameIntervalMs, 100) - this.presentedFrameMs
    ) * EMA
    this.resolveGpu(frame)
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

  private resolveGpu(frame: number): void {
    const backend = this.renderer.backend as { trackTimestamp?: boolean }
    if (
      backend.trackTimestamp !== true
      || this.resolvePending
      || frame - this.lastResolveFrame < GPU_RESOLVE_INTERVAL
    ) return

    this.resolvePending = true
    this.lastResolveFrame = frame
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
