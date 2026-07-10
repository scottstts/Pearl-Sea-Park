import type { NodeFrame, ReflectorNode } from 'three/webgpu'
import { MAIN_DETAIL_LAYER } from './layers'

export interface CadencedReflectorSnapshot {
  frameStride: number
  renders: number
  reusedFrames: number
  lastRenderFrame: number
}

/**
 * Reuse a planar reflection between application frames. The reflected image
 * remains animated by the receiving water material's per-frame ripple lookup,
 * while the expensive secondary scene render runs at a bounded cadence.
 */
export function cadenceReflector(
  node: ReflectorNode,
  frameStride = 2,
): () => CadencedReflectorSnapshot {
  const base = node.reflector
  const stride = Math.max(1, Math.round(frameStride))
  const render = base.updateBefore.bind(base)
  let lastRenderFrame = -stride
  let renders = 0
  let reusedFrames = 0

  base.updateBefore = (frame: NodeFrame): boolean | undefined => {
    const camera = frame.camera
    if (camera) base.getVirtualCamera(camera).layers.disable(MAIN_DETAIL_LAYER)

    const due = !base.hasOutput
      || base.forceUpdate
      || frame.frameId - lastRenderFrame >= stride
    if (!due) {
      reusedFrames++
      return undefined
    }

    render(frame)
    lastRenderFrame = frame.frameId
    renders++
    return undefined
  }

  return () => ({ frameStride: stride, renders, reusedFrames, lastRenderFrame })
}
