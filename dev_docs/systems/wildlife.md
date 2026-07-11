# Wildlife (S12)

## Schooling-fish removal

- Scott removed schooling fish on 2026-07-11 after repeated multi-second
  gameplay freezes near schools. `FishSchoolSystem`, its compute/storage
  buffers, quality budget, field textures, species meshes, attractor event,
  and show/feeding hooks are deleted. Do not reintroduce a fish swarm without
  a new explicit request and measured GPU evidence.
- The remaining wildlife is deliberately low-count or bounded instancing:
  rays/manta, turtles, moon jellies, grotto jellies, seahorses, and the whale.

## Esplanade event

- The existing 15-minute `manta-flyover` schedule cue owns one 45 s hero
  composition. The manta alone crosses above the Esplanade; no school or
  player-split behavior remains.
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

- Under `?debug`, canvas `data-wildlife-state` records hero phase, habitat
  populations, feeding response, whale phase/position, and per-archetype mesh
  budgets.
- Fixed validation views: `?view=esplanade`, `?view=whale`,
  `?view=jelly-court`, and `?view=turtle-lagoon`. Global `?pass=no-post`
  remains the lighting/material baseline.
- Offline procedural-mesh audit passed for every retained archetype; the
  largest repeated shape is the 298-vertex/494-triangle seahorse.
