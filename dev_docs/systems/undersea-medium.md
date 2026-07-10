# Undersea medium (S3)

`sea/medium.ts` owns underwater-ness. Above the surface it is a no-op; the `submerged` uniform (smoothed) gates everything, driven by camera y vs 0.

- **Fog + god rays live in the render pipeline's `hdrTransform` hook** (post-process over HDR, before bloom) — not in materials. One place fogs everything ever added to the scene. World rays are reconstructed from `screenUV` + `cameraProjectionMatrixInverse` + `cameraWorldMatrix` (all built-in TSL nodes — no manual matrix uniforms).
- **Aquatic perspective**: per-channel extinction `SIGMA = (0.026, 0.0085, 0.005)` ≈ 250 m dream visibility; inscatter blends deep-blue (down) → turquoise (up) with a sunward warm lobe, dimmed by camera depth.
- **Caustics** (`sea/caustics.ts`): differential-area method from the live 17 m cascade — refracted grid projected to a virtual floor, old/new area ratio = concentration, rendered additively 3×3-instanced into a wrapping 17 m tile (one cascade only: its patch tiles exactly, and a 256² grid resolves continuous filaments; adding the 5 m cascade forces an 85 m LCM tile that turns filaments into dot chains).
- **Caustics apply to surfaces via `material.receivedShadowNode`** (`applyCaustics()`): they modulate received sun light, so they inherit shadows for free and never glow in occluded interiors. Every underwater lit material must opt in (terrain S4, archkit S6 — wire it in the material factory).
- **God rays**: the same bounded ≤85 m caustic-field march now runs in a
  tiered 0.34/0.42/0.50-resolution RGBA16F target. Alpha carries linear
  depth; a five-tap full-resolution bilateral reconstruction rejects samples
  across geometry edges. The reduction preserves the physical march and
  tiered step counts (8/14/22) while removing the old full-frame cost.
- **Particulates**: instanced tetrahedra in a 60 m camera-following wrap volume, drifting on `currentFlow` (the global curl field in `sea/current.ts` — kelp/banners/jellies must sample the same field later). Node materials blend via `opacityNode` — colorNode alpha is IGNORED (dark-specks failure mode).
- **Interior blend**: `setInterior(0…1)` is owned by enclosed ride systems. The Grotto uses it to remove up to 94% of open-sea inscatter and god rays without disabling underwater extinction, so the cave becomes the game's darkness contrast while silhouettes still recede physically.
- Bookmarks: `?view=ceiling`, `?view=snell`, `?view=caustics`.
- The renderer is now **globally NoToneMapping**; the pipeline's `renderOutput(x, AgXToneMapping, SRGBColorSpace)` is the only output transform. Side RT renders (caustic tile, future water sims) stay linear — never undo this.
