# Render pipeline (S1)

Signal order (one owner of the final image, `render/pipeline.ts`):
scene pass (MSAA 4×, MRT color+view-normal/AO-receiver, depth) → GTAO at
0.5 res → full-resolution eight-neighbour depth/normal-aware reconstruction →
distance/material receiver application → `hdrTransform` hook (S3 medium splices
aquatic fog/god rays here) → `lensTransform` hook (`render/lensDrips.ts`: the
`refs/water_off_lens.html` Heartfelt/Rain drop field after surfacing — static
beads + two running-drop layers and finite-difference refraction normals; one
offset scene sample is mixed only through drop/trail coverage, with no
lens-wide blur or color filter; intensity drains for five seconds and a
coherent branch makes it free when dry or submerged) → bloom (HDR,
pre-tonemap; threshold 1.0 so only true emitters bloom) → measured exposure EV
→ `renderOutput` (AgX + sRGB, placed manually; `outputColorTransform = false`)
→ 32³ dream LUT → spatial vignette.

Three r185's GTAO output is a raw RedFormat target driven by a repeating 5×5
magic-square noise texture; it has no automatic denoise. Sampling that target
directly at half resolution produced a gray fabric/weave across the ocean and
sunlit architecture. The reconstruction samples the eight surrounding AO
texels at full-resolution UVs and weights by view-depth difference and normal
similarity — with two hard robustness rules learned from the blink pass:

- **The output is never a raw single sample.** The noise field is
  screen-locked, so any pixel that falls back to its unfiltered center sample
  strobes against sliding geometry at walking speed. Where bilateral support
  is weak the result blends toward the plain nine-tap mean instead
  (`smoothstep` on the summed neighbour weight), trading a slightly soft AO
  on unsupported slivers for temporal stability.
- **Depth similarity scales with view distance** (4 % of |viewZ|, floored at
  8 cm). A fixed metre-scale sigma rejects every neighbour on grazing floors
  at range, which is precisely where the raw-noise fallback then showed as
  dither bands; true silhouettes still differ by far more than the relative
  tolerance, so edges stay sharp. MSAA-resolved normals can cancel to zero
  length at silhouettes, so all normals go through an epsilon-guarded
  inverse square root rather than `normalize()` (NaN in WGSL fast math).
- **AO application is footprint-gated as well as distance-gated.** The gather
  radius is explicitly 0.25 m. Reconstructed view-position derivatives measure
  full-resolution metres per pixel, then ×2 gives the half-resolution gather
  texel footprint. AO fades to neutral across 0.0625→0.25 m/texel, combined
  with the existing 60→160 m distance fade by `max`. This is required for a
  high camera looking across the seabed: raw r185 GTAO quantizes grazing
  height-field depth into long gray rows even while view Z is under 60 m, so a
  distance-only policy cannot reject the invalid signal. `?pass=ao-footprint`
  shows the rejection field (white = raw AO is being neutralized).

The normal MRT's spare alpha is the AO-receiver mask (opaque default 1,
ocean 0), avoiding another 4× MSAA attachment. `?pass=ao` shows raw gather;
`ao-filtered`, `ao-applied`, and `ao-mask` isolate each subsequent decision.

The lens field is authored in the reference fullscreen mesh's Y-up UV space.
WebGPU `screenUV` is Y-down, so flip Y before evaluating `DropLayer2` and
negate the resulting refraction Y offset when sampling the scene. Without both
conversions, the exact `uv.y += time` reference motion drains upward.

Choices beyond the code:

- **The final grade is a real generated 32³ `Data3DTexture`** sampled by
  `Lut3DNode` after AgX. Its fixed transform gives lifted teal shadows, warm
  gold highlights, and protected vibrance. Only LUT intensity and the spatial
  vignette remain live trims.
- **Exposure is measured, not guessed** (`render/exposureMeter.ts`): a 64×36
  RGBA8 target stores encoded log luminance, center weight, and highlight
  pressure. Asynchronous readback computes weighted log-average exposure with
  a peak-preserving clamp and replaces only the target EV. Asymmetric
  adaptation of the current EV runs every rendered frame, avoiding
  readback-cadence brightness steps. It never synchronously stalls the render
  loop.
- **Emissive hierarchy contract:** bloom threshold is 1.0 — materials must express glow through genuinely HDR emissive values (sun sparkle strongest, lamps mid, bioluminescence subtle), never by lowering the threshold.
- **Type boundary:** @types/three TSL generics (`Node<"vec4">` etc.) churn per release — cross-module node handoffs type as `object` and cast once at the boundary (`asColor` in grade.ts). Do not thread precise TSL generic types through system APIs.
- `?pass=` views: `ao · ao-filtered · ao-applied · ao-mask · ao-footprint · bloom · depth · normal · exposure · rays · caustics · no-rays · no-post · no-grade`; wake diagnostics are `wake-layers · wake-age · wake-flow`, plus the fountain field modes. `?view=seabed-high` is the fixed high-water-column AO/minification regression camera. `?view`/`?pass` skip the enter button (validation mode).
- Dynamic resolution = `setPixelRatio(base × quality.renderScale)`; all pass targets follow the drawing-buffer size automatically. The base is capped by DPR 1.7 **and** a 4,000,000-pixel drawing-buffer budget (`recommendedPixelRatio`), recomputed on resize before dynamic scale is applied.
- Dynamic resolution is driven by the actual animation-frame interval, not CPU
  command-submission time. It is an emergency pressure valve bounded to
  0.82/0.88/0.90 by tier so it cannot become the primary performance strategy.
  Isolated long frames are rejected unless they form a consecutive hitch run;
  downscale requires sustained pressure and recovery requires a longer healthy
  interval, preventing a single hitch from triggering render-target reallocations.
  The recovery threshold includes healthy 60 Hz v-sync cadence, and a cached Auto
  session never reopens below 0.95. CPU time and presented frame time/FPS remain
  normal-play diagnostics. WebGPU render/compute timestamp queries are enabled
  only under `?debug`, because resolving and mapping them is itself queue work
  (`render/performanceMonitor.ts`).
- The scene MRT remains 4× MSAA. The default canvas is deliberately not
  multisampled because its only geometry is the final fullscreen presentation
  pass; enabling both would pay for a redundant second resolve.
- Fixed-sun static shadow clipmaps keep their authored sizes, cascades, casters,
  and filtering, but no longer traverse/encode the full live scene when the
  camera crosses a recenter threshold. After all systems initialize,
  `staticShadowScene.ts` flattens immutable static casters at their exact world
  transforms into a shadow-only WebGPU `BundleGroup`; frustum culling is off on
  these proxies because the bundle draw list is immutable and the live shadow
  camera supplies clipping. Initial paused/loading render records one bundle
  per clipmap target. Moving rides, wildlife, and props remain excluded and
  render through the existing live dynamic-caster map. The performance dataset
  reports static caster count, refresh count, and last/max CPU refresh time.
- **NodeFrame is a singleton whose `scene` every nested render reassigns.**
  The clipmap update pins the live scene before any bundle-scene level render
  and hands the dynamic-caster pass an explicit frame wrapper. Without the
  pin, any frame that refreshed a static level rendered the dynamic map from
  the bundle proxy scene — zero layer-2 objects — so every moving object's
  shadow (and all dynamic-on-dynamic shadowing) blinked off for exactly the
  recenter frames while the camera walked.
- **Loading-time warmup** (`render/warmup.ts`, awaited before the Enter
  button appears): WGSL node-building is main-thread JS (~3 s for the whole
  park if paid in one frame) and the browser compiles native shaders lazily
  on each pipeline's first submitted use (GPU-process stall = the roaming
  freeze). The warmup batch-`compileAsync`es one representative mesh per
  material × geometry-layout signature against the scene pass's own render
  target + MRT (pipeline caches key on that context state), then runs six
  real zero-dt pipeline frames with culling lifted, hidden subtrees revealed,
  all clipmap levels force-invalidated, and the exposure meter's pause gate
  lifted, so every render/compute/shadow pipeline is created *and used* once
  behind the ticket. Validation modes (`?view`/`?pass`/`?fixedTime`) skip it
  for fast reloads and accept first-sight stutter instead.
- **Runtime light membership is shader topology in Three r185.** Adding,
  removing, hiding, or layer-excluding a `Light` changes `LightsNode`'s cache
  key and synchronously rebuilds every lit RenderObject/WGSL program in the
  scene; async pipeline warmup cannot prevent that main-thread graph rebuild.
  Scheduled lights must remain members and animate a uniform value instead.
  The Bubble Fountain keeps all four point lights visible and drives intensity
  to exact zero at its former 0.02 visibility cutoff, preserving the image
  without topology churn.
