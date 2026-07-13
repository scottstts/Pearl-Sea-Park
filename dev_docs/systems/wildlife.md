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

## 2026-07-12 standing-issues update

- Turtle feeding is removed by ruling (station, pellets, attractor event,
  attraction steering). The lagoon has a real water section now: sandy bed
  disc at +0.22, remade surface at +0.46 (depth gradient, swell + wake-ring
  normals, rim foam) — the old disc z-fought the plaza plate coplanarly,
  which read as a star-shaped flicker through the circle fan.
- Turtles and seahorses are re-sculpted (scute-stepped carapace, paddle
  flippers with thickness; tapered tube seahorse with curled tail); jellies
  gained pulse-darting, tentacle billow, and breathing emissive.
- Sun Garden holds the "flowers and butterflies" promise: sun lantern,
  anemone/frond parterre, planters, benches, and 44 GPU-fluttered sea
  butterflies (instanceOrigin/instancePhase pattern, zero per-frame CPU).
- The menagerie junction is a roundabout plaza; garden spokes start at its
  rim. Grotto jellies are gone with the Grotto.

## 2026-07-13 craft pass (jelly / ray / whale geometry)

- Jelly: the bell sweeps over the rim into an inner subumbrella surface
  (real rim thickness and an underside vault), an 8-lobe scallop rides the
  rim rows, and the fringe is twelve kinked strand ribbons plus four
  ruffled oral arms off the manubrium. Morph channels are unchanged, so the
  established pulse/dart/billow animation drives the richer mesh as-is
  (~250 verts × 400 instances — fine for a court-local population).
- Ray: denser swept-wing grid (tips trail back and droop past ¾ span), a
  genuine tapering 6-ring tube tail carrying the swim wave (morph
  0.25→0.9 — the old tail was one flat triangle), eye bumps, and thick
  cephalic lobes on the manta. Wing material is countershaded with an
  eagle-ray spot constellation over the back only — `positionGeometry`
  fields, so patterns are body-locked, never world-crawling.
- Whale: nine body rings, ventral throat pouch, LONG thick knobbed
  pectorals (appendGeometry-transformed spheres with tipward flap weights —
  the humpback signature), stubby dorsal, and two broad thick fluke lobes
  whose root overlap forms the trailing notch. Hide: pleat lines and
  barnacle crust (chin + fin leading edges) share one field stack; the
  roughness channel follows both.
