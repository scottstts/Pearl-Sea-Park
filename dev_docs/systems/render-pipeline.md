# Render pipeline (S1)

Signal order (one owner of the final image, `render/pipeline.ts`):
scene pass (MSAA 4×, MRT color+view-normal, depth) → GTAO at 0.5 res (RedFormat — multiply by `.r`, never the vec4) → `hdrTransform` hook (S3 medium splices aquatic fog/god rays here) → bloom (HDR, pre-tonemap; threshold 1.0 so only true emitters bloom) → measured exposure EV → `renderOutput` (AgX + sRGB, placed manually; `outputColorTransform = false`) → 32³ dream LUT → spatial vignette.

Choices beyond the code:

- **The final grade is a real generated 32³ `Data3DTexture`** sampled by
  `Lut3DNode` after AgX. Its fixed transform gives lifted teal shadows, warm
  gold highlights, and protected vibrance. Only LUT intensity and the spatial
  vignette remain live trims.
- **Exposure is measured, not guessed** (`render/exposureMeter.ts`): a 64×36
  RGBA8 target stores encoded log luminance, center weight, and highlight
  pressure. Asynchronous readback computes weighted log-average exposure with
  asymmetric adaptation and a peak-preserving clamp. It never synchronously
  stalls the render loop.
- **Emissive hierarchy contract:** bloom threshold is 1.0 — materials must express glow through genuinely HDR emissive values (sun sparkle strongest, lamps mid, bioluminescence subtle), never by lowering the threshold.
- **Type boundary:** @types/three TSL generics (`Node<"vec4">` etc.) churn per release — cross-module node handoffs type as `object` and cast once at the boundary (`asColor` in grade.ts). Do not thread precise TSL generic types through system APIs.
- `?pass=` views: `ao · bloom · depth · normal · exposure · rays · caustics · no-rays · no-post · no-grade`, plus the fountain field modes. `?view`/`?pass` skip the enter button (validation mode).
- Dynamic resolution = `setPixelRatio(base × quality.renderScale)`; all pass targets follow the drawing-buffer size automatically. The base is capped by DPR 1.7 **and** a 4,000,000-pixel drawing-buffer budget (`recommendedPixelRatio`), recomputed on resize before dynamic scale is applied.
- Dynamic resolution is driven by the actual animation-frame interval, not CPU
  command-submission time. It is an emergency pressure valve bounded to
  0.82/0.88/0.90 by tier so it cannot become the primary performance strategy.
  The recovery threshold includes healthy 60 Hz v-sync cadence, recovery probes
  are deliberately sparse, and a cached Auto session never reopens below 0.95.
  CPU time, presented frame time/FPS, and asynchronous WebGPU render/compute
  timestamps are separate diagnostics (`render/performanceMonitor.ts`).
- The scene MRT remains 4× MSAA. The default canvas is deliberately not
  multisampled because its only geometry is the final fullscreen presentation
  pass; enabling both would pay for a redundant second resolve.
