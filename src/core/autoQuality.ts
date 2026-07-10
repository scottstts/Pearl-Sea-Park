import { Vector2 } from 'three'
import { StorageBufferAttribute } from 'three/webgpu'
import type { ComputeNode, StorageBufferNode, WebGPURenderer } from 'three/webgpu'
import { Fn, Loop, float, fract, instanceIndex, sin, storage, vec4 } from 'three/tsl'
import { TIERS } from './quality'

const RESULT_KEY = 'the-pearl:auto-quality:v1'
const MODE_KEY = 'the-pearl:quality-mode'
const SAMPLE_COUNT = 131_072
const SAMPLE_PASSES = 3

export type QualitySource = 'url' | 'override' | 'cached-auto' | 'benchmark'

export interface QualitySelection {
  tier: number
  source: QualitySource
  /** Mean queue-complete time for the representative kernel, when measured. */
  benchmarkMs: number | null
}

interface CachedResult {
  tier: number
  benchmarkMs: number
}

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
  if (forcedTier !== null) return { tier: clampTier(forcedTier), source: 'url', benchmarkMs: null }

  const mode = getQualityMode()
  if (mode !== 'auto') return { tier: mode, source: 'override', benchmarkMs: null }

  const cached = readCachedResult()
  if (cached) {
    return { tier: cached.tier, source: 'cached-auto', benchmarkMs: cached.benchmarkMs }
  }

  const benchmarkMs = await runQualityBenchmark(renderer)
  const drawingSize = renderer.getDrawingBufferSize(new Vector2())
  const drawingPixels = Math.max(1, drawingSize.x * drawingSize.y)
  const resolutionPenalty = Math.sqrt(drawingPixels / (2560 * 1440))
  const normalizedMs = benchmarkMs * Math.max(0.75, resolutionPenalty)
  const tier = normalizedMs <= 5.4 ? 2 : normalizedMs <= 11.5 ? 1 : 0
  const result = { tier, benchmarkMs }
  try {
    localStorage.setItem(RESULT_KEY, JSON.stringify(result))
  } catch {
    // Storage can be unavailable in private contexts; the measured tier still applies.
  }
  return { ...result, source: 'benchmark' }
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
    return { tier: clampTier(value.tier!), benchmarkMs: Math.max(0, value.benchmarkMs!) }
  } catch {
    return null
  }
}

function clampTier(tier: number): number {
  return Math.max(0, Math.min(TIERS.length - 1, Math.round(tier)))
}
