# Sea Park — Agent Notes & Lessons

- 2026-07-09: Game design exploration drafted at `dev_docs/design.md` (**DRAFT** — awaiting Scott's confirmation of high-level direction; do not treat as canon until confirmed). No code exists yet. Implementation planning comes only after design sign-off.
- 2026-07-09: Design **confirmed** with amendments — `dev_docs/design.md` is now canon; full implementation plan at `dev_docs/plan.md` (stages S0–S14). Key interpretations settled with Scott: (1) "no NPCs" includes the automatons — zero characters, but wildlife is desired and central; (2) the sea is treated **as air** — normal physics everywhere, underwater is purely a rendering/audio treatment (no swimming, no buoyancy, no airlocks); (3) fixed time of day — no day/night cycle, so shadows can be aggressively cached; the Grotto interior is the game's only darkness; (4) plans must always target the ultimate state (CLAUDE.md rule) — stages are build order, not feature tiers, and nothing is "deferred to later".
- Aesthetic questions should NOT be bounced back to Scott — he explicitly wants to be pleasantly surprised by bold choices ("photoreal + dream-like, a little cartoonish in feel"). Ask him only about logistics: package installs, supplied assets (PBR textures, audio files, fonts), hardware targets.
- 2026-07-09 S0 lessons (toolchain):
  - `npx tsc -b` can report a FALSE PASS off a stale `.tsbuildinfo` — trust `npm run build` (or `tsc -b --force`) after structural changes.
  - tsconfig has `erasableSyntaxOnly` → NO constructor parameter properties, NO enums/namespaces. Declare fields + assign in ctor; use const objects instead of enums.
  - `GameEvents` must stay a `type` alias (not interface) — the EventBus generic needs the implicit index signature.
  - TS 6 DOM lib already types `navigator.gpu`; do not hand-roll WebGPU navigator types.
  - three r185: `WebGPURenderer` silently falls back to WebGL2 — we hard-fail instead (see systems/foundation.md). TSL display effects live in `three/examples/jsm/tsl/display/*` (BloomNode, GTAONode, TRAANode, Lut3DNode, GodraysNode all exist in r185).
  - The Claude preview browser DOES support WebGPU — agents can and should self-verify visuals via preview screenshots (launch config `.claude/launch.json`, server name `seapark`), in addition to Scott's own runs.
- 2026-07-09 S1 lessons:
  - **`npx` is BROKEN in Scott's shell** (profile wrapper references missing `_sfw_run` → npx silently runs NOTHING and "passes"). Use `npm run <script>` or `./node_modules/.bin/<tool>` directly. Never trust an `npx` result in this repo.
  - GTAO node renders to a RedFormat target — apply as `.mul(aoTex.r)`; multiplying by the vec4 turns the whole frame red.
  - r185 post-processing class is `RenderPipeline` (in `three/webgpu`); `PostProcessing` still exists as legacy alias. `pass(scene, camera, { samples: 4 })` gives MSAA. `renderOutput()` placed manually + `outputColorTransform = false` = explicit tonemap ownership.
  - TSL node types: keep system boundaries typed as `object` + single cast (see systems/render-pipeline.md); fighting `Node<"vec4">` generics across modules is a time sink.
- 2026-07-09 S2 lessons (see systems/sea-and-sky.md for the full set):
  - **Debug mystery artifacts with `?pass=` isolation BEFORE touching materials.** A dither band on distant water survived five material fixes; it was GTAO the whole time (`?pass=ao` showed it in seconds). AO now distance-fades to neutral in the pipeline.
  - GPU readback for verification: storage buffer + `renderer.getArrayBufferAsync()`, NEVER a material/quad blit (tone mapping clamps negatives → corrupted comparisons).
  - TSL Fn params: annotate as `Node<'vec2'>` etc. (`import type { Node } from 'three/webgpu'`); `varying()` returns lose arity — cast at creation. `ComputeNode` type is exported for arrays of dispatches.
  - `renderer.compute()` accepts an array = one submission (batch same FFT stage across cascades); separate calls = separate submissions (required between stages).
  - FFT self-test PASSES (err ~1e-8): the transform is proven — never "tune around" wave oddities by touching the FFT; look at spectrum/assembly instead.
- 2026-07-09 S3 lessons:
  - Renderer is globally `NoToneMapping` now; the pipeline's explicit `renderOutput(x, AgX, sRGB)` is the ONLY output transform. Side render targets stay linear. Never set toneMapping on the renderer again.
  - Node materials: transparency/blending needs `material.opacityNode` — vec4 colorNode alpha is ignored (renders opaque).
  - Caustics-on-surfaces go through `material.receivedShadowNode` (shadow × (1 + caustic)) — inherits occlusion; use `SeaMediumSystem.applyCaustics(material)` for every underwater lit material.
  - Fog belongs in the pipeline hook, not in materials — one place, everything fogged, no per-material wiring.
  - TSL camera matrices are built-in nodes (`cameraProjectionMatrixInverse`, `cameraWorldMatrix`) — no manual matrix uniforms for post-process ray reconstruction.
  - Perf watch: god-ray march costs ~half the frame at tier 2 (121→54 fps in preview) — S14 must half-res it or add temporal accumulation.
- 2026-07-09 S5 lessons:
  - Rapier heightfield heights are COLUMN-major; a `?debug` raycast self-check guards it (physics/physicsWorld.ts) — keep that check when touching terrain.
  - Camera-parented objects need `scene.add(camera)` or they never render.
  - Agent self-testing pattern: `?debug` exposes `window.__pearl`; synthetic `KeyboardEvent`s drive the player (movement works without pointer lock by design). Walk + screenshot + read camera position = full loop verification without a human.
  - Full-frame FPS in preview now ~35 at tier 2 with terrain+flora+rays: acceptable during construction; the S14 perf pass has the levers list (godray march, seagrass vertex count, shadow cadence).
- 2026-07-10 S7 lessons (park assembly — see systems/park-assembly-audio.md for the full set):
  - **Hidden preview tab ≠ perf collapse.** When the preview window is occluded, rAF stops: stats read 0–5 FPS, `ctx.time.frame` freezes, rAF-based evals time out — while `setTimeout` and screenshots keep working. Diagnose with `document.visibilityState` FIRST before chasing "0 fps bugs". Frames can be driven manually: `registry.fixedUpdate/update` + `pipeline.render()` from `preview_eval`.
  - In `?view` mode, DevOrbit owns camera orientation every frame — to pose a shot, set `orbit.controls.target` + `camera.position` then `controls.update()`; bare `camera.lookAt` is overwritten as soon as the tab becomes visible.
  - Long thin geometry at a fixed height (paths!) floats over terrain dips and casts kilometre-long straight shadow bands. Ground every plate segment on its own terrain sample (`groundedPath`, ≤9 m pieces).
  - Scatter systems must respect `inParkFootprint()` from parkPlan.ts (discs + capsules incl. path network and future ride sites). Anything new that sprinkles the seabed follows the same rule.
  - Torus prototypes must be radius-keyed when used as rings — uniform-scaling a unit torus fattens the tube with the major radius (1.2 m brass donuts on domes, the atrium "gold balloon" mass).
  - Transparent slots must not cast shadows (`SlotWriter.compile` handles it) — glass roofs were shadowing like plywood.
  - Solid-of-revolution "basins" need open profiles: a capped CylinderGeometry LIDDED the reflecting pool with marble 3 cm above the water; the pool tuning looked broken for several rounds because the water was simply invisible.
  - **SUPERSEDED 2026-07-11:** the Tidal Court planar-reflector recipe worked visually but froze the long Esplanade sightline through nested park submission. It is historical only; the pool is now single-pass.
  - Rapier `world.castRay` before the first `world.step()` returns no hits — run raycast self-checks on the first fixedUpdate, not at init.
  - Historical preview FPS with the full park at tier 2 measured ~27–40 while visible; its reflector cost was later removed rather than merely distance-gated.
- 2026-07-10 S8 lessons (rides — see systems/rides-bell-pearl.md for the full set):
  - Route anything airborne (cables, future coaster track) with explicit point-to-segment clearance vs EVERY dome/building; the first Pearl Line draft flew through the observatory glass. There is no collision check for splines — geometry review is the check.
  - Aerial structures need lateral standoff: gondola towers 2 m beside the cable (cabins sweep 3.2 m below it); same thinking applies to coaster supports near the track envelope (S10).
  - Pulse-gondola drive: ONE global dwell timer, per-station pulse cooldowns, short glide-in windows. Commensurate cabin/station spacing produces two failure modes (permanent crawl, swallowed arrivals) that only show up in long simulated runs — test rides with thousands of fixed ticks, not by eyeballing one arrival.
  - Raised platforms need collider STAIRCASES (≤0.2 m risers); one tall cylinder reads fine visually and walls guests off invisibly (autostep max 0.45).
  - Above-water aesthetics are their own regime: FFT crests (~1.3 m) swallowed a 1.3 m deck — surface structures need 2.5 m+ freeboard; ocean skirt must end INSIDE the sky dome (sawtooth seam otherwise); near-field foam tuned via coverage threshold, not the fbm floor.
  - The atrium dome's finial pierces the surface by ~2 m — kept deliberately as the arriving guest's first landmark from the buoy ("the golden spire in the waves").
  - Timing-sensitive interaction tests (door dwells) must run inside ONE preview_eval — the live loop runs whenever the preview window surfaces between evals and eats timers.
- 2026-07-10 S9 lessons (wheel & carousel — see systems/rides-wheel-carousel.md):
  - When a ride's geometry contradicts the terrain (40 m wheel vs 26 m depth), change the TERRAIN through terrainHeight (the wheel basin) — everything downstream (heightfield, paths, scatter, visuals) follows for free. Never special-case around the height authority.
  - Rotating rigs: children that must stay world-upright apply the inverse of the rotor's rotation plus their own dynamic term (wheel gondolas: `+rotorAngle + pendulum` under `rotor −rotorAngle`).
  - Mount choice needs no UI: one interactable per mount with its anchor following the mount's world position — the interaction system's view-cone scoring IS the picker.
  - Seat eyes on small mounts must be up-and-back ((0,1.28,−0.52) on ~1 m figures) or the camera lands inside the figure's head.
  - VehicleSeatRig look requires pointer lock now — unlocked mousemove (preview window, OS cursor) was silently drifting ride cameras. Any future camera-offset input must gate on pointerLockElement.
  - The interaction view-cone gates ride EXIT prompts too — automated tests must aim the look (rig.lookYaw) at the gate before dispatching KeyE, exactly like a real guest looking at the door.
  - Composed music lives fine as inline note arrays in the audio engine (16-bar waltz loop, scheduled ahead, re-armed from update()); distance mixing = gain 1/d² + closing low-pass on one bus.
- 2026-07-10 S10 lessons (the Torrent — see systems/ride-torrent.md):
  - Energy-correct ride dynamics FIND layout bugs: every stall/insta-dock had a real cause (brake zone enclosing the launch point, spline sag off a helix, an honest energy shortfall). Trust the integrator; fix the track, never fudge the physics.
  - Zone-based accelerations (launch/surge/boost/brake) keyed to arc positions found via nearest-sample lookup of authoring landmarks — robust against re-authoring; but remember tail-indexed lookups (`points.length − k`) break if points are inserted after them.
  - Helix→straight handoffs need explicit unwind waypoints along the exit tangent; CatmullRom otherwise balloons downward and the design speed profile silently absorbs it.
  - Run the SAME integrator as a design pass before building banking/geometry — banked frames must match the speeds the train will actually carry.
  - For automated ride tests, call `interactable.onInteract()` directly; synthetic KeyE is view-cone dependent and fails silently at the wrong look angle.
- 2026-07-10 S11 lessons (Grotto — see systems/ride-grotto.md):
  - A height+velocity five-point water step has a strict 2D stability limit. The inherited `laplacian × 4.75` coupling exploded into meter-scale triangle sheets within seconds; normalized coupling 0.018 at 120 Hz is stable, and the 64² mirror scales it by cell-size squared.
  - Water impulses must be zero-mean. Repeated positive Gaussians permanently raise the conserved channel mean; use a Mexican-hat crest+trough kernel, and resolve it over at least 1.25 cells in the coarse buoyancy mirror.
  - Do not GPU-read back ride water every frame. A low-resolution CPU mirror fed the exact same mask, static profile, and impulses gives causal four-point buoyancy with no synchronization stall.
  - New terrain massing must include the approach cut used by existing paths. Segmenting plates cannot ground a path when the terrain rises between its centerline samples; carve the intended gorge in `terrainHeight` so visual and Rapier ground agree.
  - A partial back-face cave shell in an open gorge reads as disconnected black sheets. Let the terrain own the open reach and start the full shell after a bend where the one-sided surface hides the cut.
  - HDR hierarchy applies inside dark rides too: thousands of above-threshold pearls become white bloom blobs. Keep the galaxy field lit below threshold and reserve hero emission for one focal pearl.
- 2026-07-10 S12 lessons (Wildlife — see systems/wildlife.md):
  - Park avoidance needed a signed-distance authority, not a second hand-maintained obstacle list. `inParkFootprint` now derives from `parkFootprintSignedDistance`; the exact same discs/capsules bake into the fish field.
  - R32F textures are not baseline linearly filterable in WebGPU. Coarse signed distance and terrain maps use R16F; their ±300 m ranges fit comfortably and work on baseline adapters.
  - 15k boids do not require an atomic spatial grid when schools are explicit. Eight stable, well-spread cohort samples per 500-fish school make the solver O(N), deterministic, and bounded while retaining separation/alignment/cohesion behavior.
  - GPU-driven instanced positions require `frustumCulled = false` unless a separate dynamic bounds system updates world bounds; otherwise Three culls a whole school against the tiny source fish geometry at the origin.
  - Scheduled wildlife reads best as one authored composition: the manta and selected schools share the Esplanade cue, while the ordinary player-avoidance force creates the split. Validation views hold the timetable at the readable beat rather than duplicating behavior.
  - Audio-first events need semantic phases. The whale emits `approach` twelve seconds before it becomes visible, so sound, shadow, body, eye, and departure remain an explicit sequence rather than offsets scattered across systems.
- 2026-07-10 S13 lessons (Games — see systems/games-and-wonders.md):
  - A torus render mesh is not a physics ring. Ring the Narwhal uses one rigid body with 14 small ball colliders arranged around the same XZ opening as the rotated torus; the fixed horn is a cone collider, so landing over it is physically possible.
  - High-striker tuning belongs in velocity/energy space, not arbitrary impulse units. With the puck's real mass, a literal 8–19 N·s impulse launched it hundreds of meters; assigning 8.97–11.7 m/s produces the intended 4.8–7.7 m ballistic range and a meaningful upper timing band.
  - Throwing interaction needs exactly one owner. Racks arm the shared `GamesSystem`; the next pointer click samples the raw camera forward and hands a world-space origin/direction to the selected toy. This prevents four game modules from installing conflicting click listeners.
  - A bounded-water caustic must share the heightfield cause. The well bottom derives intensity from the simulated surface second difference; a decorative scrolling projector would violate the surface/normal/caustic contract.
  - Progress remains diegetic only if the state changes the prop. Unique ride events add visible ticket stamps, and unique press motifs add copper pieces to actual book pockets; counters and arrays alone are not the player-facing result.
  - Positional synthesis still needs listener ownership. Updating Web Audio's listener from the Three camera once per frame lets one-shot procedural voices use HRTF panners without introducing an audio-scene framework.
- 2026-07-10 S14 lessons (Opening Day — see systems/opening-day.md):
  - A quality tier must be chosen before tier-sized resources exist. Changing only `quality.tier` after wildlife/storage/shadow construction is false control; the pause card persists the override and reloads so every budget agrees.
  - Fixed-sun caching is only stable when shader selection reads committed map centers. Desired centers may wait behind a refresh budget; publishing them early makes the sample box drift away from cached content.
  - The original god-ray mechanism is resolution-defining, not merely
    resolution-sensitive. Commit `e59ca20` moved it into a reduced target and
    lost the reference image's fine separated shafts. Depth-aware spatial
    reconstruction cannot recover that signal without temporal history and
    velocity, so the accepted path is the pre-S14 full-output-resolution march.
  - Exposure readback belongs on a tiny encoded target and must be asynchronous. Reading the HDR scene directly or synchronously would turn eye adaptation into a frame stall.
  - A 3D LUT owns color relationships, not screen position. Keep the vignette after the LUT; baking it into color space is impossible.
  - Scheduled time begins at `park/entered`. Advancing `sim` behind the ticket makes every first visit start at an arbitrary point in the timetable and can consume the opening chime before audio exists.
  - Canonical validation names need a code authority. A boot-time ten-postcard audit prevents construction-era aliases from silently weakening the final visual contract.
  - TSL types do not prove graph-construction legality. Mutable `toVar()` accumulation still has to be created inside `Fn`; otherwise the browser reports “No stack defined” even though TypeScript and Vite pass.
  - Node labels can become WGSL declarations. Hyphens in `RTTNode.setName()` produce invalid shader identifiers; use camelCase for shader-facing names and reserve punctuation for Object3D/debug labels.
  - A Three `Data3DTexture` needs the TSL `texture3D()` accessor. The generic `texture()` accessor declares a 2D binding and WebGPU correctly rejects its 3D view.
  - Do not write `vec3(vec4Node)` in TSL. Select `.rgb`; component-count validation occurs only while the graph is built.
  - rapier3d-compat 0.19.3's own wrapper still invokes wasm-bindgen's deprecated positional initializer (upstream issue #811). Physics filters only that exact known warning during `RAPIER.init()` and restores `console.warn` in `finally`.
- 2026-07-10 performance pass:
  - WebGPU command-submission time is not frame time. Dynamic resolution must
    use animation-frame cadence (plus asynchronous GPU timestamps for evidence)
    or it will stay at full scale during a GPU-bound single-digit presentation.
  - A `ShadowBaseNode` is render-scoped by default. Nested reflector renders can
    refresh custom shadows twice unless world-space cached shadows explicitly
    switch to `NodeUpdateType.FRAME`.
  - Reducing a planar reflector's resolution does not reduce its vertex,
    draw-call, or shadow submission. Cache the soft reflection, disable bounces,
    and remove bulk main-only detail from its virtual camera.
  - Material-slot batching must retain a spatial boundary. One mesh per material
    for an entire park defeats frustum culling in the main, shadow, and reflected
    views; Sea Park uses 72 m slot chunks.
  - The 256² caustic grid instanced 3×3 submits 1,179,648 triangles per update,
    but it is part of the accepted reference mechanism. The expanded-grid rewrite
    was not visually validated independently, so it was removed during the ray
    restoration. Optimize this only with fixed-view caustic/ray evidence.
  - GPU fish need explicit dynamic school bounds before restoring frustum
    culling. Their existing ping-pong buffers also support a 30 Hz fixed solver
    with render interpolation at no extra storage cost.
  - The 256-point FFT now executes all radix stages inside workgroup memory with
    explicit barriers, retaining a separate horizontal/vertical submission.
    Never fuse those axes or remove the impulse/frequency hard gate.
  - Presentation cadence is v-sync quantized: a 60 Hz display cannot satisfy a
    dynamic-resolution recovery test below 13.7 ms. Keep recovery reachable at
    healthy ~16.7 ms, probe upward slowly, cap downscaling near native resolution,
    and never restore a prior emergency floor verbatim on the next launch.
  - Do not spatially downsample the underwater caustic ray march. Independent
    jitter becomes grain, spatial filtering becomes mud, shared midpoint phases
    become coherent sheets, and ordered phases become visible tiles. Preserve
    the full-resolution pre-`e59ca20` mechanism until the renderer owns a real
    motion-vector/history/rejection contract for temporal reconstruction.
  - Full-resolution ray quality does not require paying the march above water:
    branch on the uniform submerged gate around the loop. This removes every
    caustic texture sample in above-water frames while leaving underwater pixel
    positions, jitter, step count, source field, and accumulation unchanged.
- 2026-07-10 quality walkthrough (arrival & waterline — Scott's rulings):
  - **No player body, no camera-attached props, ever.** The held-item hand rig
    (ticket card in the view corner) read as an artifact; `heldItems.ts` is now
    state-only (stamps/pennies/prizes still tracked, `ticket/completed` still
    fires). Don't re-parent meshes to the camera without asking Scott.
  - **The waterline is `SeaSystem.surfaceHeightAtCamera`, never y<0.** A
    1-thread compute (`sea/waterlineProbe.ts`) samples the three displacement
    cascades at the camera XZ with fixed-point horizontal correction + async
    storage readback. The medium's `submerged` uniform is a hard binary flip —
    smoothing it made every swell-dunk during the descent lag visibly.
  - TSL `.sample()` inside compute compiles to `textureSampleLevel(…, 0)`
    automatically — sampling render textures from compute is fine.
  - `skyRadiance(dir, discStrength)`: physical 0.53° limb-darkened HDR disc.
    The ocean passes 0 — its analytic glint terms ARE the disc's specular
    response; sampling the hot disc through wavy normals double-counts as
    sparkle noise.
  - The underwater "gap" (bright band between the far ceiling silhouette and
    the seabed horizon) is closed by a near-surface scattering layer (exp(y/3)
    weighted analytic path integral) in the medium fog — NOT by raising global
    SIGMA (kills 250 m park clarity) and NOT by background-depth hacks (the
    band was real converged inscatter, discontinuous against the near-dark
    surface underside).
  - `world/arrival.ts` is the Descent Station's architecture authority (deck,
    braced piles to the seabed via per-pile `terrainHeight`, headframe, sheave,
    winch, canopy) and exports `DECK_TOP_Y`/`CABLE_TOP_Y`; the bell keeps only
    car/cable/terrace/drive. Bell mouth = chained stanchions + 2.2 m guard
    collider; boarding is by rig camera-blend, never on foot.
  - **The opening no longer auto-descends**: the guest spawns standing on the
    deck and presses E at the bell. Any future "cinematic" opening must stay
    guest-triggered.
  - Lens water (`render/lensDrips.ts`) hangs on the pipeline's `lensTransform`
    hook (pre-bloom): droplets/streaks/film refract by offset-resampling the
    scene texture; re-armed by every `sea/waterline-crossed` emergence. Above
    water the medium hook is identity, so offset resampling needs no fog
    recomputation — keep lens effects pre-fog-aware if that ever changes.
- 2026-07-10 walkthrough round 2 (horizon band, saucer, calm sea, bell polish):
  - **A "screen-space filter" complaint can be a coarse lathe on mirror
    glass.** The bell shell's 6-point profile gave each flat segment its own
    env-reflection tone; seated INSIDE, the segment break at eye height read
    as a hard full-screen horizontal tint mask. Any glass that encloses the
    camera needs a smooth sampled curve (CatmullRom → 20+ profile points),
    never a handful of straight profile segments.
  - **Analytic in-scatter integrals must attenuate the scattered light back
    to the camera.** The near-surface layer's ∫e^(y/h) glow, composited
    unattenuated after base fog, painted a bright band pinned to the exact
    view horizon from deep viewpoints (glow ramps over ~0.4° where grazing
    rays' surface-clip distance explodes). Fix is one term: fold −σ_base·t
    into the same exponent (u −= σ_base·wetLength) — closed form survives,
    shallow-depth gap masking unchanged, deep horizon clean.
  - The world is now a **lagoon saucer**: terrainHeight rises to −3.6 ± 1.1 m
    beyond hypot 680→1150 (never breaching; wave troughs at amplitude 0.35
    reach only ~−0.5). A coarse 7×7 ring of 400 m tiles (inner 3×3 skipped)
    extends the mesh to ±1400 — before this the seabed simply ENDED at ±600,
    which was most of the visible "gap". Physics/`TERRAIN_EXTENT` still ±600.
  - Ocean `amplitude` is 0.35 by ruling (calm glassy swell). The arrival deck
    (2.6 m freeboard) can no longer be dipped by waves — underwater only ever
    begins by starting the descent.
  - Partial-arc lathe furniture (the bell banquette) needs FINISHED ENDS:
    LatheGeometry with phiStart/phiLength leaves open tube cross-sections —
    cap them with end panels/posts or it reads as a raw half-tube (the exact
    complaint against the old torus-arc bench).
  - Scott edits the tree between agent turns (favicon/logo.png, title,
    ticket footnote removal this time). If the build breaks in a file you
    never touched, `git diff` FIRST and finish his intent (here: an orphaned
    CSS rule tail after `.ticket-footnote` was removed) — don't revert his
    changes.
- 2026-07-10 walkthrough round 3 (the band's true root; drips as dashes):
  - **The near-surface scattering layer is DEAD — do not resurrect it.** Any
    luminous slab above the camera creates an up/down asymmetry across the
    view horizon (up-grazing rays integrate along it, down-grazing rays exit
    it) → a brightness step pinned to the view horizon that users read as a
    fixed screen mask. Attenuated single scatter only cures deep cameras;
    at descent depths the step is inherent to the model.
  - The horizon "gap" root cause was the ocean's TIR underside: `tirBody`
    was `DEEP·0.55` (near-black), ~6× darker than what the fog converges to,
    so the surface silhouette always cut a bright band. TIR reflects the
    UPWELLING light — it must sit near the medium's horizontal ambient
    (now (0.035, 0.14, 0.19)). With that + the saucer, base fog alone closes
    the gap at every depth.
  - Screen-space refraction effects are invisible over flat backgrounds and
    SHATTER the horizon edge into dashes — screen-locked, self-animating,
    instantly read as artifacts. Any lens-water effect must (a) be brief
    (droplets dry in ~2–3 s, not 10) and (b) carry visible drop BODIES
    (Fresnel-dark rim + meniscus glint) so it reads as water, not pattern.
  - Verified conventions while chasing the band: three r185 WGSL builder has
    `isFlipY() = false` → `screenUV` origin is TOP-left on WebGPU, so
    `ndc.y = (1 − screenUV.y)·2 − 1` in medium.ts is CORRECT — the fog/ray
    world-ray reconstruction was never mirrored. Don't "fix" it.
- 2026-07-10 walkthrough round 4 (horizon comb; bell ribs):
  - The "patterns on the ocean at the horizon" were MOIRÉ from sampling the
    mip-less cascade maps at grazing incidence. All the anti-shimmer fades
    were distance-keyed, but the controlling variable is the projected pixel
    footprint = distance²·pixelAngle/heightGap: from the 4.4 m deck the
    surface is under-sampled from ~150 m (cascade-1 λ 2.8–17 m vs 9 m
    footprint at 200 m) while a deep diver keeps detail on the same span.
    The calm 0.35-amplitude sea exposed what the old storm chop had masked.
    All fragment-side ocean LOD (cascade keeps, normal flatten, glints,
    foam) now fades on `pixelFootprint`; never revert to distance-only.
  - Small-rotation composition bugs read as "detached props": the bell's old
    staves tilted with transposed sin/cos phases (rotation.z = cos·θ,
    rotation.x = −sin·θ) so every pole leaned sideways off the rig. For
    anything that must visibly connect two parts, build it as point-to-point
    struts (quaternion setFromUnitVectors between real anchor points), not
    as positioned primitives with hand-tuned Euler leans. The bell's
    three-segment external cage ribs seat on the bottom ring; their upper
    endpoints derive from the crown dimensions, penetrate 4 cm into its solid
    base, and carry a partially embedded socket knuckle so no view exposes a
    floating gap.
  - Footprint LOD round two: flattening NORMALS is not enough — cascade-0
    VERTEX displacement still writes vHeight (body-color stripes, crest
    scatter) and silhouette teeth, a fainter comb that survives to the mesh
    diagonals (~495 m) where only edgeKeep bounded it. All three vertex
    keeps now ride the same footprint (gap = |camera.y| since the base plane
    is y = 0). The skirt always had zero derivatives (vEdgeKeep = 0), so the
    entire comb ever lived on the inner 700 m mesh.
- 2026-07-10 underwater surface refraction:
  - An analytic-sky-only Snell window necessarily erases every above-water
    structure behind the opaque ocean sheet. The ocean now draws first in the
    transparent queue while remaining alpha-opaque/depth-writing, samples the
    completed opaque framebuffer along the true water→air refracted direction,
    and depth-reconstructs the source to accept only above-water geometry.
  - Keep the analytic sky/window-glint fallback for the sky dome: sampling its
    sub-pixel HDR sun through live wave normals aliases into white sparkles.
    Exact dielectric Fresnel, not Schlick or a binary mask, owns the fade into
    total internal reflection at the edge of Snell's window.
  - `trackTimestamp` needs `resolveTimestampsAsync` essentially every frame:
    every pass allocates queries and the pool overflows in far fewer than 60
    frames ("Maximum number of queries exceeded" warnings). The monitor now
    resolves continuously with a single resolution in flight.
- 2026-07-11 waterline and exposure timing:
  - Keep the undersea medium's authored shader graph and binary `submerged`
    uniform unchanged. A probe-storage node in the render graph caused
    above-water sky corruption and underwater gate flicker. The safe fix is
    to write the existing uniform in a post-camera `lateUpdate` phase.
  - The exposure readback computes a target only. Applying adaptation inside
    the 30-frame readback callback creates small brightness steps; adapt the
    existing EV toward that target every rendered frame instead.
- 2026-07-11 facility and amenity finish pass:
  - Architectural richness should compile into the existing material-slot and
    spatial-chunk structure. Cornices, curb inlays, joinery, and ornament can
    materially improve construction logic without turning into prop-per-draw
    rendering; keep facility plans separate from the assembly orchestrator.
  - A late blanket `traverse` can silently undo a local performance policy.
    Flora explicitly disabled seagrass shadows, then its init traversal enabled
    them again. Set shadow ownership by asset class; dense blades and tiny
    shells are never shadow casters.
- 2026-07-11 facility correction rulings:
  - Schooling fish are removed completely after continued multi-second freezes;
    the prior optimization notes are historical only. Do not restore a swarm
    without a new explicit request and measured GPU evidence.
  - Repeated amenities are immutable prototypes placed through `InstancedMesh`,
    not fragment emitters. The old bench split its slats/scrolls across separate
    transforms; the old lamp guessed torus rotations and left the crown detached.
    Bench joinery and lamp members now share one local frame and have executable
    overlap/contact audits.
  - Roofs on yawed street furniture must be designed in object-local axes and
    inherit the parent's yaw. A flattened cone is not a pitched notice-board
    roof. The two panel endpoints now meet one local-X ridge and local-±Z eaves.
  - The flattened fan-coral sphere read as a cardboard cutout and is deleted.
    Fan-shaped organisms need authored thickness/branching; omit them until that
    mechanism exists.
- 2026-07-11 Esplanade freeze, cart, orientation, and wayfinding corrections:
  - Direction-specific freezes are a render-pass clue. Looking north just past
    the Atrium admitted Tidal Court's 52 m planar-reflector disc to the frustum,
    which nested a second full-park render. Cadence/resolution limits retained
    the submission spike, so the reflector path and helper were deleted. The
    pool now has one analytic glossy draw and no auxiliary target.
  - Repeated vehicle bodies follow the same prototype rule as amenities. Pearl
    Line cabins are a five-slot instanced fleet with connected suspension and
    authored saloon/canopy profiles; moving `Object3D`s are seat transforms only.
  - Bench orientation is semantic: local front `−Z` must face an explicit focal
    point. Esplanade benches target the centerline; Atrium and Observatory rings
    target their centers. Raw placement yaw is not an acceptable public API.
  - Facility wayfinding is one system, not one-off boards. Sixteen entrance
    signs share three instanced frame slots and one 2 MB name atlas. Their plan
    records an approach target and the offline audit verifies exact facing.
- 2026-07-11 movement, underwater jump, and the teleport network (see
  systems/player.md for the full set):
  - **"Walking through mesh" is never a controller bug.** The kinematic capsule
    already collides with every registered collider, so the fix is always a
    missing collider on a solid mesh — and the gaps are the ride superstructures
    built inline without one (Great Wheel raking legs, Torrent track piers).
    Scott's ruling: solid structures only — flora, coral, wildlife, and tabletop
    props stay walk-through; do not blanket-collider organic shapes.
  - **The angled leg problem.** `addStaticBox`/`addStaticCylinder` only take a
    yaw, so a raked strut (wheel legs) cannot be matched exactly. A vertical
    pier over the reachable lowest few metres at the foot is the right envelope;
    don't chase the tilt up into an unreachable machine.
  - **Underwater jump = gravity that follows the medium.** `submerged` →
    `SWIM_GRAVITY` 2.6, above → 9.81; the leap is a slow diver's push-off, not a
    hop. This deliberately bends the "sea is air / normal physics" canon *for the
    airborne arc only* (grounded walking is unchanged), on Scott's explicit
    request. Gate = `submerged && grounded && controlEnabled`, which already
    means "in the park, outside the elevator, not in a ride car". Drive
    `submerged` from `sea/waterline-crossed`, never a y-test.
  - **Rapier snap-to-ground eats a naive jump.** Must `disableSnapToGround()`
    for the arc and re-enable on landing (and in `placeAt`), or the upward move
    is glued back to the floor. Edge-trigger the jump (`event.repeat`) and drop
    any buffered jump on the borrowed-control path, or the Space that leaves a
    bench seat launches a jump the instant the guest stands.
  - **Modal freeze must not ride on `controlEnabled`.** The teleport menu uses a
    new `PlayerSystem.inputFrozen` (freezes walk+look only). Layering another
    owner on `controlEnabled` strands control: a pause captured mid-freeze (Esc,
    alt-tab) restores the borrowed `false`. Rides/seats/pause own
    `controlEnabled`; modals own `inputFrozen`.
  - **A live (non-paused) modal must mute contextual interaction.** The teleport
    menu does not pause the loop, so `InteractionSystem.suspended` gates both the
    prompt and the key handler — otherwise an E press meant for the menu fires a
    nearby bench/gate. Esc unavoidably releases the pointer → the pause card
    opens; accepted, since Esc is the game's universal "out".
  - **Teleport lands in front of the sign, not at its approach point.** A sign's
    `approach` can be far (the Atrium's is the surface drop-off); spawn is
    `SPAWN_DIST` along the approach *ray* from the sign, turned to face the
    board. The added `park-entrance` marker (beside the bell landing) is the
    network's home node and the 17th sign — the atlas grid is now count-derived
    (`ceil(n/cols)`) and the audit checks "must not overflow", not "exactly full".
- 2026-07-11 water-interface, shadow-cadence, and residual hitch corrections:
  - A refraction direction is not a refracted ray. Projecting water→air from
    the camera origin omitted the displaced interface hit point, so an
    above-water tower silhouette drifted away from its submerged pillars as
    viewing distance changed. Use the opaque depth sample to estimate subject
    distance, then reproject from the actual surface point and depth-reject
    samples off the ray or on the wrong side of the interface.
  - The first pale near-waterline "bubble" diagnosis was wrong: it was not a
    missing air→water body-colour transmission path. The surface selected its
    optical regime with per-fragment `faceDirection`, so steep nearby displaced
    triangles could show backfaces and enter the underwater/Snell shading path
    while the camera and medium were still above water. Surface and medium now
    share one camera-level submerged uniform from the displaced waterline; an
    above-water frame cannot contain a local patch of underwater optics.
  - A fixed-sun cache cannot use periodic full-world expiry to service moving
    casters: four staggered 180-frame ages produced one broad shadow render
    every 45–90 frames, matching the residual roaming hitch, while cabins
    still stepped between captures. Static levels now have no age expiry and
    recenter only after consuming guard margin. Moving rides, wildlife, and
    physics props render continuously into one bounded layer-isolated map.
  - Async GPU readback is non-blocking to JavaScript but still adds queue resolve,
    copy, and map work. Keep the waterline probe per-frame within 3 m of mean sea
    level; safely outside that band, skip it entirely because the camera cannot
    cross the ~0.5 m displaced surface before re-entering the band.
  - Normal play also no longer enables WebGPU timestamp tracking. Resolving and
    mapping render/compute queries every frame was diagnostic synchronization,
    and the continuously refreshed dynamic-caster shadow pass made that query
    workload larger. Timestamp evidence remains available explicitly under
    `?debug`.
  - Dynamic resolution must not treat one long frame as sustained GPU pressure:
    that creates a hitch → pixel-ratio change → render-target reallocation →
    hitch feedback loop. It now requires time-based sustained pressure, rejects
    isolated outliers, and recovers slowly. Auto-quality runtime persistence also
    skips identical `localStorage` writes instead of blocking once per second.
