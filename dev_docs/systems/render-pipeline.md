# Render pipeline (S1)

Signal order (one owner of the final image, `render/pipeline.ts`):
scene pass (MSAA 4×, MRT color+view-normal, depth) → GTAO at 0.5 res (RedFormat — multiply by `.r`, never the vec4) → `hdrTransform` hook (S3 medium splices aquatic fog/god rays here) → bloom (HDR, pre-tonemap; threshold 1.0 so only true emitters bloom) → exposure EV → `renderOutput` (AgX + sRGB, placed manually; `outputColorTransform = false`) → dream grade.

Choices beyond the code:

- **The "LUT" is TSL math** (`render/grade.ts`), not a baked 3D texture: lift/gain split-tone (teal shadows / gold highlights), gamma trim, vibrance, vignette — live-tunable in the debug pane. Equivalent output, better iteration. If a real LUT texture is ever wanted, `Lut3DNode` exists in three r185 and slots after `renderOutput`.
- **Emissive hierarchy contract:** bloom threshold is 1.0 — materials must express glow through genuinely HDR emissive values (sun sparkle strongest, lamps mid, bioluminescence subtle), never by lowering the threshold.
- **Type boundary:** @types/three TSL generics (`Node<"vec4">` etc.) churn per release — cross-module node handoffs type as `object` and cast once at the boundary (`asColor` in grade.ts). Do not thread precise TSL generic types through system APIs.
- `?pass=` views: `ao · bloom · depth · normal · no-post · no-grade`. `?view`/`?pass` skip the enter button (validation mode).
- Dynamic resolution = `setPixelRatio(base × quality.renderScale)`; all pass targets follow the drawing-buffer size automatically.
