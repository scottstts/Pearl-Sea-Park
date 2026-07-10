# Undersea medium (S3)

`sea/medium.ts` owns underwater-ness. Above the surface it is a no-op; the `submerged` uniform (smoothed) gates everything, driven by camera y vs 0.

- **Fog + god rays live in the render pipeline's `hdrTransform` hook** (post-process over HDR, before bloom) — not in materials. One place fogs everything ever added to the scene. World rays are reconstructed from `screenUV` + `cameraProjectionMatrixInverse` + `cameraWorldMatrix` (all built-in TSL nodes — no manual matrix uniforms).
- **Aquatic perspective**: per-channel extinction `SIGMA = (0.026, 0.0085, 0.005)` ≈ 250 m dream visibility; inscatter blends deep-blue (down) → turquoise (up) with a sunward warm lobe, dimmed by camera depth.
- **Caustics** (`sea/caustics.ts`): differential-area method from the live 17 m
  cascade — refracted grid projected to a virtual floor, old/new area ratio =
  concentration. The authored 256² source grid is drawn 3×3 into one wrapping
  output tile, preserving the exact cross-boundary projection and 6.6 cm source
  density used by the reference underwater image.
- **Caustics apply to surfaces via `material.receivedShadowNode`** (`applyCaustics()`): they modulate received sun light, so they inherit shadows for free and never glow in occluded interiors. Every underwater lit material must opt in (terrain S4, archkit S6 — wire it in the material factory).
- **God rays**: full-output-resolution per-pixel march over the same bounded
  ≤85 m caustic field, with tiered step counts (8/14/22) and sub-step hash
  jitter. This is intentionally the pre-S14 mechanism: the fine separated
  shafts are not recoverable from a reduced spatial target without temporal
  history and velocity. The pipeline owns neither, so reduced-resolution ray
  reconstruction is prohibited; it produced mud, stochastic grain, coherent
  sheets, and visible Bayer tiles in successive attempted fixes. A coherent
  uniform branch skips the march entirely above water without changing any
  underwater sample.
- **Ray visual contract**: the open park shows many fine, softly separated
  sunward shafts like the pre-`e59ca20` reference; the contribution must contain
  no screen-fixed grain, checker/ordered pattern, broad parallel sheets, or
  foreground-edge leakage. Validate with `?pass=rays`, `?pass=no-rays`, and
  `?pass=caustics` at a fixed bookmark, seed, time, viewport, DPR, and tier.
- **Particulates**: instanced tetrahedra in a 60 m camera-following wrap volume, drifting on `currentFlow` (the global curl field in `sea/current.ts` — kelp/banners/jellies must sample the same field later). Node materials blend via `opacityNode` — colorNode alpha is IGNORED (dark-specks failure mode).
- **Interior blend**: `setInterior(0…1)` is owned by enclosed ride systems. The Grotto uses it to remove up to 94% of open-sea inscatter and god rays without disabling underwater extinction, so the cave becomes the game's darkness contrast while silhouettes still recede physically.
- Bookmarks: `?view=ceiling`, `?view=snell`, `?view=caustics`.
- The renderer is now **globally NoToneMapping**; the pipeline's `renderOutput(x, AgXToneMapping, SRGBColorSpace)` is the only output transform. Side RT renders (caustic tile, future water sims) stay linear — never undo this.
