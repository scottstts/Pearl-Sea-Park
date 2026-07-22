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
  capillary-enriched normal and a GGX/Smith direct-sun lobe; the below-surface
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
- **Above-water reflection and air→water transmission share one opaque color/depth snapshot — never a mirrored park render.** The ocean renders first in the transparent queue (while remaining alpha-opaque and depth-writing). `SeaSystem` creates one mip-generating `viewportMipTexture()` and one `viewportDepthTexture()` node shared by both sheets and every custom sample. Reflected/refracted scene color uses explicit source-UV-derivative LOD while depth remains sharp for geometric rejection. On the detailed sheet, above-water reflected geometry is traced only within 180 m and when exact Fresnel contributes at least 3.5%; air→water scene transmission is traced only within 160 m and while its energy exceeds 3%. Static architecture and moving opaque geometry use the same path, so a surfaced submarine's hull/brass participates automatically in the same-frame reflection with no vehicle-specific render. Invalid, offscreen, background, and misaligned samples fall back to shared `skyRadiance` or the water body. Underwater water→air scene geometry deliberately does **not** use this current-view depth reconstruction: its source is commonly offscreen, and feeding discontinuous depth back into a second UV folded the pavilion into animated crystal clusters. The Snell sky remains analytic and selected scene-scale subjects use the bounded forward layer below.
- **Every reflected/refracted scene ray starts at the displaced interface.** A first depth sample estimates subject distance, then the ray is reprojected from the actual water hit for the final depth/color sample; omitting that origin makes structures drift away from their water-entry points. Reconstructed depth is accepted only when it lies along the 3D ray, within the 3200 m geometry envelope, and on the requested side of the local FFT normal. A well-aligned opposite-side hit may anchor only the first 1.25 m across the interface, fading to zero: this is the bounded continuity condition for one depth layer when a single pile spans both media, not permission for foreground leakage. The Snell path retains exact water→air Fresnel/TIR; its transmission-domain test is derivative-filtered over about one output pixel so an animated normal cannot toggle a whole pixel at the critical angle. Its transmission normal also reapplies the FFT cascade keeps using `pixelFootprint × SnellAngularStretch²`: angular expansion diverges at the critical angle, so spatially resolved slope bands can still become unresolved in the transmitted image. This filtering affects only transmission; the visible silver-ceiling reflection keeps the ordinary fold-aware normal. Air→water uses the reciprocal eta and applies the same Beer–Lambert/inscatter constants as `medium.ts` over the reconstructed surface-to-subject path. The optical side remains one camera-level state from the displaced waterline—never `faceDirection`.
- **Screen-space limits are explicit.** Opaque, on-screen, depth-visible structures can participate; transparent effects render later and offscreen/occluded geometry cannot. Those cases use analytic sky/body radiance. Do not “fix” them with a full planar reflection: the earlier nested reflector proved that reduced target resolution does not reduce whole-park vertex, draw, or shadow submission cost.
- **The forward-refracted layer has two explicit scales, not one generic screen-space search.** `InterfaceStructureLayer` owns one shared half-CSS-resolution RGBA16F/depth target (1024 px maximum edge). The Descent Bell's small external brass cage remains the live-interface case: opposite-medium vertices sample the FFT height/normal, refine the crossing, solve the tangent-interface Fermat path, and run only within 90 m. The Arrival pavilion is the demonstrated scene-scale/offscreen exception. Its opaque air-side geometry is clipped below root-local y=-0.1 m, tessellated to a 1.2 m maximum source edge, and projected through the stable mean interface. Using the mean plane is intentional: evaluating a different wave normal at every distant source vertex created physically unresolved folds and temporal scrambling at the Snell singularity. The visible ocean still owns live wave silhouette, exact Fresnel/TIR, and the Snell-window mask. The pavilion target is underwater-only, fades over the last 15% of its 240 m range, and costs nine shadowless material draws / roughly 71k triangles in the current assembly. Source-edge tessellation is mandatory; restoring the pavilion's original long deck/pile triangles recreates crystal facets. The ocean samples this already-refracted target directly, so no depth value can steer a second lookup. The rejected 8–32-step epipolar search and the rejected general underwater two-depth reconstruction must not return.
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
- **Water optical diagnostics**: `?pass=water-fresnel` shows exact interface reflectance; `water-reflection` shows the reflected radiance after geometry/sky fallback; `water-transmission` shows the transmitted radiance; `water-interface` isolates all forward-refracted interface proxies; `water-validity` encodes above-water reflection / refraction / interface-proxy validity as R/G/B, and underwater general above-geometry / interface-proxy / Snell-window membership as R/G/B. Under `?debug`, `canvas.dataset.waterInterfaceLayer` reports active state, draw/vertex/triangle counts, and target dimensions once per 60 frames. Pair with fixed `?view=ceiling`, `?view=snell`, `?view=ocean-seam`, `?view=arrival-snell-rim`, and a fixed `?time=`. `arrival-snell-rim` deliberately places the distant pavilion at the water-to-air singularity and is the guard against returning crystal/shard geometry.
- **Waterline authority** (`sea/waterlineProbe.ts`): after the final camera pose, a 1-thread compute samples the same three displacement cascades at camera XZ (2 fixed-point rounds against choppy horizontal offset). It writes a 1×1 sampled state texture for the same frame's ocean/medium render and separately starts an async storage-buffer height copy for CPU events. `SeaSystem.surfaceHeightAtCamera` is therefore intentionally latent and must never gate visual underwater effects; nothing may compare camera y against 0 as a substitute for the displaced surface.
- Camera: near 0.1, far 5000 (dome 3400, skirt 9000 wide) — don't shrink far below the dome radius; the "black sky" failure mode is far-plane culling.
