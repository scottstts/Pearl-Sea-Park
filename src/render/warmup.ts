import { Vector2 } from 'three'
import type { Mesh, Object3D } from 'three'
import type { LoadTimingSink } from '../core/loadTiming'
import type { GameContext } from '../runtime/context'
import type { SystemRegistry } from '../runtime/registry'
import type { RenderPipelineSystem } from './pipeline'

const COMPILE_BATCH_SIZE = 32
const WARM_WIDTH = 64
const WARM_HEIGHT = 36
const SUBMITTED_WARM_FRAMES = 2
/**
 * Preserve the pre-optimization logical entry frame. Runtime cadence gates
 * must not change merely because fewer physical loading frames are submitted.
 */
const LOGICAL_WARM_FRAMES = 6

export interface WarmupHooks {
  /** Force-dirty every cached shadow level once the node graph exists. */
  invalidateShadows?: () => void
  recordTiming?: LoadTimingSink
}

export interface ShaderWarmupSummary {
  signatures: number
}

interface SceneWarmupState {
  culled: Object3D[]
  hidden: Object3D[]
  representatives: Mesh[]
}

/**
 * Build the scene's material pipelines asynchronously before any one-shot
 * capture renders the park. The undersea field uses the exact scene-pass MRT,
 * so these pipelines are shared by the capture and by gameplay.
 */
export async function precompileRendererShaders(
  ctx: GameContext,
  pipeline: RenderPipelineSystem,
  onProgress: (fraction: number) => void,
): Promise<ShaderWarmupSummary> {
  const { camera, renderer, scene } = ctx
  const state = prepareScene(scene)
  const meshes = state.representatives
  const scenePass = pipeline.scenePass
  const previousTarget = renderer.getRenderTarget()
  const previousMrt = renderer.getMRT()

  if (scenePass) {
    renderer.setRenderTarget(scenePass.renderTarget)
    renderer.setMRT(scenePass.getMRT())
  }

  try {
    for (let start = 0; start < meshes.length; start += COMPILE_BATCH_SIZE) {
      const end = Math.min(start + COMPILE_BATCH_SIZE, meshes.length)
      const jobs: Promise<void>[] = []
      for (let index = start; index < end; index++) {
        jobs.push(renderer.compileAsync(meshes[index], camera, scene))
      }
      await Promise.all(jobs)
      onProgress(end / Math.max(1, meshes.length))
      await nextFrame()
    }
  } finally {
    renderer.setRenderTarget(previousTarget)
    renderer.setMRT(previousMrt)
    restoreScene(state)
  }

  return { signatures: meshes.length }
}

/**
 * Submit every runtime pipeline behind the ticket without paying for six
 * full-resolution, fully-unculled frames.
 *
 * Scene materials have already been compiled by
 * `precompileRendererShaders()`. This pass:
 *  1. compiles the actual final RenderPipeline quad asynchronously;
 *  2. submits two tiny all-scene frames (initial graph, then forced shadows);
 *  3. restores the authored scene state and submits one normally culled
 *     full-size frame so entry owns final-sized render targets.
 *
 * No rendering feature or runtime resolution changes. The 64x36 size exists
 * only while the loading ticket is opaque, and pipeline cache keys are
 * independent of target dimensions.
 */
export async function warmupRenderer(
  ctx: GameContext,
  registry: SystemRegistry,
  pipeline: RenderPipelineSystem,
  onProgress: (fraction: number) => void,
  hooks: WarmupHooks = {},
): Promise<void> {
  const { renderer, scene } = ctx
  const state = prepareScene(scene)
  const nodeFrame = (
    renderer as unknown as { _nodes?: { nodeFrame?: { update(): void } } }
  )._nodes?.nodeFrame
  const size = renderer.getSize(new Vector2())
  const wasPaused = ctx.time.paused
  const firstLogicalFrame = ctx.time.frame

  renderer.setSize(WARM_WIDTH, WARM_HEIGHT, false)
  ctx.time.paused = false

  try {
    // Update once before compiling the final graph so compute-owned textures,
    // auxiliary render targets, and reflection bindings are all live.
    nodeFrame?.update()
    registry.update(ctx, 0, 0)
    registry.lateUpdate(ctx, 0, 0)

    const pipelineCompileStart = performance.now()
    await pipeline.compileAsync()
    hooks.recordTiming?.(
      'warmup-final-pipeline',
      performance.now() - pipelineCompileStart,
    )
    onProgress(0.45)

    for (let frame = 0; frame < SUBMITTED_WARM_FRAMES; frame++) {
      const frameStart = performance.now()
      const submitStart = performance.now()
      pipeline.render()
      const submitMs = performance.now() - submitStart
      ctx.time.frame++

      if (frame === 0) {
        // The first submission established the shadow node graph. Force all
        // levels once more so the static bundle pipelines are used before play.
        hooks.invalidateShadows?.()
      }

      await nextFrame()
      hooks.recordTiming?.(
        `warmup-frame:${frame + 1}`,
        performance.now() - frameStart,
        {
          height: WARM_HEIGHT,
          submitMs,
          width: WARM_WIDTH,
        },
      )
      onProgress(0.45 + (0.4 * (frame + 1)) / SUBMITTED_WARM_FRAMES)

      if (frame + 1 < SUBMITTED_WARM_FRAMES) {
        nodeFrame?.update()
        registry.update(ctx, 0, 0)
        registry.lateUpdate(ctx, 0, 0)
      }
    }
  } finally {
    ctx.time.paused = wasPaused
    renderer.setSize(size.x, size.y, false)
    restoreScene(state)
  }

  // One authored-state frame creates the final-sized MRT, AO, bloom,
  // reflection and output targets. It remains ticket-covered, but unlike the
  // tiny frames it submits only what the arrival camera can actually see.
  const fullFrameStart = performance.now()
  const fullSubmitStart = performance.now()
  nodeFrame?.update()
  registry.update(ctx, 0, 0)
  registry.lateUpdate(ctx, 0, 0)
  pipeline.render()
  const fullSubmitMs = performance.now() - fullSubmitStart
  ctx.time.frame++
  await nextFrame()
  hooks.recordTiming?.(
    'warmup-frame:final-size',
    performance.now() - fullFrameStart,
    {
      height: size.y,
      submitMs: fullSubmitMs,
      width: size.x,
    },
  )
  onProgress(1)

  // Keep every existing frame-based cadence at the same entry phase even
  // though only three loading frames were physically submitted.
  ctx.time.frame = firstLogicalFrame + LOGICAL_WARM_FRAMES
}

function prepareScene(scene: GameContext['scene']): SceneWarmupState {
  const representatives = new Map<string, Mesh>()
  const culled: Object3D[] = []
  const hidden: Object3D[] = []

  scene.traverse((object) => {
    const mesh = object as Mesh
    if (mesh.isMesh) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const materialKey = materials.map((material) => material.uuid).join(',')
      const layoutKey = [
        (mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh ? 'I' : 'M',
        mesh.geometry.index ? 'X' : '-',
        Object.keys(mesh.geometry.attributes).sort().join('.'),
      ].join('|')
      const key = `${materialKey}#${layoutKey}`
      if (!representatives.has(key)) representatives.set(key, mesh)
    }
    if (object.frustumCulled) {
      culled.push(object)
      object.frustumCulled = false
    }
    if (!object.visible) {
      hidden.push(object)
      object.visible = true
    }
  })

  return {
    culled,
    hidden,
    representatives: [...representatives.values()],
  }
}

function restoreScene(state: SceneWarmupState): void {
  for (const object of state.culled) object.frustumCulled = true
  for (const object of state.hidden) object.visible = false
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    // rAF keeps the ticket responsive. The timeout prevents a hidden tab from
    // deadlocking when the browser suppresses animation frames.
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    requestAnimationFrame(done)
    window.setTimeout(done, 40)
  })
}
