import { Vector2 } from 'three'
import type { Mesh, Object3D } from 'three'
import type { GameContext } from '../runtime/context'
import type { SystemRegistry } from '../runtime/registry'
import type { RenderPipelineSystem } from './pipeline'

/**
 * Loading-time renderer warmup. Runs after every system has initialized and
 * the static shadow casters are sealed, while the ticket screen still owns
 * the display — the Enter button must not appear until this completes.
 *
 * Why this exists (measured, not guessed):
 *  - Building a NodeMaterial's WGSL is main-thread JS. Letting the first
 *    frame do it for the whole park is a single ~3 s block, and every
 *    material that only enters the frustum later (or is revealed later,
 *    like show pools) blocks mid-roam instead.
 *  - `device.createRenderPipeline` returns immediately, but the browser's
 *    WebGPU backend compiles the native shader lazily: the first queue
 *    submission that USES a pipeline stalls the GPU process until that
 *    compile finishes. To the player that is a roaming freeze — CPU spike,
 *    GPU idle, rAF back-pressured — once per pipeline, wherever they happen
 *    to be walking when something new enters the frustum.
 *
 * So the warmup does three things, chunked across animation frames so the
 * loading UI stays alive and no single task approaches the old 3 s block:
 *  1. `compileAsync` every mesh in small batches against the exact render
 *     context of the live scene pass (same MRT, same MSAA target) — WGSL
 *     builds happen here, and pipelines are created with the async variant
 *     so the driver compiles off-thread while loading continues.
 *  2. Run a few real pipeline frames with frustum culling disabled and
 *     hidden subtrees revealed, advancing `ctx.time.frame` so cadence-gated
 *     passes fire: every render/compute/shadow pipeline is USED at least
 *     once, forcing any remaining driver compilation to finish now, behind
 *     the ticket, instead of mid-roam.
 *  3. Restore every visibility/culling flag it touched.
 *
 * Updates run with dt = 0 (the `?fixedTime` validation path already proves
 * every system supports zero-dt updates); the park clock still starts at
 * the gate click, and no gameplay event can fire at sim time 0.
 */
export interface WarmupHooks {
  /** Force-dirty every cached shadow level once the node graph exists. */
  invalidateShadows?: () => void
}

export async function warmupRenderer(
  ctx: GameContext,
  registry: SystemRegistry,
  pipeline: RenderPipelineSystem,
  onProgress: (fraction: number) => void,
  hooks: WarmupHooks = {},
): Promise<void> {
  const { scene, camera, renderer } = ctx

  // ── Collect one representative mesh per material × geometry layout ──────
  // Builds and pipelines are cached per material and vertex-layout state, so
  // one mesh per signature covers every unique compile. (Compiling all ~1000
  // meshes would also work, but compileAsync advances the node frame per
  // call, re-running FRAME-scoped shadow updates ~1000 times.)
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
  const meshes = [...representatives.values()]

  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => {
      // rAF keeps the ticket progress bar painting; the timeout keeps the
      // warmup moving when the tab loads hidden and rAF never fires.
      let settled = false
      const done = (): void => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      requestAnimationFrame(done)
      window.setTimeout(done, 40)
    })

  try {
    // ── 1. Chunked WGSL builds + async driver compilation ────────────────
    // Compilation must target the scene pass's render context: pipelines
    // are cached by target formats and sample counts, so compiling against
    // the canvas would warm the wrong cache and the live pass would still
    // recompile everything on first sight.
    const scenePass = pipeline.scenePass
    const previousTarget = renderer.getRenderTarget()
    const previousMrt = renderer.getMRT()
    if (scenePass) {
      renderer.setRenderTarget(scenePass.renderTarget)
      renderer.setMRT(scenePass.getMRT())
    }
    try {
      const BATCH = 32
      for (let start = 0; start < meshes.length; start += BATCH) {
        const jobs: Promise<void>[] = []
        for (let index = start; index < Math.min(start + BATCH, meshes.length); index++) {
          jobs.push(renderer.compileAsync(meshes[index], camera, scene))
        }
        await Promise.all(jobs)
        onProgress((0.85 * Math.min(meshes.length, start + BATCH)) / Math.max(1, meshes.length))
        await nextFrame()
      }
    } finally {
      renderer.setRenderTarget(previousTarget)
      renderer.setMRT(previousMrt)
    }

    // ── 2. Real frames: compute pipelines + shadow maps + first-use warm ─
    // Six frames with an advancing frame counter cover the small modulo
    // cadences auxiliary passes key off `ctx.time.frame`.
    //
    // FRAME-scoped node updates (shadow clipmaps, GTAO, the scene pass) key
    // off the renderer's node-frame counter, which only the internal
    // animation loop advances — and that loop is not running yet. Without
    // ticking it here, warm frames 2+ would reuse frame 1's shadow/AO work
    // and the forced level re-render below could never fire.
    const nodeFrame = (
      renderer as unknown as { _nodes?: { nodeFrame?: { update(): void } } }
    )._nodes?.nodeFrame
    // A hidden tab has a collapsed drawing buffer and every pass silently
    // skips at zero size — the warm frames would compile nothing and the
    // first visible frame would inherit the whole stall. Warm through a
    // tiny buffer instead; pipelines are size-independent. A visible tab
    // keeps its real size so no render-target reallocation lands on entry.
    const size = renderer.getSize(new Vector2())
    const collapsed = size.x < 2 || size.y < 2
    if (collapsed) renderer.setSize(64, 36, false)
    // The exposure meter is the one system that gates its compute on the
    // park clock; lift the gate so its reduction kernels compile now.
    const wasPaused = ctx.time.paused
    ctx.time.paused = false
    try {
      const WARM_FRAMES = 6
      for (let frame = 0; frame < WARM_FRAMES; frame++) {
        nodeFrame?.update()
        registry.update(ctx, 0, 0)
        registry.lateUpdate(ctx, 0, 0)
        pipeline.render()
        ctx.time.frame++
        if (frame === 0) {
          // The first render built the shadow node graph but rendered the
          // levels through the pre-graph fallback path. Re-render them all
          // from the static bundle so those pipelines exist before play.
          hooks.invalidateShadows?.()
        }
        onProgress(0.85 + (0.15 * (frame + 1)) / WARM_FRAMES)
        await nextFrame()
      }
    } finally {
      ctx.time.paused = wasPaused
      if (collapsed) renderer.setSize(size.x, size.y, false)
    }
  } finally {
    for (const object of culled) object.frustumCulled = true
    for (const object of hidden) object.visible = false
  }
}
