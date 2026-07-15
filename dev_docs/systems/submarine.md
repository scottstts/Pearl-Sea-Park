# The Submarine — Le Nautile Blanc (pilotable vehicle)

Files: `src/vehicles/submarineModel.ts` (model), `src/vehicles/submarine.ts`
(piloting system), `src/vehicles/submarineWake.ts` (underwater propeller
bubbles), `src/sea/wakeFoamMap.ts` (surface wake foam field, owned by the
sea), and `src/physics/vehicleStructureColliders.ts` (vehicle-only building
envelopes). Validation bookmark: `?view=submarine`.

## Model provenance & scale

- The hull is a **verbatim port of `refs/submarine.html`** ("Le Nautile
  Blanc"): the design contract `D`, palette, geometry kit (grid lofts with
  analytic normals, lathes, sweeps, fin lofts), the 2048×1024 painted detail
  atlas (R = window cut-outs, G = gold leaf, B = grime), quilt normal map,
  gauge faces, and every sculpted part. Do not "improve" its numbers — the
  reference file is the authority for any future geometry question.
- `SUBMARINE_SCALE = 1.22`: the reference is authored in true metres for one
  occupant (~4.2 m); ×1.22 lands at ~5.1 m — the envelope of a real luxury
  personal submersible — without touching any authored proportion.
- Four deliberate adaptations for the park pipeline (geometry untouched):
  1. Material noise fields sample **positionGeometry, not positionWorld** —
     the vehicle moves, and worldspace patterns crawl (the carousel rule).
  2. Dome and window glass use the reference's physical dielectric recipe:
     transmission 1, IOR 1.52, 5 cm optical thickness, subtle cyan volume
     attenuation, clearcoat, and PMREM reflection. Three r185 captures the
     opaque viewport for refraction inside the existing scene pass; the glass
     still writes **AO-receiver MRT alpha 0** and no depth.
  3. Lamp emission recalibrated into the park's HDR hierarchy (reference
     values were tuned for an ACES studio at exposure 1).
  4. Every lit material takes `medium.applyCaustics`. Materials are
     `MeshPhysicalNodeMaterial` — clearcoat/sheen work fine in the pipeline
     since Physical extends Standard (caustics, MRT, fog all inherit).
- The model stays ~120 individual meshes (the reference's part structure,
  incl. `scale.x = −1` mirrored fins, which the renderer handles via
  negative-determinant winding). Merging buckets would need manual index
  flips for mirrored parts — not worth the risk for one hero vehicle.

## Berth

Parked at **(9, 311)**, nose north (yaw π), east of the arrival road and 3 m
farther from the arrival tower than its original berth. It remains beside the
`park-entrance` sign and easy to reach. Rest pose is the supporting solid surface plus
`SUBMARINE_REST_HEIGHT` (the belly step is the ground contact).

## Piloting contract

- **E to board** (prompt "Pilot the submarine", gated on the guest actually
  walking free), **E again to step out** — both through the interaction
  system. While at the helm `InteractionSystem.exclusive` focuses the single
  "Step out" prompt: a roaming vehicle passes every gate/game in the park,
  and without focus an E meant for the helm could board a ride.
- Third-person chase camera: close framing at 7.0 m back / 2.7 m up
  (the hull fills a good share of the frame; the eye still clears the dome),
  look-ahead 6.5 m, exponentially damped position (5.5/s) and look target
  (8.5/s); smooth blends in/out (the VehicleSeatRig pattern, but the rig
  itself is first-person-seat-shaped so the sub has its own camera). Blend
  orientations are built with `Matrix4.lookAt` — camera convention, −z at
  the target; a plain `Object3D.lookAt` aims +z and faces exactly backward.
- Steering: W/S thrust (9 / 3.6 m/s), A/D yaw (0.85 rad/s), Space/Shift
  ascend/descend (3.4 m/s), all exponentially eased; release eases to a
  dead stop — **the craft holds station in x, y, z with no input** (no
  drift, no gravity, no buoyancy). Cosmetic pitch with vertical speed and
  bank into turns at speed; the helm wheel turns with A/D.
- The pose is fixed-step authoritative with **render interpolation via the
  loop's `alpha`** — a 60 Hz kinematic body rendered raw looks choppy at
  other refresh rates.

## Collision & envelope

- The movement probe remains the guest-sized capsule by ruling (Scott: "same
  collision as the player person"): a 0.35 r / 1.7 m kinematic capsule at
  the hull axis with its own character controller. It collides with every
  ordinary Rapier structure collider.
- Buildings need a second collision representation because their normal
  colliders intentionally describe walkable floors, posts, and rails rather
  than solid interiors. `vehicleStructureColliders.ts` adds broad 3D envelopes
  for enclosed domes, roofed halls/stations, the carousel, Great Wheel sweep,
  and arrival structure. The submarine query sees these envelopes; the guest
  controller explicitly filters them, so facilities remain enterable on foot.
  Their active collision types also exclude dynamic game pieces: these are
  vehicle query geometry, not invisible walls for midway toys.
- The seated guest's own body is carried at the hull axis every fixed step
  (so wildlife avoidance, wheel/pearl dock sensors, and ride exits all see
  the pilot where the sub is) and is **excluded from the sub's queries** via
  the controller filter predicate.
- Vertical envelope: floor at the rest height over the highest real support
  sampled across the scaled model's ~0.56 × 0.41 m lowest belly-step footprint
  (centred at local z +0.3 m), not beneath the hull-axis capsule.
  `PhysicsSystem.highestStaticSupportY` raycasts downward
  through upward-facing fixed colliders, so station floors, plazas, terraces,
  decks, and future solid floors support the visible step even when the small
  movement capsule misses them at an edge. Dynamic/kinematic bodies, sensors,
  coarse terrain heightfields, and broad vehicle-only building envelopes are
  excluded. Exact seabed `terrainHeight` is the fallback; `pavedWalkways.ts`
  supplies exact plate tops so paving remains aligned with its render mesh.
  The surface ceiling is not a clamp but **buoyancy** (below).
- **Surface floating (semi-physics)**: `sea/buoyancyProbe.ts` samples the
  TRUE displaced wave height at three hull points (bow, stern, starboard
  beam) on the GPU — same cascades + fixed-point choppy correction as the
  waterline probe, own storage buffer, async CPU readback, and it never
  touches the waterline probe's same-frame visual state. Near the surface a
  damped spring (4.0/3.2, stiffening to 12/5 once the axis breaches — water
  pushes back harder than it lets go) heaves the hull with the rendered
  swell instead of pinning it at y = 0; bow/stern and beam height
  differences become smoothed wave pitch/roll, weighted by surfacedness.
  Arriving at full ascent overshoots and plops, then settles into the bob.
  Space cannot fly the hull out (spring owns up-motion in the float band);
  Shift dives away normally. Probe dispatches only while under way within
  8 m of the surface; a failsafe ceiling sits 0.75 m over the local wave.
  The dome and collar ride above the waves half-surfaced; the ocean shader
  owns the pierce (no-bespoke-foam ruling).
- **The bob must survive the camera** (Scott's sighting: "the sub stays
  still and the ocean moves"): a chase eye that follows the hull's heave
  1:1 cancels the bob on screen no matter how well physics tracks it. The
  eye keeps its own height reference — vertical follow at 0.45/s (vs
  5.5/s planar) blending back to full speed once the height error exceeds
  ~0.7 m (genuine dives/climbs) — while the LOOK target keeps tracking
  fast, so the hull visibly ebbs and flows in frame. `?debug` exposes
  `canvas.dataset.submarine` (y, probe heights, surfacedness, wave
  attitude) as numeric evidence of the coupling.
- **Force field**: circle centre (0, 10), radius 380 m — encloses every
  attraction including the Torrent abyss helix and the arrival buoy. Soft
  quadratic inward current over the last 28 m, hard wall at the radius.
  Invisible by design.

## Parked state & exit gating

- **Exit only at a valid ground park**: E steps out only when the belly step
  rests at the detected seabed or real fixed floor (`supportHeight +
  GROUND_CLEARANCE`, ε 0.08). Mid-water or surfaced, E answers with a gentle
  serif reminder via `InteractionSystem.notice()`. This guarantees the craft
  is always walk-up re-enterable and never moves unmanned; the earlier
  settle-on-exit auto-descent is REMOVED — do not resurrect it (an unmanned
  descent could ground the hull on a dome or ride).
- `InteractionSystem.notice(text, seconds)` borrows the prompt caption
  (no key chip) for a refused-action reminder; the active interactable's key
  stays live under it, and `dismissNotice()` retires it early when the
  refused action succeeds. Notices stay in the interaction system — the
  never-build-bespoke-prompt-UI rule holds.
- A kinematic **blocker cylinder** (r ≈ 2.87 m) stands in for the hull
  footprint while parked (solid-structure rule: guests must not walk through
  it); it drops to y = −500 while under way. Both the blocker and the guest
  capsule are excluded from the sub's own collide-and-slide.
- Exit places the guest 3.5 m to starboard (clear of the blocker + capsule
  radius); the camera hand-back lands exactly on the walking eye height so
  the cut is invisible.

## Propeller & wake

- The screw spins only under input: spin-up 3.0/s toward
  `22 rad/s × (0.35 + 0.65·command)`, coast-down 1.1/s — reverse thrust
  spins it the other way.
- **A fast screw is an illusion, never a keyframe at the true rate**: an
  8-blade wheel strobes at render cadence above ~10 rad/s. The mesh
  rotation is clamped to 9 rad/s; a brass motion-blur annulus (chord-
  weighted smear with eight faint ghost-blade arcs) fades in over
  7→14 rad/s, the real blades hide once it carries the read (blur > 0.65),
  and the ghost arcs drift at 10 % of shaft rate — the film-camera
  wagon-wheel look. The disc is a **sibling** of the spinning group, its
  pattern rotated only by the slow `ghost` uniform: parented to the shaft
  it would strobe exactly like the blades it replaces.
- Wake has exactly **two mutually exclusive regimes**, gated on the CPU at
  `surfacedness >= 0.3`:
  - **Underwater bubbles only** (`SubmarineWake`, 3200/5200/7200 instances,
    ≤1600/s): small bubbles are seeded uniformly across the propeller disc.
    Each record stores only its origin, downstream drive, and spawn time; the
    shader adds simple decaying wash drift, buoyant rise, and a slight
    wobble. Diameters are 6–22 mm and biased toward the small end. There is
    no aeration cloud, cavitation, spray, vortex filament, helical path, or
    other underwater wake layer. Validation modes `?pass=wake-layers`,
    `wake-age`, `wake-flow` inspect this pool.
  - **Surface foam is part of the OCEAN, not a drawn effect** (2026-07-15
    redesign): the craft splats gaussian deposits into the sea's persistent
    wake-foam field (`sea/wakeFoamMap.ts`) and the detailed ocean sheet reads
    them through its own whitecap pipeline (see sea-and-sky.md). Per frame,
    at most 8 stamps: stern churn at the prop hub (spin-driven, so a pivot
    turn scribes its arc), a 3×2 stern fan opening at the Kelvin cusp angle
    `atan(tan(asin(1/3)))` ≈ 19.47°, and a leading-edge bow splat — the fan
    and bow gate on `wayOn` (speed), churn on spin alone. The long far V
    arms are deliberately NOT painted: in real wakes the persistent foam is
    the widening turbulent band (diffusion provides the widening); far arms
    are wave texture. Consequences that are the point: the trail persists
    when the throttle drops or the craft dives (no instant regime cull),
    re-crossing your own wake refreshes it instead of erasing it (max()
    deposits, no pool recycling), and foam can never float above or dip
    under the water because it is a shading property of the surface itself.
- Emission position comes from `propeller.getWorldPosition()` — never
  hand-scaled local offsets through `localToWorld` (the group is scaled;
  pre-scaled locals double-apply).
- **Screw sound**: `vehicle/submarine-running` events (start/stop with spin
  hysteresis 1.2/0.6 rad/s, plus continuous `spin` 0..1 re-emits) drive a
  dedicated hum voice in the audio engine — deeper than the winch hums
  (34–56 Hz shaft sine + near-octave partial + bandpass noise) with a slow
  throb on the noise texture only and every pitched element swept by spin,
  so throttle-up rises and the ~3 s coast-down audibly winds back down. The
  voice routes through its own lowpass keyed to the camera medium (260 Hz
  submerged / 2.4 kHz topside): muffled from underwater, clearer with the
  dome in the air. Loudness rides spin on a dedicated gain node (so the
  coast-down tapers the voice before the stop even fires), and the stop is a
  long anchored exponential tail (τ 1.3 s), never a cut — sources halt only
  once the envelope is far below audibility.
