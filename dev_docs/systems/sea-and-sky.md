# Sea & sky (S2)

One wave field, every consumer: `sea/waveSim.ts` produces per-cascade displacement + derivative maps that drive the surface (both sides), and later the caustics projector and god-ray flicker (S3). One sky function (`sky/skyRadiance.ts`) feeds the dome, the ocean reflection, and the Snell-window refraction — they can never disagree.

Architecture (spectral-ocean skill, WebGPU/TSL production tier):

- 3 cascades, 256², patches [250, 17, 5] m, boundary factor 6; JONSWAP × TMA × directional spread spectrum built CPU-side per cascade from `rng.fork('ocean-cascade-N')` (deterministic; Gaussian pairs consumed even out-of-band to keep bins seed-stable).
- **Amplitude is 0.35** (Scott's ruling, 2026-07-10): ~0.5 m crests, a living glassy swell. The original 0.9 read as a storm — it dunked sightlines at the arrival platform and made the descent crossing chaotic. Don't raise it without asking.
- Packed IFFT: one texture carries two complex fields (.xy height, .zw
  horizontal Dx+iDz). Each 256-point row/column transform lives in one
  workgroup array with explicit barriers between all radix-2 stages. Horizontal
  and vertical axes remain separate storage-visibility submissions, batched
  across cascades. The transform therefore uses two FFT submissions rather
  than sixteen while preserving the exact centered field and hard-gate tests.
- Assembly kernel applies the (−1)^(x+y) centering sign (per-texel AND per-neighbor when finite-differencing), builds fold-aware derivatives, Jacobian, and persistent foam history (`min(J, prev + dt·rate/max(J,0.5))`, clamped ≤ 2).
- The above-water material adds two weak procedural capillary slope bands below
  the finest FFT wavelength. Both bands fade by pixel footprint before they
  alias, and only perturb the resolved fold-aware normal; swell direction and
  displacement remain owned by the FFT. Both optical sides use exact
  unpolarised dielectric Fresnel at air IOR 1 / water IOR 1.333; the former
  above-water Schlick fit over-reflected by up to ~6 percentage points at the
  important 80–85° grazing range. Above-water reflection uses the full
  capillary-enriched normal (it also shapes the mirror's wave offset) and a
  GGX/Smith direct-sun lobe; the below-surface
  Snell/TIR path deliberately keeps the original resolved FFT normal and
  scatter response. Foam receives both shared-sky ambient and direct sun.
- **Vessel wake foam is a second coverage source in the SAME whitecap path**
  (`sea/wakeFoamMap.ts`, 2026-07-15): a world-anchored 1024² half-float
  ping-pong field over the 820 m square around the submarine force field
  (centre (0, 10)); R = fresh churn (τ 2.4 s), G = lacy residue (τ 8.5 s +
  neighbour diffusion + linear bleed to exact zero). Vehicles `splat()` up to
  8 gaussians/frame (uniformArray, ChannelSim impulse pattern); deposits
  combine by **max(), never add**, so re-crossing a trail refreshes instead
  of erasing it. The detailed sheet samples it at the undisplaced `vWorldXZ`
  (same convention as the Jacobian channel — the cascades tile, so a
  world-space trail can never live inside them) and merges it as
  `max(jacobianCoverage, residueCurve)` plus a fresh-churn density boost
  before the shared lace fbm, footprint keep, and foam shading. Because it is
  a surface property, wake foam rides displacement exactly and cannot float
  or sink. The compute pass self-gates: it dispatches only within ~35 s of a
  splat, so an unused sea costs one boot clear and nothing per frame.
- **Above-water foam is its own module** (`sea/oceanFoam.ts`, 2026-07-24): four
  coverage populations, one shading path, applied as the single
  `mix(above, color, mask)` the whitecap term always was. The Jacobian
  whitecap and the wake field answer *where the surface just folded*; the three
  additions answer *what that folding left behind*, which is the part a purely
  instantaneous foam model cannot have. **Windrows** are the load-bearing one:
  Langmuir convergence lines, ~12.5 m across-wind × ~95 m along-wind, built in
  the sim's own wind frame (`sim.sea.windAzimuth`, same `atan2(kz, kx)`
  convention as the spectrum, so streaks cut across the crest lines), drifting
  downwind at 3% of wind speed. They are modelled statistically, not simulated:
  windrows are the *steady state* of a sustained 8.5 m/s wind, so a slowly
  drifting anisotropic field is the honest representation of one rather than a
  stand-in — and the cascades could not hold them anyway, because the FFT
  patches tile (the same finding that produced `wakeFoamMap.ts`). A **raft
  tail** reads the fold history's recovery band [0.26, 0.66] as thinning foam
  instead of bare water, and **crest tear** puts a whisper of froth on the
  tallest crests inside a gust patch, where breaking begins before the
  horizontal Jacobian folds. All three combine by `max()`, never add — the same
  rule the wake deposits use.
- **Foam LOD conserves coverage; only the whitecap lace retires to zero.** Every
  new band fades to its OWN MEAN as the pixel footprint grows (`mix(0.5, band,
  keep)`, zero-mean detail octaves, `mix(0.46, lace, keep)`), because foam is an
  albedo term: a band that fades to zero makes a distant patch of sea brighten
  or darken with camera height. Windrows therefore survive far past the ~1 m
  bubble lace — their own structure is 12 m wide, so their keep is authored
  against *that* scale (3–7 m/pixel) instead of copied from the lace's 0.25–0.8.
  Past the coarse keep the band field IS its mean, which sits below the
  convergence-line threshold, so the population retires to exactly zero on its
  own; a second distance fade would double-count the handoff. Thin coverage
  multiplies by `edgeKeep` (it changes the body color, and the skirt has no
  foam); the dense whitecap keeps its original footprint-only keep, which
  already kills it long before the seam.
- **Foam shading is thickness-graded, and the grade is a SHARE.**
  `mix(thinShade, denseShade, denseMask / (denseMask + thinMask))` — dividing by
  the total is what guarantees a pixel with no raft on it shades exactly as it
  did before the module existed; grading on absolute `denseMask` instead would
  have quietly dimmed every partial-coverage whitecap. Thin rafts are
  translucent (the water beneath shows through, opacity rising with the raft's
  own density) and forward-scatter sunlight toward a viewer facing the sun;
  only dense froth reads as the near-white sheet. Bubble microrelief perturbs
  the normal the foam is lit by, and its keep drives that perturbation to zero
  by ~0.2 m/pixel — at which point the shading is bit-identical to the old
  smooth-normal result, so distant whitecaps are untouched and near ones gain
  relief. `sea/oceanFoam.ts` collects the coverage art-direction knobs in one
  block; the geometry and physics constants above them are not tuning dials.
- Cascade 0 has a separate conservative above-water footprint keep (2.5–5.5 m
  per pixel). Apply it to the derivative field *before* the fold denominator
  and use the same interval for cascade-0 vertex displacement and
  height-driven color/scatter. A post-reconstruction normal flatten cannot
  remove texture aliasing, while leaving vertex displacement alive to the old
  6–18 m/pixel interval collapses displaced triangle rows into a second comb
  near the square inner-mesh fade. The stricter shared geometry LOD removes
  that residual; it must not replace or modify the underwater optical normal.
- **FFT hard gate**: `runFftSelfTest` runs under `?debug` — impulse → constant and one-bin → cos/sin, errors ~1e-8. Readback goes through a **storage buffer** (`getArrayBufferAsync`), never a material blit.

Hard-won lessons (do not re-learn these):

- **GTAO dithers on distant or footprint-underresolved grazing geometry.** AO is
  contact-scale: the pipeline fades it to neutral beyond 60–160 m and whenever
  one half-resolution gather texel approaches its 0.25 m world radius
  (`pipeline.ts`). Distance alone is insufficient for a high camera looking
  across the seabed. Any "mysterious dither band" — check `?pass=ao` and
  `?pass=ao-footprint` first, before touching materials. This cost hours.
- **Ocean never receives screen-space AO.** The water material is reflective/
  transmissive optics rather than indirect diffuse and writes 0 into the
  normal MRT's AO-receiver alpha. This is separate from GTAO's bilateral
  reconstruction for opaque architecture; do not restore cavity multiplication
  on water to fake contact. Interface depth, Fresnel, foam, reflection, and
  refraction already own its readable structure.
- **Material-blit readbacks lie**: renderer tone mapping (AgX) clamps negatives to 0 in any quad-blit path. GPU→CPU verification must use storage-buffer readback.
- **Spectral LOD is by PIXEL FOOTPRINT, not distance** (2026-07-10): the cascade maps have no mips, and at grazing incidence the vertical footprint on the surface is distance²·pixelAngle/heightGap — a 4.4 m deck eye is under-sampled at 200 m (comb/moiré band at the horizon) while a diver sees the same span steeply and keeps detail. Fragment derivative keeps, the normal flatten, glints, foam, AND all three vertex displacement keeps fade on the footprint vs each band's shortest wavelength (~41 / 2.8 / 0.83 m; the vertex stage computes it against the y = 0 base plane, so the gap is just camera height). Cascade-0 geometry must fade too: flat normals alone leave vHeight-driven body-color stripes and silhouette teeth as a residual comb. Distance-only fades can never serve deck and diver simultaneously — don't regress this. MSAA cannot fix shader aliasing on sub-pixel waves.
- The far skirt is a FLAT exact square ring (`oceanSkirtGeometry.ts`); the inner
  700 m mesh fades ALL displacement to zero over its final 15 m. The skirt
  starts at ±335 m on the SAME y=0 plane, underlaying only that mathematically
  flat border; it renders first, so MSAA samples along the detailed edge always
  resolve to ocean instead of the bright backdrop. Do not restore the former
  0.14 m vertical sink: from underwater that made the overlap an open step,
  which grazing views rasterized as a dotted/white line while a camera rose or
  descended. Also do not rebuild the hole by deleting triangles from a coarse
  plane: the old 133.3 m grid left boundary triangles 81.3 m inside the
  requested hole, where live inner-wave troughs crossed the skirt and produced
  animated barcode/contour bands. The inner and skirt follow the camera
  together on the inner vertex grid. `?view=ocean-seam` is the fixed underwater
  regression view; `audit:geometry` proves the 15 m flat apron, zero height
  error, and upward triangles for the 256/384/448 segment tiers.
- **The TIR underside (`tirBody`) must be BRIGHT silvery teal** (≈ the medium's horizontal ambient, currently (0.035, 0.14, 0.19)), because a total-internal-reflection mirror reflects the upwelling water light. The original `DEEP·0.55` near-black ceiling carved a bright "gap" band at the surface silhouette against converged fog — the fogged underside must start from a radiance close to what the fog converges to. Keep this and medium.ts AMBIENT_* in the same family if either is retuned.
- **NO above-water optical source may be a screen-space trace.** This is the hard rule the 2026-07-24 rewrite exists to enforce, and it is a physical-plausibility rule, not a quality one: from a fixed standing position, turning the head must not change what the water is made of. Both former traces projected a ray *direction* and required its vanishing point to be inside the frustum, which is a pure function of camera pitch and nothing else. Air→water bends every ray to within 48.6° of straight down, so at the 55° FOV nothing transmitted anywhere until the camera pitched about 14° down, and the valid band then swept inward (150 m at −14°, 30 m at −15°, 10 m at −19°, 5 m at −28°) — clipped at both ends by the view cone, which is why the artifact read as an expanding *band* of real seabed with a dappled edge inside flat tint. Reflection failed in mirror image: reflected rays leave upward at `atan(h/d)` above horizontal, so pitching down past ~20° switched every reflection off. Both are now world-anchored. **Forward projection (source → apparent screen position) is frustum-safe; backward tracing (water pixel → source screen position) never can be** — if a forward-projected image lands offscreen, so does the water pixel that needed it. `viewportMipTexture()`/`viewportDepthTexture()` are gone from the ocean entirely, which also removes a full-frame HDR copy plus mip chain from every frame.
- **The Snell path is unchanged and remains analytic.** Exact water→air Fresnel/TIR with a transmission-domain test derivative-filtered over about one output pixel, so an animated normal cannot toggle a whole pixel at the critical angle. **Both sides of the interface use the one resolved fold-aware normal** — see the Snell-rim entry below for the second, footprint-inflated transmission normal that was tried and removed. Air→water uses the reciprocal eta and applies the same Beer–Lambert/inscatter constants as `medium.ts`. The optical side remains one camera-level state from the displaced waterline — never `faceDirection`.
- **Never filter the INTERFACE to stabilize what is transported through it — the Snell window's rim is the interface's own silhouette.** A second below-surface normal whose cascade keeps ran on `pixelFootprint × SnellAngularStretch²` was tried and removed. `S = eta·cosθᵢ/cosθₜ` diverges at the critical angle, so that product reached 3–45 at the rim against keep thresholds authored in metres/pixel: past ~10 m of camera depth every cascade zeroed and the window was masked, Fresnel-weighted, and refracted off a mathematically flat plane. The result is a clean analytic conic where the sea should be showing a live, dappled, wave-shaped rim (compare the pre-`df26bd6` captures). Three separable concerns hide in there: **where the rim lies** is coverage, already solved by the derivative-filtered critical-angle mask; **what the window shows** is a source-lookup question, and both remaining sources are safe (the analytic sky is smooth, the forward-projected proxy is rasterized at its own refracted position); **the transmitted sun** is the only true delta light, so its lobe — not the geometry — is broadened. For a fixed view ray a normal tilting by δ moves the transmitted direction by `|1 − S|·δ`, so `windowGlint` convolves `cos^700` (variance 1/700) with the measured per-pixel spread `|1 − S|·|∂n/∂pixel|/2` and rescales its peak by the surviving exponent, conserving lobe energy: resolved water keeps the hard sparkle, the rim hands it to a broad sheen rather than crawling. Note also that the water→air solid-angle Jacobian is `eta²·cosθᵢ/cosθₜ = S·eta`, not `S²`, and that the stretch is anisotropic (meridional `S`, sagittal `eta`) — any future stretch-aware filter must be scaled and shaped accordingly, and must apply to a lookup, never to the normal.
- **Air→water transmission deliberately contains no captured submerged park.** The former 2048² RGBA16F radiance field, 2048² canopy-height field, four scene tiles, canopy render, mip pyramid, and capture-camera shadow invalidations were removed on 2026-07-25. `sea/seabedRadiance.ts` now supplies only a 512² R16F terrain-height field plus one spatially uniform `SEABED_MEAN_RADIANCE`; it contains no mesh, flora, material, shadow, or scene-color information. The detailed sheet settles the refracted landing point with two bathymetry samples, then preserves the established downwelling leg, Beer–Lambert return attenuation, in-scatter, footprint/edge handoff, and surface-shadow coupling. This keeps water depth coloration coherent while making the submerged park impossible to see from above.
- **The sand ripple remains analytic and contains no park imagery.** `world/seabedSurface.ts` is sampled at the settled bathymetric landing point, weights only `SEABED_DIRECT_SHARE`, and fades each band to zero by its own pixel footprint. The caustic web is not sampled on the ocean surface; its mean contribution is already included in `SEABED_MEAN_RADIANCE`.
- **Waterline-crossing geometry remains explicitly separate.** The Descent Bell's small registered frame may still bridge the interface through `InterfaceStructureLayer`; that local continuity path is not a static park capture. The Arrival pavilion registration remains `underwaterOnly`, so its forward-refracted image is preserved only for the camera-below-water Snell window.
- **The cast shadow landing on the water remains unchanged** (`sea/surfaceSunShadow.ts`). It is co-located with the surface, so nothing has to place it at depth. A fixed sun plus fixed above-water structures makes the shadow footprint on y = 0 a fixed function of world XZ, so it bakes: one override material shears every vertex down its own sun ray onto the plane before projecting, top-down, additively, with sub-waterline fragments writing zero. The mask is 2048² over ±400 m centred at z = 160 (0.39 m/texel), which holds both the Descent Station and the Great Wheel's crest; clamp-to-edge returns unlit outside, which is correct because nothing out there is above water. The ocean walks each displaced surface point up its own sun ray to y = 0 before sampling, so crests read the mask where their light actually comes from. It multiplies the sun's DIRECT terms only — `sunGlint`, the crest/forward subsurface scatter, the sun-driven in-scatter, and foam's direct share. The sky reflection is untouched, because the sky is not what got blocked, and the mirrored render already carries the occluder's own reflected image.
- **Surface-shadow submission prunes only mathematical zeroes.** Before the override render, a plain non-instanced/non-skinned/non-morphed mesh whose transformed base-geometry bounds lie wholly below `ABOVE_WATER_EPSILON` is hidden: every one of its fragments previously evaluated the override's `step` to exact zero. Runtime-transformed geometry stays conservative. This changes neither caster membership nor the 2048² mask; the timing dataset reports how many submerged meshes were removed.
- **Do not try to feed the cached shadow clipmap node into the ocean material.** It was tried: `MeshBasicNodeMaterial` has no lighting model and no `receivedShadowNode` hook, and consuming `CachedShadowClipmapNode` directly fails to build the fragment pipeline, which blacks out the whole frame. Live shadows on the water would need the ocean to become a lit material — a much larger change than this is worth. The cost of the bake is that only STATIC above-water casters shadow the sea; a surfaced submarine or the riding Bell will not.
- **The caustic web remains underwater-only.** You cannot see a caustic web through the surface that made it: the same slope field that focuses the light displaces the bottom image, and the two decorrelate with depth and incidence. The capture-free surface path carries only the mean lift baked into its uniform sand radiance; underwater, where the interface is not in the path, `applyCaustics` keeps the full live web.
- **Two handoffs return the transmitted body to the palette:** the footprint flatten (past it the sheet is the far-field mirror) and `edgeKeep`. The edge keep is what makes the detailed sheet meet the palette-only skirt exactly at their seam **from any camera height** — a purely distance-keyed handoff matches at deck height and leaves a bright ring for an elevated camera. It also stops the transport ~335 m from the camera, well short of the lagoon saucer's −3.6 m rim, which would otherwise transport as a pale ring at the horizon.
- **Above-water reflection is a BOUNDED planar mirror** (`sea/oceanReflection.ts`): a camera mirrored across y = 0 with Lengyel's oblique near plane at the waterline, rendering only `WATER_REFLECTION_LAYER` into a half-resolution RGBA16F (1440 px max edge). This does not contradict the old "never a mirrored park render" ruling — that ruling was about a *nested whole-scene reflector*, whose cost is whole-park vertex, draw, and shadow submission that no target resolution reduces. The layer is the difference: only things that can actually break the surface are marked (Arrival pavilion, Descent Bell, submarine, Great Wheel), so the mirrored pass submits a handful of objects. Marking is additive and MUST follow `markDynamicShadowCasters`, whose exclusive `set` would otherwise clear it. The oblique plane is what keeps the submerged park from appearing as a floating city in the reflection.
- **A flat mirror is sampled at the water pixel's own screen position**, x-flipped (one reflection flips handedness) — because a mirrored camera rendering the real world IS the main camera rendering the mirrored world. Waves only rotate the reflected ray, so their entire contribution is the DIFFERENCE between the flat and wave-tilted vanishing points, bounded to a twentieth of the screen (the offset is exact for the ray but assumes the flat-mirror source distance, so it over-travels for near sources). That difference is the only legitimate use of a direction projection in this material: **never turn it back into a validity test**, which is precisely what the deleted trace did with the same arithmetic. Coverage comes from the target's own alpha, and uncovered pixels fall back to analytic `skyRadiance` at `discStrength 0` — the dome is deliberately NOT in the mirror, so its HDR sun disc cannot be double-counted against the surface's own GGX glint.
- **The forward-refracted layer has two explicit scales, not one generic screen-space search.** `InterfaceStructureLayer` owns one shared half-CSS-resolution RGBA16F/depth target (1024 px maximum edge). The Descent Bell's small external brass cage remains the live-interface case: opposite-medium vertices sample the FFT height/normal, refine the crossing, solve the tangent-interface Fermat path, and run only within 90 m. The Arrival pavilion is the demonstrated scene-scale/offscreen exception. Its opaque air-side geometry is clipped below root-local y=-0.1 m, tessellated to a 1.2 m maximum source edge, and projected through the stable mean interface. Using the mean plane is intentional: evaluating a different wave normal at every distant source vertex created physically unresolved folds and temporal scrambling at the Snell singularity. **The stable image is not frozen, and the motion is angular, not positional.** A tilted interface moves the apparent direction of a fixed source by `δ·(1 − 1/S)`, where δ is the interface tilt and `S = dθ_transmitted/dθ_incident` is the same Snell angular stretch the ocean computes. That factor stays below one at every incidence — at the critical angle S diverges and the factor merely saturates — so the image can never travel further than the surface actually leans, which is the bound the rejected per-vertex Fermat solve lacked. The mean-plane path solve is untouched; only its resulting direction is rotated, and an angular shift is independent of source distance. Two things keep it from folding: the tilt is a **central difference of the same heightfield over one source edge** (a point sample of the derivative map carries bands shorter than the tessellation — cascade 0 alone reaches ~2.8 m against 1.2 m edges — which arrive as per-vertex jitter, not motion), and the shift is capped at half a source edge's apparent angular size, so two projected neighbours cannot cross. That cap scales as 1/(distance × stretch), which is the correct shape: the fold risk grows with both. Near the structure the motion is fully physical (~13 px of sway at 30 m); it tapers with distance and goes quiet at the window rim, where the stable projection is the only representable image anyway. The visible ocean still owns live wave silhouette, exact Fresnel/TIR, and the Snell-window mask. The pavilion target is underwater-only, fades over the last 15% of its 130 m range, and costs nine shadowless material draws / roughly 71k triangles in the current assembly. Source-edge tessellation is mandatory; restoring the pavilion's original long deck/pile triangles recreates crystal facets. The ocean samples this already-refracted target directly, so no depth value can steer a second lookup. The rejected 8–32-step epipolar search and the rejected general underwater two-depth reconstruction must not return.
- **The crossing solve is only as good as its BRACKET, and bracketing by the camera-to-source span makes it worse exactly where it matters.** `solveTangentInterface` bisects the Snell residual along the interface tangent. Bisecting `[0, tangentLength]` leaves an absolute error of `L/2ⁿ⁺¹` — proportional to horizontal separation — while the refracted image of that source shrinks as `1/L`, so the solve goes coarser than the thing it is resolving. Two artifacts follow, and both were visible on the pavilion past ~100 m: the returned crossing is a **staircase whose grid is anchored to each vertex's own L**, so neighbouring vertices land on incommensurate grids and the image is chopped into bands; and **within** a step the returned `m = (2k+1)·L/2ⁿ⁺¹` has `dm/dL ≈ (2k+1)/2ⁿ⁺¹`, hundreds of times the true slope (which correctly saturates toward zero at distance), so each band is smeared vertically. Measured against the exact root at the `arrival-snell-rim` pose (14 m down, pavilion 130 m away, 1 px ≈ 1 mrad): the six-step full-span solve returned the **same crossing point for the waterline and the 6.5 m roof**, so the image's true 1.83 px height collapsed to 0.00 px, while sweeping L across the pavilion's own 13 m footprint drifted the apparent elevation 3.8 px per metre and stepped 58 px at a band boundary — against a true variation of 0.16 px. The vertical structure was therefore being drawn entirely by depth-into-the-scene, which is why it read as vertical smears that reshuffled while walking, and no amount of extra steps fixes the *shape* of that error. The bracket does: **only the water-side ray is bounded, and it is bounded by the critical angle** — a ray in water that connects to a source in air is inside Snell's cone by construction, so its crossing point can never lie further than `tan θ_c ≈ 1.1346` times its own distance from the interface. Submerged, that bound belongs to the CAMERA, so the interval is `~1.13 × depth`, identical for every vertex and independent of distance; above water the same bound applies to the source's depth instead (`low = L − 1.1346·sourceDepth`). Both are exact, so the root is never bracketed out. Fourteen halvings then land the crossing within a ten-thousandth of the interval — at that same pose, within 0.014 px of the exact root everywhere, restoring the 1.82 px height. Cost is per proxy vertex, not per ocean pixel (213k vertices / 71k triangles for the pavilion, and only while submerged inside 240 m).
- **What a correct distant refraction actually looks like, so it is not "fixed" again.** Refraction compresses the incidence angle only; azimuth passes through untouched. From 14 m down at 150 m separation, a 6.5 m pavilion spans `θ_w ∈ [48.51°, 48.61°]` — 1.6 mrad, roughly **two pixels tall** — against ~100 px of unchanged azimuthal width. A thin bright horizontal streak hard against the Snell rim IS the physically right answer at that range, and it stays bright because only the short leg is in water: camera → crossing is about `1.5 × depth`, while the 150 m leg is in air and unattenuated. Anything appreciably taller than a few pixels out there is a solver artifact, not perspective. Measured on the real proxy vertices at 1600×900 / 55° vFOV, from 14 m down: **135 px tall at 25 m, 46 at 40, 16 at 60, 6 at 90, 2.6 at 130** — roughly `1/L^2.4`, because the compression factor itself grows with distance. So the pavilion is a picture out to ~40 m, a readable band to ~60 m, and unresolvable past ~90 m, which is where `maxCameraDistance` now retires it (130 m, fading from ~110). Drawing it beyond that is worse than not: 71k triangles land in a few dozen texels of the half-resolution target, every texel picks whichever one wins the depth test, and the band scintillates — clean sky reads better than a scintillating nothing. **The tall lattice a player still sees out there is NOT this layer** — it is the pavilion's six bronze piles and their bracing girdle (`world/arrival.ts`), ordinary geometry seen directly through the water, about 86 × 173 px at 130 m and roughly 30° below the refracted image. Confirmed by forcing the layer off and re-shooting the identical frame. Seeing the pavilion at all from half a park away is correct in principle — the whole above-water hemisphere folds into the 97.2° cone, so distant things do not leave the window, they pile up at its edge — it is just that what piles up there is below one pixel. The one physical effect that would spread it, wave lensing at the rim, smears it into a broken incoherent shimmer rather than a legible structure, and a forward-projected mesh cannot represent that at all: it is single-valued, and the shimmer needs one source appearing in several places at once.
- `texture(...).sample(uv)` re-samples a texture node at a custom UV; `textureNode.value = tex` repoints after ping-pong swaps. `.sample()` inside a compute shader compiles to `textureSampleLevel(…, 0)` automatically — the waterline probe relies on this.
- Sun is FIXED (elevation 42°, azimuth 215°) in `sky/sun.ts` — everything shares its uniforms. PMREM environment baked once at init (sky never changes).
- The shared sky radiance includes a faint lavender marine-aerosol layer with
  broad asymmetric C1 shoulders: 16% at the mathematical horizon, softly
  fading to zero around 10° below it and 17° above it. The low peak and wide
  zero-slope fades prevent either endpoint from reading as a belt, while the
  shorter lower shoulder covers the strip a finite ocean plane can expose
  from elevated cameras. Keep this response bounded and free of division:
  `skyRadiance` also feeds the ocean reflection path, where a non-finite value
  can black out the entire surface. This is a sky-radiance handoff, not
  underwater fog; the depth-aware atmospheric composite remains gated by the
  displaced waterline. The haze wraps all 360° and stays consistent in the
  dome, ocean reflection, and above-water sky seen through Snell's window.
- `sky/marineAerialPerspective.ts` extends that same tint onto real distant
  surfaces in the HDR pipeline. It begins at 150 m, uses one exponential with
  0.0005 m⁻¹ extinction, and caps at 78%: the near field remains crisp,
  mid-distance silhouettes pick up visible mist, and the far ocean converges
  toward the horizon without losing all surface signal. The raw depth
  background sentinel excludes sky pixels, and the
  same-frame displaced-waterline state makes the term an underwater no-op.
  This path adds no draw, auxiliary target, or march; it reads the existing
  scene depth once. `?pass=haze` shows its mask.
- The above-water ocean material has no separate terminal fog-color override.
  Its former fixed gray `MIST` blend made the deliberately flat far skirt read
  as a pale shelf and double-counted distance extinction once the shared
  aerial-perspective pass existed. Both the detailed sheet and skirt now keep
  their common sky-reflection handoff; the depth-aware HDR pass is the sole
  owner of atmospheric convergence. Do not fix the shelf by restoring distant
  displacement: the flat skirt remains required for alias-free grazing views.
- **The sun disc is physical**: 0.53° angular diameter, Neckel–Labs limb darkening, HDR core ~1500× with a three-lobe circumsolar aureole; bloom makes the glare. `skyRadiance(dir, discStrength)` — the ocean passes `discStrength 0` because its analytic `sunGlint`/`windowGlint` terms ARE the delta-light specular response; re-reflecting the HDR disc through bumpy normals double-counts it as sparkling white pixels. Never re-add a wide flat smoothstep disc.
- **Water optical diagnostics**: `?pass=water-fresnel` shows exact interface reflectance; `water-reflection` shows the reflected radiance after geometry/sky fallback; `water-transmission` shows the transmitted radiance; `water-interface` isolates all forward-refracted interface proxies; `water-validity` encodes, above water, mirror-pass active / undersea-field present / interface-proxy coverage as R/G/B — **R and G must be FLAT under pure camera rotation from a fixed viewpoint, and that is the regression test for this whole pass**; underwater it stays general above-geometry / interface-proxy / Snell-window membership as R/G/B; `water-foam` shows the four foam coverage populations before lace and shading (R dense whitecap + wake, G windrow raft, B crest tear) and is black underwater and on the skirt, both of which carry no foam term. Under `?debug`, `canvas.dataset.waterInterfaceLayer` reports active state, draw/vertex/triangle counts, and target dimensions once per 60 frames. Pair with fixed `?view=ceiling`, `?view=snell`, `?view=ocean-seam`, `?view=arrival-snell-rim`, and a fixed `?time=`. `arrival-snell-rim` deliberately places the distant pavilion at the water-to-air singularity and is the guard against returning crystal/shard geometry.
- **Waterline authority** (`sea/waterlineProbe.ts`): after the final camera pose, a 1-thread compute samples the same three displacement cascades at camera XZ (2 fixed-point rounds against choppy horizontal offset). It writes a 1×1 sampled state texture for the same frame's ocean/medium render and separately starts an async storage-buffer height copy for CPU events. `SeaSystem.surfaceHeightAtCamera` is therefore intentionally latent and must never gate visual underwater effects; nothing may compare camera y against 0 as a substitute for the displaced surface.
- Camera: near 0.1, far 5000 (dome 3400, skirt 9000 wide) — don't shrink far below the dome radius; the "black sky" failure mode is far-plane culling.
