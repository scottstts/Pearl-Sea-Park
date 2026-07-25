export type LoadTimingDetail = Record<string, boolean | number | string>

export interface LoadTimingRecord {
  label: string
  durationMs: number
  detail?: LoadTimingDetail
}

export type LoadTimingSink = (
  label: string,
  durationMs: number,
  detail?: LoadTimingDetail,
) => void

/**
 * Durable loading telemetry. Publish after every record so a slow or failed
 * boot can still be inspected from `canvas.dataset.loadTiming`.
 */
export class LoadTimingRecorder {
  private readonly records: LoadTimingRecord[] = []
  private readonly canvas: HTMLCanvasElement
  private readonly startedAtMs: number
  private readyAtMs: number | null = null

  constructor(canvas: HTMLCanvasElement, startedAtMs: number) {
    this.canvas = canvas
    this.startedAtMs = startedAtMs
    this.publish()
  }

  record(
    label: string,
    durationMs: number,
    detail?: LoadTimingDetail,
  ): void {
    this.records.push({
      label,
      durationMs: Math.max(0, durationMs),
      ...(detail ? { detail } : {}),
    })
    this.publish()
  }

  async measure<T>(label: string, task: () => Promise<T>): Promise<T> {
    const start = performance.now()
    try {
      return await task()
    } finally {
      this.record(label, performance.now() - start)
    }
  }

  ready(): void {
    this.readyAtMs = performance.now()
    this.publish()
  }

  private publish(): void {
    const now = this.readyAtMs ?? performance.now()
    const byLabel: Record<string, number> = {}
    for (const record of this.records) {
      byLabel[record.label] = (byLabel[record.label] ?? 0) + record.durationMs
    }
    this.canvas.dataset.loadTiming = JSON.stringify({
      totalMs: now - this.startedAtMs,
      ready: this.readyAtMs !== null,
      byLabel,
      records: this.records,
    })
  }
}
