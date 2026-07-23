import { DoubleSide } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn,
  If,
  cameraProjectionMatrix,
  cameraProjectionMatrixInverse,
  cameraPosition,
  cameraViewMatrix,
  cameraWorldMatrix,
  dot,
  exp,
  float,
  getScreenPosition,
  getViewPosition,
  log2,
  max,
  mix,
  modelWorldMatrix,
  mrt,
  normalize,
  normalView,
  positionLocal,
  pow,
  reflect,
  refract,
  screenSize,
  screenUV,
  smoothstep,
  step,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { fbm2, valueNoise2 } from '../render/tslNoise'
import { skyRadiance } from '../sky/skyRadiance'
import { sunColorUniform, sunDirectionUniform } from '../sky/sun'
import {
  AIR_IOR,
  AQUATIC_AMBIENT_DOWN,
  AQUATIC_AMBIENT_UP,
  AQUATIC_EXTINCTION,
  WATER_IOR,
} from './opticalConstants'
import type { InterfaceStructureNodes } from './interfaceStructureLayer'
import { OCEAN_FLAT_EDGE_MARGIN } from './oceanSkirtGeometry'
import { SEABED_MEAN_RADIANCE } from './seabedRadiance'
import {
  WAKE_FOAM_CENTER_X,
  WAKE_FOAM_CENTER_Z,
  WAKE_FOAM_SIZE,
  type WakeFoamMap,
} from './wakeFoamMap'
import type { WaveSim } from './waveSim'

/** Water body palette (linear HDR-ish, tuned for the golden afternoon). */
const DEEP = vec3(0.005, 0.045, 0.09)
const SHALLOW = vec3(0.014, 0.13, 0.17)
const SSS_TINT = vec3(0.035, 0.2, 0.22)

type MipColorSample = Node<'vec4'> & {
  level: (levelNode: Node<'float'>) => Node<'vec4'>
}

export interface OceanMaterialOptions {
  /** Full three-cascade sampling + foam; false = far skirt (cascade 0 only). */
  detailed: boolean
  /** One shared opaque-frame copy, sampled at reflected/refracted UVs. */
  sceneBackdrop: {
    sample: (uv: Node<'vec2'>) => MipColorSample
  }
  /** Shared opaque-frame depth copy paired with `sceneBackdrop`. */
  sceneDepth: {
    sample: (uv: Node<'vec2'>) => Node<'vec4'>
  }
  /** Opposite-medium opaque structures forward-refracted into screen space. */
  interfaceStructures?: InterfaceStructureNodes
  /** Camera-medium authority: 0 above the displaced surface, 1 below it. */
  submerged: Node<'float'>
  /**
   * World-anchored seabed height (baked terrain), giving the detailed sheet
   * its analytic transmitted-bottom base. Absent on the skirt, which keeps
   * the far-field palette.
   */
  seabedHeight?: (worldXZ: Node<'vec2'>) => Node<'float'>
  /**
   * World-anchored vessel wake foam field, merged into the whitecap foam
   * coverage (detailed sheet only) so wake trails ARE ocean foam.
   */
  wakeFoam?: WakeFoamMap | null
  /**
   * Half-size of the detailed mesh: fine cascades fade to zero approaching
   * this edge so the surface exactly matches the cascade-0-only skirt at the
   * seam. Zero disables the fade (skirt).
   */
  edgeFadeHalfSize?: number
  /** Compile-time isolation view used by fixed visual-validation captures. */
  debugMode?: OceanOpticsDebugMode
}

export type OceanOpticsDebugMode =
  | 'final'
  | 'fresnel'
  | 'reflection'
  | 'transmission'
  | 'interface'
  | 'validity'

export function oceanOpticsDebugMode(pass: string): OceanOpticsDebugMode {
  switch (pass) {
    case 'water-fresnel':
      return 'fresnel'
    case 'water-reflection':
      return 'reflection'
    case 'water-transmission':
      return 'transmission'
    case 'water-interface':
      return 'interface'
    case 'water-validity':
      return 'validity'
    default:
      return 'final'
  }
}

/**
 * The ocean surface, shaded per the spectral-ocean optics contract:
 * fold-aware normals from summed cascade derivatives, side-aware Fresnel,
 * shared skyRadiance plus validated scene reflection, two-sided scene
 * transmission, crest subsurface scatter, Jacobian foam with history, and —
 * from below — the true Snell's window with total internal reflection outside
 * it.
 */
export function createOceanSurfaceMaterial(
  sim: WaveSim,
  timeUniform: Node<'float'>,
  options: OceanMaterialOptions,
): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial()
  material.side = DoubleSide
  material.fog = false
  // The viewport copy used by underwater refraction must be taken after the
  // opaque scene has rendered but before this surface shades. Alpha remains
  // one and depth still writes, so the ocean is visually/depth-wise opaque;
  // the transparent queue is only render-order ownership for the backdrop.
  material.transparent = true
  material.depthWrite = true
  // A transparent DoubleSide material normally draws back and front in two
  // passes. This is a single geometric sheet, and a second pass would copy
  // the first pass's water result into its own refraction backdrop.
  material.forceSinglePass = true
  // Screen-space AO estimates missing *diffuse* ambient light. This material
  // owns reflective/transmissive water optics, so cavity-multiplying its final
  // color is physically wrong and exposes GTAO's sampling lattice at grazing
  // incidence. Override the normal MRT's spare alpha receiver channel only.
  material.mrtNode = mrt({ normal: vec4(normalView, 0) })

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
            edgeHalf - OCEAN_FLAT_EDGE_MARGIN,
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
    // Match the above-water cascade-0 normal cutoff. Keeping coarse vertex
    // displacement to 18 m/pixel left sub-pixel triangle rows even after the
    // fragment normal and height response had flattened, producing both the
    // dark comb and the faint gray band at the inner-mesh transition.
    float(1).sub(smoothstep(2.5, 5.5, vertexFootprint)),
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
  // Cascade 0 needs a stricter keep for the narrow above-water GGX lobe:
  // attenuate while its shortest wave still spans ~16 pixels and finish by
  // ~8 pixels. Sampling first and flattening the reconstructed normal later
  // preserves the alias, which is what produced the visible horizon comb.
  const keepCascade0Above = float(1).sub(smoothstep(2.5, 5.5, pixelFootprint))
  const keepCascade1 = float(1).sub(smoothstep(0.35, 1.2, pixelFootprint))
  const keepCascade2 = float(1).sub(smoothstep(0.1, 0.4, pixelFootprint))
  const cascadeKeeps = [float(1), keepCascade1, keepCascade2]

  // Bind each raw cascade sample once. The visible-water normal and the more
  // aggressively filtered Snell transmission normal below reuse these fetches,
  // so optical stability adds arithmetic rather than texture IO.
  const derivativeSamples: Node<'vec4'>[] = []
  for (let i = 0; i < cascadeCount; i++) {
    derivativeSamples.push(
      sim.derivativeNodes[i]
        .sample(vWorldXZ.div(patch[i]))
        .mul(vEdgeKeep)
        .toVar() as unknown as Node<'vec4'>,
    )
  }
  const derivative0 = derivativeSamples[0]
  let derivatives: Node<'vec4'> = derivative0
  for (let i = 1; i < cascadeCount; i++) {
    derivatives = derivatives.add(
      derivativeSamples[i].mul(cascadeKeeps[i]),
    )
  }
  const aboveDerivatives = derivatives.sub(
    derivative0.mul(float(1).sub(keepCascade0Above)),
  )

  // Fold-aware normal (slope / (1 + λ·dD/dx)). Optical side is a camera
  // medium state, never a per-triangle facing test: right at the crossing a
  // displaced sheet can expose nearby backfaces before the camera itself is
  // submerged. The surface must not mix two optical media in one frame.
  const slopeX = derivatives.x.div(max(0.18, derivatives.z.add(1)))
  const slopeZ = derivatives.y.div(max(0.18, derivatives.w.add(1)))
  const upNormal = normalize(vec3(slopeX.negate(), 1, slopeZ.negate()))
  const isAbove = float(1).sub(options.submerged)
  const sideSign = isAbove.mul(2).sub(1)
  const rawNormal = upNormal.mul(sideSign)

  const toCamera = cameraPosition.sub(vWorld)
  const viewDistance = toCamera.length()
  const viewDir = toCamera.div(viewDistance)

  // Normal flatten rides the same footprint (cascade-0 bottoms out ~41 m):
  // past it the surface hands off to the smooth mirror + analytic sky. The
  // 41 m tail still combs above ~λ/8, so complete the flatten by 16.
  const distanceFade = smoothstep(5.0, 16.0, pixelFootprint)
  const normal = normalize(mix(rawNormal, vec3(0, sideSign, 0), distanceFade))

  // Water -> air expands angles, with an unbounded derivative at the critical
  // angle. A wave band that is spatially resolved on the water can therefore
  // still become subpixel in the transmitted image. Estimate that Snell
  // Jacobian from the regular normal, square it for the 2-D source footprint,
  // and reapply the established cascade LOD thresholds. This finite-pixel
  // microfacet average stabilizes transmission without flattening the visible
  // silver-ceiling reflection.
  const preliminaryBelowNoV = max(dot(viewDir, normal), 0.001)
  const waterToAirEta = float(WATER_IOR / AIR_IOR)
  const preliminarySinTransmitted2 = waterToAirEta
    .mul(waterToAirEta)
    .mul(float(1).sub(preliminaryBelowNoV.mul(preliminaryBelowNoV)))
  const preliminaryCosTransmitted = float(1)
    .sub(preliminarySinTransmitted2)
    .max(0.0)
    .sqrt()
  const snellAngularStretch = waterToAirEta
    .mul(preliminaryBelowNoV)
    .div(preliminaryCosTransmitted.max(0.04))
    .max(1.0)
  const snellFootprint = pixelFootprint
    .mul(snellAngularStretch.mul(snellAngularStretch))
    .min(64.0)
  const snellKeeps = [
    float(1).sub(smoothstep(2.5, 5.5, snellFootprint)),
    float(1).sub(smoothstep(0.35, 1.2, snellFootprint)),
    float(1).sub(smoothstep(0.1, 0.4, snellFootprint)),
  ]
  let snellDerivatives: Node<'vec4'> = derivativeSamples[0].mul(snellKeeps[0])
  for (let i = 1; i < cascadeCount; i++) {
    snellDerivatives = snellDerivatives.add(
      derivativeSamples[i].mul(snellKeeps[i]),
    )
  }
  const snellSlopeX = snellDerivatives.x.div(
    max(0.18, snellDerivatives.z.add(1)),
  )
  const snellSlopeZ = snellDerivatives.y.div(
    max(0.18, snellDerivatives.w.add(1)),
  )
  const snellResolvedUp = normalize(
    vec3(snellSlopeX.negate(), 1, snellSlopeZ.negate()),
  )
  const snellDistanceFade = smoothstep(5.0, 16.0, snellFootprint)
  const belowOpticalNormal = normalize(
    mix(snellResolvedUp, vec3(0, 1, 0), snellDistanceFade),
  ).negate()

  const sunDir = sunDirectionUniform

  // ── Above-surface optical normal ──────────────────────────────────────
  // The FFT resolves down to ~0.83 m. Add two weak, independently advected
  // capillary bands below that limit so close water carries real small-scale
  // slope variation without rewriting the swell. Each band disappears once
  // its shortest structure is below the current pixel footprint.
  const aboveSlopeX = aboveDerivatives.x.div(max(0.18, aboveDerivatives.z.add(1)))
  const aboveSlopeZ = aboveDerivatives.y.div(max(0.18, aboveDerivatives.w.add(1)))
  let aboveNormal: Node<'vec3'> = normalize(
    vec3(aboveSlopeX.negate(), 1, aboveSlopeZ.negate()),
  )
  if (options.detailed) {
    const detailUvA = vWorldXZ
      .mul(1.7)
      .add(vec2(0.11, -0.07).mul(timeUniform))
    const detailUvB = vWorldXZ
      .mul(4.7)
      .add(vec2(-0.19, 0.13).mul(timeUniform))
    const heightA = valueNoise2(detailUvA)
    const detailA = vec2(
      valueNoise2(detailUvA.add(vec2(0.12, 0))).sub(heightA),
      valueNoise2(detailUvA.add(vec2(0, 0.12))).sub(heightA),
    ).div(0.12)
    const heightB = valueNoise2(detailUvB)
    const detailB = vec2(
      valueNoise2(detailUvB.add(vec2(0.08, 0))).sub(heightB),
      valueNoise2(detailUvB.add(vec2(0, 0.08))).sub(heightB),
    ).div(0.08)
    const detailKeepA = float(1)
      .sub(smoothstep(0.025, 0.12, pixelFootprint))
      .mul(vEdgeKeep)
    const detailKeepB = float(1)
      .sub(smoothstep(0.008, 0.035, pixelFootprint))
      .mul(vEdgeKeep)
    const capillarySlope = detailA
      .mul(detailKeepA)
      .add(detailB.mul(detailKeepB).mul(0.35))
    aboveNormal = normalize(
      normal.add(vec3(capillarySlope.x, 0, capillarySlope.y).mul(0.045)),
    )
  }

  // Exact, unpolarised dielectric Fresnel. The returned Y channel is the
  // physical transmission-domain mask (zero under total internal reflection).
  const dielectricFresnel = (
    cosIncident: Node<'float'>,
    incidentIor: number,
    transmittedIor: number,
  ): Node<'vec2'> => {
    const etaI = float(incidentIor)
    const etaT = float(transmittedIor)
    const etaRatio = etaI.div(etaT)
    const sinTransmitted2 = etaRatio
      .mul(etaRatio)
      .mul(float(1).sub(cosIncident.mul(cosIncident)))
    // The critical-angle boundary moves across the screen with the FFT
    // normal. Filter that binary domain test over roughly one output pixel;
    // exact Fresnel still drives transmission energy to zero at the physical
    // limit, while the sampling mask no longer toggles an entire pixel.
    const criticalWidth = sinTransmitted2
      .fwidth()
      .mul(1.5)
      .max(0.001)
      .min(0.05)
    const canTransmit = float(1).sub(
      smoothstep(
        float(1).sub(criticalWidth),
        float(1).add(criticalWidth),
        sinTransmitted2,
      ),
    )
    const cosTransmitted = float(1).sub(sinTransmitted2).max(0.0).sqrt()
    const rs = etaI
      .mul(cosIncident)
      .sub(etaT.mul(cosTransmitted))
      .div(etaI.mul(cosIncident).add(etaT.mul(cosTransmitted)).max(1e-4))
    const rp = etaT
      .mul(cosIncident)
      .sub(etaI.mul(cosTransmitted))
      .div(etaT.mul(cosIncident).add(etaI.mul(cosTransmitted)).max(1e-4))
    return vec2(rs.mul(rs).add(rp.mul(rp)).mul(0.5), canTransmit) as Node<'vec2'>
  }

  const incident = viewDir.negate()
  const aboveNoV = max(dot(viewDir, aboveNormal), 0.001)
  const aboveFresnelResult = dielectricFresnel(aboveNoV, AIR_IOR, WATER_IOR)
  const aboveFresnel = aboveFresnelResult.x
  const belowNoV = max(dot(viewDir, belowOpticalNormal), 0.001)
  const belowFresnelResult = dielectricFresnel(belowNoV, WATER_IOR, AIR_IOR)
  const interfaceFresnel = belowFresnelResult.x
  const insideWindow = belowFresnelResult.y

  /**
   * Trace one reflected/refracted ray against the already-completed opaque
   * framebuffer. Output = [uv.x, uv.y, surface-to-source metres, signed validity].
   * Positive validity means the reconstructed source is on the requested side
   * of the displaced interface. A small negative value means a well-aligned hit
   * landed on the opposite side within 1.25 m of the interface: that is the
   * bounded continuity source for piles and other meshes that straddle water.
   */
  const traceOpaqueSceneRay = (
    rayDirection: Node<'vec3'>,
    expectedSide: 1 | -1,
    enabled: Node<'float'>,
    depthSource = options.sceneDepth,
  ): Node<'vec4'> =>
    Fn(() => {
      const trace = vec4(0).toVar()
      If(enabled.greaterThan(0.001), () => {
        const initialRayView = cameraViewMatrix.mul(vec4(rayDirection, 0)).xyz
        const initialUv = getScreenPosition(initialRayView, cameraProjectionMatrix)
        const initialUvInside = step(0.002, initialUv.x)
          .mul(step(initialUv.x, 0.998))
          .mul(step(0.002, initialUv.y))
          .mul(step(initialUv.y, 0.998))
        const initialClampedUv = initialUv.clamp(vec2(0.002), vec2(0.998))
        const initialDepth = depthSource.sample(initialClampedUv as Node<'vec2'>).r
        const initialSourceView = getViewPosition(
          initialClampedUv,
          initialDepth,
          cameraProjectionMatrixInverse,
        )
        const initialSourceWorld = cameraWorldMatrix.mul(vec4(initialSourceView, 1)).xyz
        const estimatedDistance = initialSourceWorld
          .sub(vWorld)
          .length()
          .clamp(0.5, 3200.0)

        // Reproject from the displaced surface hit, not the camera origin. This
        // keeps a structure's reflected/refracted image attached at water entry.
        const targetWorld = vWorld.add(rayDirection.mul(estimatedDistance))
        const targetView = cameraViewMatrix.mul(vec4(targetWorld, 1)).xyz
        const targetUv = getScreenPosition(targetView, cameraProjectionMatrix)
        const uvInside = step(0.002, targetUv.x)
          .mul(step(targetUv.x, 0.998))
          .mul(step(0.002, targetUv.y))
          .mul(step(targetUv.y, 0.998))
          .mul(initialUvInside)
        const clampedUv = targetUv.clamp(vec2(0.002), vec2(0.998))
        const sourceDepth = depthSource.sample(clampedUv as Node<'vec2'>).r
        const sourceView = getViewPosition(
          clampedUv,
          sourceDepth,
          cameraProjectionMatrixInverse,
        )
        const sourceWorld = cameraWorldMatrix.mul(vec4(sourceView, 1)).xyz
        const sourceOffset = sourceWorld.sub(vWorld)
        const rayDistance = max(dot(sourceOffset, rayDirection), 0.0)
        const lateralError = sourceOffset.sub(rayDirection.mul(rayDistance)).length()
        const rayThickness = rayDistance.mul(0.015).add(0.35)
        const rayAlignment = float(1).sub(
          smoothstep(rayThickness, rayThickness.mul(3.0), lateralError),
        )
        const sourceIsGeometry = step(sourceDepth, 0.999999).mul(
          step(sourceView.length(), 3200.0),
        )
        const baseValidity = uvInside
          .mul(sourceIsGeometry)
          .mul(step(0.02, rayDistance))
          .mul(rayAlignment)

        // Test side relative to the live local interface, not the mean y=0
        // plane. A wrong-side hit may still anchor the first 1.25 m of a
        // continuous crossing mesh; beyond that it cannot masquerade as the
        // hidden transmitted side and cleanly falls back to sky/body radiance.
        const requestedSideDistance = dot(sourceOffset, upNormal).mul(expectedSide)
        const requestedSide = step(0.02, requestedSideDistance)
        const oppositeSideAnchor = step(requestedSideDistance, -0.02).mul(
          float(1).sub(smoothstep(0.05, 1.25, requestedSideDistance.abs())),
        )
        const signedValidity = baseValidity.mul(requestedSide.sub(oppositeSideAnchor))
        trace.assign(vec4(clampedUv, rayDistance, signedValidity))
      })
      return trace
    })()

  const sampleTracedSceneWithSource = (
    trace: Node<'vec4'>,
    colorSource: OceanMaterialOptions['sceneBackdrop'],
  ): Node<'vec4'> =>
    Fn(() => {
      const sample = vec4(0).toVar()
      // Explicit LOD remains valid inside the non-uniform geometry-validity
      // branch, where implicit texture derivatives are undefined. It averages
      // sky and thin architecture in proportion to the refracted source
      // footprint instead of turning Snell minification into vertical shards.
      const sourceFootprint = max(
        trace.xy.dFdx().mul(screenSize).length(),
        trace.xy.dFdy().mul(screenSize).length(),
      )
      // Level six was still only a 64 px average. Snell compression is
      // unbounded at the critical angle, so allow the sampler to reach the
      // 1x1 tail (the backend clamps this to the texture's last real level).
      const sourceLod = log2(max(sourceFootprint, 1.0)).clamp(0.0, 12.0)
      If(trace.w.abs().greaterThan(0.001), () => {
        sample.assign(
          vec4(
            colorSource.sample(trace.xy).level(sourceLod).rgb,
            trace.w,
          ),
        )
      })
      return sample
    })()

  const sampleTracedScene = (trace: Node<'vec4'>): Node<'vec4'> =>
    sampleTracedSceneWithSource(trace, options.sceneBackdrop)

  /**
   * The dedicated structure pass has already solved the optical path and
   * rasterized its vertices at their refracted screen positions. Sample it at
   * this water pixel directly; depth only reconstructs the source path length
   * needed by above-water Beer-Lambert attenuation.
   */
  const sampleInterfaceStructure = (
    enabled: Node<'float'>,
    reconstructPath = false,
  ): { sample: Node<'vec4'>; path: Node<'float'> } => {
    const structures = options.interfaceStructures
    if (!structures) return { sample: vec4(0), path: float(0) }

    const sample = Fn(() => {
      const result = vec4(0).toVar()
      If(enabled.greaterThan(0.001), () => {
        const rawColor = structures.color.sample(screenUV)
        const geometryValidity = rawColor.a.mul(structures.active)
        If(geometryValidity.greaterThan(0.001), () => {
          // Linear filtering against a transparent-black target premultiplies
          // edge color. Undo that before the ocean applies coverage once.
          const sourceColor = rawColor.rgb.div(max(rawColor.a, 0.001))
          result.assign(vec4(sourceColor, geometryValidity))
        })
      })
      return result
    })()
    const path = reconstructPath
      ? Fn(() => {
          const result = float(0).toVar()
          If(enabled.greaterThan(0.001), () => {
            const sourceDepth = structures.depth.sample(screenUV).r
            const sourceView = getViewPosition(
              screenUV,
              sourceDepth,
              cameraProjectionMatrixInverse,
            )
            const sourceWorld = cameraWorldMatrix.mul(vec4(sourceView, 1)).xyz
            result.assign(sourceWorld.sub(vWorld).length().max(0.02))
          })
          return result
        })()
      : float(0)
    return {
      sample,
      path,
    }
  }

  const belowRefracted = refract(
    incident,
    belowOpticalNormal,
    WATER_IOR / AIR_IOR,
  )
  // Underwater scene-scale subjects are forward-projected into the dedicated
  // layer below. A current-view depth snapshot cannot solve an offscreen air
  // source, and feeding discontinuous depth back into another lookup is what
  // folded the distant pavilion into animated crystal/paper-ball geometry.
  const belowSceneSample = vec4(0)
  const belowSceneValid = float(0)
  const belowStructure = options.interfaceStructures
    ? sampleInterfaceStructure(
        options.interfaceStructures.active.mul(options.submerged).mul(insideWindow),
      )
    : { sample: vec4(0), path: float(0) }
  const belowStructureSample = belowStructure.sample
  const belowStructureValid = max(belowStructureSample.a, 0.0)

  const aboveRefracted = refract(incident, aboveNormal, AIR_IOR / WATER_IOR)
  const aboveRefractionEnabled = options.detailed
    ? isAbove
        .mul(step(vDistance, 160.0))
        .mul(step(0.03, float(1).sub(aboveFresnel)))
    : float(0)
  const aboveRefractionTrace = traceOpaqueSceneRay(
    aboveRefracted,
    -1,
    aboveRefractionEnabled,
  )
  const aboveRefractionSample = sampleTracedScene(aboveRefractionTrace)
  const aboveRefractionValid = max(aboveRefractionSample.a, 0.0)
  const aboveInterfaceAnchor = max(aboveRefractionSample.a.negate(), 0.0)
  const aboveStructure = options.interfaceStructures
    ? sampleInterfaceStructure(
        options.interfaceStructures.active.mul(aboveRefractionEnabled),
        true,
      )
    : { sample: vec4(0), path: float(0) }
  const aboveStructureSample = aboveStructure.sample
  const aboveStructureValid = max(aboveStructureSample.a, 0.0)

  const reflectedDirection = reflect(incident, aboveNormal)
  const aboveReflectionEnabled = options.detailed
    ? isAbove.mul(step(vDistance, 180.0)).mul(step(0.035, aboveFresnel))
    : float(0)
  const aboveReflectionTrace = traceOpaqueSceneRay(
    reflectedDirection,
    1,
    aboveReflectionEnabled,
  )
  const aboveReflectionSample = sampleTracedScene(aboveReflectionTrace)
  const aboveReflectionValid = max(aboveReflectionSample.a, 0.0)

  // ── Above-surface shading ──────────────────────────────────────────────

  const aboveHeight = vHeight.mul(keepCascade0Above)
  const heightMask = smoothstep(-1.7, 1.5, aboveHeight)
  const bodyBase = mix(DEEP, SHALLOW, heightMask)

  // Keep this original resolved-wave scatter for the underwater TIR body.
  // Above-water optics use the capillary-enriched normal below.
  const crestLight = normalize(sunDir.negate().add(normal.mul(0.4)))
  const crestScatter = pow(max(dot(viewDir, crestLight), 0.0), 4.5)
    .mul(1.0)
    .mul(smoothstep(-0.1, 1.1, vHeight))

  const noL = max(dot(aboveNormal, sunDir), 0.0)
  const fresnelF0 = float(((AIR_IOR - WATER_IOR) / (AIR_IOR + WATER_IOR)) ** 2)
  const aboveCrestLight = normalize(sunDir.negate().add(aboveNormal.mul(0.4)))
  const aboveCrestScatter = pow(max(dot(viewDir, aboveCrestLight), 0.0), 4.5)
    .mul(smoothstep(-0.1, 1.1, aboveHeight))
  const forwardScatter = pow(max(dot(viewDir, sunDir.negate()), 0.0), 4.0)
    .mul(smoothstep(-0.15, 0.9, aboveHeight))
    .mul(float(1).sub(aboveFresnel))
    .mul(0.32)
  const scatterLight = noL.mul(0.5).add(0.5)
  const surfaceScatter = SSS_TINT.mul(aboveCrestScatter.add(forwardScatter)).mul(
    scatterLight,
  )
  const body = bodyBase.add(surfaceScatter)

  // The analytic sky remains the guaranteed reflection source. A validated
  // surface-anchored framebuffer hit replaces it only for nearby opaque air
  // geometry, so pavilion/column reflections cost no mirrored world render.
  // discStrength 0: sunGlint below IS the disc's delta-light response.
  const skyReflection = skyRadiance(reflectedDirection, float(0))
  const reflectedRadiance = mix(
    skyReflection,
    aboveReflectionSample.rgb,
    aboveReflectionValid.clamp(0, 1),
  )

  // Air -> water transmission must be WORLD-anchored, never screen-anchored.
  // A traced sample only exists while its refracted source happens to sit
  // inside the current frustum, so radiance the trace alone contributes forms
  // a camera-frustum-shaped patch that swells under pure head tilt. The base
  // therefore reconstructs the true local bottom from the baked terrain field
  // and runs one shared Beer-Lambert transport; the trace merely substitutes
  // real imagery (piles, shadows, sand texture) at matched luminance where
  // valid, so its validity boundary carries no brightness step. The trace
  // itself fades out before its hard 160 m enable for the same reason.
  const traceRangeFade = float(1).sub(smoothstep(140.0, 160.0, vDistance))
  const aboveStructureContribution = aboveStructureValid.clamp(0, 1)
  const aboveTransmissionValidity = max(
    max(aboveRefractionValid, aboveInterfaceAnchor.mul(0.82)).mul(traceRangeFade),
    aboveStructureContribution,
  ).clamp(0, 1)
  const aboveTransmissionSource = mix(
    aboveRefractionSample.rgb,
    aboveStructureSample.rgb,
    aboveStructureContribution,
  )
  const aboveTransmissionPath = mix(
    aboveRefractionTrace.z,
    aboveStructure.path,
    aboveStructureContribution,
  )
  const seabedHeight = options.seabedHeight
  const transmittedRadiance: Node<'vec3'> = seabedHeight
    ? Fn(() => {
        const result = body.toVar()
        // `isAbove` comes from the 1x1 waterline texture and is constant
        // across the draw, so this branch is uniform: underwater frames pay
        // for none of the seabed transport they would immediately discard.
        If(isAbove.greaterThan(0.001), () => {
          // Landing point in two fixed-point steps. Air->water refraction is
          // never shallower than ~41 degrees below horizontal, so clamping the
          // descent to 0.3 bounds the step and two seabed fetches converge to
          // metre level — ample for a radiance gradient.
          const downSlope = aboveRefracted.y.min(-0.3)
          const firstPath = seabedHeight(vWorldXZ)
            .sub(vWorld.y)
            .div(downSlope)
            .clamp(0.5, 300.0)
          const landingXZ = vWorldXZ.add(aboveRefracted.xz.mul(firstPath))
          const analyticPath = seabedHeight(landingXZ)
            .sub(vWorld.y)
            .div(downSlope)
            .clamp(0.5, 320.0)

          // The traced sample replaces the analytic bottom rather than adding
          // to it, and both carry the same mean radiance, so crossing the
          // trace's validity boundary changes detail without changing level.
          const tracedShare = aboveTransmissionValidity
          const bottomColor = mix(
            vec3(...SEABED_MEAN_RADIANCE),
            aboveTransmissionSource,
            tracedShare,
          )
          const waterPath = mix(
            analyticPath,
            aboveTransmissionPath.clamp(0.05, 3500.0),
            tracedShare,
          )
          const aquaticTransmittance = exp(
            vec3(...AQUATIC_EXTINCTION).mul(waterPath).negate(),
          )
          // Both legs cross water. The opaque buffer lights the seabed as if
          // it stood in air, so restore the missing downwelling leg from the
          // source's vertical depth and the sun's elevation before the return
          // path attenuates it. An 18% unfiltered share stands in for
          // environment and emissive energy the buffer cannot separate.
          const sourceVerticalDepth = waterPath.mul(aboveRefracted.y.negate().max(0))
          const downwellingPath = sourceVerticalDepth.div(max(sunDir.y, 0.15))
          const downwellingTransmittance = exp(
            vec3(...AQUATIC_EXTINCTION).mul(downwellingPath).negate(),
          )
          const sourceLightingFilter = mix(vec3(1), downwellingTransmittance, 0.82)
          const transmittedMidpointY = vWorld.y.add(
            aboveRefracted.y.mul(waterPath.mul(0.5)),
          )
          const transmittedDepthDim = exp(transmittedMidpointY.min(0).mul(0.03))
          const transmittedUpness = smoothstep(-0.5, 0.75, aboveRefracted.y)
          const transmittedSunward = pow(
            max(dot(aboveRefracted, sunDir), 0.0),
            6.0,
          ).mul(0.06)
          // Crests keep a translucency lift, which the palette's DEEP->SHALLOW
          // mix used to supply, so the swell still reads through the transport.
          const aquaticInscatter = mix(
            vec3(...AQUATIC_AMBIENT_DOWN),
            vec3(...AQUATIC_AMBIENT_UP),
            transmittedUpness,
          )
            .mul(transmittedDepthDim)
            .mul(heightMask.mul(0.55).add(1))
            .add(sunColorUniform.mul(transmittedSunward))
          const foggedTransmission = bottomColor
            .mul(sourceLightingFilter)
            .mul(aquaticTransmittance)
            .add(aquaticInscatter.mul(float(1).sub(aquaticTransmittance.g)))
          // Two handoffs back to the palette body, both already owned by this
          // sheet: the footprint flatten (past it the surface is the far-field
          // mirror) and the same edge keep every other detailed-only term
          // uses, which is what makes this sheet meet the palette-only skirt
          // exactly at their seam from any camera height. The keep also stops
          // the transport well short of the lagoon saucer's shallow rim, which
          // would otherwise read as a pale ring at the horizon.
          const transportKeep = float(1).sub(distanceFade).mul(vEdgeKeep)
          result.assign(
            mix(
              body,
              foggedTransmission.add(surfaceScatter.mul(0.45)),
              transportKeep,
            ),
          )
        })
        return result
      })()
    : body

  const halfVector = normalize(sunDir.add(viewDir))
  const noH = max(dot(aboveNormal, halfVector), 0.0)
  const voH = max(dot(viewDir, halfVector), 0.0)
  // GGX replaces the old thresholded sparkle mask. The resolved FFT slopes
  // shape the sun lane; capillary slopes break it into near-field facets.
  const roughness = float(0.075)
  const alpha2 = roughness.mul(roughness)
  const distributionDenominator = noH.mul(noH).mul(alpha2.sub(1)).add(1)
  const distribution = alpha2.div(
    distributionDenominator.mul(distributionDenominator).mul(Math.PI),
  )
  const smithK = roughness.add(1).mul(roughness.add(1)).div(8)
  const geometryV = aboveNoV.div(aboveNoV.mul(float(1).sub(smithK)).add(smithK))
  const geometryL = noL.div(noL.mul(float(1).sub(smithK)).add(smithK).max(1e-4))
  const microFresnel = fresnelF0.add(
    float(1)
      .sub(fresnelF0)
      .mul(pow(float(1).sub(voH), 5.0)),
  )
  const directSpecular = distribution
    .mul(geometryV)
    .mul(geometryL)
    .mul(microFresnel)
    .mul(noL)
    .div(max(aboveNoV.mul(noL).mul(4), 0.02))
  const sunGlint = sunColorUniform.mul(directSpecular).mul(3.4)

  let above = mix(transmittedRadiance, reflectedRadiance, aboveFresnel).add(sunGlint)

  if (options.detailed) {
    // Jacobian foam: history-driven coverage × bubbly fbm detail, sun/sky lit.
    // Coverage only where the surface genuinely folded; fades with distance
    // so the fbm detail can never read as far-field shimmer.
    let coverage: Node<'float'> = float(1).sub(smoothstep(-0.05, 0.26, vFoam))
    let churn: Node<'float'> = float(0)
    if (options.wakeFoam) {
      // Vessel wake joins the SAME whitecap pipeline (coverage → lace →
      // foamShade): a property of this surface, never an overlay, so it
      // rides the displaced water exactly. Sampling by the undisplaced
      // vWorldXZ matches the Jacobian channel, so deposited foam sloshes
      // with the same horizontal chop as the ocean's own whitecaps.
      const wakeUv = vWorldXZ
        .sub(vec2(WAKE_FOAM_CENTER_X, WAKE_FOAM_CENTER_Z))
        .div(WAKE_FOAM_SIZE)
        .add(0.5)
      const wake = options.wakeFoam.foamNode.sample(wakeUv)
      // Residue behaves exactly like whitecap coverage — the shared lace
      // multiply opens holes in it as it decays. Fresh churn adds the
      // near-solid froth core right behind the hull.
      coverage = max(coverage, smoothstep(0.02, 0.6, wake.g))
      churn = smoothstep(0.1, 0.75, wake.r)
    }
    const bubbleA = fbm2(vWorldXZ.mul(0.9).add(vec2(0.13, 0.07).mul(timeUniform)))
    const bubbleB = fbm2(vWorldXZ.mul(1.7).sub(vec2(0.11, 0.05).mul(timeUniform)))
    const foamKeep = float(1).sub(smoothstep(0.25, 0.8, pixelFootprint))
    const foamMask = coverage
      .mul(bubbleA.mul(bubbleB).mul(1.7).add(0.06))
      .add(churn.mul(bubbleA.mul(0.45).add(0.62)))
      .mul(foamKeep)
      .clamp(0, 1)
    const foamAmbient = skyRadiance(aboveNormal, float(0)).mul(0.22)
    const foamShade = foamAmbient.add(
      sunColorUniform.mul(noL.mul(0.9).add(0.3)).mul(0.9),
    )
    above = mix(above, foamShade, foamMask)
  }

  // ── Below-surface shading: the Silver Ceiling ──────────────────────────
  const skyThrough = skyRadiance(belowRefracted, float(0)).mul(0.9)
  const windowGlint = pow(max(dot(belowRefracted, sunDir), 0.0), 700.0)
    .mul(24.0)
    .mul(sunColorUniform)

  // Only real geometry in air participates below the surface. The sky dome
  // remains on the analytic path so its sub-pixel HDR sun cannot become
  // framebuffer-sampling noise.
  const belowStructureContribution = belowStructureValid.clamp(0, 1)
  const aboveWaterStructure = max(
    belowSceneValid,
    belowStructureContribution,
  ).clamp(0, 1)
  const belowTransmissionSource = mix(
    belowSceneSample.rgb,
    belowStructureSample.rgb,
    belowStructureContribution,
  )
  const transmittedScene = mix(
    skyThrough.add(windowGlint),
    belowTransmissionSource,
    aboveWaterStructure,
  )

  // Exact unpolarised dielectric Fresnel for water -> air. Schlick alone
  // does not rise correctly into the critical angle, so it would let the
  // structure remain pasted over what should become total internal reflection.
  const interfaceTransmission = insideWindow.mul(float(1).sub(interfaceFresnel))

  // Outside the critical angle: total internal reflection. The mirror
  // reflects the UPWELLING water light — silvery teal near the medium's
  // horizontal ambient (medium.ts AMBIENT_* mix), not the deep body color.
  // A near-black ceiling here is what carved the bright "gap" band at the
  // surface silhouette against converged fog: the fogged underside must
  // start from a radiance close to what the fog converges to.
  const tirBody = vec3(0.035, 0.14, 0.19).add(SSS_TINT.mul(crestScatter).mul(0.5))

  const below = mix(tirBody, transmittedScene, interfaceTransmission)

  const debugMode = options.debugMode ?? 'final'
  let finalColor: Node<'vec3'> = mix(below, above, isAbove)
  if (debugMode === 'fresnel') {
    finalColor = vec3(mix(interfaceFresnel, aboveFresnel, isAbove))
  } else if (debugMode === 'reflection') {
    finalColor = mix(tirBody, reflectedRadiance, isAbove)
  } else if (debugMode === 'transmission') {
    finalColor = mix(transmittedScene, transmittedRadiance, isAbove)
  } else if (debugMode === 'interface') {
    const aboveInterface = aboveStructureSample.rgb.mul(aboveStructureContribution)
    const belowInterface = belowStructureSample.rgb.mul(belowStructureContribution)
    finalColor = mix(belowInterface, aboveInterface, isAbove)
  } else if (debugMode === 'validity') {
    const aboveValidity = vec3(
      aboveReflectionValid,
      aboveRefractionValid,
      aboveStructureContribution,
    )
    const belowValidity = vec3(
      belowSceneValid,
      belowStructureContribution,
      insideWindow,
    )
    finalColor = mix(belowValidity, aboveValidity, isAbove)
  }

  material.colorNode = vec4(finalColor, 1.0)
  return material
}
