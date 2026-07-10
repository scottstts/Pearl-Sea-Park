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
  seated in the bell at the pavilion; `park/entered` (the enter click) starts
  a 2.4 s hold then a 40 s eased descent. Waterline crossing, god-ray reveal,
  and audio low-pass all fall out of existing camera-driven systems — nothing
  is scripted per-frame. Fully interactive throughout (free-look, no cuts).
- State machine: docked-top / descending / docked-bottom / ascending, emitted
  as `ride/bell-state` (audio hum + arrival chime key off it). Re-ridable
  forever from both ends; boarding prompts are `enabled`-gated by state.
- The pavilion deck has a real 3.2 m shaft hole (four slabs), rail colliders,
  and 2.6 m freeboard — at deck 1.3 m the FFT crests washed over the boards.
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
