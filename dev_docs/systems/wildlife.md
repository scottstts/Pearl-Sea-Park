# Wildlife (S12)

## Schooling fish

- `FishSchoolSystem` owns four GPU storage buffers: vec4 position A/B and
  velocity A/B. They ping-pong once per rendered frame; the active buffer is
  sampled directly by three `InstancedMesh` species draws. No fish transforms
  or animation data return to the CPU.
- Quality budgets are exact: tier 0 = 5,000 fish / 10 schools; tier 1 = 10,000
  / 20; tier 2 = 15,000 / 30. Every school contains 500 fish. Species counts
  are respectively 2,000/1,500/1,500; 3,500/3,500/3,000; and
  5,000/5,000/5,000 for silversides, golden trevally-likes, and candy-striped
  reef fish.
- The compute is O(N × 8), not O(N²): each fish samples eight stable,
  well-spread members of its own 500-fish cohort. Separation is distance
  weighted; alignment and cohesion use the cohort average. A moving school
  target, the shared current field, terrain clearance, surface ceiling, and
  attraction forces complete the acceleration model. Speed is bounded at
  0.72–3.4 m/s (4.9 m/s during the hero pass).
- Fish meshes are authored along local +Z. Per-vertex `morphWeight` drives
  tail flex in TSL, while velocity constructs an orthonormal swim frame in the
  vertex graph. Three species are therefore three draw calls at every tier.
  Offline geometry audit: 65 vertices / 105 triangles per fish archetype.
- The player is a 13.5 m avoidance sphere with a steep inner force. Schools
  open an aisle causally; no fish teleports or uses a scripted split pose.

## Park field and attraction hooks

- `parkFootprintSignedDistance()` is the signed-distance form of the existing
  `parkPlan` discs and capsules. `inParkFootprint()` now delegates to it, so
  scatter and wildlife cannot silently disagree.
- The compute samples two 128² R16F maps across the park: signed obstacle
  distance and terrain height. R16F is deliberate: R32F linear filtering is
  optional on WebGPU adapters. Central differences on the signed-distance map
  steer fish around district-scale architecture; the field is a flow guide,
  not per-baluster collision.
- Carousel bulbs and Tidal Court lamps are permanent local, low-strength
  attractors. `wildlife/fish-attractor` adds one temporary gameplay/show hook
  with position, radius, strength, and duration; feeding and future props can
  use it without knowing about storage buffers. `wildlife/turtle-attractor`
  similarly drives the lagoon residents and is ready for S13 food pellets.

## Esplanade event

- The existing 15-minute `manta-flyover` schedule cue owns one 45 s hero
  composition. Every fifth school (two/four/six by tier) converges on three offset Esplanade lanes
  while the manta crosses above. Park-SDF force is reduced, not disabled, for
  these elevated schools; player avoidance remains fully active and creates
  the acceptance split.
- `?view=esplanade` holds the choreography around phase 0.43 so the fixed
  postcard camera does not have to wait five minutes for the timetable.
  Normal play always follows the scheduler.

## Species and habitats

- Six rays total: five 2.9 m rays on closed centripetal spline fields and one
  6.3 m-wide manta. Wing lift is a per-vertex TSL field; the manta analytically
  blends from its lazy park loop into the scheduled Esplanade path.
- Eight turtles use a closed spline inside the Menagerie lagoon. Feeding
  attraction blends each resident toward a distinct point around the food,
  preserving a group rather than stacking eight meshes at one coordinate.
- Jellies are two vertex-driven instanced populations: 400 moon jellies in
  Jellyfish Court and 200 bioluminescent jellies in the Grotto. Bell pulse,
  slow vertical travel, and drift all sample one phase plus `currentFlow`.
- Forty seahorses ring the carousel exterior; a curved tube silhouette, snout,
  dorsal fin, current drift, and tail-weighted sway keep the nod readable.
- S12 completes the previously reserved Menagerie footprint with three linked
  courts: a 14 m-radius jelly cloister, a 13 m Turtle Lagoon, and the glass Sun
  Garden. All anchors now live under `PARK_PLAN.menagerie`; paths are grounded
  in short plates and habitat floors/courts have Rapier colliders.

## Whale passage

- The humpback mesh is 14.21 m long with an authored tapered body, pectoral
  fins, flukes, two actual eyes, and tail-weighted TSL flex. It follows a
  non-looping centripetal path along the north drop-off.
- A 90 s `whale-passage` reserves 12 s for audio first, then 68 s of visible
  travel. The whale begins above/far enough for its shadow to cross before the
  body descends; the near-side eye passes the Overlook at guest height. Audio
  is a procedural bending sub-bass choir plus filtered deterministic breath.
- `?view=whale` holds the animal near the eye-to-eye beat. In normal play the
  passage remains on the 20-minute park schedule.

## Diagnostics and verification

- Under `?debug`, canvas `data-wildlife-state` records fish/species/school
  counts, sampled neighbors, compute steps, draw counts, hero phase, habitat
  populations, feeding response, whale phase/position, and per-archetype mesh
  budgets.
- Fixed validation views: `?view=esplanade`, `?view=whale`,
  `?view=jelly-court`, and `?view=turtle-lagoon`. Global `?pass=no-post`
  remains the lighting/material baseline.
- Offline procedural-mesh audit passed for every archetype; the largest
  repeated shape is the 298-vertex/494-triangle seahorse, and the 15k fish
  archetypes remain 65 vertices/105 triangles each. Lint, typecheck, and
  production bundle are clean without launching a GPU preview.
