# Opening Day (S14)

## Bubble Fountain visual contract

Subject: the Tidal Court reflecting pool becomes a three-minute inverted
Bellagio — physically scaled air bubbles threaded by lamplight, framed by the
existing 80 m colonnade.

Observable invariants:

- bubbles originate at the 32 brass nozzles and rise rather than fall;
- bubble birth/death is hidden by age envelopes, with no pool allocations;
- light shafts share each jet's radius, fan, spiral, height, and show envelope;
- the crown remains readable without bloom and never depends on post blur;
- normal play follows the 720 s schedule (offset 90, duration 180);
- `?view=fountain` holds the authored crown beat for deterministic inspection.

`shows/bubbleFountain.ts` uses three draws: tiered bubble instances
(800/1400/2200), 32 analytic shafts, and 32 brass nozzles. CPU code changes
only seven uniforms and four local point-light intensities per frame. The
six sections are overture, fans, spiral, crown, chorus, and finale. Debug
modes `?pass=fountain-age` and `?pass=fountain-envelope` expose the controlling
fields; `canvas.dataset.fountainState` records the current section and values.

The composed fountain cue is procedural and positional. A sixteen-bar phrase
is scheduled ahead on one HRTF bus while the show event is active.

## Fixed-sun cached shadows

`render/cachedShadowClipmaps.ts` replaces the old single 180 m camera-following
box with four ordinary static-world shadow maps covering 28, 84, 252, and
650 m half-widths, plus one 112 m moving-caster map. The clipmap owner is
frame-scoped, so multiple render passes in one application frame reuse the
same committed maps. Static levels publish committed centers, snap X/Y to
their actual texel footprints, quantize Z, cross-fade inside a guard band, and
consume one ordinary refresh budget per frame. They recenter only after camera
drift consumes half the guard margin; a one-texel desired-center change is not
an invalidation. With the fixed sun they have no age expiry: the old staggered
180-frame expiry forced a broad full-world render every 45–90 frames. Rides,
wildlife, and physics props occupy a dedicated camera-visible caster layer
rendered every frame into the small fifth map, so their shadows remain
continuous without recapturing the park. Forced spatial invalidation still
bypasses the static budget. Normal bias scales by world texel size.

`canvas.dataset.shadowClipmaps` exposes desired/committed centers, coverage,
map/texel sizes, dirty bits, age, update budget, direction delta, scaled bias,
static render counts, and the dynamic-caster map/layer/render count. The fixed
sun never causes continuous static-world refreshes.

## Measured image and performance path

- `render/exposureMeter.ts`: 64×36 encoded luminance, asynchronous readback,
  weighted log average, highlight clamp, asymmetric adaptation.
- `render/grade.ts`: actual generated 32³ RGBA8 LUT after the single AgX+sRGB
  output transform; vignette remains spatial and therefore outside the LUT.
- God rays retain their pre-S14 full-output-resolution march. The attempted
  reduced-resolution target was rejected because its fine caustic shafts cannot
  be spatially reconstructed without mud or visible sampling structure.
- Tidal Court no longer owns a planar-reflection target. Its pool is a
  single-draw analytic glossy surface; this removes the nested full-park render
  that froze the Atrium-to-Esplanade north-facing view.
- `canvas.dataset.performance` reports CPU submission time, presented frame
  time/FPS, asynchronous render/compute/combined GPU timestamps, draw and
  primitive counts, render targets, quality, render scale, and GPU-resource bytes.

## Quality selection and pause

Before any tier-sized resource exists, `core/autoQuality.ts` runs a real
131072-element WebGPU storage kernel (one warm compile + three timed queue-
complete dispatches) only as a starting hint. Auto v2 records the render scale
the representative scene actually sustains, but reopens at no less than 0.95;
three severe floor-bound samples lower the next session's feature tier. Live
control uses presentation cadence, not asynchronous CPU submission time. It
sheds scale under sustained missed frames, recovers with sparse near-native
probes, and never falls below the tier's 0.82/0.88/0.90 floor. URL `?tier=`, then a
persistent pause-card override, take precedence. The pause card applies volume
live; changing tier reloads because storage counts and render-target sizes are
construction-time contracts.

## Ten-postcard gate

`core/postcards.ts` is the canonical list:

`descent · esplanade · breach · dive · manta · wishing-well · snell · whale · treasury · fountain`

Boot fails loudly if any fixed bookmark is missing. Scheduled subjects are
held at a readable deterministic beat in their postcard view. The output
audit is also published on `canvas.dataset.postcardAudit`. `?time=<seconds>`
freezes authored time while continuing render/update diagnostics, so captures
can hold exact ride, water, exposure, and effect state.

## Verification

The S14 handoff uses strict TypeScript, ESLint, production build,
whitespace/diff checks, canonical bookmark scan, deterministic-source scan,
and schedule/clipmap math audits. After runtime-only TSL issues were reported,
one brief tier-0 `?view=fountain&time=126` console smoke test compiled the full
WebGPU graph with zero errors or warnings, confirmed all ten postcard systems,
then closed the tab and server. No visual-tuning session was left running.

Runtime constraints surfaced by that check:

- TSL `.assign()`/`.addAssign()` operations must be constructed inside `Fn`;
- `RTTNode.setName()` becomes a WGSL identifier, so use identifier-safe names;
- `Data3DTexture` must enter the graph through `texture3D()`, never `texture()`;
- select `.rgb` from vec4 nodes instead of constructing `vec3(vec4)`;
- rapier3d-compat 0.19.3 has a known generated-wrapper init warning despite
  successful initialization, so physics suppresses only that exact message
  while preserving and immediately restoring all other console warnings.
