# The Torrent (S10)

## Track

- Authored closed CatmullRom (centripetal, 0.5) through ~33 control points:
  station straight → launch runway → over the rim lip → cliff-face plunge
  threading the wreck → open-void sweep with a −64 valley → 1.5-turn helix
  climb (r 15.5, −56 → −20, phase θ₀ = 90° so the entry tangent IS the
  westbound sweep direction and the exit is the eastbound unwind — no
  turnaround points anywhere) → unwind shoulder → shelf return dip →
  booster straight → +2.6 m breach hump (wide −4 shoulders) → splash
  re-entry → one even 180° brake arc → home. ~720 m.
- Frames: 2400 arc-length samples with **scalar-bank analytic frames** (see
  the 2026-07-12 ride-feel pass below): signed bank angle
  `atan2(min(v²·κ_lateral, g·tan 0.55), g)` in the zero-roll frame, smoothed
  as a scalar over ±32 samples, then `up = refUp·cos b + side·sin b`. The
  design pass runs the same integrator as the runtime before geometry is
  built, so banking always matches the ride actually driven.
- Rails/spine are TubeGeometry over tiny `Curve` adapters that read the frame
  table (offset in the banked frame); ties are one InstancedMesh; supports
  spawn only where the seabed is within 34 m (the void stays unsupported).

## Dynamics (energy-correct, plan §9.3)

- `v̇ = −g·t_y − c_d·v|v| − c_r` + zone accelerations; `ṡ = v`, all through
  the ONE shared `trackAccel()` (runtime + design pass + lap simulator).
  Zones: station launch (2.4 m/s²), **helix surge** (2.9 m/s², first 60% of
  the helix only — the jet dies and the last turns climb on momentum), hump
  booster (13 m/s²), brake run (8 m/s cruise + √-ease onto the platform,
  decel capped 8 m/s²), exact-landing dock.
- Measured lap: ~59 s with a real rhythm — launch 15, plunge 28.6 max,
  helix decaying to a 12.8 crest, shelf-saddle drift 6.1, breach hump ~16,
  splash 22, brake cruise 8.
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
- The train (2026-07-12 redesign) is five japanned hydro-sleds: deep
  torrent-teal lacquer hulls (CatmullRom profile, 36 radial segments — the
  camera rides centimetres away) over brass running trim. Craft rules baked
  in: panel seams are radius-keyed tori BOUNDING hull bays, never crossing
  the cockpit opening, with instanced rivet studs (castShadow off — tiny
  fittings); the cockpit is an inward-wound open lathe tub with leather
  bolster/squab/backrest genuinely inside; screen mounts, deck spine, and
  lamp stems are point-to-point members; stern is a verdigris cowl around a
  tapered venturi throat (a bare cone apex read as a spike) with three
  thickness-bearing swept fins; bow carries a wave-cutter blade and
  half-embedded nacre pearl. Head car has a bow lamp, tail car a stern
  lantern (lampGlobe, inside bloom hierarchy). Every extreme stays inside
  the audited envelope: half-width ≤ 0.62, z ∈ [−1.5, 1.62]; the rig eye
  (0, 0.82, −0.12) keeps ≥0.35 m clearance from every member ahead of it.
- Hull authority (2026-07-13): rides/torrentCarHull.ts, a leaf module the
  geometry audit builds directly. The hull is NOT a LatheGeometry — a full
  revolve roofs the cockpit with its own top arc (the tub sat buried inside
  the closed volume: the "seat covered by the shell" defect), and a
  phiStart/phiLength sector would slot the hull nose-to-tail. Rings are
  authored per profile station and their arc SKIPS the cockpit's plan
  ellipse (0.40 × 0.56 around z −0.05), the arc endpoints landing exactly on
  the ellipse; a flared collar wall rises from that analytic rim to
  (0.45 × 0.595, y 0.588), tucked under the coaming torus and outside the
  tub mouth so neither side ever sees the seam. The same rebuild retired a
  latent mirror: LatheGeometry + rotateX(−π/2) sent profile +y to −z, so
  the hull was z-flipped against every hullRadiusAt-keyed fitting (bow
  collar, seams, louvres, rivets) and the "embedded" bow pearl floated off
  the tip. `auditTorrentCarHull` (in `npm run audit:geometry`) proves
  winding, envelope, well openness, rider sightline, and collar tuck.
- The wreck is one coherent broken hull: tapered keel, ten shaped ribs,
  longitudinal stringers, attached broken plank courses, and a leaning mast
  with cross-tree and iron crow's ring. It remains open at the track thread.
- NO bespoke dressing where the hump pierces the surface (Scott's ruling,
  2026-07-12): the ocean shader owns that interface for every opaque
  structure — depth-tested intersection/shading from above, framebuffer
  Snell refraction from below — exactly like the arrival pavilion's piles.
  The old decorative foam quads read as floating white patches and are
  deleted (wheel too). Never add per-structure water-pierce effects.

## Testing

- Interaction prompts are view-cone gated: automated boarding tests must
  either aim the camera at the gate or invoke `interactable.onInteract()`
  directly — blind synthetic KeyE at the wrong look angle silently no-ops
  (this cost three debugging rounds; prefer direct invocation for rides).

## 2026-07-12 standing-issues update

- Track authoring moved to rides/torrentTrack.ts (pure math) and is enforced
  by `auditTorrentTrack()` in `npm run audit:geometry`: ≥0.55 m seabed
  clearance over reachable ground, loop-seam up-dot ≥0.999, a breaching hump,
  and a completing lap. The helix moved past the locally-jittered rim
  (center st.z−133) and the dive skims the measured shelf before plunging —
  the old helix/dive ran metres under the sand.
- Frames use ANALYTIC banking (gravity + capped centripetal, per
  refs/roller_coaster.html) — periodic by construction; parallel transport
  around a closed loop leaves a seam twist and is banned here.
- Basis rule: right = up × tangent, makeBasis(right, up, tangent). The old
  tangent×up basis was left-handed and scrambled car orientations.
- Ride flow: E boards and arms (auto-launch ~2.4 s), one lap, dock, E steps
  off; no lap-bar interaction; relaunch unreachable while anyone is seated.
  Station canopy west columns stand at st.x−2.2, clear of the rails.

## 2026-07-12 ride-feel pass (Scott's screenshots)

- **Roll axis is a contract now**: `auditTorrentTrack()` measures signed
  bank against the zero-roll frame and throws over 34° or 7°/m of roll
  rate (measured: 31.5° / 3.1°/m). Two banking constructions corkscrewed
  before this: (1) normalizing the horizontal curvature residue and scaling
  it by FULL κ — a pure vertical bend poured its pitch curvature into
  microscopic lateral spline noise; (2) boxcar-averaging up VECTORS — the
  near-opposing raws in the cliff-lip S-bend cancelled and the normalized
  residue pointed ~120° off. Banking must use κ_lateral (horizontal
  curvature only — vertical bends roll zero) and smooth the bank ANGLE as
  a scalar, never the vectors.
- **Pacing is a contract too**: the audit throws if the plunge tops below
  20 m/s or the helix crest leaves [2, 15] m/s. The old 7.2/6.0/3.4 zone
  trio pinned the whole lap near max speed ("too fast and constant").
  Honest-physics retuning found two stall traps with the profile printer
  (speed every 25 m): the −15 shelf-return saddle and the breach hump both
  fell onto the 0.5 m/s floor — fixed by lowering the saddle to −16.8/−17.6
  and sizing SURGE/BOOST from the v² energy budget, then verifying with the
  simulator. Tune by profile, not by feel.
- Brake run: the old servo-to-2.2 m/s was a 30 s crawl over 65 m. Now
  BRAKE_RETURN_SPEED 8 m/s with target `min(8, √(2·1.3·remaining))`,
  min()-only (brakes never push), decel capped, exact-landing dock (the
  wheel's lesson). Brake segment: ~8 s.
- The open-void sweep gained a −64 valley (more up-and-down over the abyss;
  banks energy for the helix).
- **Knot contract** (Scott found the track literally tied a knot the audit
  missed): `auditTorrentTrack()` now measures max tangent turn rate
  (≤14°/m ≈ a 4 m radius floor; a spline cusp measures 50–500°/m) and min
  self-distance (≥6 m between samples more than 14 m apart along the arc).
  Two knots existed: the splash tail dived north-east then hairpinned back
  south through ONE control point, and the helix approach overshot the
  entry southbound and doubled back. The rule: track flow must never
  reverse direction across a single control point — spread any big heading
  change across several points on an even arc, or better, re-phase the
  element (the helix went to 1.5 turns @ θ₀ 90° precisely so its entry/exit
  tangents match the neighbouring legs). Measured: 10.3°/m max turn,
  13.1 m self-distance.
