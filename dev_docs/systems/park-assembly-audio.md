# Park Assembly, Scheduler & Audio (S7)

## Layout authority

- `src/world/parkPlan.ts` is the **only** source of park geometry facts. S7 added
  `PARK_PATHS` (every mosaic path segment) and `inParkFootprint(x, z, margin)`
  (discs + capsules covering every built or reserved footprint, including the
  future wheel/torrent/menagerie/grotto sites). Anything that scatters content
  on the seabed (flora today; shells, props, wildlife rest-points later) must
  consult `inParkFootprint` — reef rocks were spawning inside the reflecting
  pool before this existed.

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
- Benches viewed end-on read as a single iron hoop (both scroll sides line
  up); intentional, but seat-facing choices should consider the main view axis.

## Physics

- Rapier's query pipeline is only valid after the first `world.step()` — the
  heightfield raycast self-check now runs on the first `fixedUpdate`, not at
  init (init-time raycasts return no hits → false "FAIL Infinity").

## Scheduler & audio

- `SchedulerSystem` (`src/core/scheduler.ts`) emits `schedule/event`
  {name, phase} from `PARK_SCHEDULE` (chimes 5 min, fountain show 12 min,
  manta 15 min, whale 20 min). Ride/wildlife stages subscribe rather than
  keeping their own clocks, so everything stays in phase with `ctx.time.sim`.
- `AudioEngineSystem` is fully procedural (pink-noise bed + breathing filter,
  detuned shimmer pad, FM bell chimes, ticket-punch thunk). The master chain
  ends in a low-pass swept 1900 Hz ↔ 16 kHz on `sea/waterline-crossed` — the
  audible half of the waterline crossing. AudioContext starts on
  `park/entered` (the enter click satisfies the gesture requirement).

## Verification workflow additions

- The preview tab is usually **hidden**: rAF never fires, stats read 0–5 FPS,
  and `ctx.time.frame` freezes. This is NOT a perf collapse — screenshots
  still work, and frames can be driven manually via
  `registry.fixedUpdate/update + pipeline.render()` from `preview_eval`.
- In `?view` mode DevOrbit owns the camera: set `orbit.controls.target` (+
  `camera.position`, then `controls.update()`) — a bare `camera.lookAt` is
  overwritten the moment the window becomes visible.
