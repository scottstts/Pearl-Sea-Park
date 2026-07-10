# Sea & sky (S2)

One wave field, every consumer: `sea/waveSim.ts` produces per-cascade displacement + derivative maps that drive the surface (both sides), and later the caustics projector and god-ray flicker (S3). One sky function (`sky/skyRadiance.ts`) feeds the dome, the ocean reflection, and the Snell-window refraction — they can never disagree.

Architecture (spectral-ocean skill, WebGPU/TSL production tier):

- 3 cascades, 256², patches [250, 17, 5] m, boundary factor 6; JONSWAP × TMA × directional spread spectrum built CPU-side per cascade from `rng.fork('ocean-cascade-N')` (deterministic; Gaussian pairs consumed even out-of-band to keep bins seed-stable).
- Packed IFFT: one texture carries two complex fields (.xy height, .zw
  horizontal Dx+iDz). Each 256-point row/column transform lives in one
  workgroup array with explicit barriers between all radix-2 stages. Horizontal
  and vertical axes remain separate storage-visibility submissions, batched
  across cascades. The transform therefore uses two FFT submissions rather
  than sixteen while preserving the exact centered field and hard-gate tests.
- Assembly kernel applies the (−1)^(x+y) centering sign (per-texel AND per-neighbor when finite-differencing), builds fold-aware derivatives, Jacobian, and persistent foam history (`min(J, prev + dt·rate/max(J,0.5))`, clamped ≤ 2).
- **FFT hard gate**: `runFftSelfTest` runs under `?debug` — impulse → constant and one-bin → cos/sin, errors ~1e-8. Readback goes through a **storage buffer** (`getArrayBufferAsync`), never a material blit.

Hard-won lessons (do not re-learn these):

- **GTAO dithers on distant grazing geometry (ocean!).** AO is contact-scale: the pipeline fades AO to neutral beyond 60–160 m (`pipeline.ts`). Any "mysterious dither band" seen on far surfaces — check `?pass=ao` FIRST, before touching materials. This cost hours.
- **Material-blit readbacks lie**: renderer tone mapping (AgX) clamps negatives to 0 in any quad-blit path. GPU→CPU verification must use storage-buffer readback.
- **Spectral LOD everywhere**: fine cascades fade by distance in BOTH vertex displacement and fragment derivatives; sun glints and fbm foam fade by ~250–380 m. MSAA cannot fix shader/geometry aliasing on sub-pixel waves.
- The far skirt is a FLAT ring (vertex-sampling waves at 187 m spacing is pure aliasing); the inner 700 m mesh fades ALL displacement to zero at its edge so the surfaces meet exactly. Inner follows the camera quantized to its own grid step.
- `texture(...).sample(uv)` re-samples a texture node at a custom UV; `textureNode.value = tex` repoints after ping-pong swaps.
- Sun is FIXED (elevation 42°, azimuth 215°) in `sky/sun.ts` — everything shares its uniforms. PMREM environment baked once at init (sky never changes).
- Camera: near 0.1, far 5000 (dome 3400, skirt 9000 wide) — don't shrink far below the dome radius; the "black sky" failure mode is far-plane culling.
