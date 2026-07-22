# Descent Bell & Pearl Line (S8)

## Vehicle seat rig (`rides/vehicleSeat.ts`)

- `VehicleSeatRig` is the one seating rig in the game (bench sitting and its
  `SeatSystem` were removed 2026-07-12): smooth blend in, camera locked to a
  vehicle-local eye with full free-look (vehicle attitude × seat yaw × look),
  smooth blend out.
- Exits are gated by `rig.canExit` — rides flip it at docks only, so movement
  keys can never dump a guest into open water mid-ride (an
  any-key-to-leave behaviour would be wrong for vehicles).
- On exit the rig writes the camera's final yaw/pitch back into
  `PlayerSystem.setLook` before re-enabling control — without that the camera
  snaps to the pre-ride orientation on the handover frame.
- The player body is parked at the ride exit for the whole ride; the rig only
  drives the camera. Handover is therefore seamless and physics never fights
  the ride.

## Descent Bell (`rides/descentBell.ts`)

- The opening: when the session starts without `?view`, the guest begins
  STANDING on the Descent Station deck, free to roam it — there is no
  auto-descent (Scott's ruling, 2026-07-10). The existing "Descend into the
  park" interactable (press E at the bell mouth) boards the rig, then a 2.4 s
  hold and the 40 s eased descent. Waterline crossing, god-ray reveal, and
  audio low-pass all fall out of existing camera-driven systems — nothing is
  scripted per-frame. Fully interactive throughout (free-look, no cuts).
- State machine: docked-top / descending / docked-bottom / ascending, emitted
  as `ride/bell-state` (audio hum + arrival chime key off it). Re-ridable
  forever from both ends; boarding prompts are `enabled`-gated by state.
- The station architecture (deck, piles, headframe, sheave, winch, canopy)
  lives in `world/arrival.ts`, which exports `DECK_TOP_Y` and `CABLE_TOP_Y`;
  the bell owns only the car, cable, terrace, and drive. The bell mouth is
  ringed by chained stanchions with a 2.2 m guard collider — boarding is by
  camera blend (rig), never by walking over the shaft; without the guard a
  guest can step through the open mouth while the bell is down.
- Deck freeboard stays ≥ 2.5 m — at deck 1.3 m the FFT crests washed over the
  boards.
- The exterior cage is four continuous `TubeGeometry` meridian ribs derived
  from the glass shell's own `CatmullRomCurve3`. Each centreline is displaced
  along the 2D profile normal by the rib radius plus a 2 cm air gap, so the
  brass cannot alternate between cutting into and floating away from the
  curved shell. The base collar samples that same offset profile, the two
  profile-radius opening collars meet the ribs at the glass cuts, and one crown
  collar deliberately bridges the rib endpoints into the solid crown.
  Keep this as one coherent cage — segmented cylinder chords and ball-joint
  elbows visibly disagree with the smooth lathed glass.
- That external cage is also the Bell's complete ocean-interface registration:
  the four ribs, bottom/opening/crown collars, crown, and hook are merged into
  one optical proxy draw. The floor, glass, fender, interior brass trim,
  and cable are intentionally excluded. The complete Arrival pavilion now
  shares the bounded target only from underwater, with an air-side clip, 1.2 m
  source tessellation, and a stable mean interface; it is not fed through the
  rejected general two-depth viewport path. While the Bell cage crosses the
  live FFT surface, its proxy supplies the otherwise hidden opposite-medium
  half to Snell transmission. Each cage vertex solves its apparent optical path
  through a live-FFT tangent interface (three heightfield crossing refinements,
  then two six-step Fermat bisections) before rasterization. The pavilion uses
  the cheaper single mean-plane solve because scene-scale per-vertex wave
  normals are unresolved at the Snell rim. The shared target is shadowless and
  half CSS resolution (1024 px maximum edge); the Bell is near-camera gated,
  while the underwater-only pavilion fades over 204–240 m. The ocean samples
  one already-refracted color/depth pixel instead of searching the screen. This
  is the cost/quality boundary—keep the
  registration frame-only unless an observed artifact justifies widening it.
- The Arrival pavilion is the one demonstrated scene-scale exception. Its
  direct air-side image can be outside the underwater viewport, so the canopy,
  frame, deck, and pile tops must be present in the forward target. Transparent
  optics and source geometry below y=-0.1 m stay out. Never remove its source
  clipping/tessellation or switch it back to live per-vertex FFT normals; both
  changes recreate the distance-amplified facets and temporal scrambling.
- Bell boarding retains the shared rig's original 1.2 s straight camera blend.
  The shell is two independent lathed glass sections with a 360-degree opening
  from local y = 1.20 to 1.92, so the camera enters through empty space from
  every azimuth rather than crossing physical transmission. Profile-matched
  brass collars capture both cut edges and connect them to the continuous cage
  ribs. The shell clone keeps full-time physical glass properties; never
  animate its IOR, thickness, clearcoat, visibility, or shader variant.
- The lathed glass shell clones the shared decorative glass but renders
  `FrontSide` only. Its winding is outward, so the bell remains glazed from
  exterior views while a seated camera cannot see the shell's backfaces. The
  original constant-alpha DoubleSide shell overlaid its open edge across the
  passenger view; against the changing waterline that read as a smooth
  camera-centred pale bubble unrelated to the ocean waves. The current physical
  transmission recipe retains this FrontSide ownership and also opts out of
  the normal MRT's AO receiver channel: the shell has no depth of its own, so
  feeding its curved normal to GTAO alongside the ocean/deck depth produces
  vertical facet-like bands across exterior views.
- Terrace = the bell's own SlotWriter build (plaza, steps, lamps, landing
  ring); the arrival→atrium path lives in `PARK_PATHS`.

## Pearl Line (`rides/pearlLine.ts`)

- Closed centripetal CatmullRom loop (~1.04 km) at cruise y −12 (14 m over
  the floor), dipping to boarding height only at the two stations
  (Esplanade West at (−34, 210), Wheel Pier at (146, 58)).
- **Route legs are clearance-checked against every built structure.** The
  first draft flew cabins straight through the observatory dome and grazed
  the atrium. When adding structures near the loop, re-check the legs.
- Pulse drive: one global `dwellTimer` halts the entire cable (that is how
  real pulse gondolas board); the pulse trigger is per-station
  (`station.pulsedAtS`) because near-commensurate cabin/station spacing lets
  one station's pulse permanently swallow the other's arrivals.
- Keep the station glide-in window SHORT (6 m) — the slowdown is global, so a
  wide window near either station drops the whole line into a minute-long
  crawl somewhere else on the loop.
- Towers stand 2 m BESIDE the line with a bracket arm to the sheave — cabins
  hang 3.2 m under the cable and sweep through any on-axis column. Pylons
  also respect `inParkFootprint`.
- Cabins use one authored local-space assembly in `pearlLineCabin.ts`: a flared
  extruded saloon, shallow arched canopy, floor pan, continuous brass frame,
  thin side/end panes, interior benches, door furniture, and a connected
  saddle→yoke→clamp→twin-sheave suspension. The eight moving cabins share five
  instanced material draws; their empty `Object3D` anchors remain only for seat
  transforms. Do not return to per-cabin primitive part meshes.
- Cabin caster meshes live on the dedicated dynamic-shadow layer. Their map
  refreshes every rendered frame while the four static-world clipmaps stay
  cached, so seabed shadows follow the continuously moving cable instead of
  advancing at cache-refresh cadence. Fleet-wide frustum culling is disabled:
  the eight instances span the kilometre loop, so rebuilding five aggregate
  bounds per frame cannot reject the fleet in practical park views.
- Glazing remains thin panes rather than a solid glass box (a box renders a fat
  refractive seam across the guest's view). `audit:geometry` verifies finite
  bounds, nontrivial body profile, five draw slots, and zero roof/yoke gaps.
- Station platforms use a three-cylinder collider staircase — a single tall
  cylinder defeats the character controller's 0.45 m autostep and guests
  bounce off an invisible wall.
- Boarding punches the ticket (`ticket/punched`), riding emits
  `ride/pearl-riding` for the cable hum; alighting is offered only while the
  guest's own cabin is held at a platform.

## Verification lessons

- The preview window surfaces (and the live loop runs) between `preview_eval`
  calls — timing-sensitive sequences (9 s door dwells) must be exercised in
  ONE atomic eval, and polls must sample finer than the window they detect.
- Full-cycle proofs ran: opening descent → step ashore → walk; board →
  cruise → alight at the far station; forced docked-bottom → ascend.

## 2026-07-12 standing-issues update

- Descent station: the bell-mouth collar is a closed clockwise lathe whose
  throat wraps below the deck underside (the old open ribbon rendered
  inside-out — the "inner rim ring" bug); the fascia profile is closed;
  ArchKit.stepsRing is a single watertight tread lathe at every plaza.
- Pearl Line: route lives in rides/pearlRoute.ts, swept offline against dome
  crowns / wheel envelope / midway roof / seabed (`auditPearlRoute`). The
  west leg now clears the Sun Garden dome by ~7 m. Ride logic is a state
  machine — cars stop ONLY for a waiting guest, run station-to-station
  non-stop at 3.9 m/s (1.5×), and hold until the rider steps off and walks
  clear. The pulse-dwell drive described above is historical.
- Cabins are open (glass slot deleted; four instanced draws): waist-high
  nacre panels + brass waist rail, forward-starboard bay open as the door.
