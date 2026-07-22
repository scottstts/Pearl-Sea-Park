# Seabed & flora

## Terrain (S4 — unchanged authorities)

- **`terrainHeight(x, z)` in `world/terrainHeight.ts` is the single height authority** — chunk geometry, scatter placement, colliders, and any "put this on the ground" logic must query it. Deterministic (CPU value-noise, fixed seeds), cheap. Geography: plateau −26 m, flattened central pad (~300 m), jagged north rim at z ≈ −250 plunging to −300 (the drop-off), soft sinks on the other edges, then the **lagoon saucer**: beyond hypot ≈ 680 m the floor rises to −3.6 ± 1.1 m by 1150 m so no open-water gap column exists at any horizon direction.
- Terrain = 10×10 CPU-built chunks (frustum-cullable), analytic normals, plus a coarse 7×7 far-tile ring (400 m tiles, inner 3×3 skipped) carrying the saucer out to ±1400 m. Physics heightfield spans ±600 (`TERRAIN_EXTENT`).
- **`MeshStandardNodeMaterial.normalNode` consumes a view-space normal.** The sand ripple field is authored in terrain-local space and passed through `transformNormalToView()` exactly once. Keep the field local and the hook view-space.
- Sand has fbm tonal variation, warped ripple normals, and a **greenish tint exactly where the seagrass meadow mask is high — same field, same cause**: `fbmCpu(x·0.0045, z·0.0045, 5, seed 23) > 0.62`. Any flora change must keep sampling this exact mask or the sand/meadow correlation breaks.
- Watch exposure: sand albedo is deliberately dark-ish because caustics (×1.15) + sun 3.4 + fog inscatter stack up.

## Flora remake (2026-07-22)

Total rebuild of every plant/rock/coral archetype. Three modules:

- `world/reefPatches.ts` — **the shared colony layout.** Deterministic patch
  centers (reef colonies), kelp grove stands, and garden-eel lawns computed
  from rng forks whose labels alone fix the sequence. FloraSystem and
  WildlifeSystem each call `computeSeabedColonies(ctx.rng)` and derive the
  IDENTICAL world with zero coupling — fish schools anchor on the exact
  patches the corals grew on. Distribution philosophy: everything is patch
  + falloff + loners, never uniform confetti.
- `world/floraGeometry.ts` — **sculpted mesh builders** (leaf module;
  `audit:geometry` builds and measures every archetype offline). One
  writer, four channels: `position`, `animWeight` (sway weight, 0 =
  rooted/rigid), `animPhase` (per-frond/tentacle/spine desync), `tint`
  (authored color cause). Doctrine: real thickness everywhere, closed
  solids (tube caps, cone tips, buried base fans), displacement at vertex
  creation with recomputed normals.
- `world/flora.ts` — placement, materials, sway. All families are
  InstancedMesh; big rigid families split into quadrant sector draws so
  looking away culls them.

### Marine vegetation identity (2026-07-22 ruling)

The first soft-vegetation set (upright grass-blade rosettes + a
stipe-with-leaf-blades kelp) read as LAWN GRASS and a GARDEN SAPLING —
land-plant construction grammars do not transfer underwater, whatever
the palette. Both were retired on Scott's reference photos (Fucus beds,
coastal algae turf). The replacements:

- **Strap kelp** (`createStrapKelpGeometry`): from a holdfast mound, 4–6
  LONG leathery ribbon blades rise steeply, bow over, and stream
  sideways — ruffled margins, basal pneumatocysts, no trunk, no leaves.
  The audit enforces the marine silhouette numerically: horizontal
  spread must EXCEED rise. The material drags free lengths along the
  live current (streaming, not arcing — the straps are authored bowed).
- **Algae turf** (`createAlgaeTuftGeometry`): three low domed clump
  archetypes — 'rockweed' (broad serrated Fucus fronds, many
  dichotomously forked, olive→gold with translucent amber edges),
  'codium' (green tubular finger bush, Y-forks, velvet rough), 'plume'
  (feathery notched arcs, rose ↔ violet per clump). These ARE the
  meadow now; the mask still rules where turf is dense, so the sand
  tint correlation survives.
- **Clustered, never uniform**: acceptance = meadow mask (low-freq) ×
  clump-noise gate (fbm ~0.033/m → 15–30 m patches) × park living zone,
  then every accepted parent sprouts 1–3 children within 0.5–1.9 m
  (Neyman–Scott). Multi-scale patchiness per Scott's explicit ask.

### The tint convention (color follows the carved cause)

`tint` is baked WITH the displacement that caused it, so the material's
light/dark always matches the sculpt — no screen-space guessing:

- brain coral: meander ridge field (contour-lines-of-a-warped-fbm carves
  ridges AND writes tint; valleys shade dark, crests pale).
- boulders/pinnacles: strata band index (bedding planes carved by
  y-quantization; tint alternates per band; algae mask rides upward
  geometry normals on top).
- staghorn/fans: branch order (tips pale — axial corallites/polyps).
- sponges: rim/throat gradient; amphorae: slip bands (survive toppling by
  construction); kelp: stipe 0 → blade ~0.55 → bladder 0.8 → edge/tip 1.

### Sway architecture

- Instanced flora sway is **world-space offsets added to `positionLocal`**
  (the instance transform is already applied to positionLocal in the node
  pipeline — the jelly precedent, now extended to flora). Instance yaw
  bakes into the matrix; flow pushes everything in world axes, which is
  physically right (one current).
- Kelp/seagrass bend on a **stiffness-shaped circular arc**: per-vertex
  bend angle φ_v = φ·(0.4 + 0.6·w^0.8), arc angle a = φ_v·yFraction, lean =
  R(1−cos a), drop = R·sin a − h. Every term vanishes as φ→0 — **do not
  use the grass-skill's a = φ·w^1.5 shaping directly**: it bakes a
  permanent droop at rest (fine for meadow grass, wrong for a buoyant
  10 m kelp stalk).
- Gust fronts (`sin(dot(rootXZ, dir)·k − t·speed)`) travel through the
  meadow and the kelp stands so surge reads as weather, not per-plant
  wiggle. Kelp frond flutter rides `animWeight − yFraction^1.35` — the
  baked blade surplus over the stipe's height law — so the stipe arcs
  without fluttering.
- Height fraction for arcs comes from `positionGeometry.y / authored
  height` (geometry space, exact under instance scaling); world height =
  `instanceScale` attr × authored height.

### Density is allocated by GUEST PROXIMITY (2026-07-22 ruling)

The first remake distributed by map area and left the park core — where
the camera actually lives — barren (Scott: "no lush flora anywhere").
The corrected doctrine:

- **The verge band is the guaranteed-seen band.** `sampleParkVergePoint`
  (reefPatches.ts) draws points just off path shoulders and plaza/keepout
  rims (KEEPOUT_DISCS is exported for exactly this), lateral-biased close.
  A quarter of the seagrass budget, ~340 coral-garden pieces (small
  brains/staghorns/fans/anemones/urchins/starfish/sponges in clustered
  beds), a third of the shell/pebble litter, half the crabs, and a third
  of the scallop beds plant there.
- **Garden patches hug the park**: 10 small colonies at radius 55–205 m
  (plus 14 open-reef patches at 150–470). Fish schools fill garden
  patches FIRST. Two kelp groves step in to 235–320 m.
- Seagrass field scatter: meadow-mask cores stay densest, acceptance ×1
  inside the park's 310 m living zone vs ×0.3 outside, and bare sand
  keeps a sparse everywhere-tuft floor (mask correlation with the sand
  tint is untouched — the mask still rules where meadows READ as
  meadows). Loners: two thirds of the budget inside 300 m.

### Aggressive LOD (what pays for the density)

`FloraSystem.lodFade(origin, far)`: instances collapse to degenerate
points (relative-to-origin geometry × smoothstep(far → 0.75·far) of
camera XZ distance) — the rasterizer discards them, so far dressing
costs vertex-stage only. Collapse radii: pebbles 72, shells 85,
starfish 95, urchins 100, anemones 110, seagrass 115, fans 150; fauna:
scallops 85, crabs 95, eels 130, fish schools 240 (in their own
materials). Distant meadow COLOR is already painted by the sand-tint
field, and rigid reef (corals/boulders/sponges/pinnacles — the
shadow-casting landmark masses) never collapses, so nothing pops.
Chunking: seagrass 10×10 (84 m chunks), everything large in quadrant
sector draws — frustum culling does the rest.

### Families & budgets (tier-2 rough counts)

strap kelp ~360 plants in ≤10 grove draws (~310 tris each, streaming);
algae turf ~15k clumps (rockweed/codium/plume ≈ 45/30/25, 25%
verge-planted) in 7×7 chunk × 3 variant draws, tier-scaled by
`seagrassDensity`, collapse at 115 m; brain/staghorn/table corals,
2 boulder variants, 8 pinnacles, tube/barrel sponges (rigid, castShadow,
static-bundle safe) at ×1.8 per-patch counts over 24 patches plus ~3.5×
loners; 2 sea-fan variants + anemones + urchins + starfish (swaying or
small — NEVER shadow casters, the cached clipmaps would freeze the
pose); ~590 turban/fan shells + ~980 pebbles, giant clams + amphorae
(sea treasures). Reef colonies get framework boulders first, coral heads
in sibling micro-clusters, sponges on flanks, fans on the periphery
aligned across the patch's tangent (± jitter), anemones/urchins snugged
against placed rocks, then the loner scatter ties patches together.

- Sea fans returned (the 2026-07-11 flat-card ruling demanded authored
  thickness/branching first): they are real branch lattices of tapered
  tubes grown in a near-vertical plane, 2–3 orders, knob tips.
- Urchins seat with **negative sink** (lifted ~0.6·s) so they stand on
  their lower spines instead of nesting half-buried; scale ranges keep
  them 14–30 cm.
- All scatter honors `inParkFootprint` margins, `RIM_Z` offsets, and a
  −33..−17 m ground band (keeps everything off the rim plunge, the wheel
  basin, and the outer sink).

### Verification

`npm run audit:geometry` now gates flora (and fauna) geometry: per-archetype
triangle budgets, finiteness, channel ranges, mean-outward-normal checks on
closed masses, kelp authored height — and exits nonzero on any failure.
Debug bookmarks: `?view=gardens` (kept), `?view=reef` (richest patch),
`?view=fish` (hero school).
