import { NoToneMapping } from 'three'
import { WebGPURenderer } from 'three/webgpu'

/** True only when a real WebGPU adapter is obtainable — we never run WebGL. */
export async function webgpuAvailable(): Promise<boolean> {
  if (!('gpu' in navigator) || !navigator.gpu) return false
  try {
    return (await navigator.gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}

export async function createRenderer(
  canvas: HTMLCanvasElement,
  trackTimestamp = false,
): Promise<WebGPURenderer> {
  const renderer = new WebGPURenderer({
    canvas,
    // The scene MRT owns 4x MSAA. Multisampling the final fullscreen canvas
    // pass would add a second resolve without improving geometry edges.
    antialias: false,
    powerPreference: 'high-performance',
    // Resolving WebGPU timestamps submits a query resolve/copy and maps a
    // readback buffer. Keep that diagnostic path for explicit debug sessions;
    // continuously serializing it during normal play can turn a transient GPU
    // backlog into a visible presentation hitch.
    trackTimestamp,
  })
  await renderer.init()

  // WebGPURenderer silently falls back to WebGL2 when WebGPU is missing.
  // This project is WebGPU-only: refuse the fallback outright.
  const backend = renderer.backend as { isWebGPUBackend?: boolean }
  if (backend.isWebGPUBackend !== true) {
    renderer.dispose()
    throw new Error('webgpu-backend-unavailable')
  }

  renderer.setPixelRatio(recommendedPixelRatio())
  renderer.setSize(window.innerWidth, window.innerHeight)
  // Never tone-map at the renderer — the pipeline's explicit renderOutput()
  // is the single output transform (side targets must stay linear).
  renderer.toneMapping = NoToneMapping
  renderer.shadowMap.enabled = true
  return renderer
}

/** Cap both DPR and total drawing-buffer pixels before dynamic render scale. */
export function recommendedPixelRatio(
  width = window.innerWidth,
  height = window.innerHeight,
): number {
  const maxPixels = 4_000_000
  const dpr = Math.min(
    window.devicePixelRatio,
    1.7,
    Math.sqrt(maxPixels / Math.max(1, width * height)),
  )
  return Math.max(1, dpr)
}
