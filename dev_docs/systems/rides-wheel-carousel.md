# Great Wheel & Carrousel des Abysses (S9)

## Great Wheel (`rides/greatWheel.ts`)

- **The wheel turns in a dredged basin.** A 40 m wheel on the −26 m plateau
  cannot both clear the sand and merely crest the surface, so `terrainHeight`
  carves a round pit to ≈ −40 at the wheel anchor (literals in terrain.ts —
  importing parkPlan there would be a dependency cycle). Hub sits at −18,
  giving a +2 m crest breach and 2 m ground clearance. Physics, paths, and
  scatter all follow automatically because terrainHeight is the one authority.
- Rotor hierarchy: `rotor.rotation.z = −angle`; each gondola car applies
  `+angle + swing` so cars stay world-upright with a pendulum term on top.
  Pendulum is a per-gondola CPU integration (gravity, damping, current-field
  drive that weakens above the waterline).
- The dock angle is computed from the pier deck height
  (`acos((dockY − hubY)/R)`, west branch) so the docked gondola floor is
  flush with the deck; the state machine (see update below) owns the pacing.
- The breach is not scripted: the camera crossing y = 0 flips the medium and
  the audio low-pass exactly as walking would. No added dressing at the
  pierce points (Scott's ruling, 2026-07-12): the ocean shader owns the
  interface for every opaque structure, same as the arrival pavilion — the
  old fbm foam discs are deleted.
- The pier reaches from the basin rim (outside the pit) to the gate; the
  court→wheel path now ends at the rim (basin edge), not inside the falloff.

## Carrousel des Abysses (`rides/carousel.ts`)

- Sited south of the Midway hall at `PARK_PLAN.carousel` (100, 182) with its
  own plaza, keep-out disc, and a midway→carousel path.
- Two decks: 16 lower mounts (alternating radius rows) + 8 upper on a lathe
  annulus deck; parasol-cone canopy with brass edge ring; mirror core
  (metalness 1) with brass fluting; ~72 instanced bulbs on three rings.
- Mounts are primitive compositions (spheres/cones/lathe/torus) in nacre +
  candy tints — plump toy silhouettes per plan §2; six kinds cycled
  (seahorse, dolphin, turtle, ray, narwhal, nautilus chariot).
- Crank rods really connect: each figure bobs `sin(3.1·angle + phase)` and its
  rod stretches between a fixed overhead anchor and the figure top each frame
  (scale.y + position.y — no skeleton needed).
- Timetable drive: run 34 s / rest 14 s forever. **Mount choice = look
  choice:** every mount registers its own interactable whose anchor follows
  the mount's world position; the interaction system's view-cone scoring
  turns "look at the narwhal, press E" into mount selection with no UI.
- Ride camera: seat eye (0, 1.28, −0.52) mount-local — the first attempt sat
  inside the figure's head; seat eyes on small mounts need to be up-and-back.

## Waltz & audio

- The music-box waltz is composed inline in the audio engine (16-bar A-major
  3/4 loop; bass on 1, chord plucks on 2/3, doubled-octave melody; pluck =
  sine + 4× partial with fast decay). The loop is scheduled ahead of
  `currentTime` and re-armed from `update()`.
- Distance mix: `waltzGain ∝ 1/d²` (+ a near-field bump) and a low-pass that
  closes with distance — the "waltz across the lagoon" is a mix decision in
  one place, not a spatializer.
- `VehicleSeatRig` free-look now requires pointer lock (same rule as the
  walking controller) — stray unlocked cursor motion was drifting seat views.

## Verify

- Wheel: full cycle proven (board at pier, breach at +1.1 m with sky and sun
  glint, alight). Carousel: stop-window boarding by look ("Ride the ray"),
  spin with bob, dismount. Both punch the ticket and drive audio hums.

## 2026-07-12 standing-issues update

- The wheel spins on a player-aware state machine (cruising → arriving →
  boarding → riding → unloading → clearing): constant spin, deceleration only
  when a guest stands at the pier head, exactly one revolution per ride, and
  no motion until the rider steps off and clears the area. The old pulse-stop
  dwell timer is gone.
- Gondolas are open-air nautilus boats (closed-lathe hull, ring bench, gate
  posts at the local −x entry — cars never yaw, so −x always faces the pier
  when docked). No glass by ruling. Pivot axles span the rim pair and a
  zigzag lattice braces the two rims. (The stern nautilus spiral crest +
  pearl was removed 2026-07-12 at Scott's request — it read as a see-through
  hanging ornament from the ride camera.)
- **Exact-landing stops (Scott's ride pass):** the wheel runs at constant
  cruise the whole revolution and both stops (docking for a waiting guest,
  finishing the ride) clamp the integration step so the rotor halts on the
  precise angle with speed hard-zeroed. Never re-introduce a
  detect-radius-then-ease stop: with the 1.4/s speed smoothing it keeps
  ~0.05 rad/s at detection and drifts the gondola ~0.7 m up the rim past the
  dock — and a decel `target = remaining·k` without a `min(cruise, …)` clamp
  SURGES (0.6·1.1 ≈ 10× cruise). The `arriving` glide uses gain 0.3
  (overdamped against the smoothing) with a 0.03 rad/s floor → docks at a
  gentle 0.6 m/s rim speed.
- **Rider camera:** seat eye is (0, −0.48, 0) car-local — bench-anchored
  (0.72 m above the seat, 0.26 m above the hull rim, 0.42 m under the pivot
  axle). The old (0, −0.1, 0) put the near plane inside the axle tube. The
  rim-pair lattice uses 24 struts with nodes every 15° so nodes land ON the
  gondola pivot angles at the rims and struts cross the gondola plane 7.5°
  (2.6 m) from every pivot; the previous 11.25° lattice passed 0.65 m from
  half the pivots (centimetres from the hanging camera) and no phase shift
  could widen it — the crossing spacing, not the phase, was the problem.
- The pier ends at hub−21.4 (the rim circle crosses deck height at −19.49;
  the old deck at −17.8 was carved by the wheel). Gateway moved onto the deck.
- The basin has a dense local Rapier heightfield patch (~1 m cells, coarse
  field sunk beneath it) — see physics/physicsWorld.ts; the global 9.4 m grid
  could not represent the pit and guests fell through the mismatch.
- Carousel: board ANYWHERE while it spins (nearest lower-deck mount at press
  time), dismount any time to the radially nearest plaza point; the run/rest
  timetable is ambience only. Mounts are sculpted (bendArc/torpedo/limb
  helpers in carousel.ts); the body gained a rounding board, canopy ribs,
  pennant valance, and a spire finial.

## 2026-07-13 craft pass

- Wheel structure: raked legs carry flange couplings along their axes
  (collars quaternion-aligned to the leg direction, shrinking toward the
  hub), the axle rides visible journal bearings/housings/rosettes at both
  leg pairs, rim bulbs are strung on thin brass carrier wires, and every
  spoke wears a mid-span turnbuckle sleeve (ONE InstancedMesh for all 32).
- Gondolas: the nacre hull is scallop-fluted by displacement (14
  belly-weighted flutes, ±1.8 cm, same audited envelope — zero extra
  draws), the rim carries a brass gunwale band, and the keel is a turned
  drop-finial. Per-car dressing must stay draw-frugal: cars swing
  independently on their pendulums, so their parts can never batch.
- Carousel: deck (painted show rings over planking), skirt/canopy stripes,
  and rounding-board panels+gilt rails are all patterned in
  positionGeometry — worldspace fields CRAWL on a spinning rotor. The 28
  pennant cones became one continuous scalloped valance (displaced open
  cylinder hem, striped warm), and twelve brass whiplash crest scrolls
  stand on the fascia. Local striped/deck materials skip caustics like the
  mount tints (CarouselSystem has no medium access — accepted precedent).
