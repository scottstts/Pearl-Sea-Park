# Games and Small Wonders (S13)

## Throw handoff and held collection

- `GamesSystem` is the one click-to-throw owner. An ordinary contextual `E`
  interaction arms a ring, pearl, food cone, or wishing coin as the current
  item; the next left click uses the camera's exact forward vector. There is
  no aim line, reticle, trajectory preview, or vertical correction.
- Food cones contain eight physical pellets and remain armed for eight
  clicks; single-use throws return the ticket as the current item.
- **Held items are state-only** (2026-07-10 quality pass): Scott removed the
  first-person hand rig and every camera-attached prop — the view is a clean
  POV. `HeldItemSystem` still tracks the current item, ride stamps, pressed
  pennies, prizes, and the paper hat flag, and the `1–4`/`T` prop-recall keys
  are gone. Prize/progress feedback is therefore event- and world-side only.
- `HeldItemSystem` de-duplicates ride stamps. The six required gates are
  Bell, Pearl Line, Wheel, Carousel, Torrent, and Grotto; their complete set
  emits `ticket/completed`.

## The three Midway games

- **Ring the Narwhal:** each brass ring is one dynamic Rapier body with 14
  spherical colliders around a 0.76 m opening. The collider and torus are both
  authored in the horizontal XZ plane, so the compound can genuinely fall
  around the fixed conical horn. Toss velocity is 8.5 m/s along the raw look
  direction; gravity and tumble own the arc.
- **Pearl Diver:** 0.28 m nacre pearls are CCD dynamic spheres rolling on a
  9.6 m lacquered ramp tilted 0.2 rad, with matching rotated Rapier ramp and
  side-lip colliders. Three backboard pockets award 10/50/20; the backboard is
  a real stop surface and pocket scoring uses the caught sphere position.
- **Kraken Bell:** the timing hammer visibly sweeps at 2.6 rad/s. `E` samples
  its phase and assigns the rail-locked dynamic puck 8.97–11.7 m/s vertical
  speed. Rapier gravity decides whether it reaches the 6.25 m bell. Offline
  integration at 60 Hz measured maxima 4.80/5.82/6.71/7.67 m for timing powers
  0.35/0.60/0.80/1.00, so only the upper timing band rings.
- The bell emits a true world position. `AudioEngineSystem` updates the Web
  Audio listener from the camera every frame and plays its two FM partials
  through an inverse-distance HRTF `PannerNode`.
- First success puts a paper hat on the prize counter; the third puts the
  plush kraken there. The player still physically takes each prize — awards
  never jump directly into inventory.

## Turtle feeding and park collectibles

- The Menagerie dispenser arms eight Rapier pellet spheres. A pellet crossing
  the lagoon volume emits a turtle attractor at its physical hit point; turtle
  paths converge distinctly around food. Pellets expire after 18 s.
- Eight penny presses live at the Bell, Atrium, hub, Wheel, Carousel,
  Menagerie, Grotto, and Overlook. Each has rollers, a four-turn crank, a
  dropping pressed coin, one unique motif, and a matching collider. Finished
  coins populate eight physical pockets in the held velvet book.
- The sweets kiosk dispenses the melting strawberry cone. The Grand Atrium
  pedestal supplies the pocket park model and disappears only after it is
  taken.
- `games/fixtureDetails.ts` supplies batched physical joinery for otherwise
  box-like fixtures: service/prize counters receive stone plinths, brass tops,
  corner posts and nacre studs; Pearl Diver owns an inset frame; Kraken Bell a
  foot/crown/side structure. Details compile through one spatial `SlotWriter`
  per owning game system instead of creating one draw per fastener.

## Wishing well water

- The well is a 64² circular `ChannelSim`, reusing the Grotto's RG
  height/velocity ping-pong, Neumann mask banks, 120 Hz step, zero-mean
  Mexican-hat impulses, and 64² CPU mirror. Its 4.8 m plane and 1.55 m liquid
  radius are small enough that one 0.26 m coin impulse stays readable.
- Wishing coins are CCD dynamic cylinders. A ripple is injected only when the
  actual body crosses the water level inside the liquid radius; coins then
  continue to the physical bowl floor.
- Water displacement and normals sample the same height texture. The bottom's
  caustic intensity is the absolute second difference of that simulated
  surface, so the focus pattern cannot move independently of real ripples.
  Global underwater caustics still supply the lower-frequency light field.
- Diagnostics: `?pass=well-height`, `well-normal`, and `well-caustic`.
  `?view=wishing-well` frames the complete mechanism.

## Validation surface

- `?view=midway-games` frames all three games. Under `?debug`, canvas
  `data-games-state` records armed throws, live rigid bodies, scores, timing
  best, prizes, press/pellet state, held item/stamp/penny counts, wishing-coin
  crossings, and water solver maxima.
- Compile/lint/bundle validation is supplemented by the 60 Hz Kraken
  integration above. The existing 240 s Grotto solver stress result covers
  the identical well equation at a denser impulse cadence.

## 2026-07-12 standing-issues update

- Kraken Bell is display-only: no interaction, no swing; the hammer lies
  statically beside the strike pad facing the board; the tower is a tapered
  board with rail rungs, a real closed-lathe bell on a yoke, and verdigris
  tentacles. Ring the Narwhal's figure is a sculpted breaching bust with a
  helix-wrapped tusk (physics colliders unchanged). Pearl Diver's board has
  recessed funnel pockets, a crest, and side wings.
- The turtle feeding station is removed; the 'Grotto Pearl' penny press is
  now 'Sun Garden' at the garden door (the eight-pocket book stays full).
- The wishing well's water sim moved to src/sea/channelSim.ts (the Grotto,
  its former home, no longer exists).

## 2026-07-13 craft pass

- Wishing well is now the storybook silhouette: coping posts, verdigris
  gable (notice-board roof convention — ridge along X, panels pitch about
  X), brass windlass with rope wraps and crank, and a hemp line down to a
  banded wooden pail over the water. Physics unchanged (posts rise from the
  already-collidered coping).
- Penny presses gained a barrel pediment (a FULL squashed cylinder half-sunk
  into the cabinet — a half-cylinder cap shows its open cut plane from
  below), nacre motif plaque, and brass corner pilasters. Sweets kiosk:
  scalloped parasol (displaced cone hem), pearl finial, and two glass
  cloches with real stock (wafer-cone scoops, nacre bonbons). Prize counter:
  backwall shelves with a pearl bowl and ribboned boxes so it reads stocked
  before any prize is won. Midway counters share the scalloped-parasol hem.
- The Kraken Bell, Ring-the-Narwhal, and Pearl Diver fixtures kept their
  2026-07-12 redesigns untouched (fresh by ruling).
