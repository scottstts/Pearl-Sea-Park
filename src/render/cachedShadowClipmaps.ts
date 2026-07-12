import {
  Light,
  Matrix4,
  Object3D,
  Sphere,
  Vector3,
  Vector4,
} from 'three'
import type { DirectionalLight, DirectionalLightShadow, Scene } from 'three'
import { NodeUpdateType, ShadowBaseNode, ShadowNode } from 'three/webgpu'
import type { Node, NodeBuilder, NodeFrame } from 'three/webgpu'
import {
  Fn,
  abs,
  float,
  max,
  min,
  reference,
  renderGroup,
  shadowPositionWorld,
  smoothstep,
  uniform,
  vec4,
} from 'three/tsl'
import { MAIN_DETAIL_LAYER } from './layers'

const ORIGIN = new Vector3()
const WORLD_UP = new Vector3(0, 1, 0)
const LIGHT_DIRECTION = new Vector3()
const LIGHT_ORIENTATION = new Matrix4()
const CAMERA_WORLD = new Vector3()
const CAMERA_LIGHT = new Vector3()
const LEVEL_CENTER = new Vector3()
const REGION_CENTER = new Vector3()

const DIRTY_DYNAMIC = 1 << 0
const DIRTY_INVALID = 1 << 1
const DIRTY_FORCED = 1 << 2
const DIRTY_MOVED = 1 << 3
const DIRTY_EXPIRED = 1 << 4
const DIRTY_DIRECTION = 1 << 5

/** How far ahead (in seconds of travel) recentering leads a moving camera. */
const LEAD_SECONDS = 1

/** Extra down-sun slab depth so ground far below a high camera stays inside. */
const DEPTH_REACH = 70

interface ClipmapLight extends Object3D {
  target: Object3D
  castShadow: true
  shadow: DirectionalLightShadow
}

interface LevelState {
  halfWidth: number
  centerX: number
  centerY: number
  centerZ: number
  desiredX: number
  desiredY: number
  desiredZ: number
  texelWidth: number
  normalBias: number
  valid: boolean
  forceDirty: boolean
  age: number
  dirtyReasons: number
  renderCount: number
}

interface ShadowFilterArguments {
  filterFn: (args: {
    depthTexture: Node
    shadowCoord: Node<'vec4'>
    shadow: DirectionalLightShadow
    depthLayer: Node | null
  }) => Node<'float'>
  depthTexture: Node
  shadowCoord: Node<'vec4'>
  shadow: DirectionalLightShadow
  depthLayer: Node | null
}

interface InternalShadowNode extends ShadowNode {
  shadowMap?: unknown
  updateShadow(frame: NodeFrame): void
}

export interface ShadowClipmapOptions {
  camera: Object3D
  levelMapSizes: readonly number[]
  firstRadius?: number
  scaleFactor?: number
  maxDistance?: number
  lightMargin?: number
  shadowCameraNear?: number
  shadowCameraFar?: number
  guardBand?: number
  blendRatio?: number
  dynamicLevels?: number
  updateBudget?: number
  maxCacheAge?: number
  directionEpsilon?: number
  /** Maximum age of a dynamic near map before moving casters refresh it. */
  dynamicRefreshFrames?: number
  /** Object layer isolated into a cheap continuously refreshed shadow map. */
  dynamicCasterLayer?: number
  dynamicCasterHalfWidth?: number
  dynamicCasterMapSize?: number
}

export interface ShadowClipmapSnapshot {
  textureCount: number
  staticCasterBundle: null | { casterCount: number }
  dynamicLevels: number
  dynamicRefreshFrames: number
  updateBudget: number
  budgetBefore: number
  budgetAfter: number
  directionDelta: number
  staticRefreshes: number
  lastStaticRefreshCpuMs: number
  maxStaticRefreshCpuMs: number
  dynamicCaster: null | {
    layer: number
    halfWidth: number
    mapSize: number
    texelWidth: number
    committed: [number, number, number]
    renderCount: number
  }
  levels: Array<{
    index: number
    renderedHalfWidth: number
    sampledHalfWidth: number
    mapSize: number
    texelWidth: number
    desired: [number, number, number]
    committed: [number, number, number]
    dynamic: boolean
    valid: boolean
    forceDirty: boolean
    age: number
    dirtyReasons: number
    normalBias: number
    renderCount: number
  }>
}

/** Always sample the comparison texture; select lit outside its XYZ projection. */
class BoundedShadowNode extends ShadowNode {
  constructor(light: ClipmapLight, shadow: DirectionalLightShadow) {
    super(light as unknown as Light, shadow)
  }

  setupShadowFilter(_builder: NodeBuilder, args: ShadowFilterArguments): Node<'float'> {
    const { filterFn, depthTexture, shadowCoord, shadow, depthLayer } = args
    const inProjection = shadowCoord.x
      .greaterThanEqual(0)
      .and(shadowCoord.x.lessThanEqual(1))
      .and(shadowCoord.y.greaterThanEqual(0))
      .and(shadowCoord.y.lessThanEqual(1))
      .and(shadowCoord.z.greaterThanEqual(0))
      .and(shadowCoord.z.lessThanEqual(1))
    const shadowValue = filterFn({ depthTexture, shadowCoord, shadow, depthLayer })
    return inProjection.select(shadowValue, float(1))
  }
}

/**
 * Fixed-sun directional shadow clipmaps. Selection uses committed map state,
 * so a cached level can wait for its budget slot without its sample box
 * drifting away from the texture it actually contains.
 */
export class CachedShadowClipmapNode extends ShadowBaseNode {
  override readonly light: DirectionalLight
  readonly camera: Object3D
  readonly levels: number
  readonly maxDistance: number
  readonly lightMargin: number
  readonly shadowCameraNear: number
  readonly shadowCameraFar: number
  readonly guardBand: number
  readonly blendRatio: number
  readonly dynamicLevels: number
  readonly updateBudget: number
  readonly maxCacheAge: number
  readonly dynamicRefreshFrames: number
  readonly dynamicCasterLayer: number | null
  readonly dynamicCasterHalfWidth: number
  readonly dynamicCasterMapSize: number

  private readonly levelMapSizes: readonly number[]
  private readonly halfWidths: number[] = []
  private readonly levelStates: LevelState[] = []
  private readonly levelData: Vector4[] = []
  private readonly shadowNodes: BoundedShadowNode[] = []
  private readonly lights: ClipmapLight[] = []
  private readonly worldToLight = new Matrix4()
  private readonly lastDirection = new Vector3()
  private readonly lastCameraLight = new Vector3(Number.NaN, Number.NaN, Number.NaN)
  private readonly velocityLight = new Vector3()
  private readonly dynamicCenter = new Vector3(Number.NaN, Number.NaN, Number.NaN)
  private readonly directionCos: number
  private dynamicLight: ClipmapLight | null = null
  private dynamicShadowNode: BoundedShadowNode | null = null
  private dynamicRenderCount = 0
  private dynamicTexelWidth = 0
  private baseBias = 0
  private baseNormalBias = 0
  private firstUpdate = true
  private initialized = false
  private budgetBefore = 0
  private budgetAfter = 0
  private directionDelta = 0
  private staticCasterScene: Scene | null = null
  private staticCasterCount = 0
  private staticRefreshes = 0
  private lastStaticRefreshCpuMs = 0
  private maxStaticRefreshCpuMs = 0

  constructor(light: DirectionalLight, options: ShadowClipmapOptions) {
    super(light)
    this.light = light
    this.camera = options.camera
    this.levelMapSizes = options.levelMapSizes
    this.levels = Math.max(1, this.levelMapSizes.length)
    const firstRadius = Math.max(1, options.firstRadius ?? 28)
    const scaleFactor = Math.max(1.5, options.scaleFactor ?? 3)
    this.maxDistance = Math.max(firstRadius, options.maxDistance ?? 650)
    for (let index = 0; index < this.levels; index++) {
      const width = Math.min(firstRadius * scaleFactor ** index, this.maxDistance)
      this.halfWidths.push(index === this.levels - 1 ? this.maxDistance : width)
    }
    this.lightMargin = options.lightMargin ?? 120
    this.shadowCameraNear = options.shadowCameraNear ?? 1
    this.shadowCameraFar = options.shadowCameraFar ?? 1_600
    this.guardBand = clamp(options.guardBand ?? 0.12, 0.02, 0.5)
    this.blendRatio = clamp(options.blendRatio ?? 0.16, 0.01, 0.9)
    this.dynamicLevels = Math.round(clamp(options.dynamicLevels ?? 1, 0, this.levels))
    this.updateBudget = Math.max(1, Math.round(options.updateBudget ?? 1))
    this.maxCacheAge = Math.max(0, Math.round(options.maxCacheAge ?? 180))
    this.dynamicRefreshFrames = Math.max(1, Math.round(options.dynamicRefreshFrames ?? 2))
    this.dynamicCasterLayer = options.dynamicCasterLayer ?? null
    this.dynamicCasterHalfWidth = Math.max(
      firstRadius,
      options.dynamicCasterHalfWidth ?? firstRadius * 4,
    )
    this.dynamicCasterMapSize = Math.max(
      128,
      Math.round(options.dynamicCasterMapSize ?? this.levelMapSizes[0]),
    )
    this.directionCos = Math.cos(options.directionEpsilon ?? 0.002)
    // These world-space clipmaps are camera-independent once rendered, so
    // every render pass in one app frame must reuse the committed maps.
    this.updateBeforeType = NodeUpdateType.FRAME
  }

  attach(): this {
    ;(this.light.shadow as DirectionalLightShadow & { shadowNode?: Node }).shadowNode = this
    return this
  }

  /** Use a sealed, render-bundled proxy scene for immutable clipmap levels. */
  setStaticCasterScene(scene: Scene, casterCount: number): void {
    this.staticCasterScene = scene
    this.staticCasterCount = casterCount
  }

  /** Zero-allocation live counters for per-frame hitch attribution. */
  get liveStaticRefreshCount(): number {
    return this.staticRefreshes
  }

  get liveDynamicRenderCount(): number {
    return this.dynamicRenderCount
  }

  staticPerformanceSnapshot(): {
    casterCount: number
    refreshes: number
    lastCpuMs: number
    maxCpuMs: number
  } {
    return {
      casterCount: this.staticCasterCount,
      refreshes: this.staticRefreshes,
      lastCpuMs: this.lastStaticRefreshCpuMs,
      maxCpuMs: this.maxStaticRefreshCpuMs,
    }
  }

  resetStaticPerformance(): void {
    this.staticRefreshes = 0
    this.lastStaticRefreshCpuMs = 0
    this.maxStaticRefreshCpuMs = 0
  }

  detach(): this {
    const shadow = this.light.shadow as DirectionalLightShadow & { shadowNode?: Node }
    if (shadow.shadowNode === this) delete shadow.shadowNode
    return this
  }

  override setup(builder: NodeBuilder): Node {
    if (!this.initialized) this.initLevels()
    const levelData = reference('levelData', 'vec4', this)
    levelData.setName('shadowClipmapLevels')
    const levelDataArray = levelData as unknown as { element(index: number): Node<'vec4'> }
    const worldToLight = uniform(this.worldToLight)
      .setGroup(renderGroup)
      .setName('shadowClipmapWorldToLight')

    return Fn(() => {
      this.setupShadowPosition(builder)
      const lightPosition = worldToLight
        .mul(vec4(shadowPositionWorld as Node<'vec3'>, 1))
        .xy.toVar()
      const accumulated = vec4(0).toVar()
      const remaining = float(1).toVar()
      for (let index = 0; index < this.levels; index++) {
        const level = vec4().toVar(`shadowClipmapLevel${index}`)
        level.assign(levelDataArray.element(index))
        const distance = max(
          abs(lightPosition.x.sub(level.x)),
          abs(lightPosition.y.sub(level.y)),
        )
        const fade = float(1).sub(
          smoothstep(level.z.mul(1 - this.blendRatio), level.z, distance),
        )
        const weight = fade.mul(remaining)
        const shadowSample = this.shadowNodes[index] as unknown as Node<'float'>
        accumulated.addAssign(shadowSample.mul(weight))
        remaining.mulAssign(float(1).sub(fade))
      }
      const staticShadow = accumulated.add(vec4(remaining))
      if (this.dynamicShadowNode) {
        // One sun, two caster sets: the union is the darker visibility, not
        // multiplication (which would double-darken overlapping penumbrae).
        return min(staticShadow, this.dynamicShadowNode as unknown as Node<'float'>)
      }
      return staticShadow
    })()
  }

  override updateBefore(frame: NodeFrame): boolean | undefined {
    if (!this.light.parent) return undefined
    if (!this.initialized) this.initLevels()
    // NodeFrame is a singleton whose `scene` is reassigned by every nested
    // render. A static level refresh below renders the bundle proxy scene,
    // which leaves `frame.scene` pointing at it — and the dynamic caster
    // pass afterwards would then render that proxy scene (no layer-2
    // objects) instead of the live world: an empty moving-caster map for
    // exactly the recenter frame. That was the "moving shadows blink while
    // walking" defect. Pin the live scene before any level renders.
    const liveScene = frame.scene
    for (const levelLight of this.lights) {
      if (levelLight.parent) continue
      this.light.parent.add(levelLight.target)
      this.light.parent.add(levelLight)
    }
    if (this.dynamicLight && !this.dynamicLight.parent) {
      this.light.parent.add(this.dynamicLight.target)
      this.light.parent.add(this.dynamicLight)
    }

    LIGHT_DIRECTION.subVectors(this.light.target.position, this.light.position).normalize()
    LIGHT_ORIENTATION.lookAt(ORIGIN, LIGHT_DIRECTION, WORLD_UP)
    this.worldToLight.copy(LIGHT_ORIENTATION).invert()
    this.directionDelta = this.lastDirection.lengthSq() === 0
      ? Math.PI
      : Math.acos(clamp(LIGHT_DIRECTION.dot(this.lastDirection), -1, 1))
    const directionChanged = LIGHT_DIRECTION.dot(this.lastDirection) < this.directionCos
    if (directionChanged) this.lastDirection.copy(LIGHT_DIRECTION)
    CAMERA_WORLD.setFromMatrixPosition(this.camera.matrixWorld)
    CAMERA_LIGHT.copy(CAMERA_WORLD).applyMatrix4(this.worldToLight)

    // Camera velocity in light space (smoothed). Recentering leads a moving
    // camera by up to LEAD_SECONDS so the terrain a rider is approaching is
    // shadowed BEFORE they arrive — purely reactive recentering always put
    // the freshest gap exactly where a fast camera was looking.
    const deltaTime = Math.min(0.1, Math.max(1e-3, frame.deltaTime || 1 / 60))
    if (Number.isNaN(this.lastCameraLight.x) || directionChanged) {
      this.velocityLight.set(0, 0, 0)
    } else {
      const blend = Math.min(1, deltaTime * 5)
      this.velocityLight.x +=
        ((CAMERA_LIGHT.x - this.lastCameraLight.x) / deltaTime - this.velocityLight.x) * blend
      this.velocityLight.y +=
        ((CAMERA_LIGHT.y - this.lastCameraLight.y) / deltaTime - this.velocityLight.y) * blend
    }
    this.lastCameraLight.copy(CAMERA_LIGHT)
    const lightSpeed = Math.hypot(this.velocityLight.x, this.velocityLight.y)

    let budget = this.firstUpdate || directionChanged ? this.levels : this.updateBudget
    this.budgetBefore = budget
    this.firstUpdate = false
    let finestTexel = 0

    // ── Pass 1: state, lead-biased desired centers, dirty reasons ────────
    for (let index = 0; index < this.levels; index++) {
      const state = this.levelStates[index]
      const shadow = this.lights[index].shadow
      const camera = shadow.camera
      const texelWidth = (camera.right - camera.left) / shadow.mapSize.width
      if (index === 0) finestTexel = texelWidth
      const texelScale = finestTexel > 0 ? texelWidth / finestTexel : 1
      shadow.bias = this.baseBias
      shadow.normalBias = this.baseNormalBias * texelScale
      state.texelWidth = texelWidth
      state.normalBias = shadow.normalBias
      state.age++

      // Lead clamped to 0.3·halfWidth: the camera stays well inside the
      // sampled box (0.88·halfWidth) even fully ahead-biased.
      const lead =
        lightSpeed > 1e-3
          ? Math.min(LEAD_SECONDS, (state.halfWidth * 0.3) / lightSpeed)
          : 0
      const targetX = CAMERA_LIGHT.x + this.velocityLight.x * lead
      const targetY = CAMERA_LIGHT.y + this.velocityLight.y * lead
      state.desiredX = Math.round(targetX / texelWidth) * texelWidth
      state.desiredY = Math.round(targetY / texelWidth) * texelWidth
      const zQuantum = state.halfWidth * 0.5
      state.desiredZ = Math.round(CAMERA_LIGHT.z / zQuantum) * zQuantum
      const dynamic = index < this.dynamicLevels
      // Cached levels own a guard band precisely so their committed map can
      // remain valid while the camera moves. Refreshing on every one-texel
      // shift defeated that cache and caused broad full-world shadow spikes.
      // The near dynamic level still follows its texel grid immediately.
      const recenterDistance = state.halfWidth * this.guardBand * 0.5
      const moved = dynamic
        ? state.desiredX !== state.centerX
          || state.desiredY !== state.centerY
          || state.desiredZ !== state.centerZ
        : !state.valid
          || Math.abs(state.desiredX - state.centerX) >= recenterDistance
          || Math.abs(state.desiredY - state.centerY) >= recenterDistance
          || state.desiredZ !== state.centerZ
      const expired = this.maxCacheAge > 0 && state.age >= this.maxCacheAge
      let dirtyReasons = 0
      if (dynamic && state.age >= this.dynamicRefreshFrames) dirtyReasons |= DIRTY_DYNAMIC
      if (!state.valid) dirtyReasons |= DIRTY_INVALID
      if (state.forceDirty) dirtyReasons |= DIRTY_FORCED
      if (moved) dirtyReasons |= DIRTY_MOVED
      if (expired) dirtyReasons |= DIRTY_EXPIRED
      if (directionChanged) dirtyReasons |= DIRTY_DIRECTION
      state.dirtyReasons = dirtyReasons
    }

    // ── Pass 2: render forced/dynamic levels always, then hand the budget
    // to the MOST-LAGGED dirty levels first. The old lowest-index-first
    // order let a fast camera keep the fine levels dirty every frame and
    // starve the mid levels — their eventual catch-up was the "shadow
    // appears one section at a time" pop during rides.
    const pending: { index: number; urgency: number }[] = []
    for (let index = 0; index < this.levels; index++) {
      const state = this.levelStates[index]
      if (state.dirtyReasons === 0) continue
      const dynamic = index < this.dynamicLevels
      if (dynamic || state.forceDirty) {
        this.renderLevel(index, frame)
        continue
      }
      const recenterDistance = Math.max(1e-6, state.halfWidth * this.guardBand * 0.5)
      const urgency = state.valid
        ? Math.max(
            Math.abs(state.desiredX - state.centerX),
            Math.abs(state.desiredY - state.centerY),
          ) / recenterDistance
          + (state.desiredZ !== state.centerZ ? 10 : 0)
        : Infinity
      pending.push({ index, urgency })
    }
    pending.sort((a, b) => b.urgency - a.urgency)
    for (const entry of pending) {
      if (budget <= 0) break
      budget--
      this.renderLevel(entry.index, frame)
    }

    for (let index = 0; index < this.levels; index++) {
      const state = this.levelStates[index]
      if (state.valid) {
        this.levelData[index].set(
          state.centerX,
          state.centerY,
          state.halfWidth * (1 - this.guardBand),
          0,
        )
      }
    }
    const dynamicFrame = Object.assign(Object.create(frame), { scene: liveScene }) as NodeFrame
    this.updateDynamicCasterShadow(dynamicFrame)
    this.budgetAfter = budget
    return undefined
  }

  /** Commit a level's desired center and render its shadow map. */
  private renderLevel(index: number, frame: NodeFrame): void {
    const state = this.levelStates[index]
    const levelLight = this.lights[index]
    const shadow = levelLight.shadow
    state.centerX = state.desiredX
    state.centerY = state.desiredY
    state.centerZ = state.desiredZ
    state.valid = true
    state.forceDirty = false
    state.age = 0
    state.renderCount++

    LEVEL_CENTER.set(
      state.centerX,
      state.centerY,
      state.centerZ + state.halfWidth + this.lightMargin,
    ).applyMatrix4(LIGHT_ORIENTATION)
    levelLight.position.copy(LEVEL_CENTER)
    levelLight.target.position.copy(LEVEL_CENTER).add(LIGHT_DIRECTION)
    levelLight.updateMatrixWorld(true)
    levelLight.target.updateMatrixWorld(true)
    shadow.needsUpdate = true
    const shadowNode = this.shadowNodes[index] as unknown as InternalShadowNode
    if (shadowNode.shadowMap) {
      const started = performance.now()
      if (this.staticCasterScene) {
        const staticFrame = Object.assign(Object.create(frame), {
          scene: this.staticCasterScene,
        }) as NodeFrame
        shadowNode.updateShadow(staticFrame)
      } else {
        shadowNode.updateShadow(frame)
      }
      this.lastStaticRefreshCpuMs = performance.now() - started
      this.maxStaticRefreshCpuMs = Math.max(
        this.maxStaticRefreshCpuMs,
        this.lastStaticRefreshCpuMs,
      )
      this.staticRefreshes++
      shadow.needsUpdate = false
    }
  }

  /** Force every level, or only levels overlapping a world-space sphere. */
  invalidate(worldBounds?: Sphere): void {
    if (!worldBounds) {
      for (const state of this.levelStates) state.forceDirty = true
      return
    }
    REGION_CENTER.copy(worldBounds.center).applyMatrix4(this.worldToLight)
    for (const state of this.levelStates) {
      const reach = state.halfWidth + worldBounds.radius
      if (
        Math.abs(REGION_CENTER.x - state.centerX) < reach
        && Math.abs(REGION_CENTER.y - state.centerY) < reach
      ) {
        state.forceDirty = true
      }
    }
  }

  debugSnapshot(): ShadowClipmapSnapshot {
    return {
      textureCount: this.levels + (this.dynamicShadowNode ? 1 : 0),
      staticCasterBundle: this.staticCasterScene
        ? { casterCount: this.staticCasterCount }
        : null,
      dynamicLevels: this.dynamicLevels,
      dynamicRefreshFrames: this.dynamicRefreshFrames,
      updateBudget: this.updateBudget,
      budgetBefore: this.budgetBefore,
      budgetAfter: this.budgetAfter,
      directionDelta: this.directionDelta,
      staticRefreshes: this.staticRefreshes,
      lastStaticRefreshCpuMs: this.lastStaticRefreshCpuMs,
      maxStaticRefreshCpuMs: this.maxStaticRefreshCpuMs,
      dynamicCaster: this.dynamicCasterLayer === null
        ? null
        : {
            layer: this.dynamicCasterLayer,
            halfWidth: this.dynamicCasterHalfWidth,
            mapSize: this.dynamicCasterMapSize,
            texelWidth: this.dynamicTexelWidth,
            committed: [this.dynamicCenter.x, this.dynamicCenter.y, this.dynamicCenter.z],
            renderCount: this.dynamicRenderCount,
          },
      levels: this.levelStates.map((state, index) => ({
        index,
        renderedHalfWidth: state.halfWidth,
        sampledHalfWidth: state.halfWidth * (1 - this.guardBand),
        mapSize: this.levelMapSizes[index],
        texelWidth: state.texelWidth,
        desired: [state.desiredX, state.desiredY, state.desiredZ],
        committed: [state.centerX, state.centerY, state.centerZ],
        dynamic: index < this.dynamicLevels,
        valid: state.valid,
        forceDirty: state.forceDirty,
        age: state.age,
        dirtyReasons: state.dirtyReasons,
        normalBias: state.normalBias,
        renderCount: state.renderCount,
      })),
    }
  }

  override dispose(): void {
    this.detach()
    for (const shadowNode of this.shadowNodes) shadowNode.dispose()
    for (const levelLight of this.lights) {
      levelLight.shadow.dispose()
      levelLight.parent?.remove(levelLight)
      levelLight.target.parent?.remove(levelLight.target)
    }
    this.dynamicShadowNode?.dispose()
    this.dynamicLight?.shadow.dispose()
    this.dynamicLight?.parent?.remove(this.dynamicLight)
    this.dynamicLight?.target.parent?.remove(this.dynamicLight.target)
    this.staticCasterScene?.clear()
    this.staticCasterScene = null
    this.staticCasterCount = 0
    super.dispose()
  }

  private initLevels(): void {
    if (this.initialized) return
    this.initialized = true
    this.baseBias = this.light.shadow.bias
    this.baseNormalBias = this.light.shadow.normalBias
    for (let index = 0; index < this.levels; index++) {
      const halfWidth = this.halfWidths[index]
      const target = new Object3D()
      const shadow = this.light.shadow.clone()
      shadow.mapSize.set(this.levelMapSizes[index], this.levelMapSizes[index])
      shadow.camera.left = -halfWidth
      shadow.camera.right = halfWidth
      shadow.camera.top = halfWidth
      shadow.camera.bottom = -halfWidth
      shadow.camera.near = this.shadowCameraNear
      // Down-sun reach = halfWidth + DEPTH_REACH past the level center. The
      // center tracks the CAMERA's light-space depth, so a rider 40–60 m
      // above the seabed (Torrent plunge/helix) pushed the ground below
      // OUTSIDE the old margin+2·halfWidth slab of the finest level — and
      // because level blending weighs XY only, that level CLAIMED the region
      // and returned lit: whole chunks of ground shadow popped in and out as
      // the z-center requantized. DEPTH_REACH covers the park's full
      // camera-over-ground range (~80 m · sin 42° + z-quantum lag).
      shadow.camera.far = Math.max(
        this.shadowCameraNear + 1,
        Math.min(this.shadowCameraFar, this.lightMargin + halfWidth * 2 + DEPTH_REACH),
      )
      shadow.camera.updateProjectionMatrix()
      // A non-default mask prevents Three from replacing this with the main
      // camera mask during the shadow render. Static maps retain ordinary and
      // main-detail casters while excluding the dedicated moving-caster layer.
      if (this.dynamicCasterLayer !== null) shadow.camera.layers.enable(MAIN_DETAIL_LAYER)
      shadow.autoUpdate = false
      shadow.needsUpdate = false
      const levelLight = Object.assign(new Object3D(), {
        target,
        castShadow: true as const,
        shadow,
      }) as ClipmapLight
      this.lights.push(levelLight)
      this.shadowNodes.push(new BoundedShadowNode(levelLight, shadow))
      this.levelData.push(new Vector4(1e9, 1e9, 1e-6, 0))
      this.levelStates.push({
        halfWidth,
        centerX: Number.NaN,
        centerY: Number.NaN,
        centerZ: Number.NaN,
        desiredX: Number.NaN,
        desiredY: Number.NaN,
        desiredZ: Number.NaN,
        texelWidth: 0,
        normalBias: 0,
        valid: false,
        forceDirty: false,
        age: Math.floor(-(index * this.maxCacheAge) / this.levels),
        dirtyReasons: DIRTY_INVALID,
        renderCount: 0,
      })
    }
    this.initDynamicCasterShadow()
  }

  private initDynamicCasterShadow(): void {
    if (this.dynamicCasterLayer === null || this.dynamicLight) return
    const target = new Object3D()
    const shadow = this.light.shadow.clone()
    const halfWidth = this.dynamicCasterHalfWidth
    shadow.mapSize.set(this.dynamicCasterMapSize, this.dynamicCasterMapSize)
    shadow.camera.left = -halfWidth
    shadow.camera.right = halfWidth
    shadow.camera.top = halfWidth
    shadow.camera.bottom = -halfWidth
    shadow.camera.near = this.shadowCameraNear
    shadow.camera.far = Math.max(
      this.shadowCameraNear + 1,
      Math.min(this.shadowCameraFar, this.lightMargin + halfWidth * 2),
    )
    shadow.camera.layers.set(this.dynamicCasterLayer)
    shadow.camera.updateProjectionMatrix()
    shadow.autoUpdate = false
    shadow.needsUpdate = false
    const light = Object.assign(new Object3D(), {
      target,
      castShadow: true as const,
      shadow,
    }) as ClipmapLight
    this.dynamicLight = light
    this.dynamicShadowNode = new BoundedShadowNode(light, shadow)
  }

  private updateDynamicCasterShadow(frame: NodeFrame): void {
    const levelLight = this.dynamicLight
    const shadowNode = this.dynamicShadowNode as InternalShadowNode | null
    if (!levelLight || !shadowNode) return
    const shadow = levelLight.shadow
    const halfWidth = this.dynamicCasterHalfWidth
    const texelWidth = (halfWidth * 2) / this.dynamicCasterMapSize
    this.dynamicTexelWidth = texelWidth
    this.dynamicCenter.set(
      Math.round(CAMERA_LIGHT.x / texelWidth) * texelWidth,
      Math.round(CAMERA_LIGHT.y / texelWidth) * texelWidth,
      Math.round(CAMERA_LIGHT.z / (halfWidth * 0.5)) * (halfWidth * 0.5),
    )
    shadow.bias = this.baseBias
    shadow.normalBias = this.baseNormalBias * (
      texelWidth / Math.max(1e-6, this.levelStates[0].texelWidth)
    )
    LEVEL_CENTER.set(
      this.dynamicCenter.x,
      this.dynamicCenter.y,
      this.dynamicCenter.z + halfWidth + this.lightMargin,
    ).applyMatrix4(LIGHT_ORIENTATION)
    levelLight.position.copy(LEVEL_CENTER)
    levelLight.target.position.copy(LEVEL_CENTER).add(LIGHT_DIRECTION)
    levelLight.updateMatrixWorld(true)
    levelLight.target.updateMatrixWorld(true)
    shadow.needsUpdate = true
    if (shadowNode.shadowMap) {
      shadowNode.updateShadow(frame)
      shadow.needsUpdate = false
      this.dynamicRenderCount++
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
