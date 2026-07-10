# Games and Small Wonders (S13)

## Throw handoff and held collection

- `GamesSystem` is the one click-to-throw owner. An ordinary contextual `E`
  interaction takes a ring, pearl, food cone, or wishing coin into the hand
  rig; the next left click uses the camera's exact forward vector. There is no
  aim line, reticle, trajectory preview, or vertical correction.
- Food cones contain eight physical pellets and remain held for eight clicks.
  Single-use throws return to the ticket. Collected persistent props can be
  revisited without UI: `1` ticket, `2` velvet penny book, `3` pocket park
  model, `4` plush kraken; `T` hides/shows the hand rig.
- The paper hat is a separate camera child. Winning and taking it exposes a
  curved cardstock brim at the top of first-person view while any other item
  remains usable. Ice cream is an actual cone+scoop prop whose scoop settles
  to 28% height over 150 s and does nothing else.
- `HeldItemSystem` now de-duplicates ride stamps and physically adds them to
  the ticket face. The six required gates are Bell, Pearl Line, Wheel,
  Carousel, Torrent, and Grotto; their complete set emits `ticket/completed`.

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
  the lagoon volume emits both turtle and fish attractors at its physical hit
  point; turtle paths converge distinctly around food while nearby schools
  gather more loosely. Pellets expire after 18 s.
- Eight penny presses live at the Bell, Atrium, hub, Wheel, Carousel,
  Menagerie, Grotto, and Overlook. Each has rollers, a four-turn crank, a
  dropping pressed coin, one unique motif, and a matching collider. Finished
  coins populate eight physical pockets in the held velvet book.
- The sweets kiosk dispenses the melting strawberry cone. The Grand Atrium
  pedestal supplies the pocket park model and disappears only after it is
  taken.

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
