# Render pipeline (S1)

Signal order (one owner of the final image, `render/pipeline.ts`):
scene pass (MSAA 4×, MRT color+view-normal, depth) → GTAO at 0.5 res (RedFormat — multiply by `.r`, never the vec4) → `hdrTransform` hook (S3 medium splices aquatic fog/god rays here) → `lensTransform` hook (`render/lensDrips.ts`: the `refs/water_off_lens.html` Heartfelt/Rain drop field after surfacing — static beads + two running-drop layers and finite-difference refraction normals; one offset scene sample is mixed only through drop/trail coverage, with no lens-wide blur or color filter; intensity drains for five seconds and a coherent branch makes it free when dry or submerged) → bloom (HDR, pre-tonemap; threshold 1.0 so only true emitters bloom) → measured exposure EV → `renderOutput` (AgX + sRGB, placed manually; `outputColorTransform = false`) → 32³ dream LUT → spatial vignette.

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
- `?pass=` views: `ao · bloom · depth · normal · exposure · rays · caustics · no-rays · no-post · no-grade`, plus the fountain field modes. `?view`/`?pass` skip the enter button (validation mode).
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
