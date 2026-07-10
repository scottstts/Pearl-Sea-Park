import { DoubleSide } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  cameraPosition,
  dot,
  faceDirection,
  float,
  max,
  mix,
  modelWorldMatrix,
  normalize,
  positionLocal,
  pow,
  reflect,
  refract,
  smoothstep,
  step,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { fbm2 } from '../render/tslNoise'
import { skyRadiance } from '../sky/skyRadiance'
import { sunColorUniform, sunDirectionUniform } from '../sky/sun'
import type { WaveSim } from './waveSim'

/** Water body palette (linear HDR-ish, tuned for the golden afternoon). */
const DEEP = vec3(0.005, 0.045, 0.09)
const SHALLOW = vec3(0.014, 0.13, 0.17)
const SSS_TINT = vec3(0.035, 0.2, 0.22)
const MIST = vec3(0.38, 0.5, 0.58)

export interface OceanMaterialOptions {
  /** Full three-cascade sampling + foam; false = far skirt (cascade 0 only). */
  detailed: boolean
  /**
   * Half-size of the detailed mesh: fine cascades fade to zero approaching
   * this edge so the surface exactly matches the cascade-0-only skirt at the
   * seam. Zero disables the fade (skirt).
   */
  edgeFadeHalfSize?: number
}

/**
 * The ocean surface, shaded per the spectral-ocean optics contract:
 * fold-aware normals from summed cascade derivatives, side-aware Fresnel,
 * shared skyRadiance for reflection, crest subsurface scatter, Jacobian foam
 * with history, and — from below — the true Snell's window with total
 * internal reflection outside it.
 */
export function createOceanSurfaceMaterial(
  sim: WaveSim,
  timeUniform: Node<'float'>,
  options: OceanMaterialOptions,
): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial()
  material.side = DoubleSide
  material.fog = false

  const patch = sim.patchLengths
  const cascadeCount = options.detailed ? 3 : 1

  // ── Vertex: displacement from summed cascades ──────────────────────────
  const baseWorld = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz
  const xz = baseWorld.xz

  // The skirt is FLAT (vertex-sampling waves at 187 m spacing is pure
  // aliasing); the inner mesh fades ALL displacement to zero at its edge so
  // the two surfaces meet exactly.
  const edgeHalf = options.edgeFadeHalfSize ?? 0
  const edgeKeep =
    edgeHalf > 0
      ? float(1).sub(
          smoothstep(
            edgeHalf - 170,
            edgeHalf - 15,
            max(positionLocal.x.abs(), positionLocal.z.abs()),
          ),
        )
      : float(0)

  // Spectral LOD applies to vertex displacement too, and by PIXEL FOOTPRINT
  // like the fragment side (the base plane sits at y = 0, so the grazing gap
  // is just camera height). Displaced geometry aliases at the horizon even
  // after normals flatten: silhouette teeth, and vHeight-driven body-color
  // stripes — the residual comb. Cascade 0 fades too; only edgeKeep used to
  // bound it, which left raw swell geometry out to the mesh diagonals.
  const vertexDistance = cameraPosition.sub(baseWorld).length()
  const vertexGap = cameraPosition.y.abs().max(0.5)
  const vertexFootprint = vertexDistance.mul(vertexDistance).mul(0.001).div(vertexGap)
  const vertexKeeps = [
    float(1).sub(smoothstep(6.0, 18.0, vertexFootprint)),
    float(1).sub(smoothstep(0.35, 1.2, vertexFootprint)),
    float(1).sub(smoothstep(0.1, 0.4, vertexFootprint)),
  ]

  let displacement: Node<'vec3'> = sim.displacementNodes[0]
    .sample(xz.div(patch[0]))
    .xyz.mul(edgeKeep)
    .mul(vertexKeeps[0])
  for (let i = 1; i < cascadeCount; i++) {
    displacement = displacement.add(
      sim.displacementNodes[i].sample(xz.div(patch[i])).xyz.mul(edgeKeep).mul(vertexKeeps[i]),
    )
  }

  const foamHistory = options.detailed
    ? sim.displacementNodes[0].sample(xz.div(patch[0])).w.min(
        sim.displacementNodes[1].sample(xz.div(patch[1])).w,
      )
    : float(1)

  material.positionNode = positionLocal.add(displacement)

  const vWorldXZ = varying(xz) as unknown as Node<'vec2'>
  const vHeight = varying(displacement.y) as unknown as Node<'float'>
  const vFoam = varying(foamHistory) as unknown as Node<'float'>
  const vWorld = varying(baseWorld.add(displacement)) as unknown as Node<'vec3'>

  // ── Fragment ───────────────────────────────────────────────────────────
  const vEdgeKeep = varying(edgeKeep) as unknown as Node<'float'>
  const vDistance = varying(
    cameraPosition.sub(baseWorld.add(displacement)).length(),
  ) as unknown as Node<'float'>

  // Spectral LOD by PIXEL FOOTPRINT, not distance. The cascade maps carry no
  // mips; sampling them where one output pixel spans more than a band's
  // wavelength beats into comb/moiré patterns. At grazing incidence the
  // vertical footprint on the surface is distance²·pixelAngle / heightGap
  // (|viewDir.y| = heightGap/distance): a 4.4 m deck eye is under-sampled at
  // 200 m while a diver sees the same span steeply and keeps full detail —
  // pure distance fades can never serve both (the "horizon comb" artifact).
  const heightGap = cameraPosition.y.sub(vWorld.y).abs().max(0.5)
  const pixelFootprint = vDistance.mul(vDistance).mul(0.001).div(heightGap)
  // Shortest wavelengths per cascade: ~41 m / ~2.8 m / ~0.83 m.
  const keepCascade1 = float(1).sub(smoothstep(0.35, 1.2, pixelFootprint))
  const keepCascade2 = float(1).sub(smoothstep(0.1, 0.4, pixelFootprint))
  const cascadeKeeps = [float(1), keepCascade1, keepCascade2]

  let derivatives: Node<'vec4'> = sim.derivativeNodes[0]
    .sample(vWorldXZ.div(patch[0]))
    .mul(vEdgeKeep)
  for (let i = 1; i < cascadeCount; i++) {
    derivatives = derivatives.add(
      sim.derivativeNodes[i].sample(vWorldXZ.div(patch[i])).mul(vEdgeKeep).mul(cascadeKeeps[i]),
    )
  }

  // Fold-aware normal (slope / (1 + λ·dD/dx)), then face-side flip.
  const slopeX = derivatives.x.div(max(0.18, derivatives.z.add(1)))
  const slopeZ = derivatives.y.div(max(0.18, derivatives.w.add(1)))
  const upNormal = normalize(vec3(slopeX.negate(), 1, slopeZ.negate()))
  const sideSign = faceDirection
  const rawNormal = upNormal.mul(sideSign)

  const toCamera = cameraPosition.sub(vWorld)
  const viewDistance = toCamera.length()
  const viewDir = toCamera.div(viewDistance)

  // Normal flatten rides the same footprint (cascade-0 bottoms out ~41 m):
  // past it the surface hands off to the smooth mirror + analytic sky. The
  // 41 m tail still combs above ~λ/8, so complete the flatten by 16.
  const distanceFade = smoothstep(5.0, 16.0, pixelFootprint)
  const normal = normalize(mix(rawNormal, vec3(0, sideSign, 0), distanceFade))

  const sunDir = sunDirectionUniform
  const isAbove = sideSign.mul(0.5).add(0.5)

  // ── Above-surface shading ──────────────────────────────────────────────
  const heightMask = smoothstep(-1.7, 1.5, vHeight)
  const bodyBase = mix(DEEP, SHALLOW, heightMask)

  const crestLight = normalize(sunDir.negate().add(normal.mul(0.4)))
  const crestScatter = pow(max(dot(viewDir, crestLight), 0.0), 4.5)
    .mul(1.0)
    .mul(smoothstep(-0.1, 1.1, vHeight))
  const body = bodyBase.add(SSS_TINT.mul(crestScatter))

  const fresnelNormal = normalize(mix(normal, vec3(0, 1, 0), 0.5))
  const fresnel = float(0.02).add(
    float(0.98).mul(pow(float(1).sub(max(dot(viewDir, fresnelNormal), 0.0)), 5.0)),
  )
  // discStrength 0: sunGlint below IS the disc's specular response — the
  // delta-light term. Reflecting the HDR disc through bumpy normals again
  // would double-count it as sparkling white pixels.
  const skyReflection = skyRadiance(reflect(viewDir.negate(), fresnelNormal), float(0))

  const halfVector = normalize(sunDir.add(viewDir))
  // Discrete glints are ripple-scale specular: once the footprint passes the
  // ripple size they must dissolve into the smooth reflected sun lane.
  const sparkleKeep = float(1).sub(smoothstep(0.08, 0.3, pixelFootprint))
  const glint = smoothstep(0.9, 0.99, pow(max(dot(halfVector, normal), 0.0), 250.0)).mul(
    sparkleKeep,
  )
  const sunGlint = sunColorUniform.mul(glint).mul(6.0)

  let above = mix(body, skyReflection, fresnel).add(sunGlint)

  if (options.detailed) {
    // Jacobian foam: history-driven coverage × bubbly fbm detail, sun/sky lit.
    // Coverage only where the surface genuinely folded; fades with distance
    // so the fbm detail can never read as far-field shimmer.
    const coverage = float(1).sub(smoothstep(-0.05, 0.26, vFoam))
    const bubbleA = fbm2(vWorldXZ.mul(0.9).add(vec2(0.13, 0.07).mul(timeUniform)))
    const bubbleB = fbm2(vWorldXZ.mul(1.7).sub(vec2(0.11, 0.05).mul(timeUniform)))
    const foamKeep = float(1).sub(smoothstep(0.25, 0.8, pixelFootprint))
    const foamMask = coverage
      .mul(bubbleA.mul(bubbleB).mul(1.7).add(0.06))
      .mul(foamKeep)
      .clamp(0, 1)
    const foamShade = sunColorUniform
      .mul(max(dot(normal, sunDir), 0.0).mul(0.9).add(0.35))
      .mul(1.15)
    above = mix(above, foamShade, foamMask)
  }

  // Aerial haze toward the horizon.
  const haze = float(1).sub(viewDistance.mul(0.0011).pow(2).negate().exp())
  const sunward = pow(max(dot(viewDir.negate(), sunDir), 0.0), 8.0)
  const hazeColor = MIST.add(sunColorUniform.mul(sunward).mul(0.4))
  above = mix(above, hazeColor, haze.clamp(0, 1))

  // ── Below-surface shading: the Silver Ceiling ──────────────────────────
  const incident = viewDir.negate()
  const refracted = refract(incident, normal, 1.333)
  const insideWindow = step(1e-5, dot(refracted, refracted))

  const skyThrough = skyRadiance(refracted, float(0)).mul(0.9)
  const windowGlint = pow(max(dot(refracted, sunDir), 0.0), 700.0)
    .mul(24.0)
    .mul(sunColorUniform)

  // Outside the critical angle: total internal reflection. The mirror
  // reflects the UPWELLING water light — silvery teal near the medium's
  // horizontal ambient (medium.ts AMBIENT_* mix), not the deep body color.
  // A near-black ceiling here is what carved the bright "gap" band at the
  // surface silhouette against converged fog: the fogged underside must
  // start from a radiance close to what the fog converges to.
  const tirBody = vec3(0.035, 0.14, 0.19).add(SSS_TINT.mul(crestScatter).mul(0.5))

  const below = mix(tirBody, skyThrough.add(windowGlint), insideWindow)

  material.colorNode = vec4(mix(below, above, isAbove), 1.0)
  return material
}
