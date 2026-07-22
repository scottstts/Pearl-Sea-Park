# Wildlife (S12)

## Schooling-fish removal

- Scott removed schooling fish on 2026-07-11 after repeated multi-second
  gameplay freezes near schools. `FishSchoolSystem`, its compute/storage
  buffers, quality budget, field textures, species meshes, attractor event,
  and show/feeding hooks are deleted. Do not reintroduce a fish SWARM (GPU
  boid compute) without a new explicit request and measured GPU evidence.
- The remaining wildlife is deliberately low-count: a curated GLB cast on
  authored paths (below) plus bounded vertex-TSL instancing for the
  Menagerie exhibits and seabed micro-fauna. No compute, no storage
  buffers; the moving cast costs ~70 mixers, most distance-gated.

## GLB animal cast (2026-07-22)

Scott's ruling: procedural animal meshes are done ("just not the level of
fidelity i want"). Every MOVING animal is now a free authored GLB playing
its exact authored animation. Raw downloads stay untouched in
`assets/glb_raw/`; the game loads compressed copies from `public/fauna/`
(133–519 kB each, ~2.6 MB total for eight species — shark, hammerhead,
blue whale, eagle ray, crab, angelfish, tuna, seahorse).

- **Offline pipeline** (gltf-transform, run out-of-repo; contract enforced
  by `scripts/audit-fauna-assets.mjs`): dedup → resample → prune → weld →
  simplify (shark 0.55, crab 0.65 — heroes keep full detail) → meshopt
  (`EXT_meshopt_compression` + `KHR_mesh_quantization`) → WebP textures
  (normals q88, everything else q78; 1024 px for shark/hammerhead/whale/
  ray, 512 px for the small species). Material normalization is
  deliberate: spec-gloss → metal-rough (shark), then unlit / clearcoat /
  specular / ior extensions removed — DISPOSE the extension object, not
  per-material nulls, or `extensionsUsed` keeps advertising them. The
  crab was authored UNLIT; delitting it here is what lets it take sun,
  shadow, and caustics. NEVER simplify a rig whose clip animates MORPH
  TARGETS (the seahorse's fin flutter rides `weights` channels) — meshopt
  alone got it to 361 kB with all 28k triangles.
- **Alpha rule**: the angelfish shipped alphaMode BLEND on body and fins.
  Transparent meshes don't write depth and the underwater fog is a
  depth-driven HDR composite — BLEND fish would ghost unfogged. Body →
  OPAQUE, fins → MASK (cutoff 0.35).
- **Clip rules**: never route-follow a clip with root motion — the
  shark's 'circling' clip translates 62 units (a baked orbit) and was
  stripped; only in-place clips ship ('swimming', 'Action', 'Take 001',
  'Swim cycle', 'Animation', 'Swim3_Long_Wide', 'Tuna_Swim' ×2). And
  PROFILE a clip's activity before shipping it: the angelfish's 43 s take
  is completely motionless for its first 28 s (random spawn phases parked
  most fish in the dead stretch — Scott read it as "animation is gone"),
  so the manifest's `clipWindow` trims it to the active final 15 s at
  load. The offline activity profiler lives in the session notes
  (per-bucket bone-velocity sweep).
- **`wildlife/faunaAssets.ts` (FaunaLibrary)**: GLTFLoader + MeshoptDecoder
  (`three/addons`), loaded in `WildlifeSystem`'s async `init` — the
  registry awaits it (the audio-engine precedent). Normalization measures
  the SKINNED bind pose, never mesh-node bounds: these rigs transform
  meshes through the armature (the blue whale's skeleton is 5.6× its mesh
  node; the tuna's mesh node stands vertical while the skeleton swims
  horizontally). Real-scale manifest: shark 3.2 m, hammerhead 3.5 m, blue
  whale 24 m, eagle ray 2.2 m span, angelfish 0.30 m, tuna 1.4 m, crab
  0.28 m leg span. The eagle ray is +X-forward (yawFix −π/2); all others
  +Z. Materials convert to `MeshStandardNodeMaterial` (metalness pinned at
  0.04, per-species roughness floors) so `medium.applyCaustics` can hook
  `receivedShadowNode`; underwater haze needs no per-material work.
- **spawn()** = SkeletonUtils clone sharing geometry/materials, plus its
  own AnimationMixer on the authored clip with per-instance phase and
  timeScale (the eagle ray plays at 0.55× — the authored 1.7 s wingbeat is
  too frantic for a 2 m ray). Mixers AND matrix-world walks are
  distance-gated via `instance.setActive` (angelfish pairs 140 m, crabs
  80 m); the camera-local drifters gate on their own wall fade.
- **NO per-mesh frustum culling on fauna** (Scott's 2026-07-22 pop
  report: animals vanished while partially in shot; whale/hammerhead/
  fish/crab never drew at all). Root cause: SkinnedMesh culls by a sphere
  in "attached"-bind-mode mesh space, and these rigs transform their
  meshes THROUGH the armature — the sphere lands in the wrong place
  (mildly wrong for the near-identity shark/ray rigs → edge pops; wildly
  wrong for the armature-scaled whale, the vertical-mesh-node tuna, and
  the multi-skin hammerhead/angelfish → never visible). `frustumCulled =
  false` on every fauna mesh; the cast is a few dozen animals, the small
  species are hard-gated, and the rasterizer clips the rest.
- **Cast wiring** (behavior parity is the rule — "this asset replacement
  should be mesh only"): the reef shark, hammerhead, and blue whale roam
  OVER-PARK RINGS (Scott's drawing) — big, overall-circular loops that
  enclose the guest districts and cross the arrival threshold every lap:
  `shark-park-ring` 945 m / 7.9 min CCW at 17.5 m clearance,
  `hammerhead-park-ring` 867 m / 8.5 min CW at 17.8 m,
  `blue-whale-park-ring` 1005 m / 9.3 min at 20.8 m (its western arc
  glides straight over the Sun Garden dome; entrance passes 6 / 11.3 /
  5.5 m). Speeds run at the energetic end of each species' real range so
  laps stay in single-digit minutes; with staggered phases + directions
  something big crosses the threshold every ~2–3 minutes. Five ambient
  eagle rays keep their local circles 8–17 m up. Emperor angelfish live
  as PAIRS (2 × up to 6 garden patches — territorial pair fish, not
  schoolers). ~90 × tier crabs ALL live in the walkway-verge tuft band at
  2× display scale (42–73 cm spans — Scott's final ruling: verges are
  the only places the player actually goes and looks;
  `CRAB_FACING_FLIP` in seabedLife.ts if the walk clip turns out to lead
  with the other flank). Seventy-two GLB seahorses hover the carousel
  ring at 2× display scale (33–61 cm, Scott's ruling over field-guide
  size), one cluster-level gate sleeping the herd beyond 120 m.
- **Still procedural** (no replacement assets provided): turtles,
  jellies, sun butterflies, the humpback whale-passage hero, garden
  eels, scallops. They swap the same way the moment assets exist (the
  seahorses did exactly that on 2026-07-22).
- **`scripts/audit-fauna-assets.mjs`** (runs inside `npm run
  audit:geometry`): per-file byte ceiling (1.1 MB), required clip names,
  triangle budgets, skinned-rig presence, WebP-only textures, and an
  extension whitelist. A careless re-export fails offline, not in a
  screenshot.

## Fish & seabed life

- The MAIN fish population is the camera-local drifter wrap box, exactly
  the old behavior with GLB bodies (Scott's parity ruling): ~38 × tier
  emperor angelfish always swimming near and around the guest, plus a few
  yellowfin tuna cruising through as the big-loner layer the teal wrasse
  used to be. Same 24×8×24 m box centered 3 m above the eye, same
  world-anchored straight cruises re-tiled around the camera, same
  scale-fade at the walls and the waterline — but the wrap math is CPU
  now (a few dozen roots), so the old viewCenter-vs-cameraPosition caster
  trap no longer exists: there is no shader-side camera dependency, and
  shadows agree for free. NO distant fish (standing ruling); angelfish
  pairs on the garden patches carry the anchored-school role.
- `wildlife/seabedLife.ts` still owns the vertex-TSL micro-fauna:
  - Garden eels sway in the current and telescope into the sand as the
    camera nears (`cameraPosition` read in the vertex stage, thresholds
    staggered per eel so lawns ripple down ahead of a walking guest).
  - Scallops breathe open (~22°) and clap shut in rare desynchronized
    bursts; the upper valve rotates about the authored hinge, yaw lives in
    per-instance facing attrs, normals get the same rotations.
  - Crabs are GLB clones and 100% of them live in the walkway-verge tuft
    band (`sampleParkVergePoint`, 0.5–5.5 m off the path edge — the same
    sampler flora plants those tufts with; Scott's final ruling: the
    verges are the only places the player actually goes and looks).
    These draws deliberately SKIP the park-footprint filter, whose 2.2 m
    margin had silently rejected the entire verge band since the
    procedural era — which is why path-side crabs never existed until
    the placement CENSUS caught it (replicate the exact spawn logic
    offline, same seed + fork labels, and histogram
    distance-to-nearest-path before trusting any "guests will run into
    them" claim). Flat ground only (slope < 0.045), visibility gate
    100 m, 2× display scale (42–73 cm spans, Scott's ruling).
    They SHUFFLE: a short back-and-forth line with eased stops, the walk
    clip playing IN REVERSE on the way back (negative mixer.timeScale),
    the line's heading wandering slowly plus a small cross-line drift —
    Scott's requested behavior.
- No colliders (walk-through ruling); eels/scallops keep `markMainDetail`
  + receiveShadow; crabs stay non-casting like before.
- `auditFaunaGeometry()` still gates the REMAINING procedural archetypes
  (turtle, jelly, seahorse, sun butterfly, humpback, eel, scallop) inside
  `npm run audit:geometry`.
- Debug: `?view=fish` holds an angelfish pair; snapshot counts ride
  `data-wildlife-state` as before.

## Esplanade event

- The 15-minute cue is `ray-flyover` now (renamed from `manta-flyover`
  when the procedural manta retired): the eagle-ray SQUADRON — three GLB
  rays in echelon at the species' honest top scale (2.6–2.9 m spans) —
  crosses above the Esplanade for the same 45 s beat, idling over the
  west sand between shows. Three marble-crossing shadows instead of one.
- View/bookmark/postcard renamed `manta` → `rays` everywhere
  (scheduler.ts, wildlifeSystem.ts, postcards.ts).
- `?view=esplanade` holds the choreography around phase 0.43 so the fixed
  postcard camera does not have to wait five minutes for the timetable.
  Normal play always follows the scheduler.

## Species and habitats

- Rays: five GLB eagle rays (1.9–2.6 m spans) glide the closed centripetal
  spline circles 8–17 m up — deliberately ABOVE the shark band so the two
  layers read separately — plus the three-ray flyover squadron.
- Pelagic rings live in `wildlife/pelagicRoutes.ts` (authored waypoints,
  no jitter — that's what makes clearance auditable; waypoint y =
  terrainHeight + clearance). Third same-day revision, per Scott's
  drawing: the rings circle ABOVE THE PARK ITSELF, enclosing the guest
  districts, not the outside sand. Altitude (17.5–20.8 m) is what makes
  that possible — the animals overfly the built skyline and cross the
  Pearl corridor ABOVE the cable, while full-height hazards (the
  breaching Great Wheel, Descent Bell shaft, Torrent station, Pearl
  stations, submarine berth, Esplanade vault, Midway hall) are dodged
  horizontally. `pelagicRoutesAudit.ts` is height-aware accordingly:
  full-height discs/capsules keep 2D margins; overflyable structures
  (plazas, courts, the sun dome at its exact 13.8 m, signs, pylons up to
  their local cable height) require the species' BODY BOTTOM (belly or
  fluke downstroke) to clear the top by ≥1.2 m; the cable band is legal
  above the hardware or below the cabin sweep (±1.5 m); plus the Torrent
  track (3D), terrain band, and entrance-pass contract — wired into
  `npm run audit:geometry`. The audit caught the Pearl loop's WESTERN
  return leg riding ~0.7 m above cruise height, which set the final
  clearances. `?view=pelagics` looks up from the threshold.
- Pearl Line interaction rules for low fauna: the cable descends to dock
  height near both stations, so cabins sweep through the 0–14 m band
  there — routes must cross the cable line only where cabins stay ≥1.5 m
  above the animal's top point (audited via a cabin-envelope gap check),
  and must clear a conservative every-60 m pylon-candidate superset by
  ≥5 m. Path lamps top out at 3.74 m, so ≥5.2 m cruise clearance overflies
  all walkway furniture.
- Eight turtles use a closed spline inside the Menagerie lagoon. Feeding
  attraction blends each resident toward a distinct point around the food,
  preserving a group rather than stacking eight meshes at one coordinate.
- Jellies are two vertex-driven instanced populations: 400 moon jellies in
  Jellyfish Court and 200 bioluminescent jellies in the Grotto. Bell pulse,
  slow vertical travel, and drift all sample one phase plus `currentFlow`.
- Seventy-two GLB seahorses ring the carousel exterior at 33–61 cm —
  2× real-species scale by Scott's explicit ruling (display creatures
  beat field-guide accuracy here) — playing their authored sway clip,
  bones plus morph-target fin flutter, over a gentle CPU drift/bob on
  the same ring the procedural ones held.
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
- Fixed validation views: `?view=esplanade`, `?view=rays`, `?view=whale`,
  `?view=pelagics`, `?view=fish`, `?view=jelly-court`, and
  `?view=turtle-lagoon`. Global `?pass=no-post` remains the
  lighting/material baseline. (A `?view=crabs` bookmark existed briefly
  and was removed at Scott's request — crabs are on the flora clusters
  now, findable by eye.)
- Offline audits: `auditFaunaGeometry` covers the retained procedural
  archetypes; `audit-fauna-assets.mjs` covers the compressed GLB cast.

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

## 2026-07-13 craft pass (jelly / whale — the ray notes retired with the procedural rays, 2026-07-22)

- Jelly: the bell sweeps over the rim into an inner subumbrella surface
  (real rim thickness and an underside vault), an 8-lobe scallop rides the
  rim rows, and the fringe is twelve kinked strand ribbons plus four
  ruffled oral arms off the manubrium. Morph channels are unchanged, so the
  established pulse/dart/billow animation drives the richer mesh as-is
  (~250 verts × 400 instances — fine for a court-local population).
- Whale: nine body rings, ventral throat pouch, LONG thick knobbed
  pectorals (appendGeometry-transformed spheres with tipward flap weights —
  the humpback signature), stubby dorsal, and two broad thick fluke lobes
  whose root overlap forms the trailing notch. Hide: pleat lines and
  barnacle crust (chin + fin leading edges) share one field stack; the
  roughness channel follows both.
