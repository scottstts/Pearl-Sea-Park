# Descent Bell & Pearl Line (S8)

## Vehicle seat rig (`rides/vehicleSeat.ts`)

- `VehicleSeatRig` is the moving-vehicle counterpart to `SeatSystem` (which
  remains bench-only): smooth blend in, camera locked to a vehicle-local eye
  with full free-look (vehicle attitude × seat yaw × look), smooth blend out.
- Exits are gated by `rig.canExit` — rides flip it at docks only, so movement
  keys can never dump a guest into open water mid-ride (SeatSystem's
  any-key-to-leave behaviour is wrong for vehicles).
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
- The four three-segment cage ribs are point-to-point members. Their upper
  anchors derive from the crown's base radius/height and terminate 4 cm inside
  the solid crown with a partially embedded brass knuckle; an endpoint merely
  aligned to the crown silhouette leaves a visible air gap from oblique views.
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
- Cabin glazing is four thin panes, not a solid glass box (a box renders a
  fat refractive seam across the guest's view).
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
