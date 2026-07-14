# Seabed & flora (S4)

- **`terrainHeight(x, z)` in `world/terrain.ts` is the single height authority** — chunk geometry, scatter placement, S5 colliders, and any "put this on the ground" logic must query it. Deterministic (CPU value-noise, fixed seeds), cheap. Geography: plateau −26 m, flattened central pad (~300 m), jagged north rim at z ≈ −250 plunging to −300 (the drop-off), soft sinks on the other edges, then the **lagoon saucer**: beyond hypot ≈ 680 m the floor rises to −3.6 ± 1.1 m by 1150 m (Scott's ruling, 2026-07-10) so no open-water gap column exists at any horizon direction; it crests at −2.5 m worst case — under every wave trough, never breaching. North it forms the trench's far wall; the drop-off's open blue stays.
- Terrain = 10×10 CPU-built chunks (frustum-cullable), analytic normals, plus a coarse 7×7 far-tile ring (400 m tiles, 32 verts, inner 3×3 skipped) carrying the saucer out to ±1400 m. The detailed grid and physics heightfield still span ±600 (`TERRAIN_EXTENT`); the fine/coarse seam at ±600 sits in the −40..−60 m sink zone where fog crushes any T-junction hairline. Sand material has fbm tonal variation, warped ripple bands as a normal perturbation, and a **greenish tint exactly where the seagrass meadow mask is high — same field, same cause** (procedural-fields principle: `fbmCpu(x·0.0045, z·0.0045, 5, seed 23) > 0.62`).
- **`MeshStandardNodeMaterial.normalNode` consumes a view-space normal.** The
  sand ripple field is authored in terrain-local space, so `terrain.ts`
  resolves that local perturbation and calls `transformNormalToView()` exactly
  once. Passing the local vector directly pins the normal to the camera: while
  facing away from the sun and pitching down, direct light collapses until the
  seabed turns into the medium's flat blue inscatter. Keep the field local and
  the hook view-space; do not tune albedo, caustics, fog, or exposure around a
  coordinate-space error.
- **Kelp + seagrass are BAKED geometry with root attributes, not instanced**: per-vertex `rootXZ` + `swayWeight`, so `material.positionNode` sways them coherently on the shared `currentFlow` field in one draw. Kelp carries four alternating lateral blades per stalk in that same mesh, producing a feathered silhouette without another animation or draw. This dodges the instanceMatrix-vs-positionNode ordering problem entirely — reuse the pattern for banners/ropes.
- `attribute('name', 'type')` returns an untyped node — cast to `Node<'vec2'>` etc. at creation.
- Corals/rocks: brain and staghorn coral plus displaced rocks use static InstancedMesh scatter via `rng.fork`; killed instances get zero-scale matrices. Rock transforms include bounded tilt and independent XYZ proportions rather than yaw plus uniform scale. The flattened purple fan-coral archetype was removed on 2026-07-11 after it read as a cardboard cutout; do not recreate fan coral from a flattened sphere or card.
- Seabed micro-dressing adds two low-segment shell families (clam fan and spiral) and two displaced pebble families: 820 deterministic instances in four draws, footprint-aware, non-shadow-casting, and varied by tilt/proportion. These are silhouette/placement assets, not high-frequency hero meshes.
- Dense flora and micro-dressing never cast directional shadows. A former final traversal accidentally re-enabled shadows after seagrass disabled them, submitting up to 120,000 grass triangles to shadow rendering; substantial reef forms are now the only flora casters.
- Watch exposure: sand albedo is deliberately dark-ish (0.48–0.58) because caustics (×1.15) + sun 3.4 + fog inscatter stack up; if the seabed blows out again, look at that stack before touching the tonemap.
- Bookmarks: `?view=dropoff` (postcard 4 staging), `?view=gardens`.

## 2026-07-12 standing-issues update

- `terrainHeight` lives in world/terrainHeight.ts (a leaf module with .ts
  imports) so offline geometry audits sample the exact game field;
  world/terrain.ts re-exports it. The grotto massif/gorge/channel cuts and
  the massif reef-stone sand tint were removed with the Grotto.
- The Great Wheel basin gets a dense local physics heightfield patch — see
  physics/physicsWorld.ts and rides-wheel-carousel.md.

## 2026-07-13 craft pass

- The reef is now six instanced archetypes: brain coral (second wrinkle
  octave), forked staghorn, rock, tube-sponge clusters (closed clockwise
  lathes — hollow mouths visible without DoubleSide), barrel sponges, and
  table corals (trunk + wavy thick plate). All share one material recipe:
  identity color × a broad worldspace colony-patch field, plus a
  `positionLocal.y` tip gradient for species with growth direction. Extend
  the reef by adding to the archetype table, not with one-off meshes.
- Kelp/seagrass color: per-stalk tone from the baked root hash plus a warm
  translucent tip term on the sway weight. The blade geometry budget is
  unchanged (seagrass stays single-triangle at 120k — do not "upgrade" it
  to quads without a measured budget).
- New "sea treasures" dressing (buildSeaTreasures): ~8 giant clams (merged
  fluted two-valve shells hinged open, DoubleSide by design; iridescent
  mantle whose electric spots pulse on `timeUniform`; nacre pearl) and ~18
  amphorae (closed lathe + handles; slip bands in `positionLocal` so they
  survive toppled instances; barnacle crust from a world fbm). Both respect
  `inParkFootprint` margins and the rim exclusion like every scatter family.
