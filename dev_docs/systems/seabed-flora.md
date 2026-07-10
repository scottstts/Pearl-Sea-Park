# Seabed & flora (S4)

- **`terrainHeight(x, z)` in `world/terrain.ts` is the single height authority** — chunk geometry, scatter placement, S5 colliders, and any "put this on the ground" logic must query it. Deterministic (CPU value-noise, fixed seeds), cheap. Geography: plateau −26 m, flattened central pad (~300 m), jagged north rim at z ≈ −250 plunging to −300 (the drop-off), soft sinks on the other edges.
- Terrain = 10×10 CPU-built chunks (frustum-cullable), analytic normals; sand material has fbm tonal variation, warped ripple bands as a normal perturbation, and a **greenish tint exactly where the seagrass meadow mask is high — same field, same cause** (procedural-fields principle: `fbmCpu(x·0.0045, z·0.0045, 5, seed 23) > 0.62`).
- **Kelp + seagrass are BAKED geometry with root attributes, not instanced**: per-vertex `rootXZ` + `swayWeight`, so `material.positionNode` sways them coherently on the shared `currentFlow` field in one draw. This dodges the instanceMatrix-vs-positionNode ordering problem entirely — reuse the pattern for banners/ropes.
- `attribute('name', 'type')` returns an untyped node — cast to `Node<'vec2'>` etc. at creation.
- Corals/rocks: 4 displaced-primitive archetypes, static InstancedMesh, scatter via `rng.fork` bands, killed instances get zero-scale matrices. These are S4-grade set dressing — S6/S7 may upgrade silhouettes (fan corals especially).
- Watch exposure: sand albedo is deliberately dark-ish (0.48–0.58) because caustics (×1.15) + sun 3.4 + fog inscatter stack up; if the seabed blows out again, look at that stack before touching the tonemap.
- Bookmarks: `?view=dropoff` (postcard 4 staging), `?view=gardens`.
