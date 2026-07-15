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
  displacement remain owned by the FFT. Above-water reflection uses the full
  resulting normal, physical water F0 (0.02037), and a GGX/Smith direct-sun
  lobe instead of a thresholded sparkle mask. Foam receives both shared-sky
  ambient and direct sun. The below-surface Snell/TIR path deliberately keeps
  the original resolved FFT normal and scatter response.
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
  700 m mesh fades ALL displacement to zero before its edge and overlaps the
  skirt by only 2 m, where it is already flat. Do not rebuild the hole by
  deleting triangles from a coarse plane: the old 133.3 m grid left boundary
  triangles 81.3 m inside the requested hole, so live inner-wave troughs
  crossed the skirt and produced animated barcode/contour bands. The inner and
  skirt follow the camera together on the inner vertex grid.
- **The TIR underside (`tirBody`) must be BRIGHT silvery teal** (≈ the medium's horizontal ambient, currently (0.035, 0.14, 0.19)), because a total-internal-reflection mirror reflects the upwelling water light. The original `DEEP·0.55` near-black ceiling carved a bright "gap" band at the surface silhouette against converged fog — the fogged underside must start from a radiance close to what the fog converges to. Keep this and medium.ts AMBIENT_* in the same family if either is retuned.
- **Snell's window includes real above-water geometry, anchored at the interface.** The ocean renders first in the transparent queue (while remaining alpha-opaque and depth-writing). A first depth sample estimates subject distance, then the physically refracted ray is reprojected from the actual displaced surface hit point for the final color/depth sample. Omitting that surface origin makes structures drift away from their water-entry points with camera distance. Reconstructed depth admits only geometry on the transmitted side and nearer than the 3400 m sky dome; an alignment tolerance rejects detached foreground samples. Invalid/offscreen samples and the dome fall back to the shared analytic sky + filtered window glint. Exact water→air dielectric Fresnel fades transmission to zero at the critical angle. The optical side is one camera-level uniform derived from the same displaced waterline as the underwater medium; never use per-fragment `faceDirection`, because nearby wave triangles can expose opposite faces just before a crossing and mix the underwater/Snell regime into an above-water frame. The framebuffer depth/color reprojection is coherently skipped while above water.
- `texture(...).sample(uv)` re-samples a texture node at a custom UV; `textureNode.value = tex` repoints after ping-pong swaps. `.sample()` inside a compute shader compiles to `textureSampleLevel(…, 0)` automatically — the waterline probe relies on this.
- Sun is FIXED (elevation 42°, azimuth 215°) in `sky/sun.ts` — everything shares its uniforms. PMREM environment baked once at init (sky never changes).
- **The sun disc is physical**: 0.53° angular diameter, Neckel–Labs limb darkening, HDR core ~1500× with a three-lobe circumsolar aureole; bloom makes the glare. `skyRadiance(dir, discStrength)` — the ocean passes `discStrength 0` because its analytic `sunGlint`/`windowGlint` terms ARE the delta-light specular response; re-reflecting the HDR disc through bumpy normals double-counts it as sparkling white pixels. Never re-add a wide flat smoothstep disc.
- **Waterline authority** (`sea/waterlineProbe.ts`): after the final camera pose, a 1-thread compute samples the same three displacement cascades at camera XZ (2 fixed-point rounds against choppy horizontal offset). It writes a 1×1 sampled state texture for the same frame's ocean/medium render and separately starts an async storage-buffer height copy for CPU events. `SeaSystem.surfaceHeightAtCamera` is therefore intentionally latent and must never gate visual underwater effects; nothing may compare camera y against 0 as a substitute for the displaced surface.
- Camera: near 0.1, far 5000 (dome 3400, skirt 9000 wide) — don't shrink far below the dome radius; the "black sky" failure mode is far-plane culling.
