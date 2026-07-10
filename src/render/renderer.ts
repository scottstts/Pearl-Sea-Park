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

export async function createRenderer(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
  const renderer = new WebGPURenderer({ canvas, antialias: true })
  await renderer.init()

  // WebGPURenderer silently falls back to WebGL2 when WebGPU is missing.
  // This project is WebGPU-only: refuse the fallback outright.
  const backend = renderer.backend as { isWebGPUBackend?: boolean }
  if (backend.isWebGPUBackend !== true) {
    renderer.dispose()
    throw new Error('webgpu-backend-unavailable')
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  // Never tone-map at the renderer — the pipeline's explicit renderOutput()
  // is the single output transform (side targets must stay linear).
  renderer.toneMapping = NoToneMapping
  renderer.shadowMap.enabled = true
  return renderer
}
