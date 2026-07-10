# The Torrent (S10)

## Track

- Authored closed CatmullRom (centripetal, 0.5) through ~35 control points:
  station straight → launch runway → over the rim lip → cliff-face plunge
  threading the wreck → open-void sweep at −60 → 1.75-turn helix climb
  (r 15.5, −56 → −20) → unwind shoulder → shelf return dip → booster
  straight → +2.6 m breach hump → splash re-entry → brake run → home.
  ~733 m.
- Frames: 2400 arc-length samples, parallel-transported up vectors, then
  **solved banking**: signed horizontal curvature × a design-pass speed
  profile → `atan(v²κ/g)`, clamped ±60°, box-smoothed over ±26 samples. The
  design pass runs the same integrator as the runtime before geometry is
  built, so banking always matches the ride actually driven.
- Rails/spine are TubeGeometry over tiny `Curve` adapters that read the frame
  table (offset in the banked frame); ties are one InstancedMesh; supports
  spawn only where the seabed is within 34 m (the void stays unsupported).

## Dynamics (energy-correct, plan §9.3)

- `v̇ = −g·t_y − c_d·v|v| − c_r` + zone accelerations; `ṡ = v`. Zones:
  station launch (7.2 m/s²), **helix surge** (3.4 m/s² — water jets carry
  the train up the spiral; on-theme and energy-honest), hump booster
  (6.0 m/s²), brake run (servo toward 2.2 m/s), dock capture.
- Measured lap: ~100 s, 34 m/s max in the plunge, ≥14.7 m/s everywhere after
  launch, rider's eye +0.9 m over the sea at the hump.
- **Two traps found by honest physics:**
  1. The brake zone ends AT the station mark, so a freshly-launched train is
     "inside" it — brake capture must be gated on the lap being underway
     (both in the runtime and in the design pass, or banking solves for a
     2 m/s crawl).
  2. Spline sag: a helix that hands off to a distant waypoint overshoots
     ~16 m downward (the exit tangent still spirals). Helixes need explicit
     unwind points that continue the exit tangent while leveling. Also the
     original 2.25-turn helix was an energy hole — the stall point sat
     exactly on the helix cylinder. Check stall positions against feature
     geometry before blaming the connector.

## Station & set dressing

- Station: boarding deck + gable-roofed shelter + plaza on the existing
  court→torrent path; boarding flow is board → "Lower the lap bar" →
  2.2 s → launch; exits only while docked.
- The wreck is a rib-skeleton hull (keel, nine torus ribs, leaning mast,
  scattered planks) half-buried on the cliff face at the thread-through.
- Splash/breach foam reuses the churning-fbm disc from the wheel at the two
  y = 0 track crossings.

## Testing

- Interaction prompts are view-cone gated: automated boarding tests must
  either aim the camera at the gate or invoke `interactable.onInteract()`
  directly — blind synthetic KeyE at the wrong look angle silently no-ops
  (this cost three debugging rounds; prefer direct invocation for rides).
