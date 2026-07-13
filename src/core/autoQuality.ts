import { Vector2 } from 'three'
import { StorageBufferAttribute } from 'three/webgpu'
import type { ComputeNode, StorageBufferNode, WebGPURenderer } from 'three/webgpu'
import { Fn, Loop, float, fract, instanceIndex, sin, storage, vec4 } from 'three/tsl'
import { TIERS } from './quality'

const RESULT_KEY = 'the-pearl:auto-quality:v2'
const MODE_KEY = 'the-pearl:quality-mode'
const SAMPLE_COUNT = 131_072
const SAMPLE_PASSES = 3

export type QualitySource = 'url' | 'override' | 'cached-auto' | 'benchmark'

export interface QualitySelection {
  tier: number
  source: QualitySource
  /** Mean queue-complete time for the representative kernel, when measured. */
  benchmarkMs: number | null
  /** Runtime-calibrated starting scale from a previous Auto session. */
  initialRenderScale: number
}

interface CachedResult {
  tier: number
  benchmarkMs: number
  renderScale: number
}

let severeRuntimeSamples = 0
let lastPersistedRuntimeSignature: string | null = null
let lastRuntimePersistMs = -Infinity

/** Minimum spacing between runtime persistence writes. localStorage is
 * synchronous main-thread I/O; while dynamic resolution breathes, an
 * unquantized renderScale changed the signature every sample and wrote to
 * disk once a second for nothing. */
const RUNTIME_PERSIST_INTERVAL_MS = 20_000

/** Pause-card overrides survive reload; `auto` returns ownership to the benchmark. */
export function setQualityMode(mode: 'auto' | number): void {
  try {
    if (mode === 'auto') localStorage.setItem(MODE_KEY, 'auto')
    else localStorage.setItem(MODE_KEY, String(clampTier(mode)))
  } catch {
    // The active session still has its selected tier when persistence is denied.
  }
}

export function getQualityMode(): 'auto' | number {
  try {
    const raw = localStorage.getItem(MODE_KEY)
    if (raw === null || raw === 'auto') return 'auto'
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampTier(parsed) : 'auto'
  } catch {
    return 'auto'
  }
}

/**
 * Select the tier before any tier-sized systems initialize. The benchmark is
 * a real WebGPU storage-buffer kernel and `computeAsync` waits for queue
 * completion, so the score is GPU work rather than a user-agent guess.
 */
export async function selectInitialQuality(
  renderer: WebGPURenderer,
  forcedTier: number | null,
): Promise<QualitySelection> {
  if (forcedTier !== null) {
    return { tier: clampTier(forcedTier), source: 'url', benchmarkMs: null, initialRenderScale: 1 }
  }

  const mode = getQualityMode()
  if (mode !== 'auto') {
    return { tier: mode, source: 'override', benchmarkMs: null, initialRenderScale: 1 }
  }

  const cached = readCachedResult()
  if (cached) {
    return {
      tier: cached.tier,
      source: 'cached-auto',
      benchmarkMs: cached.benchmarkMs,
      // Never reopen directly at an emergency floor. A previous session may
      // have sampled a transient hitch, a backgrounded tab, or a different
      // viewport. Start near native and let the live controller re-evaluate.
      initialRenderScale: Math.max(0.95, cached.renderScale),
    }
  }

  const benchmarkMs = await runQualityBenchmark(renderer)
  const drawingSize = renderer.getDrawingBufferSize(new Vector2())
  const drawingPixels = Math.max(1, drawingSize.x * drawingSize.y)
  const resolutionPenalty = Math.sqrt(drawingPixels / (2560 * 1440))
  const normalizedMs = benchmarkMs * Math.max(0.75, resolutionPenalty)
  const tier = normalizedMs <= 5.4 ? 2 : normalizedMs <= 11.5 ? 1 : 0
  const result = { tier, benchmarkMs, renderScale: 1 }
  try {
    const signature = JSON.stringify(result)
    localStorage.setItem(RESULT_KEY, signature)
    lastPersistedRuntimeSignature = signature
  } catch {
    // Storage can be unavailable in private contexts; the measured tier still applies.
  }
  return { tier, benchmarkMs, initialRenderScale: 1, source: 'benchmark' }
}

/**
 * Persist what the representative scene, not just the startup kernel, could
 * sustain. Severe floor-bound sessions start one feature tier lower on the
 * next visit; healthy sessions retain their authored tier and a conservative
 * near-native starting hint.
 */
export function recordAutoRuntimeSample(
  selection: QualitySelection,
  tier: number,
  renderScale: number,
  presentedFrameMs: number,
): void {
  if (selection.source === 'url' || selection.source === 'override') return
  const floor = TIERS[tier].renderScaleMin
  severeRuntimeSamples = presentedFrameMs > 28 && renderScale <= floor + 0.01
    ? severeRuntimeSamples + 1
    : 0
  const nextTier = severeRuntimeSamples >= 3 && tier > 0 ? tier - 1 : tier
  const result: CachedResult = {
    tier: nextTier,
    benchmarkMs: selection.benchmarkMs ?? 0,
    // Quantized to 0.05: the stored value is only a next-session starting
    // hint (and re-floored to ≥0.95 on load), so fine steps are noise.
    renderScale: nextTier === tier
      ? Math.round(clamp(renderScale, floor, 1) * 20) / 20
      : 1,
  }
  try {
    const signature = JSON.stringify(result)
    if (signature === lastPersistedRuntimeSignature) return
    const now = performance.now()
    // A tier demotion must land immediately; scale hints can wait their turn.
    if (nextTier === tier && now - lastRuntimePersistMs < RUNTIME_PERSIST_INTERVAL_MS) return
    localStorage.setItem(RESULT_KEY, signature)
    lastPersistedRuntimeSignature = signature
    lastRuntimePersistMs = now
  } catch {
    // Runtime adaptation remains active when persistence is unavailable.
  }
}

async function runQualityBenchmark(renderer: WebGPURenderer): Promise<number> {
  const attribute = new StorageBufferAttribute(new Float32Array(SAMPLE_COUNT * 4), 4)
  const target = storage(attribute, 'vec4', SAMPLE_COUNT) as StorageBufferNode<'vec4'>
  const kernel = Fn(() => {
    const seed = float(instanceIndex).mul(0.000_119_209_29)
    const value = vec4(seed, seed.mul(1.37).add(0.17), seed.mul(2.11).add(0.31), 1).toVar()
    Loop(36, ({ i }) => {
      const wave = sin(value.mul(1.91).add(float(i).mul(0.071)))
      value.assign(fract(wave.mul(7.13).add(value.wzyx.mul(1.17)).abs()))
    })
    target.element(instanceIndex).assign(value)
  })().compute(SAMPLE_COUNT) as ComputeNode
  kernel.setName('qualityAutoBenchmark')

  // First dispatch compiles the kernel and is intentionally excluded.
  await renderer.computeAsync(kernel)
  const started = performance.now()
  for (let i = 0; i < SAMPLE_PASSES; i++) await renderer.computeAsync(kernel)
  const elapsed = (performance.now() - started) / SAMPLE_PASSES
  kernel.dispose()
  target.dispose()
  return elapsed
}

function readCachedResult(): CachedResult | null {
  try {
    const raw = localStorage.getItem(RESULT_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<CachedResult>
    if (!Number.isFinite(value.tier) || !Number.isFinite(value.benchmarkMs)) return null
    const tier = clampTier(value.tier!)
    const storedScale = Number(value.renderScale ?? 1)
    const result = {
      tier,
      benchmarkMs: Math.max(0, value.benchmarkMs!),
      renderScale: Number.isFinite(storedScale)
        ? clamp(storedScale, TIERS[tier].renderScaleMin, 1)
        : 1,
    }
    lastPersistedRuntimeSignature = raw
    return result
  } catch {
    return null
  }
}

function clampTier(tier: number): number {
  return Math.max(0, Math.min(TIERS.length - 1, Math.round(tier)))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
