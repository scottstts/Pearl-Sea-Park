import {
  AnimationClip,
  AnimationMixer,
  AnimationUtils,
  Box3,
  DoubleSide,
  FrontSide,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  SkinnedMesh,
  Vector3,
} from 'three'
import type { Material, Object3D } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import type { SeaMediumSystem } from '../sea/medium'

/**
 * The animal cast, loaded (Scott's ruling, 2026-07-22): the moving animals
 * are AUTHORED GLBs now, not procedural meshes — the compressed rigs live in
 * `public/fauna/` (raw sources in `assets/glb_raw/`, pipeline notes in
 * dev_docs/systems/wildlife.md). Each species is normalized ONCE at load:
 *
 * - Scale comes from the SKINNED bind pose, not the mesh node — several of
 *   these rigs scale/rotate the mesh through the armature (the blue whale's
 *   skeleton is 5.6× its mesh; the tuna swims horizontally while its mesh
 *   node stands upright), so raw geometry bounds lie. `targetSize` metres
 *   along `measureAxis` of the posed box is the realistic-scale contract.
 * - Orientation is normalized to +Z-forward via `yawFix` (the eagle ray is
 *   authored +X-forward; everything else already faces +Z).
 * - Materials are converted to MeshStandardNodeMaterial so the caustic
 *   projector can modulate their received shadow — underwater haze needs no
 *   per-material work (it's the depth-driven HDR composite).
 *
 * `spawn()` returns a SkeletonUtils clone sharing geometry/materials with
 * the template, with its own AnimationMixer playing the authored clip.
 */
export type FaunaId =
  | 'shark'
  | 'hammerhead'
  | 'blueWhale'
  | 'eagleRay'
  | 'crab'
  | 'angelfish'
  | 'tuna'
  | 'seahorse'

interface FaunaSpec {
  file: string
  /** Realistic-size target, metres, along `measureAxis` of the posed bind box. */
  targetSize: number
  measureAxis: 'x' | 'y' | 'z'
  /** Yaw applied so the animal faces +Z. */
  yawFix: number
  /** 'center' for swimmers; 'feet' rests the bind pose bottom on y = 0. */
  anchor: 'center' | 'feet'
  clip: string
  /** Loop only this [start, end] window (seconds) of the authored clip.
   *  The angelfish ships a 43 s take whose FIRST 28 s are completely
   *  motionless (measured offline) — random spawn phases parked most
   *  fish in the dead stretch and they read as unanimated. */
  clipWindow?: readonly [number, number]
  /** Authored-beat multiplier so the cycle reads at cruise speed. */
  timeScale: number
  /** Animated-pose box (raw units, from the offline pose audit) — sizes the
   *  cull/shadow sphere without ever measuring animation at runtime. */
  animatedSize: readonly [number, number, number]
  castShadow: boolean
  receiveShadow: boolean
  caustics: number
  /** Sketchfab exports run glossy; organic hides get a roughness floor. */
  roughnessFloor: number
}

const FAUNA_SPECS: Record<FaunaId, FaunaSpec> = {
  shark: {
    file: 'shark.glb',
    targetSize: 3.2,
    measureAxis: 'z',
    yawFix: 0,
    anchor: 'center',
    clip: 'swimming',
    timeScale: 1,
    animatedSize: [6.9, 6.0, 16.8],
    castShadow: true,
    receiveShadow: true,
    caustics: 0.9,
    roughnessFloor: 0.45,
  },
  hammerhead: {
    file: 'hammerhead.glb',
    targetSize: 3.5,
    measureAxis: 'z',
    yawFix: 0,
    anchor: 'center',
    clip: 'Action',
    timeScale: 1,
    animatedSize: [1.46, 1.26, 3.76],
    castShadow: true,
    receiveShadow: true,
    caustics: 0.9,
    roughnessFloor: 0.42,
  },
  blueWhale: {
    file: 'blue-whale.glb',
    targetSize: 24,
    measureAxis: 'z',
    yawFix: 0,
    anchor: 'center',
    clip: 'Take 001',
    timeScale: 1,
    animatedSize: [11.1, 9.9, 32.9],
    castShadow: true,
    receiveShadow: true,
    caustics: 0.9,
    roughnessFloor: 0.5,
  },
  eagleRay: {
    file: 'eagle-ray.glb',
    // Measured across the WINGSPAN (raw z): a 2.2 m spotted-eagle-ray disc.
    targetSize: 2.2,
    measureAxis: 'z',
    yawFix: -Math.PI / 2,
    anchor: 'center',
    clip: 'Swim cycle',
    // The authored beat is a brisk 1.7 s; big rays row nearer 3 s.
    timeScale: 0.55,
    animatedSize: [9.8, 4.4, 9.5],
    castShadow: true,
    receiveShadow: true,
    caustics: 0.9,
    roughnessFloor: 0.45,
  },
  crab: {
    file: 'crab.glb',
    targetSize: 0.28,
    measureAxis: 'x',
    yawFix: 0,
    anchor: 'feet',
    clip: 'Animation',
    timeScale: 1,
    animatedSize: [2.92, 1.39, 2.02],
    castShadow: false,
    receiveShadow: true,
    caustics: 1.1,
    roughnessFloor: 0.6,
  },
  angelfish: {
    file: 'angelfish.glb',
    targetSize: 0.3,
    measureAxis: 'z',
    yawFix: 0,
    anchor: 'center',
    clip: 'Swim3_Long_Wide',
    clipWindow: [28, 43],
    timeScale: 1,
    animatedSize: [0.073, 0.116, 0.201],
    castShadow: true,
    receiveShadow: false,
    caustics: 0.9,
    roughnessFloor: 0.5,
  },
  tuna: {
    file: 'tuna.glb',
    targetSize: 1.4,
    measureAxis: 'z',
    yawFix: 0,
    anchor: 'center',
    clip: 'SKM_Tuna|SKM_Tuna|Tuna_Swim',
    timeScale: 1.15,
    animatedSize: [0.22, 0.21, 0.59],
    castShadow: true,
    receiveShadow: false,
    caustics: 0.9,
    roughnessFloor: 0.3,
  },
  seahorse: {
    file: 'seahorse.glb',
    // Standing height of the largest real species (big-bellied seahorse).
    targetSize: 0.26,
    measureAxis: 'y',
    yawFix: 0,
    anchor: 'center',
    clip: 'Animation',
    timeScale: 1,
    animatedSize: [0.53, 1.85, 1.0],
    castShadow: false,
    receiveShadow: false,
    caustics: 1.0,
    roughnessFloor: 0.5,
  },
}

export interface FaunaPrototypeInfo {
  targetSize: number
  clip: string
  clipDuration: number
  boundsRadius: number
}

interface FaunaPrototype {
  spec: FaunaSpec
  template: Group
  clips: AnimationClip[]
  /** World-space cull/shadow sphere radius at spawn scale 1. */
  boundsRadius: number
}

export interface FaunaInstance {
  readonly root: Group
  readonly mixer: AnimationMixer
  /** World bounds radius including the per-instance scale. */
  readonly boundsRadius: number
  update(dt: number): void
  /** Distance-gate helper: hides the subtree AND stops its matrix-world
   *  walk (a hidden 184-joint crab must cost nothing). */
  setActive(active: boolean): void
}

export interface FaunaSpawnOptions {
  /** Uniform size variation on top of the realistic base size. */
  scale?: number
  /** Animation phase 0..1 so a fleet never beats in sync. */
  phase?: number
  /** Extra speed multiplier over the species' authored timeScale. */
  timeScale?: number
  clip?: string
}

export class FaunaLibrary {
  private readonly medium: SeaMediumSystem
  private readonly prototypes = new Map<FaunaId, FaunaPrototype>()
  private readonly convertedMaterials = new Set<MeshStandardNodeMaterial>()

  constructor(medium: SeaMediumSystem) {
    this.medium = medium
  }

  async load(): Promise<void> {
    if (this.prototypes.size > 0) return
    const loader = new GLTFLoader()
    loader.setPath(`${import.meta.env.BASE_URL}fauna/`)
    loader.setMeshoptDecoder(MeshoptDecoder)
    await Promise.all(
      (Object.keys(FAUNA_SPECS) as FaunaId[]).map(async (id) => {
        const spec = FAUNA_SPECS[id]
        const gltf = await loader.loadAsync(spec.file).catch((error: unknown) => {
          throw new Error(`fauna asset '${spec.file}' failed to load: ${String(error)}`)
        })
        this.prototypes.set(id, this.prepare(id, spec, gltf.scene, gltf.animations))
      }),
    )
  }

  private prepare(
    id: FaunaId,
    spec: FaunaSpec,
    content: Group,
    clips: AnimationClip[],
  ): FaunaPrototype {
    // Materials → node materials (caustics need receivedShadowNode).
    const converted = new Map<Material, MeshStandardNodeMaterial>()
    content.traverse((object) => {
      if (!(object instanceof Mesh)) return
      const source = object.material as MeshStandardMaterial
      let material = converted.get(source)
      if (!material) {
        material = this.convertMaterial(source, spec)
        converted.set(source, material)
      }
      object.material = material
      object.castShadow = spec.castShadow
      object.receiveShadow = spec.receiveShadow
      // NO per-mesh frustum culling for fauna, ever. SkinnedMesh culls by
      // a sphere in "attached"-bind-mode mesh space, and these rigs move
      // their meshes THROUGH the armature (the whale's skeleton is 5.6×
      // its mesh node; the tuna's mesh node stands vertical) — the sphere
      // lands in the wrong place and whole species vanish at frame edges
      // or never draw at all (Scott's 2026-07-22 report). The cast is a
      // few dozen animals and the small species are distance-gated; the
      // rasterizer clips the rest.
      object.frustumCulled = false
    })

    // Normalize: measure the SKINNED pose, then wrap with yaw + scale and
    // recenter so the template origin is the animal's body center (or its
    // feet), facing +Z, at true metric size.
    const rawSize = posedLocalBox(content).getSize(new Vector3())
    const measured = rawSize[spec.measureAxis]
    if (!(measured > 0)) throw new Error(`fauna '${id}': degenerate posed bounds`)
    const scale = spec.targetSize / measured
    const inner = new Group()
    inner.name = `fauna-inner:${id}`
    inner.rotation.y = spec.yawFix
    inner.scale.setScalar(scale)
    inner.add(content)
    const template = new Group()
    template.name = `fauna:${id}`
    template.add(inner)
    const normalized = posedLocalBox(template)
    const center = normalized.getCenter(new Vector3())
    inner.position.set(
      -center.x,
      spec.anchor === 'feet' ? -normalized.min.y : -center.y,
      -center.z,
    )

    const animated = new Vector3(...spec.animatedSize).multiplyScalar(scale)
    const preparedClips = clips.map((clip) => {
      if (clip.name !== spec.clip || !spec.clipWindow) return clip
      // subclip is frame-indexed; 30 fps grid comfortably brackets the
      // resampled keyframes.
      const trimmed = AnimationUtils.subclip(
        clip,
        clip.name,
        Math.round(spec.clipWindow[0] * 30),
        Math.round(spec.clipWindow[1] * 30),
        30,
      )
      trimmed.resetDuration()
      return trimmed
    })
    return { spec, template, clips: preparedClips, boundsRadius: animated.length() / 2 }
  }

  private convertMaterial(
    source: MeshStandardMaterial,
    spec: FaunaSpec,
  ): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial()
    material.name = source.name
    material.color.copy(source.color)
    material.map = source.map
    material.normalMap = source.normalMap
    if (source.normalScale) material.normalScale.copy(source.normalScale)
    material.roughnessMap = source.roughnessMap
    material.roughness = Math.max(spec.roughnessFloor, source.roughness)
    // Organic hides: never metallic, whatever the export says.
    material.metalness = 0.04
    material.emissive.copy(source.emissive)
    material.emissiveMap = source.emissiveMap
    material.alphaTest = source.alphaTest
    material.transparent = source.transparent
    material.side = source.side === FrontSide ? FrontSide : DoubleSide
    this.medium.applyCaustics(material, spec.caustics)
    this.convertedMaterials.add(material)
    return material
  }

  spawn(id: FaunaId, options: FaunaSpawnOptions = {}): FaunaInstance {
    const prototype = this.prototypes.get(id)
    if (!prototype) throw new Error(`fauna '${id}' not loaded`)
    const scale = options.scale ?? 1
    const root = cloneSkeleton(prototype.template) as Group
    root.scale.setScalar(scale)

    const clipName = options.clip ?? prototype.spec.clip
    const clip = AnimationClip.findByName(prototype.clips, clipName)
    if (!clip) throw new Error(`fauna '${id}': clip '${clipName}' missing`)
    const mixer = new AnimationMixer(root)
    const action = mixer.clipAction(clip)
    action.play()
    action.time = (options.phase ?? 0) * clip.duration
    mixer.timeScale = prototype.spec.timeScale * (options.timeScale ?? 1)
    mixer.update(0)

    return {
      root,
      mixer,
      boundsRadius: prototype.boundsRadius * scale,
      update(dt: number): void {
        mixer.update(dt)
      },
      setActive(active: boolean): void {
        root.visible = active
        root.matrixWorldAutoUpdate = active
      },
    }
  }

  info(id: FaunaId): FaunaPrototypeInfo {
    const prototype = this.prototypes.get(id)
    if (!prototype) throw new Error(`fauna '${id}' not loaded`)
    const clip = AnimationClip.findByName(prototype.clips, prototype.spec.clip)
    return {
      targetSize: prototype.spec.targetSize,
      clip: prototype.spec.clip,
      clipDuration: clip?.duration ?? 0,
      boundsRadius: prototype.boundsRadius,
    }
  }

  dispose(): void {
    for (const prototype of this.prototypes.values()) {
      prototype.template.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose()
      })
    }
    for (const material of this.convertedMaterials) {
      material.map?.dispose()
      material.normalMap?.dispose()
      material.roughnessMap?.dispose()
      material.emissiveMap?.dispose()
      material.dispose()
    }
    this.prototypes.clear()
    this.convertedMaterials.clear()
  }
}

/** Skinned-pose-true bounds of `root`, in root-local space. Plain geometry
 *  bounds lie for these rigs (armature scale/rotation) — see module doc. */
function posedLocalBox(root: Object3D): Box3 {
  root.updateMatrixWorld(true)
  const rootInverse = new Matrix4().copy(root.matrixWorld).invert()
  const relative = new Matrix4()
  const meshBox = new Box3()
  const box = new Box3()
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return
    if (object instanceof SkinnedMesh) {
      object.skeleton.update()
      object.computeBoundingBox()
      if (!object.boundingBox) return
      meshBox.copy(object.boundingBox)
    } else {
      object.geometry.computeBoundingBox()
      if (!object.geometry.boundingBox) return
      meshBox.copy(object.geometry.boundingBox)
    }
    relative.multiplyMatrices(rootInverse, object.matrixWorld)
    box.union(meshBox.applyMatrix4(relative))
  })
  return box
}
