# The Submarine — Le Nautile Blanc (pilotable vehicle)

Files: `src/vehicles/submarineModel.ts` (model), `src/vehicles/submarine.ts`
(piloting system), `src/vehicles/submarineWake.ts` (propeller bubbles).
Validation bookmark: `?view=submarine`.

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
  2. Transmission glass → the park's thin transparent-pane recipe (Descent
     Bell shell) with the **AO-receiver MRT alpha 0** fix.
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

Parked at **(6, 311)**, nose north (yaw π): the mirror image of the
`park-entrance` sign (−6, 311) across the arrival road at x = 0 — sign west
of the threshold, submarine east, symmetric about the road as Scott
specified. Rest pose is `terrainHeight + SUBMARINE_REST_HEIGHT` (belly step
settles millimetres into the sand).

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

- **Collision is the guest capsule by ruling** (Scott: "same collision as
  the player person"): a 0.35 r / 1.7 m kinematic capsule at the hull axis
  with its own character controller. The hull visually overlaps structures
  the way a walking guest's view would; anywhere a guest fits, the sub fits.
- The seated guest's own body is carried at the hull axis every fixed step
  (so wildlife avoidance, wheel/pearl dock sensors, and ride exits all see
  the pilot where the sub is) and is **excluded from the sub's queries** via
  the controller filter predicate.
- Vertical envelope: floor at the rest height over `terrainHeight` (the same
  authority as physics/visuals, so basins and the drop-off cliff all work
  unmodified). The surface ceiling is not a clamp but **buoyancy** (below).
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

- **Exit only at a seabed park** (Scott's ruling, 2026-07-14): E steps out
  only when the hull rests at its terrain floor (`terrainHeight +
  GROUND_CLEARANCE`, ε 0.08). Under way — mid-water, surfaced, or perched on
  a structure (whose collider holds the capsule above the terrain floor) —
  E answers with a gentle serif reminder ("Settle on the seabed to step
  out") via the new `InteractionSystem.notice()`. This guarantees the craft
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
- Wake = `SubmarineWake`, **two regimes cross-faded by surfacedness**
  (Scott's reference photos): submerged it is a dense milky turbulent cloud
  with helical bubble glitter; surfaced it is a white boat-wake trail. Four
  GPU ring-buffer pools, all motion vertex/fragment TSL against **absolute
  elapsed time** (fountain recycling rule); the CPU only writes spawn
  records:
  - **Plume cloud** (512 puffs, ≤110/s underwater): soft milky spheres
    shed across the disc, bulk-convected and bulk-swirled down the wake,
    inflating ~2.6× over life. Fragment-stage `mx_noise` erosion (seeded,
    age-scrolled, threshold tightening with age) carves each puff into an
    irregular billow and breaks it apart downstream — volumetric and
    irregular, never uniform smoke. This is what reads as the bright cloudy
    mass; the bubbles below are the glitter inside it.
  - **Surface foam** (512 patches, ≤110/s when surfaced, scaled by speed):
    flattened pancake puffs churned out at the stern — 45 % thrown to the
    stern quarters with lateral drive (the spreading V arms), the rest
    boiling straight off the screw (the centre churn); the hull's own
    advance paints the trail. Each patch's vertex stage **samples the same
    displacement cascades the ocean renders with**, so foam is pinned to
    the true displaced surface and rides the same waves as the hull. Noise
    lacing tightens with age so sheets dissolve into lacy trailing edges.
  - **Entrained bubbles** (2304 instances, ≤700/s underwater): each
    record stores the hub centre, unit wake axis, and initial radial
    vector. The shader advects it down a decaying helix — Rodrigues
    rotation about the axis with swirl ∝ axialSpeed/(0.4+r₀), so the hub
    vortex rope corkscrews fast and tight while tip filaments turn slower;
    decaying axial convection with a slow residual; radial spreading;
    size-correlated buoyant rise after an entrainment delay; and layered
    positional + angular turbulence growing with age so filaments wander
    and unravel downstream. 72 % of spawns cluster on the eight **live
    blade angles** (± 0.12 rad) at the tip annulus — successive emissions
    trace eight real interleaved tip-vortex filaments — and the rest seed
    the hub rope. Per-spawn axial jitter (±25 %) smears the filaments into
    turbulent streaks with distance.
  - **Cavitation pockets** (128 instances): inception only above 16 rad/s
    (~73 % shaft speed), rate ramping to 220/s. Soft-bodied vapour puffs
    (full centre, faint silhouette — the inverse of a bubble's rim shell)
    shed exactly at blade tips with the tip's tangential velocity plus a
    short downstream kick, growing fast and collapsing faster (dead by
    0.88 of a 0.07–0.18 s life).
  - Both pools hide entirely once the last spawn has dissipated; bubbles
    fade approaching the displaced surface; swirl handedness about the
    wash axis is invariant under thrust reversal (sign(spin)·sign(wash)
    ≡ −1), so no sign attribute is needed.
- Emission position comes from `propeller.getWorldPosition()` — never
  hand-scaled local offsets through `localToWorld` (the group is scaled;
  pre-scaled locals double-apply).
