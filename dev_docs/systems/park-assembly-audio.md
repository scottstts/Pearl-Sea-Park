# Park Assembly, Scheduler & Audio (S7)

## Layout authority

- `src/world/parkPlan.ts` is the **only** source of park geometry facts. S7 added
  `PARK_PATHS` (every mosaic path segment) and `inParkFootprint(x, z, margin)`
  (discs + capsules covering every built or reserved footprint, including the
  future wheel/torrent/menagerie/grotto sites). Anything that scatters content
  on the seabed (flora today; shells, props, wildlife rest-points later) must
  consult `inParkFootprint` — reef rocks were spawning inside the reflecting
  pool before this existed.
- S12 promoted the same footprints to `parkFootprintSignedDistance()`. The
  boolean keep-out delegates to that signed field, and wildlife bakes it to a
  128² R16F flow map. This preserves one collision/layout authority across
  scatter, habitat placement, and GPU schooling behavior.
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

## The reflecting pool is a planar reflector

- PMREM env reflection can never draw scene geometry, so a "reflecting pool"
  built from a glossy standard material reads as milk. The pool uses the TSL
  `reflector()` (r185 core): `resolutionScale 0.35`, `generateMipmaps`,
  sampled at `levelNode = 3` for a soft-focus dream mirror; UV wobbled by the
  same ripple field that drives `normalNode` (offset ≤0.012 — bigger offsets
  alias the low-res mirror into checkerboard moiré).
- The mirrored Silver Ceiling is HDR-huge: Reinhard-squash
  (`rgb/(rgb+1)`) + tint before blending, and blend with a plane Fresnel
  (`facing = normalize(camera − pos).y`) so steep views read the dark basin.
- Reflection lives in `emissiveNode` (black base color, env 0) so the lighting
  pipeline leaves it alone; roughness 0.08 keeps a live sun glint from
  `normalNode`.
- Do **not** call `.level()` / `.blur()` on a ReflectorNode — they clone the
  node and clones never receive the live RT texture. Set `levelNode` directly.
- The pool reflector has `bounces: false` and reuses its scene texture for one
  intervening application frame. Animated ripple UVs continue every frame, so
  the soft mip-3 mirror stays fluid while its secondary scene render is capped
  at half display cadence. The virtual camera disables the main-detail layer
  (particulates, bubbles, jellies); architectural silhouettes, sky,
  lighting, hero wildlife, and the ceiling remain reflected.
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
