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
- Pulse boarding reuses the Pearl Line pattern: slow near the dock alignment,
  stop for a dwell, per-pulse cooldown by rotor angle. The dock angle is
  computed from the pier deck height (`acos((dockY − hubY)/R)`, west branch).
- The breach is not scripted: the camera crossing y = 0 flips the medium and
  the audio low-pass exactly as walking would. The added dressing is two
  fbm-churn foam discs pinned where the rim pierces the surface
  (`±√(R² − hubY²)` from the hub).
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
