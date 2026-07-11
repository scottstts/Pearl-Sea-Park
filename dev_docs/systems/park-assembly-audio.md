# Park Assembly, Scheduler & Audio (S7)

## Layout authority

- `src/world/parkLayout.ts` is the source of static park anchors, authored path
  segments, and entrance markers. `src/world/parkPlan.ts` derives
  `inParkFootprint(x, z, margin)`
  (discs + capsules covering every built or reserved footprint, including the
  future wheel/torrent/menagerie/grotto sites). Anything that scatters content
  on the seabed (flora today; shells, props, wildlife rest-points later) must
  consult `inParkFootprint` — reef rocks were spawning inside the reflecting
  pool before this existed.
- S12 promoted the same footprints to `parkFootprintSignedDistance()`. The
  boolean keep-out delegates to that signed field, preserving one authority
  across scatter and habitat placement. The former schooling-field consumer
  was deleted with the fish-school system.
- `PARK_PLAN.menagerie` now owns explicit `sunGarden`, `jellyCourt`, and
  `turtleLagoon` anchors. Their cloister, dome, lagoon, grounded links, and
  colliders land with S12 wildlife rather than remaining an empty reserved
  disc.

## Paths follow terrain

- `ParkAssemblySystem.groundedPath` splits every path into ≤9 m plates, each at
  its own local terrain height (+0.02), with 0.3 m overlaps. **Never** lay one
  long plate at a fixed height: over dipping sand it floats and its sun shadow
  drapes the park in straight kilometre-wide bands (this was the mystery
  "giant diagonal shadow" — not a shadow-map artifact).
- Each plate gets a matching thin static box collider, so walking on/off paths
  is a real 0.2 m step the character controller absorbs (plazas already had
  cylinder colliders).

## The reflecting pool is single-pass

- The former TSL planar reflector was the cause of the reproducible freeze
  when the guest stood beyond the Atrium and looked north along the Esplanade.
  At that position the 52 m water disc entered the camera frustum and started
  a nested full-park render. Resolution and cadence limits did not eliminate
  its submission cost, so the reflector and its cadence helper are deleted.
- The pool is now one 48-segment disc with an analytic two-band ripple normal,
  grazing-angle color, restrained environment response, and a small dark-water
  emissive floor. It adds no render target, secondary camera, readback, or
  direction-dependent render pass.
- The basin is a lathed open **ring**; the original capped cylinder put a
  marble lid 3 cm above the water and hid the pool entirely (looked like a
  bright marble disc — cost several debugging rounds).

## ArchKit lessons

- **Ring modules are radius-keyed prototypes** (`dome-ring-8.7`,
  `plaza-curb-9.0`, `steps-cap-48.6`): uniform-scaling a unit torus scales the
  tube with the major radius (a r=8 dome wore a 1.3 m brass donut; the atrium's
  "gold balloon" mass was partly this). Tube radii are constants in meters.
- `SlotWriter.compile` sets `castShadow = false` on transparent slots — glass
  roofs/domes were throwing fully opaque plywood shadows.
- Park assembly uses 72 m material-slot chunks. Batching remains bounded by
  material within each cell, but camera and shadow frusta can reject distant
  districts instead of submitting one park-wide marble/brass mesh.
- Benches and lamps do not emit through district `SlotWriter`s. They are fixed
  prototypes owned by `ParkAmenitiesSystem`, and every placement is a complete
  instance transform. This prevents a bench or lamp from splitting across
  spatial chunks and makes every copy structurally identical.
- Bench local front is `−Z`; placement is only through `addBenchFacing()` with
  an explicit world-space focal point. Esplanade benches face its centerline,
  while Atrium and Observatory rings face their own centers. The offline audit
  rejects any placement whose forward/target dot product is not effectively 1.
- `FacilitySignsSystem` places one rooted, brass-framed marker at every facility
  threshold. All sixteen frames share three instanced material draws and all
  sixteen names share one 1024×512 (2 MB) atlas mesh, for four draws total.
  `parkLayout.ts` owns positions and arrival targets; the geometry audit checks
  unique coverage, approach-facing orientation, and walking-lane clearance.
- Facility finish is plan-driven in `world/parkFacilities.ts`: Esplanade owns a
  continuous entablature and threshold urns; Tidal Court a pearl-pedestal rim;
  Midway an arched/corniced hall and built counter rhythm; Café Méduse a full
  arcade plus curved service bar; the Observatory an armillary focal point;
  and the Overlook viewing instruments and terminal markers. Atrium and the
  Menagerie courts use the same vocabulary. Ride transitions (Pearl Line
  stations, Wheel pier head, Torrent station, Grotto portal) are finished as
  architecture without redesigning already-authored ride machinery.
- Paths retain the ≤9 m terrain-following segmentation, but each segment now
  carries two narrow marble curbs and brass longitudinal inlays. Those pieces
  merge into the existing spatial material chunks and do not create a draw per
  segment.

## Physics

- Rapier's query pipeline is only valid after the first `world.step()` — the
  heightfield raycast self-check now runs on the first `fixedUpdate`, not at
  init (init-time raycasts return no hits → false "FAIL Infinity").

## Scheduler & audio

- `SchedulerSystem` (`src/core/scheduler.ts`) emits `schedule/event`
  {name, phase} from `PARK_SCHEDULE` (chimes 5 min, fountain show 12 min,
  manta 15 min, whale 20 min). Ride/wildlife stages subscribe rather than
  keeping their own clocks, so everything stays in phase with `ctx.time.sim`.
- The clock is held at zero behind the entry ticket. Chimes and the first
  90-second fountain cue therefore begin relative to the guest's arrival, not
  an arbitrary amount of time spent on the loading/entry screen.
- Two in-world mechanical timetable boards flip on event transitions and
  15-second countdown boundaries. They render the same `PARK_SCHEDULE`
  authority used by the systems; there is no parallel UI timetable. Their
  structural furniture is a turned-post, stone-foot, brass-reveal frame with a
  conventional two-panel pitched roof in board-local coordinates. The ridge
  follows local X; the eaves follow local ±Z regardless of the whole board's
  world yaw. `audit:geometry` verifies both panels meet the ridge and eaves.
- `AudioEngineSystem` is fully procedural (pink-noise bed + breathing filter,
  detuned shimmer pad, FM bell chimes, ticket-punch thunk). The master chain
  ends in a low-pass swept 1900 Hz ↔ 16 kHz on `sea/waterline-crossed` — the
  audible half of the waterline crossing. AudioContext starts on
  `park/entered` (the enter click satisfies the gesture requirement).
- S13 updates the Web Audio listener from the camera pose every frame. The
  Kraken Bell is the first true HRTF world source (inverse distance, 90 m
  cutoff); its low body and high strike partials originate at the physical
  bell rather than the master bus. Penny presses, prizes, and ticket
  completion reuse the procedural punch/chime voices.
- S14 adds the fountain's sixteen-bar glass-and-brass cue on a persistent HRTF
  source at Tidal Court. Its gain follows the exact `fountain-show` start/end
  phases. The pause card drives the master gain, and all procedural noise and
  detune choices are now deterministic.

## Verification workflow additions

- The preview tab is usually **hidden**: rAF never fires, stats read 0–5 FPS,
  and `ctx.time.frame` freezes. This is NOT a perf collapse — screenshots
  still work, and frames can be driven manually via
  `registry.fixedUpdate/update + pipeline.render()` from `preview_eval`.
- In `?view` mode DevOrbit owns the camera: set `orbit.controls.target` (+
  `camera.position`, then `controls.update()`) — a bare `camera.lookAt` is
  overwritten the moment the window becomes visible.
