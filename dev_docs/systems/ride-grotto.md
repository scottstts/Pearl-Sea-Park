# Grotto of Pearls (S11)

## Route and ride timing

- The closed centripetal Catmull–Rom channel is 110.53 m. Three shell boats
  share one pulse-dock drive at 0.44 m/s; every arriving boat gets a 10 s
  dwell. An offline run of the production drive measured 265.55 s (4.43 min)
  from departure to the same boat's return.
- The rapids scene is a real channel profile, not a camera kick: the surface
  eases down 0.85 m, holds through the run-out, then recovers in the hidden
  return. The boats sample that same profile and accelerate locally through it.
- Boarding uses `VehicleSeatRig`; the camera stays boat-local with free look,
  and exit is enabled only when that same boat returns to the dock.

## Bounded water and buoyancy

- `ChannelSim` owns an RG float storage-texture ping-pong at 120 Hz: height in
  R, vertical velocity in G. Tier 0 uses 128²; tiers 1–2 use 256². A static
  channel mask supplies reflecting (Neumann) banks rather than draining waves
  to zero at the shoreline.
- Surface displacement and normals sample the same live height texture. The
  static drop profile is another texture in the same UV frame, so the visible
  chute, normals, and boat motion cannot disagree.
- Wakes, drips, and the rapids splash use zero-mean Mexican-hat velocity
  impulses. Positive Gaussians are invalid here: repeated wakes add net mean
  height until the channel climbs its safety clamp.
- Boat attitude comes from four samples (bow, stern, port, starboard) of a
  64² CPU mirror of the same masked solver and impulses. This avoids a
  synchronous WebGPU readback while retaining causal heave, pitch, and roll.
  Coupling is scaled by cell-size squared so the coarse mirror propagates at
  the visual simulation's world-space speed.
- A 240 s offline stress run of the mirror with denser-than-runtime wake and
  drip cadence remained below 0.263 m height and 0.018 m/step velocity; its
  absolute safety bounds are 0.55 and 0.35.

## Environment and scenes

- `terrainHeight` owns the reef massif, its path-aligned approach gorge, and
  the open dock channel cut. The visual terrain, Rapier heightfield, path
  plates, and water therefore share one ground authority. The closed cave
  shell begins only after the first bend, underneath the one-sided reef
  surface; starting a partial shell in the open gorge exposes disconnected
  back-face sheets.
- Cave geometry lives on light layer 1. Camera depth inside the channel drives
  `SeaMediumSystem.setInterior`, suppressing open-sea inscatter and god rays,
  while `audio/grotto-interior` crossfades a deterministic 3.8 s convolution
  tail and the procedural shell-organ phrase.
- The three authored beats are: rooted bioluminescent sea-lily gardens; a
  kinetic scallop-backed organ with breathing pipes, fan ribs, keys, flywheel,
  and dais; and a vertical three-arm pearl galaxy whose ordinary stars stay
  below bloom while one central pearl owns the hero emission.

## Validation surface

- Cameras: `?view=grotto`, `grotto-far`, `grotto-water`, `grotto-garden`,
  `grotto-organ`, and `treasury`.
- Water diagnostics: `?pass=grotto-height`, `grotto-velocity`,
  `grotto-normal`, and `grotto-mask`; the global `no-post` pass remains the
  baseline check.
- Under `?debug`, the canvas `data-grotto-state` attribute records boat arc
  positions, drive state, simulation resolutions, and maximum CPU-mirror
  height/velocity without requiring a mutable console hook.
