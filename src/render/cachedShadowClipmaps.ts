import {
  Light,
  Matrix4,
  Object3D,
  Sphere,
  Vector3,
  Vector4,
} from 'three'
import type { DirectionalLight, DirectionalLightShadow } from 'three'
import { NodeUpdateType, ShadowBaseNode, ShadowNode } from 'three/webgpu'
import type { Node, NodeBuilder, NodeFrame } from 'three/webgpu'
import {
  Fn,
  abs,
  float,
  max,
  reference,
  renderGroup,
  shadowPositionWorld,
  smoothstep,
  uniform,
  vec4,
} from 'three/tsl'

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
}

export interface ShadowClipmapSnapshot {
  textureCount: number
  dynamicLevels: number
  dynamicRefreshFrames: number
  updateBudget: number
  budgetBefore: number
  budgetAfter: number
  directionDelta: number
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

  private readonly levelMapSizes: readonly number[]
  private readonly halfWidths: number[] = []
  private readonly levelStates: LevelState[] = []
  private readonly levelData: Vector4[] = []
  private readonly shadowNodes: BoundedShadowNode[] = []
  private readonly lights: ClipmapLight[] = []
  private readonly worldToLight = new Matrix4()
  private readonly lastDirection = new Vector3()
  private readonly directionCos: number
  private baseBias = 0
  private baseNormalBias = 0
  private firstUpdate = true
  private initialized = false
  private budgetBefore = 0
  private budgetAfter = 0
  private directionDelta = 0

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
    this.directionCos = Math.cos(options.directionEpsilon ?? 0.002)
    // These world-space clipmaps are camera-independent once rendered, so
    // every render pass in one app frame must reuse the committed maps.
    this.updateBeforeType = NodeUpdateType.FRAME
  }

  attach(): this {
    ;(this.light.shadow as DirectionalLightShadow & { shadowNode?: Node }).shadowNode = this
    return this
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
      return accumulated.add(vec4(remaining))
    })()
  }

  override updateBefore(frame: NodeFrame): boolean | undefined {
    if (!this.light.parent) return undefined
    if (!this.initialized) this.initLevels()
    for (const levelLight of this.lights) {
      if (levelLight.parent) continue
      this.light.parent.add(levelLight.target)
      this.light.parent.add(levelLight)
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

    let budget = this.firstUpdate || directionChanged ? this.levels : this.updateBudget
    this.budgetBefore = budget
    this.firstUpdate = false
    let finestTexel = 0

    for (let index = 0; index < this.levels; index++) {
      const state = this.levelStates[index]
      const levelLight = this.lights[index]
      const shadow = levelLight.shadow
      const camera = shadow.camera
      const texelWidth = (camera.right - camera.left) / shadow.mapSize.width
      if (index === 0) finestTexel = texelWidth
      const texelScale = finestTexel > 0 ? texelWidth / finestTexel : 1
      shadow.bias = this.baseBias
      shadow.normalBias = this.baseNormalBias * texelScale
      state.texelWidth = texelWidth
      state.normalBias = shadow.normalBias
      state.age++

      state.desiredX = Math.round(CAMERA_LIGHT.x / texelWidth) * texelWidth
      state.desiredY = Math.round(CAMERA_LIGHT.y / texelWidth) * texelWidth
      const zQuantum = state.halfWidth * 0.5
      state.desiredZ = Math.round(CAMERA_LIGHT.z / zQuantum) * zQuantum
      const dynamic = index < this.dynamicLevels
      const moved = state.desiredX !== state.centerX
        || state.desiredY !== state.centerY
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

      const canRender = dynamic || state.forceDirty || budget > 0
      if (dirtyReasons !== 0 && canRender) {
        if (!dynamic && !state.forceDirty) budget--
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
          shadowNode.updateShadow(frame)
          shadow.needsUpdate = false
        }
      }

      if (state.valid) {
        this.levelData[index].set(
          state.centerX,
          state.centerY,
          state.halfWidth * (1 - this.guardBand),
          0,
        )
      }
    }
    this.budgetAfter = budget
    return undefined
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
      textureCount: this.levels,
      dynamicLevels: this.dynamicLevels,
      dynamicRefreshFrames: this.dynamicRefreshFrames,
      updateBudget: this.updateBudget,
      budgetBefore: this.budgetBefore,
      budgetAfter: this.budgetAfter,
      directionDelta: this.directionDelta,
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
      shadow.camera.far = Math.max(
        this.shadowCameraNear + 1,
        Math.min(this.shadowCameraFar, this.lightMargin + halfWidth * 2),
      )
      shadow.camera.updateProjectionMatrix()
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
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
