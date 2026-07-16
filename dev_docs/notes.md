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
  - Horizon haze belongs in the shared `skyRadiance` elevation response, not a
    detached transparent fog shell: that keeps the dome, ocean reflection,
    and Snell-window sky coherent. A short lower-elevation tail may cover sky
    exposed beyond the finite ocean plane; the GPU waterline gate, not a hard
    ray-elevation cutoff, keeps the actual underwater composite untouched.
  - Far-surface marine haze needs both reconstructed view distance and raw
    depth: view distance drives analytic extinction, while raw depth rejects
    the non-depth-writing sky. Gate it with the GPU displaced-waterline state;
    a CPU camera-height check can leak air fog into crossing frames.
  - Once the shared marine aerial-perspective pass owns distance extinction,
    the ocean material must not also converge to a fixed `MIST` color. That
    duplicate blend turned the intentionally flat far-ocean skirt into a pale
    shelf. Keep the skirt flat for grazing-angle stability; remove competing
    color ownership instead of reintroducing distant wave displacement.
  - Never gate a horizon tint with `step(0, ray.y)`: elevated cameras expose
    lower sky between the finite ocean edge and the mathematical horizon, so
    the binary gate becomes a screen-wide color ring. A narrow smoothstep
    interval can still expose its outer edge as a belt. Use broad, faint C1
    shoulders and keep the result strictly bounded: this shared function also
    feeds water reflection, so a non-finite haze value can black out the ocean.
    Keep the actual air/underwater composite gated by the GPU waterline state.
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
    branch on the spatially uniform submerged gate around the loop. This removes every
    caustic texture sample in above-water frames while leaving underwater pixel
    positions, jitter, step count, source field, and accumulation unchanged.
- 2026-07-10 quality walkthrough (arrival & waterline — Scott's rulings):
  - **No player body, no camera-attached props, ever.** The held-item hand rig
    (ticket card in the view corner) read as an artifact; `heldItems.ts` is now
    state-only (stamps/pennies/prizes still tracked, `ticket/completed` still
    fires). Don't re-parent meshes to the camera without asking Scott.
  - **The waterline is the displaced wave field, never y<0.** A 1-thread
    compute (`sea/waterlineProbe.ts`) samples the three displacement cascades
    at camera XZ with fixed-point horizontal correction. Visual consumers use
    its same-frame 1×1 GPU state texture; `SeaSystem.surfaceHeightAtCamera` is
    the intentionally latent CPU copy for events/gameplay only. The medium gate
    remains a hard binary flip — smoothing made every swell-dunk lag visibly.
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
  - A probe-storage **buffer node** in the render graph caused above-water sky
    corruption and underwater gate flicker; do not restore it. Moving a CPU
    uniform write to post-camera `lateUpdate` fixed camera-order latency but
    could not fix asynchronous map latency under GPU load. The final visual
    authority is instead a sampled 1×1 half-float texture written by a
    post-camera compute and consumed by the immediately following render. It
    retains the authored binary shader graph without a CPU round trip or nine
    displacement samples per output pixel. The same state also suppresses the
    above-water lens overlay immediately on submergence; its CPU event remains
    responsible only for droplet wet/dry history and emergence re-arming.
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
  - The pale near-waterline "bubble" was not an ocean or Snell effect. The
    camera rides inside the Descent Bell's lathed glass shell, but that shell
    reused constant-alpha DoubleSide architectural glass. Its backfaces and
    open lower edge overlaid a smooth curved region on the passenger view;
    changing water colour merely made that camera-enclosing overlay obvious.
    The lathe winding is outward (all radial normal dots are positive), so a
    bell-only FrontSide clone preserves exterior glazing and removes the entire
    interior overlay. The ocean still shares one camera-level submerged state
    with the medium; that is correct optical-state hygiene, but was not the
    source of this artifact.
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
- 2026-07-11 above-water ocean fidelity and emergence lens:
  - Preserve the representation boundary: FFT displacement/derivatives own all
    resolved waves; sub-grid capillary detail may perturb only the above-water
    shading normal and must fade by pixel footprint. Reflection uses the shared
    analytic sky with its disc suppressed, while the fixed sun enters once via
    a GGX/Smith microfacet lobe. The underwater Snell/TIR path continues to use
    the unmodified resolved normal and scatter.
  - `refs/water_off_lens.html` is the droplet-field contract: retain its
    Heartfelt/Rain static/running drops, finite-difference normals, and
    five-second envelope. Scott explicitly rejected its full-frame stochastic
    blur, cool multiplication, and extra vignette because their fade fights the
    game's warm grade. Mix one refracted scene sample only through drop/trail
    coverage. Arm it on displaced-waterline emergence, gate it with the
    same-frame submerged texture, and skip its sample when dry.
  - A mip-less cascade can alias even when its reconstructed normal is faded
    later. The GGX pass exposed cascade 0 as a horizontal comb because that
    cascade had no pre-reconstruction keep. For above-water shading, attenuate
    the sampled derivative before the nonlinear fold denominator while the
    shortest wave still spans 16–8 pixels; keep the underwater normal on its
    established path.
  - Fragment-only LOD was insufficient: cascade-0 vertex displacement remained
    live to 18 m/pixel, so grazing triangle rows collapsed into the original
    intermittent comb plus a fainter gray pattern near the inner-mesh fade.
    Cascade-0 vertex, above-water derivative, and height-response keeps must
    share the conservative 2.5–5.5 m/pixel interval.
  - Fullscreen coordinate conventions are part of a shader port. Reference
    plane UVs increase upward; WebGPU `screenUV` increases downward. Evaluate
    the rain field with flipped Y and negate the refraction Y offset on the
    return to screen space, or running drops travel upward.
- 2026-07-12 standing-issues pass, descent bell (single-side fixes):
  - LatheGeometry facing is decidable on paper: normal/winding = (dy, −dx) of
    the profile tangent, so an ASCENDING profile segment faces +r (outward),
    descending faces the axis, top runs face up only when traversed inward.
    Decorative rings must be CLOSED clockwise loops (outer wall up → top
    inward → inner wall down → bottom outward); the deck's bell-mouth collar
    was an open counter-clockwise ribbon and rendered fully inside-out — the
    reported "inner rim ring" see-through. Audit any open lathe against this
    rule before blaming materials or adding DoubleSide (which costs fill rate
    everywhere and hides the real authoring bug).
  - The rebuilt collar's throat now drops below the deck underside (2.33 m <
    2.38 m) so the plank sandwich's raw inner cut is never visible from the
    bell; closing a profile can double as cladding for adjacent open edges.
  - `ArchKit.stepsRing` is now a single closed radius-keyed lathe (tread +
    nosing + buried skirt). The old open cylinder + torus cap left a hollow
    see-through annulus between plaza edge and cap at EVERY plaza (hub, bell
    terrace, observatory, atrium, carousel, pearl stations, jelly, torrent).
    Envelope kept: top y+0.14, outer ≈ radius+0.62, so existing colliders
    and stacked-staircase call sites are untouched.
- 2026-07-12 standing-issues pass, grand atrium (urn planter redesign):
  - `ArchKit.urn` is now a real pedestal PLANTER: stepped marble plinth,
    watertight closed-lathe verdigris vessel (base/cavetto/knopped stem/
    gadrooned bowl/rolled rim/interior wall+floor), `lib.soil` fill, a
    13-frond sea-fern rosette in the new `lib.foliage`, and the nacre pearl
    now SITS half-embedded in the soil instead of hovering over the mouth.
    All call sites (atrium, esplanade, overlook, jelly court) inherit it.
  - New shared materials: `foliage` (teal fern, FrontSide — fronds are
    closed tubes so no DoubleSide tax) and `soil` (dark loam). Both take
    caustics via `lit()` like every underwater material.
  - Fronds are chains of tapering capped cylinders with sphere knuckles
    (`frondGeometry` in archkit/modules.ts) — per the fan-coral ruling,
    organic shapes get authored thickness, never flat cards. Variation is a
    fixed jitter table; ArchKit stays deterministic with no RNG.
  - Urns now get physics cylinders at their call sites (solid structure
    rule): r≈0.48·scale, added in detailAtrium/detailEsplanade.
- 2026-07-12 standing-issues pass, tidal court (Bubble Fountain full redesign):
  - The fountain now has a PERMANENT sculpted centerpiece in the reflecting
    pool (three closed-lathe tiers: marble basin drum, verdigris scallop
    bowl on a knopped stem, brass calyx cradling a 0.85 m nacre hero pearl,
    eight point-to-point scroll struts) plus three fixed rings of physical
    jet mouths: 8 crown horns (calyx lip), 8 tilted mid horns (tier-one
    dish), 16 verdigris lily nozzles at r=17 in the pool. Jets fire from
    REAL nozzles — the old design slid its emission radius 8→22 m, which is
    what read as "spinning light beams"; plume bases must never move.
  - Plumes are coherent air columns now: per-bubble packet gating keyed to
    LAUNCH time (`launch = time − age·riseTime`) makes bursts travel up a
    column as one slug; entrainment cone (spread ∝ age^1.6) keeps columns
    tight at the mouth. Light shafts hug the same jet frames with the same
    cone so light threads THROUGH air instead of free-standing sabres.
  - `timeUniform` is absolute elapsed time, never the show-local clock —
    resetting it at show start teleported every airborne bubble.
  - The fountain never disappears between shows: an idle cue (crown 4.2 m,
    mid 2.2 m, outer 0) breathes continuously. Perf split: a ~30 %-budget
    ambient InstancedMesh (jets mod 16 = crown+mid only) is always on; the
    ~70 % show pool toggles `visible` with the schedule so idle vertex cost
    stays small. Distinct hash seed offsets per pool — identical
    instanceIndex seeds would render duplicate z-fighting bubbles.
  - Columns fade out approaching y≈−0.4 (Silver Ceiling dissolve) — cue
    heights can then be authored freely without breaching the surface; the
    finale crown column deliberately dissolves INTO the ceiling.
  - Tidal Court's eight lagoon-ring pedestals (open lathe + hovering pearl)
    are replaced by the shared `kit.urn` planters with colliders.
- 2026-07-12 standing-issues pass, midway hall:
  - Roads must terminate at a junction plaza, never inside a hall floor. The
    hub and grotto roads used to end/start INSIDE the midway floor plates —
    diagonal mosaic, curbs, and brass inlays crisscrossing (the reported
    mess) — and the hub road also clipped the cafe plaza en route. New
    scheme: `MIDWAY_APRON` (r=7 forecourt at (100,133), tangent to the
    hall's south edge z=140), all roads end at its rim, the hub road bends
    at (40,124) which clears the cafe keepout by >1.5 m, and a 4 m spur
    links the cafe to that bend. Apron is in KEEPOUT_DISCS; its plaza is
    anchored at raw terrainHeight so its top is flush with path tops.
  - When re-sculpting a physics game fixture, keep the tuned collider frame
    FIXED and sculpt around it: the narwhal is now a breaching closed-lathe
    torpedo whose snout tip lands exactly under the unchanged tusk collider
    axis (x, baseY+1.375..2.925, z−0.35); ring-scoring numbers untouched.
    Tusk spiral = shrinking-radius helix TubeGeometry wrapped on the cone.
  - Pearl Diver pockets are recessed funnels: an inward-wound lathe
    (descending profile → faces the axis) rotated −π/2 so the throat recedes
    into the board; the funnel interior is VISIBLE because of the winding —
    no DoubleSide needed. Funnel tails must stay shorter than the board
    depth or they poke out the back as see-through holes.
  - Kraken Bell is display-only by ruling: interaction, strike logic, and
    the swing animation are gone; the hammer lies statically (head flat on
    the ground beside the strike pad, face toward the board, handle resting
    back). The puck/bell physics rig is kept as dormant set dressing.
  - High-striker tower = flattened 4-segment tapered cylinder (rotateY π/4
    then scale z) — a cheap way to get a tapering board silhouette;
    graduation rungs mount BETWEEN the rails, not floating on the face.
- 2026-07-12 standing-issues pass, cafe:
  - Sign placement near a junction must be solved against ALL constraints at
    once: the boot audit rejects <0.35 m path clearance, and the sign's frame
    LEGS (±1.55 m local x after yaw) must clear the plaza curb, not just the
    sign center. Cafe sign now at (cafe.x−10.2, cafe.z+0.4); the first two
    candidate spots failed on the new hub-road legs — check every path
    segment before committing a sign move.
  - The cafe "ring" is a circular BAR: closed clockwise lathe with an actual
    counter top (r 1.58→2.02 at +1.06) — an open lathe ribbon has no top
    surface and reads as a mystery ring. Middle filled by a marble pedestal
    + brass samovar + nacre finial so the ring reads as furniture with a
    purpose. Brass trim now hugs the rim (the old canopy torus floated 0.2 m
    above the open profile with nothing holding it).
- 2026-07-12 standing-issues pass, observatory:
  - The armillary is now a real instrument: sculpted closed-lathe pedestal,
    a 23.4°-tilted assembly (two meridians, broad equator, both tropics at
    r·cos/sin of the tilt, ecliptic), polar axis rod with finial + socket
    boss, nacre globe, and two cradle struts. KEY TECHNIQUE: build one
    assembly Matrix4 (tilt + position) and compute every attachment point
    THROUGH it (`toWorld`) — hand-deriving tilted contact points is exactly
    how parts end up floating. The axis foot height feeds back into the
    assembly center so the socket always lands on the capital.
- 2026-07-12 standing-issues pass, leviathan overlook:
  - The urn row sat EXACTLY on the balustrade line (both authored at
    centerZ−1) — when two features share a coordinate, check which one owns
    the line. Planters now stand at centerZ+0.5 (1.5 m inside the rail),
    mid-segment in x so they miss the balustrade joints, with colliders.
  - Telescopes are a tube TRAIN on one parametric sight line: define pivot +
    sight direction once, pose every part (draw tube, barrel, objective
    bell, eyecup, counterweight) at scalar offsets `along(t)` with one
    shared quaternion — segment radii/lengths chosen to overlap at the
    seams. Fork yoke (cheeks + axle + trunnions) roots the line to the
    baluster pedestal. Same pattern as the armillary: one frame, offsets
    through it, never hand-placed world coordinates per part.
- 2026-07-12 standing-issues pass, great wheel:
  - The basin fall-through was a COLLIDER RESOLUTION mismatch, not a terrain
    bug: the global Rapier heightfield is 128 divisions over 1200 m (9.4 m
    cells) vs the 1.5 m visual mesh — a 15 m-deep pit over a 13 m slope
    polygonizes meters away from the visuals. Fix pattern: a dense local
    heightfield patch (88 div over ±44 m ≈ 1 m cells) owns the basin, and
    the coarse samples strictly inside sink to −60 so the patch is the only
    top surface. CRITICAL: the patch must extend one full coarse cell past
    the sink radius, or the sink slope forms an invisible pit ring around
    the patch. Boot raycast check now samples the basin floor and slope.
    Reuse this pattern for any future steep local feature.
  - The pier ran to hx−17.8 while the rim circle crosses deck height at
    hx−19.49 — the wheel carved through the deck end (the reported "bite").
    Deck now ends at hx−21.4 (rim max reach 20.32, docked hull ≈21.0), with
    end rails leaving a central boarding gap and the gateway moved onto the
    deck. Docked-gondola floor rides level with the deck (dockY=pierY+1.75).
  - Gondolas are open-air nautilus boats: closed-lathe hull with real
    interior (rim at chest height, no glass by ruling), ring bench with
    finished ends, keel, stern spiral crest (one arc end lands ON the rim),
    gate posts at the entry gap facing local −x — cars cancel rotor spin so
    local −x always faces the pier when docked. Pivot axles now visibly
    span the rim pair, and a zigzag lattice braces the two rims.
  - Ride state machine (cruising→arriving→boarding→riding→unloading→
    clearing): the wheel spins constantly, decelerates only when the guest
    stands at the pier head (`playerAtDock`, r=4.5 around the deck end),
    waits while they decide, runs EXACTLY one revolution when boarded
    (angle-accumulated, no pulse stops), and resumes only after the guest
    steps off AND leaves the zone. `positiveAngle` (wrap into [0,2π)) picks
    the next arriving gondola — signed deltas pick one that just passed.
- 2026-07-12 standing-issues pass, carousel (+ wildlife seahorse):
  - Mount sculpting toolkit in carousel.ts: `bendArc` (bends a geometry's +Y
    into a Y-Z arc — turns straight lathe torpedoes into arcing dolphin/
    narwhal bodies and even bends cones into curved dorsal fins), `torpedo`
    (closed lathe), `limb` (tapering knuckled chains for necks/whip tails).
    All six species rebuilt: bent bodies, thickness-bearing fins/flukes
    (squashed ellipsoids, never flat cones), helix-wrapped narwhal tusk,
    scute-stepped turtle shell lathe, and a shared crafted saddle (seat,
    rolled cantle, brass pommel, skirt, straps + stirrup rings).
  - Boarding rule per Scott: hop on ANYWHERE around the platform even while
    it spins — one center interactable picks the nearest LOWER-deck mount to
    the player at press time (upper deck excluded by distance naturally);
    dismount any time to the radially nearest plaza point. The dismount
    anchor is a live Vector3 following the ridden mount (interaction holds
    the reference), so the prompt stays in the rider's view cone. The old
    per-mount view-cone picker and the stopped-only gating are gone; the
    run/rest timetable remains as ambience only.
  - Carousel body: rounding-board fascia (closed lathe ring) now carries the
    bulb run, canopy has 12 brass ribs + 28 pennant valance cones + spire
    finial with nacre pearl; mirror core gets arched panel frames and
    mouldings.
  - Wildlife seahorse: body is a unit TubeGeometry post-scaled per ring to a
    radius profile (belly bulge → whip tail) — tapering a tube by scaling
    vertices toward their spine point PRESERVES the tube's winding, where
    hand-ringing a curved Frenet frame risks inside-out quads. Tail now
    genuinely curls; snout/coronet/dorsal/pectorals are 3D (the old snout
    and fin were single flat triangles).
- 2026-07-12 standing-issues pass, the Torrent (major rework):
  - `terrainHeight` now lives in the LEAF module world/terrainHeight.ts
    (only ../core/noise2.ts, explicit .ts imports) so offline audits under
    `node --experimental-strip-types` can sample the exact game field.
    world/terrain.ts re-exports it; nothing else changed. Audited modules
    must import only .ts-suffixed leaves — that's why facilitySigns works.
  - Track authoring moved to rides/torrentTrack.ts (pure math) with
    `auditTorrentTrack()` wired into `npm run audit:geometry`: enforces
    ≥0.55 m seabed clearance wherever ground > −45, seam up-dot ≥ 0.999,
    a breaching hump, and a completing lap (integrated with the runtime
    physics). Current numbers: clearance 0.87 m, seam 0.999996, lap 64.6 s,
    peak 35 m/s.
  - TWO track-under-sand causes found numerically: (a) the DROP-OFF RIM
    JITTER locally extends the shelf to z≈−270 near the helix/dive corridor
    — never trust RIM_Z=−250 as "the void starts here"; sample the field.
    The helix moved to (−26,−298) (fully past the local rim) and the dive
    now skims the shelf at ground+1.3 until the measured lip, then plunges
    with the cliff. (b) The old return leg was a hairpin (z −161→−179→−171)
    the centripetal spline swung wide on; replaced with a monotonic brake
    arc curving home to the seam.
  - The "twisted mess" at the loop seam was PARALLEL-TRANSPORT HOLONOMY:
    transporting up-vectors around a closed loop does not return to the
    start. Fix per refs/roller_coaster.html: analytic banked frames —
    up ∝ G·worldUp + min(v²κ, G·tanMAX)·(horizontal curvature dir),
    projected ⊥ tangent, window-smoothed. Periodic by construction.
  - The "directions all over the place" train was a LEFT-HANDED basis:
    side = tangent×up fed to makeBasis gives a reflection, and
    setFromRotationMatrix on it produces garbage. Right-handed rule:
    right = up × tangent, basis(right, up, tangent) — the reference calls
    this exact bug out. With the proper basis, rig baseYaw π faces the
    camera down the car's +z = the HEAD of the train.
  - Ride flow: E boards AND arms (launch 2.4 s later — no separate lap-bar
    interaction), one loop, brake-capture only after stateTime>10 (the
    brake zone contains the launch point), dock at the platform mark,
    E to step off; relaunch is only reachable through the boarding
    interaction, which is disabled while anyone is seated.
  - Station canopy west columns moved from st.x+0.4 (INSIDE the rail
    envelope — plinths in the track) to st.x−2.2 with the gable widened to
    span both rows. Cars got closed hulls with recessed cockpit cavities +
    coamings (open-ended cylinders show culled interiors), fins, nozzle
    rings; track ties got spine webs; supports got flared feet + clamps.
- 2026-07-12 standing-issues pass, menagerie gardens:
  - The 'menagerie' entrance marker is removed by ruling — the junction
    between the three gardens is not a destination. Removing an entry from
    FACILITY_ENTRANCE_SIGNS removes the sign, its atlas tile, its collider,
    AND its teleport node in one edit (teleport derives from that roster).
    The spoke paths and the three garden signs stay.
- 2026-07-12 standing-issues pass, sun garden:
  - The dome now holds its promised "greenhouse of flowers and butterflies":
    a brass sun lantern (marble pedestal, lampGlobe globe, 8 ray cones,
    warm PointLight) as the garden's own sun, an annular parterre (closed
    marble curb + soil ring lathes) of golden anemones (verdigris stalk,
    brass petal crowns, nacre hearts) and exported `frondGeometry` ferns,
    four kit.urn planters with colliders, and two registered bench seats
    facing the lantern.
  - Sea butterflies (44 pteropods) reuse the jelly/seahorse GPU pattern:
    instanceOrigin/instancePhase attributes, all drift + wingbeat in vertex
    TSL (morphWeight is the flutter channel rising toward wing tips), zero
    per-frame CPU. This is the sanctioned way to add ambient life —
    NOT a boid swarm (those stay removed by ruling).
  - The five-way path knot at the menagerie junction is now a roundabout
    plaza (r 6.5, flush with path tops); all three garden spokes start at
    its rim via a computed `spokeStart` (center + 6.5·unit(end−center)).
    Same junction-plaza cure as the Midway apron.
- 2026-07-12 standing-issues pass, jelly court:
  - The two urns stood dead-center in the colonnade's GATE openings (urns
    at ±x r 12.2 vs gates at columns i 3/4 and 10/11 — the ±x lanes). Four
    planters now sit on the court diagonals with colliders. When placing
    furniture inside a ring colonnade, check the gate angles first.
  - Livelier medusae, all still vertex-TSL: a second-harmonic shimmer on
    the bell contraction, an asymmetric upward DART on each squeeze
    (pulse.max(0)^1.6 — jets rise on contraction then sink), tentacle
    billow lag on the morphWeight channel, and court jellies now breathe
    their faint emissive with the pulse instead of holding it constant.
- 2026-07-12 standing-issues pass, turtle lagoon:
  - Turtle feeding is REMOVED by ruling (overrides the design-doc verb
    list): feeding station, pellets, `wildlife/turtle-attractor` event, the
    ambientLife listener, and the turtles' attraction steering are all
    gone. The `food-cone` HeldItemKind union member remains (state-only,
    harmless).
  - The "star-like flicker" was COPLANAR Z-FIGHTING: the water disc sat at
    exactly the plaza plate's top (both lagoonY+0.18), and CircleGeometry
    is a triangle FAN from a center vertex — the fight resolves per
    triangle, radiating star-shaped from the center, camera-independent.
    Any disc laid on a plate needs real vertical separation. The lagoon now
    has a true section: dark sandy bed at +0.22, water surface at +0.46
    inside the rim throat (turtles bob right at the new surface).
  - Water remake, single draw: radial depth gradient (turquoise shallows →
    deep center), two crossing swells + concentric wake rings in the
    normal, grazing-angle sheen, and an fbm foam thread hugging the marble
    rim. Same one-pass philosophy as the Tidal Court pool (no reflector).
  - Turtles re-sculpted: scute-stepped ringBody carapace + plastron + keel
    beads, neck/beaked head, and swept paddle flippers with thickness
    (scaled/rotated spheres via appendGeometry, flap weights toward tips).
- 2026-07-12 standing-issues pass, grotto of pearls REMOVED (Scott's ruling):
  - Full wipe: GrottoSystem + registration deleted; sign/teleport node,
    grotto road, and keep-out removed; the reef massif + boarding gorge +
    channel cuts removed from terrainHeight (Rapier field and flora follow
    automatically); the massif reef-stone sand tint removed; grotto jellies
    removed; grotto audio (cave convolver bus, shell organ, drips, ride
    hum) and the three grotto events removed.
  - Survivors, deliberately: `ChannelSim` moved to src/sea/channelSim.ts —
    the Wishing Well drives it, it was never grotto-specific. The medium's
    generic `interior` uniform/`setInterior` stays as capability (rests at
    0). Ride-stamp roster is 5 (ticket/completed adjusted); the ninth
    postcard is now 'sun-garden' (the boot audit enforces the ten names);
    the 'Grotto Pearl' penny press became 'Sun Garden' at the garden door
    so the eight-pocket penny book stays complete.
  - dev_docs/systems/ride-grotto.md carries a REMOVED banner; treat its
    content as historical only.
- 2026-07-12 standing-issues pass, pearl line:
  - The route now lives in rides/pearlRoute.ts (leaf module) with
    `auditPearlRoute()` in `npm run audit:geometry`: sweeps the cabin
    envelope (3.34 m under the cable, ±1 m) against every dome crown
    (analytic ellipsoids), the Great Wheel envelope, the Midway gable, and
    the seabed (station approaches get a graded ground-hug budget — the
    glide-in legitimately reaches 0.31 m). Scott's sighting confirmed
    numerically: the old (−148,−12,102)→(−122,−12,8) leg carved the Sun
    Garden dome; the leg now swings to (−166,−10.5,96)→(−136,−10.5,−2) and
    clears by 6.96 m. Aerial routes are audit contracts now, not reviews.
  - Ride contract rebuilt as a state machine (cruising→arriving→boarding→
    riding→unloading): the line NEVER stops on its own; a guest standing on
    a platform (r 6.5) glides the next cabin in (forward-distance argmin,
    same positive-wrap lesson as the wheel); walking away releases it;
    boarding runs non-stop to the OTHER station at 1.5× the old speed
    (3.9 m/s); after alighting the state returns to 'boarding' since the
    guest is still on the platform — it self-releases when they leave.
    Global pulse-dwell (DWELL/STATION_WINDOW machinery) is gone.
  - Cabins are OPEN by ruling: the glass slot is deleted (fleet is four
    draws); waist-high nacre panels + a brass waist rail close the lower
    bays, the forward-starboard bay stays floor-open as the doorway, and
    everything above the waist is unobstructed in all directions. Gotcha:
    the body slot's extrusions are non-indexed — new box parts in that slot
    need `.toNonIndexed()` or mergeGeometries refuses the mix.
  - Seat camera baseYaw π = cabin local +z = direction of travel (the
    VehicleSeatRig convention: identity camera looks −z, π flips it onto
    the vehicle's forward axis).
- 2026-07-12 ride-feel pass (bench removal + wheel camera/pacing):
  - Bench sitting is REMOVED by ruling: benches are scenery (geometry +
    collider only). player/seats.ts (SeatSystem) is deleted end-to-end —
    main.ts registration, the `seats` slot on DistrictServices, all four
    registerBenchSeat call sites (esplanade, atrium ring, observatory,
    sun garden), and the 'seats' ticket-screen label. Do not re-add sit
    prompts; the only seating rig is rides/vehicleSeat.ts (VehicleSeatRig).
  - Seat-eye placement rule: anchor the eye to the SEAT geometry, not the
    vehicle origin. The wheel's eye was (0, −0.1, 0) — 4 cm off the pivot
    axle tube, so the near plane (0.1) sliced the "attachment bar" for the
    whole ride. Now (0, −0.48, 0): 0.72 m above the bench seat top (−1.20),
    0.26 m above the hull rim, 0.42 m under the axle. Check every authored
    eye against ALL members within ~0.6 m (axle, arms, rim, crest), not
    just the obvious hull.
  - Rotating-frame clearance is a spacing problem, not a phase problem: the
    wheel's rim-pair lattice (32 struts, 11.25° z=0 crossings) passed 0.65 m
    from half the 12 pivots, and 1.875° was already the OPTIMAL phase
    (crossings repeat every gcd(11.25°,30°)=3.75°; max-min = half that). Fix
    was re-noding: 24 struts, nodes every 15° land exactly on pivot angles
    at the rims, crossings 7.5° (2.6 m) from every pivot. When props share a
    rotor with a camera, compute the worst-case pass analytically first.
  - Exact-landing stops for constant-speed rides: integrate
    `step = min(speed·dt, remaining)` and hard-zero speed at the clamp.
    Never detect-then-ease: with the 1.4/s speed smoothing the old wheel
    kept ~0.05 rad/s at detection and drifted ~0.7 m up the rim past the
    dock (Scott saw the gondola finish above the bridge end); and a decel
    `target = remaining·k` WITHOUT `min(cruise, …)` surges (0.6·1.1 ≈ 10×
    cruise — the "suddenly speeds up to finish" bug). Riding is now flat
    cruise + clamp (verified: end error exactly 0, max speed 1.0000×
    cruise); arriving uses gain 0.3 (overdamped vs the smoothing, no
    sawing) with a 0.03 rad/s floor → docks at 0.6 m/s rim, exact angle,
    so the gondola floor lands flush with the deck as dockY intends.
- 2026-07-12 Torrent ride-feel pass (roll twists, pacing, brake crawl):
  - Coaster banking construction lessons (both failures shipped before
    being caught): (1) NEVER normalize the horizontal curvature residue
    and scale by full κ — a pure vertical bend (plunge, hump) pours its
    pitch curvature into microscopic lateral spline noise and the track
    corkscrews senselessly; bank from κ_lateral (the horizontal component
    of the curvature vector) so vertical bends roll exactly zero.
    (2) NEVER boxcar-smooth up VECTORS — near-opposing raws (S-bend at the
    cliff lip) cancel, and the normalized residue points anywhere (~120°
    observed). Smooth the SIGNED BANK ANGLE as a scalar in the zero-roll
    frame (refUp = worldUp ⊥ tangent, side = tangent × refUp, up =
    refUp·cos b + side·sin b): cancellation is impossible and |bank| ≤ cap
    by construction. Roll is now audited: ≤34° bank, ≤7°/m roll rate.
  - Ride pacing with honest physics: tune from a speed PROFILE (print v
    every 25 m via the shared integrator), not from feel or hand energy
    budgets alone. Two stall traps sat exactly at the v-floor (0.5 m/s):
    the shelf-return saddle (58 s crawl) and the breach hump — invisible
    in lapSeconds alone until it doubled. trackAccel() is now the ONE
    shared authority (runtime + design pass + simulator); rhythm is an
    audit contract (dive ≥20 m/s, helix crest in [2,15] m/s).
  - Brake runs: servo-to-slow-speed across a long zone is a crawl (the
    complaint "extremely slow at the end"). Cruise home at a real speed
    with target min(V_RETURN, √(2·a·remaining)), min()-only so brakes
    never push, decel capped, exact-landing dock (same as the wheel).
- 2026-07-12 Torrent knot pass (Scott: "the track tied a knot"):
  - Spline knots come from AUTHORING, not sampling: any place the intended
    flow reverses direction across a single Catmull-Rom control point
    (dive NE → next point back SW) makes the spline swing a loop/cusp.
    Never author a 180° with one point; spread heading changes evenly
    across several points, or re-phase the element so entry/exit tangents
    match the neighbouring legs (the helix became 1.5 turns starting at
    θ₀ = 90°: entry tangent = the westbound sweep, exit = the eastbound
    unwind — the turnaround vanished instead of being smoothed).
  - Audits must cover the failure CLASS, not just known symptoms: the
    track audit checked clearance/seam/speeds but nothing about curvature,
    so a visible knot passed. Added: max tangent turn rate ≤14°/m (a cusp
    measures 50–500°/m; sane track ~10) and min self-distance ≥6 m between
    samples >14 m apart along the arc. When a human finds a defect class
    numerically detectable, add the metric the same day.
  - Diagnose spline geometry numerically FIRST (sort samples by turn rate,
    print worst locations) — my two guesses about which corner was the
    knot were both wrong; the scan found s≈694 (splash tail hairpin) and
    s≈242 (helix approach doubling back) instantly.
- 2026-07-12 breach foam + shadow streaming (Scott's underwater screenshot):
  - RULING (supersedes an earlier edge-fade patch): NO bespoke per-structure
    water-pierce dressing, ever. The ocean surface shader already owns the
    interface for EVERY opaque structure that pokes through the water —
    depth-tested intersection and shading from above, framebuffer-refracted
    Snell window from below — exactly like the arrival pavilion's piles
    (the reference; it has zero custom dressing). The Torrent and Great
    Wheel decorative foam quads read as floating white patches from below
    and were DELETED, not softened. If a pierce point ever looks wrong,
    fix the ocean shader, not the structure.
  - Cached shadow clipmaps + a fast camera: two systemic lessons in
    render/cachedShadowClipmaps.ts. (1) Reactive recentering puts the
    freshest shadow gap exactly where a rider is LOOKING (ahead); lead the
    desired centers by smoothed light-space velocity (≤1 s of travel,
    clamped to 0.3·halfWidth) — zero extra renders. (2) Never hand a
    shared per-frame budget out in fixed index order: fine levels go dirty
    every frame at speed and STARVE the mid levels, whose eventual
    catch-up pops whole shadow sections in. Select by urgency (lag over
    recenter threshold, invalid = ∞). Verified by offline simulation of
    the recenter math (worst excursion 0.34 of the sampled box at 28 m/s,
    all levels bounded render rates).
- 2026-07-12 ocean barcode, entry sync, and roaming hitch pass:
  - The persistent above-water "barcode" had a second cause beyond mip-less
    FFT minification: `createSkirtGeometry` filtered triangles out of a 48×48,
    6400 m plane. The requested ±348 m hole therefore had diagonal boundary
    triangles reaching ±266.7 m — 81.3 m inside the intended hole and ~83 m
    beneath the inner surface. Inner waves were still live there and troughs
    crossed the skirt at y=−0.14, producing animated contour bands. The skirt
    is now four explicit rectangles with an exact ±348 m hole and only a 2 m
    overlap, entirely inside the inner mesh's already-flat border. Geometry
    audit enforces the seam; no FFT/detail/tessellation quality was reduced.
  - Static clipmap caching did not cache CPU scene traversal/command encoding:
    each camera recenter synchronously called `updateShadow` on the full live
    scene, increasingly expensive after the facility pass. Immutable casters
    are now flattened at exact world matrices into a shadow-only WebGPU render
    bundle after world init; first/loading render records each clipmap target,
    and gameplay refreshes execute those commands. All static casters and map
    resolutions remain; dynamic casters retain their live map. Existing perf
    telemetry now records static refresh CPU timing for evidence.
  - Entry sound now shares the ticket's 1.6 s reveal envelope instead of
    jumping to full gain under an opaque overlay. All large procedural PCM
    beds (ambience, whale breath, five ride hums) generate during loading and
    become reusable AudioBuffers at entry, removing later event-time CPU loops.
  - The finer gray "fabric" left after the geometry barcode disappeared was
    not another FFT defect. Three r185 GTAO uses a repeating 5×5 magic-square
    noise field and produces raw half-resolution visibility with no built-in
    denoise; the pipeline bilinearly enlarged and multiplied it into the whole
    HDR scene, so the weave crossed ocean, metal, and deck shading in screen
    space. GTAO now receives an eight-neighbour full-resolution bilateral
    reconstruction (view-depth + normal weights). Normal-MRT alpha is an AO
    receiver channel, with ocean explicitly 0 and ordinary opaque surfaces 1,
    so no extra 4× MSAA target or graphics downgrade was introduced. Preserve
    `?pass=ao`, `ao-filtered`, `ao-applied`, and `ao-mask` as the proof chain.
- 2026-07-12 freeze/blink/entry pass (measured in-browser, not guessed —
  instrument first, the first two theories were both wrong):
  - **The roaming freeze was never JS-visible.** GPUDevice-prototype probes
    showed `createRenderPipeline` returns in ~0 ms and no long tasks fire;
    Chrome compiles the native shader lazily on each pipeline's FIRST
    submitted use, stalling the GPU process (CPU spike, GPU idle, rAF
    back-pressured — exactly the reported symptom). Building WGSL for the
    whole park is a separate ~3.1 s main-thread block if paid in one frame.
    Fix: `render/warmup.ts` runs behind the ticket — chunked `compileAsync`
    (one representative mesh per material × geometry-layout signature,
    against the scene pass's exact target+MRT context or the pipeline cache
    misses) + six real zero-dt frames with culling lifted, hidden subtrees
    revealed, clipmap levels force-invalidated, and the exposure-meter pause
    gate lifted. Enter appears only after this completes; verified: full
    park roam + revealing every hidden subtree creates ZERO new pipelines.
  - **The moving-shadow blink was the bundle refresh poisoning NodeFrame.**
    NodeFrame is a singleton and every nested render reassigns its `.scene`;
    after a static level rendered the bundle proxy scene, the same frame's
    dynamic-caster pass read `frame.scene` = proxy scene (no layer-2
    objects) and rendered an EMPTY moving-caster map — so moving objects'
    shadows (and dynamic-on-dynamic shading) vanished for exactly the frames
    where a level recentered, i.e. only while walking. Clipmaps now pin the
    live scene at updateBefore entry and wrap the dynamic pass's frame.
    Verified: invalidate-every-frame worst case keeps 595/595 dynamic draws.
  - The AO reconstruction's raw-center fallback + fixed 0.5 m depth sigma
    passed screen-locked noise through at thin members and grazing floors
    (visible dither; strobing under motion). Reconstruction now blends to
    the plain nine-tap mean where bilateral support is weak, scales depth
    tolerance with |viewZ| (4 %, 8 cm floor), and epsilon-guards normal
    normalization (MSAA-resolved normals can cancel to zero → NaN in WGSL).
  - Agent-harness gotchas that cost hours: manual `pipeline.render()` calls
    do NOT advance `nodeFrame.frameId` (only the renderer's animation loop
    does), so FRAME-scoped nodes (clipmaps, GTAO, PassNode) silently freeze —
    tick `renderer._nodes.nodeFrame.update()` between manual frames. A
    hidden preview tab has a 0×0 drawing buffer (renders no-op; warmup
    clamps to 64×36) and throttles `setTimeout` to 1 s. `drawImage(webgpu
    canvas)` works even hidden for per-frame pixel probes. Walking-speed
    single-frame pop detectors are parallax-dominated at 192×108 — only
    still-camera or sub-pixel-crawl runs isolate real temporal artifacts.
- 2026-07-12 residual-hitch pass + Torrent train redesign:
  - Remaining freeze tail after the warmup fix, attributed by measurement:
    per-system update() allocation is ~0 KB/frame (no GC fuel — the earlier
    530 KB/frame reading was the probe's own allocations), runtime-spawned
    game props reuse library materials (pipeline cache hits, not compiles).
    What's left: dynamic-resolution render-target reallocation on scale
    steps (already heavily damped; do NOT make recovery jump — the
    probe-upward-slowly lesson stands), an occasional heavy static-level
    refresh coinciding with a loaded frame, and browser/driver noise
    (pointer-lock transitions, Chrome pipeline-cache serialization early in
    a session). `FramePerformanceMonitor.hitches` now retains the last 24
    >40 ms frames with cpuMs, scale-change flag, and static/dynamic shadow
    work deltas — read `canvas.dataset.performance` after feeling a freeze
    before optimizing anything further.
  - Instrumented sessions can poison the auto-quality cache: floor-bound
    synthetic frames persist a LOWER tier for the next session
    (`the-pearl:auto-quality:v2`). Clear it after harness abuse, or pass
    `?tier=`.
  - The Torrent train is redesigned (cars only — geometry/materials; track,
    physics, ride logic untouched). New shared library materials: `lacquer`
    (japanned torrent-teal coachwork, grazing sheen) and `leather` (oxblood
    upholstery) — reusable for future vehicles. Craft patterns applied and
    worth repeating: CatmullRom-sampled lathe profile with a radius helper
    so seam rings/collars are radius-keyed to the hull; the cockpit as an
    inward-wound open lathe tub (funnel-winding rule) so the seat is REALLY
    visible instead of a capped pod (the old cars and the first draft both
    failed this — a closed cavity sphere reads as a sealed hatch with the
    headrest as its handle); nozzles are tapered venturis, never bare cone
    apexes (reads as a spike); fins are squashed ellipsoids (thickness
    ruling); rivet studs are one InstancedMesh per car with castShadow off.
    Envelope discipline: half-width ≤ 0.62 (station column audit), length
    within CAR_GAP minus coupling clearance, eye-clearance check at the rig
    anchor before committing any cockpit member.
- 2026-07-13 all-assets craft pass (geometry/materials/self-animation only —
  no mechanics, render, or environment changes):
  - Materials library doctrine is now explicit IN the file: every channel of
    a material derives from the same few named causal fields (brass
    hammer+tarnish, marble warp→veins+bed, verdigris single patina field
    driving color+metalness+roughness, mosaic tile-id → palette+glaze+bevel
    normal), and fine microstructure multiplies a camera-distance
    `detailKeep(far)` so it dissolves before it aliases. New shared material:
    `rope` (fenders, rigging, coils, windlass). Nacre is a cosine-palette
    interference sweep — the phase also drives growth-ripple roughness.
  - PATTERNS ON ROTATING RIGS MUST BE GEOMETRY-SPACE. Worldspace fbm/stripes
    crawl visibly across a spinning carousel deck/canopy (ω·r ≈ 2 m/s at the
    rim). The carousel's deck rings, skirt/canopy stripes, and rounding-board
    panels all pattern in positionGeometry; the shared worldspace library
    materials stay fine on small rotor parts where the crawl is unreadable.
    (Body-locked wildlife patterning uses positionGeometry for the same
    reason.)
  - Fluting is cheap and transformative: a displaced CylinderGeometry
    (radial cos(angle·flutes), ≥4 segments per flute, entasis swell) turned
    every park column from a pipe into an order; the same trick scalloped
    the wheel gondola hulls (belly-weighted flutes, same envelope) and clam
    valves (rim-weighted flutes + wavy lip). Always recompute normals after.
  - Half-primitives are the open-lathe bug in disguise: a half CylinderGeometry
    pediment shows its open cut plane from below (caught in self-review —
    replaced with a full squashed cylinder half-sunk into the cabinet). Any
    "arched cap" should be a closed solid intersecting its base.
  - Cloth/banner sway without attributes: merge banners into ONE mesh
    (SlotWriter-style bake = positionLocal IS world position), weight sway by
    (1 − uv.y), phase by positionLocal.z. Banners must NOT cast shadows —
    the cached static clipmaps would freeze the flap mid-pose.
  - New decorative assets, all instanced/merged and footprint-aware:
    esplanade silk banners (swaying, gold-bordered, pearl emblem), midway
    bulb festoons (catenary wires in the iron slot + one instanced globe
    draw), ~8 giant clams (pulsing electric mantle spots, nacre pearls),
    ~18 barnacled amphorae in spill clusters, wishing-well roof + windlass +
    pail, wreck rigging catenaries + a toppled anchor, arrival bollard
    wraps + a coiled line, bell rope fender + floor compass rose.
  - Reef grew to six archetypes (added tube sponges/barrel sponges/table
    corals — closed clockwise lathes with visible hollow interiors, no
    DoubleSide) sharing one colony-patch material recipe with positionLocal
    tip gradients. Jelly/ray/whale meshes rebuilt (see wildlife.md) with the
    SAME morph channels so existing vertex animation drives them unchanged.
  - Wheel gondola added-draw budget: hull flutes cost zero draws (displaced
    lathe), the brass gunwale lip is +1 mesh/car; the spiral crest idea was
    dropped as +48 draws. When dressing per-car parts, prefer displacing the
    existing lathe over adding members — cars swing independently so they
    can never share an InstancedMesh.
- 2026-07-13 craft pass round 2 (Scott lifted the "fresh by ruling" guard —
  the 07-12 redesigns got their own improvement pass):
  - Urns: the "gadrooned bowl" is now genuinely gadrooned (16 lobes carved
    into the swell by displacement inside the cached proto), a brass girdle
    rings the knop, and three trailing fronds spill over the rim — their
    spine clears the rolled rim TOP (y 1.13 over rim 1.1) before drooping;
    the first draft clipped straight through the rim wall. Check any
    over-the-edge spine against the profile it crosses.
  - Fountain: tier-two flare is scallop-gadrooned; BOTH raised tiers hold
    standing water (two one-draw ripple discs on the reflecting-pool
    recipe — jets now fire out of pools, not dry marble); eight bronze fish
    leap around the tier-one dish (one merged crescent: torus-arc body with
    head sphere + tail cone closing BOTH open arc ends — the banquette
    rule); nacre bead swags sag between the crown horns.
  - Carousel tack: reins from pommel to each species' bit point + brow
    boss, built ONCE per kind and cached (tackGeometry Map) — 20 mounts
    cost 20 draws, not 60. Chariot gained a closed shell fan (squashed full
    sphere, never a half-primitive) and side grab rails.
  - Torrent cars: +2 draws/car — merged brass trim (six engine-bay louvres
    + bow roundel rings) and merged nacre roundel discs, max reach 0.45
    inside the 0.62 audited half-width.
  - Pearl cabins: all inside the existing four slots — corner gussets to
    the side eave rails, ridge-end bead finials (kept at z ±1.0 so the
    audited z-size stays under 2.2), and bench legs (the seats floated).
  - Midway: narwhal got carved marble splash ripples + two leaping bronze
    companions; pearl diver got flush lane rails on the incline (offset
    along the ramp's rotated up-axis, visual only); the kraken tower got
    its eye (nacre sclera, iron pupil, brass lid) above the rungs.
  - Small wildlife: seahorse body is ring-plated (radius ripple fading
    where the tail thins); turtle shells wear scute seams as CONTOUR LINES
    of one plate field (fract-band distance → seam grooves + per-plate
    mottle, top-masked); butterflies carry authored wing markings (dark
    scalloped border + one eyespot per forewing) gated by the flutter
    channel so bodies stay plain. Contour-lines-of-a-field is a good
    generic trick for organic plating.
- 2026-07-13 inspection fixes (Scott's screenshots):
  - **Wheel lattice pierced the gondolas** — the clearance had been computed
    for the PIVOT, not the swung-down hull: a car hangs 2.02 m below its
    pivot and the hang direction sweeps every in-plane direction over a
    revolution, so car-fixed matter fills an in-plane disc of radius ≈2.8 m
    around each pivot for all |z| ≤ 1.14. NO member may cross the inter-rim
    space near the rim circle. The rims are now triangulated IN THEIR OWN
    PLANES (48-node zigzag between outer/inner hoops at z ±1.35, one
    96-instance draw); the rim pair is tied across z only by the pivot
    axles. Rule: rotating-frame clearance must be checked against the full
    SWEPT VOLUME of suspended parts, not their anchor points.
  - **Lamp cap/bead floated above the globe** — the cone cap's base radius
    (0.2) exceeded the globe radius (0.19), so it could never touch the
    sphere. Lantern heads now compute a real contact latitude: cap base
    r = 0.66·R seats at y = √(R²−r²) on the sphere; a calyx cup cradles the
    glass from below to the equator. Rule: anything "capping" a sphere must
    derive its seat height from the sphere equation, never eyeballed.
  - **Pearl-cabin ridge beads hovered** — placed at the roof Bézier's
    CONTROL height (2.2) but a quadratic curve peaks at ≈2.02; control
    points are not on the curve. Beads now half-sink into the actual crown.
  - **Torrent screen** removed by ruling: the glass dome read as nothing
    underwater and its centre mount strut read as a bare rod stuck in the
    deck. The brass hoop + side mounts stay as a racing wind hoop.
  - **Teleport menu**: every FACILITY_ENTRANCE_SIGNS entry now carries a
    subtitle (tidal-court, leviathan-overlook, jelly-court, turtle-lagoon
    added — the menu AND the physical sign atlas both render it), and the
    menu's back key is Q (hint + handler); Esc still silently closes the
    menu before cascading to the pause card so pause never captures a
    frozen input state.
- 2026-07-13 standing-defects pass (Torrent cockpit, exposure swing, seabed
  moiré, roaming freezes):
  - **A lathe can never carry a cockpit.** A full revolve roofs any deck
    opening with its own top arc — the Torrent tub/seat sat sealed INSIDE the
    closed hull (Scott's screenshot: continuous shell inside the coaming) —
    and a phiStart/phiLength sector slots the hull nose-to-tail instead.
    Openings in solids of revolution are authored per RING: clip each ring's
    arc where the opening's plan ellipse crosses it (endpoints exactly on the
    ellipse → analytic rim, no staircase) and bridge rim→coaming with a
    collar wall. Hull authority: rides/torrentCarHull.ts (leaf), proven by
    `auditTorrentCarHull` in audit:geometry (winding, envelope, openness
    probes, rider sightline, collar tuck).
  - **`rotateX(−π/2)` maps profile +y to −z, not +z** (verified numerically —
    the matrix comment in three docs is easy to misread). The Torrent hull
    was silently z-MIRRORED against every radius-keyed fitting for two
    passes; the near-symmetric profile masked it (bow collar floated 8 cm,
    "half-embedded" pearl floated clear of the tip). When a lathe must match
    z-keyed fittings, build the rings directly in final coordinates (or
    rotateX(+π/2)) and let one module own both the surface and radiusAt().
  - Exposure retune (exposureMeter.ts): target =
    clamp(0.6·min(keyEV, highlight98%+0.35), −2.5, +0.75), readback every 12
    frames, brighten/darken 1.4/2.3 s⁻¹. Two field defects drove every
    number: looking DOWN at caustic-lit sand crushed the frame and recovered
    over seconds (response gain 0.6 halves the swing; faster brighten +
    tighter cadence fix the recovery), and void-dominated Torrent frames
    (precipice wall, vertical re-entry dive) rode the old +1.8 ceiling and
    blew the visible sand white while ripple shading stayed dark — the
    reported "extremely contrasty dark wave patterns". The −2.5 floor is
    load-bearing above water; do not raise the +0.75 ceiling without
    re-checking both Torrent spots.
  - The OTHER half of the contrasty seabed: the mip-less caustic web aliases
    into dark moiré waves at grazing incidence — the ocean-cascade barcode
    class, on a different texture. Surface consumers now use
    `causticWorldSample(node, { footprintFade: true })` (dissolves the web
    into its conserved 0.18 mean over 0.06→0.28 m/px measured from screen
    derivatives of the surface-plane coordinate). The god-ray march must
    keep the exact sampler — its per-pixel jitter makes derivatives garbage.
  - Roaming-freeze pass (the "CPU spike, GPU idle, no location" class):
    · Schedule boards flipped IN SYNC every 15 s — two 1024×512 canvas
      redraws + CanvasTexture re-uploads on one frame, anywhere in the park.
      Flips are now staggered 0.55 s apart (`pendingFlip`). Any future
      CanvasTexture rewriters must stagger the same way.
    · The WebGPU renderer never calls BufferAttribute.onUpload, so every
      procedural merge kept its CPU Float32Arrays for the whole session —
      hundreds of MB of external memory pressure feeding the browser's full
      GCs. `render/releaseGeometry.ts` swaps static-mesh arrays for
      ZERO-LENGTH same-type arrays after warmup (never null — the renderer
      still reads array.constructor/BYTES_PER_ELEMENT for later pipeline
      layouts, and .count is a constructor-set field that keeps supplying
      draw counts). Bounding volumes are computed BEFORE the swap (culling
      computes them lazily from arrays otherwise). Predicates: plain Mesh
      only, no morphs, all attributes plain StaticDrawUsage BufferAttributes;
      opt-out via geometry.userData.keepCpuArrays. Runs only after warmup
      (which uploads everything); validation runs skip it. Stats on
      `canvas.dataset.geometryRelease`.
    · HitchRecord now carries `longTaskMs`, `heapMB`, `heapDeltaMB`. Reading
      a freeze: frameMs huge + cpuMs small + longTaskMs small → the stall is
      OUTSIDE JS (GPU process, compositor, driver); longTaskMs large →
      main-thread block between ticks; heapDeltaMB strongly negative →
      major-GC signature. Attribute BEFORE optimizing further.
    · recordAutoRuntimeSample wrote localStorage ~1/s while dynamic
      resolution breathed (unquantized renderScale changed the signature
      every sample; localStorage is synchronous disk I/O). Persisted scale
      is now 0.05-quantized and writes are ≥20 s apart (tier demotions still
      land immediately).
    · Wishing-well pennies built a NEW CylinderGeometry per toss and never
      disposed it — runtime prototypes must be created once and reused (the
      amenity rule applies to spawned props too).
- 2026-07-14 sand-normal + residual roaming-freeze pass (both reproduced and
  isolated before editing):
  - **Sand failure was a coordinate-space bug, not exposure/fog/caustics.**
    `?pass=no-post` preserved the dark fill and `?pass=normal` showed the
    terrain normal staying camera-fixed as the view pitched down. Three r185's
    `MeshStandardNodeMaterial.normalNode` hook is view-space, but terrain.ts
    returned the locally authored ripple normal directly. The material now
    resolves the same local field and transforms it once with
    `transformNormalToView`; no color, wave, caustic, fog, light, or grading
    value changed.
  - **The residual freeze was a scheduled whole-scene shader rebuild.** The
    fountain faded its four PointLights by intensity and then toggled
    `.visible` at six seconds. That removed four light IDs from Three's
    `LightsNode` key: instrumentation measured 84 synchronous live pipeline
    requests at t=5.89 s followed by 1.88 s + 0.37 s blocked frames. The
    inverse transition recurred when the scheduled show began at t=90 s.
  - Driver warmup was not the remaining answer. Even with both pipeline
    variants retained, the pause remained because light-key invalidation
    rebuilds every RenderObject/NodeBuilder state on the main thread. Small
    InstancedMeshes made the miss especially pathological: semantically
    identical WGSL differed only by a regenerated `NodeBuffer_<id>` name.
    All warmup/pinning/padding experiments were reverted.
  - Final fix: the four fountain lights remain scene members, and their
    intensity becomes exact zero at the same `showGlow <= 0.02` cutoff where
    visibility previously became false. Output and scheduling are unchanged;
    only shader topology stays stable. A tier-2 scripted full park circuit
    crossing the 90 s show start produced zero runtime pipeline creations,
    zero >120 ms frames, ~8.2 ms steady CPU frames, and static-shadow refresh
    CPU <=0.8 ms. Restore the normal >40 ms telemetry threshold after probes.
- 2026-07-14 recorded medium ambience: only the global camera-medium bed uses
  assets (`ocean_ambiance.mp3` + `seagulls.mp3` above, `underwater.mp3` below,
  and `water_splash.mp3` on either-direction crossing); all ride, wildlife,
  music, chime, and interaction sound remains procedural. Ambient loop
  tails/heads are baked through a 3 s equal-power crossfade before native
  looping, and the medium buses crossfade on the canonical displaced-waterline
  event.
- 2026-07-14 ambience tuning: `seagulls.mp3` joins the above-water ocean bed on
  its own lightly attenuated, crossfaded loop bus; the underwater bus gain is
  raised modestly.
- 2026-07-14 replacement splash + submergence tail: the new 0.94 s
  `water_splash.mp3` impacts within its first 0.1 s, so it plays from offset 0
  at gain 0.28 (2× the previous source gain). Recorded medium beds now join
  after the procedural waterline low-pass but before master volume; this lets
  ocean + seagulls retain a real 4.5 s gain tail when submerging instead of
  having their high frequencies disappear during the 0.6 s filter sweep.
- 2026-07-14 Descent Bell glass barcode: transparent `depthWrite=false` glass
  was still replacing the scene pass's no-blend normal MRT with its curved
  near-shell normal while depth remained the distant ocean/deck. GTAO shaded
  that incoherent depth/normal pair into vertical bands bounded exactly by the
  bell shell. Shared decorative glass now writes AO-receiver alpha zero, as
  the ocean already does; do not feed transparent optics into opaque AO.
- 2026-07-14 Torrent motion polish: Three `Curve.getPointAt()` defaults to a
  200-division arc-length cache even when callers build a much denser frame
  table. On the 720 m Torrent this produced 22.6% nominal-step variation and
  visible cadence through sustained turns. Set `arcLengthDivisions` before
  the first length/sample query, audit step uniformity, and evaluate rendered
  position/tangent from the live spline; use the table for smoothly
  interpolated authored bank. Spatially ease force-zone boundaries and
  compensate total work so removing jerk does not silently redesign pacing.
- 2026-07-14 pilotable submarine (see systems/submarine.md for the full set):
  - `refs/submarine.html` is ported verbatim into vehicles/submarineModel.ts
    (contract, atlas, geometry kit, every part) at SUBMARINE_SCALE 1.22.
    Four sanctioned adaptations only: geometry-space noise (moving body),
    physical viewport-transmission glass + MRT AO-alpha-0, lamp emission
    recalibrated to park HDR, caustics on all lit materials.
    MeshPhysicalNodeMaterial works fine in the pipeline (extends Standard,
    so applyCaustics/mrtNode/fog inherit; clearcoat+sheen render).
  - `select()` over a color()/vec3 pair types as Node<"vec3"|"color"> —
    cast at creation, same rule as varying().
  - A scaled Group makes hand-scaled local offsets through localToWorld
    DOUBLE-apply the scale. For emission/attachment points on scaled rigs,
    use child.getWorldPosition(), never precomputed scaled locals.
  - New `InteractionSystem.exclusive`: while set, only that interactable is
    eligible. Required for roaming vehicles — the piloted sub passes every
    gate/game in the park and an E meant for the helm would board a ride.
    Owners MUST clear it when focus ends (enter sets, exit/dispose clear).
  - Vehicle collision by ruling: the sub collides as the GUEST CAPSULE
    (0.35 r kinematic capsule + own character controller at the hull axis) —
    anywhere a guest fits, the sub fits; hull-vs-wall overlap is accepted.
    The carried player body and the parked blocker cylinder must both be
    excluded from the vehicle's computeColliderMovement via the filter
    predicate or the craft collides with its own passenger/footprint.
  - Kinematic vehicles at 60 Hz need render interpolation: keep prev/current
    pose in fixedUpdate and lerp with the loop's `alpha` in update(), or
    motion is visibly choppy on non-60 Hz displays. The chase camera then
    follows the RENDER pose, not the physics pose.
  - Exit is gated on a genuine ground park (seabed or a real fixed floor;
    supersedes the briefly-implemented settle-on-exit auto-descent, which is
    REMOVED): E
    under way shows a gentle reminder instead, via the new
    `InteractionSystem.notice(text)` transient caption (no key chip, same
    serif voice; `dismissNotice()` retires it when the action succeeds).
    Rationale: an abandoned hull mid-water is unreachable forever, and an
    unmanned auto-descent could ground it on a dome or ride. The hull therefore
    NEVER moves without a pilot.
  - Exit hand-back lands the camera exactly on the walking eye
    (feet + 1.7 = body + EYE_HEIGHT − capsule offset) — same-frame cut is
    invisible; copy the exit math from vehicleSeat/submarine when building
    future vehicles.
- 2026-07-14 submarine camera fixes (Scott's sighting: boarding blend faced
  backward, then "cut" to the sub):
  - NEVER bake a camera orientation through a plain Object3D scratch:
    `Object3D.lookAt` aims the object's +z AT the target, while cameras
    render down −z — the resulting quaternion is exactly reversed, and the
    error hides until the first real `camera.lookAt` snaps it right (reads
    as a cut). Build camera-facing quaternions with
    `Matrix4.lookAt(eye, target, up)` (camera convention) +
    `setFromRotationMatrix`, or use a scratch camera.
  - Chase framing tightened by ruling: 7.0 m back / 2.7 m up (was 10.6/4.0)
    so the hull takes a bigger share of the frame while the eye still
    clears the dome.
- 2026-07-14 submarine screw illusion + surface floating (Scott's rulings):
  - Fast rotors are FAKED, never keyframed at the true rate: an 8-blade
    wheel strobes at render cadence above ~10 rad/s. Pattern (reusable for
    any future fast rotor): clamp the mesh rotation to a readable rate,
    cross-fade a motion-blur disc (chord-weighted smear + N-fold ghost
    arcs) over the strobe band, hide the real blades once the disc carries
    the read, and drift the ghost arcs at ~10% of shaft rate (wagon-wheel).
    CRITICAL: the disc must be a SIBLING of the spinning group with its
    pattern rotated only by a slow uniform — parented to the shaft it
    strobes exactly like the blades it replaces.
  - Floating craft get TRUE wave heights, not an approximate CPU swell:
    sea/buoyancyProbe.ts samples the displacement cascades at N hull
    points (same fixed-point choppy correction as the waterline probe) into
    its own storage buffer with async readback — gameplay CPU data only,
    never touching the waterline probe's same-frame visual state. Heave is
    a damped spring toward the local wave (stiffer above the surface than
    below — water pushes back harder than it lets go), and bow/stern/beam
    height differences become smoothed pitch/roll. Latency of a few frames
    is invisible through the spring. Dispatch only near the surface; one
    init dispatch prewarms the compute pipeline behind the ticket.
- 2026-07-14 propeller wake rework (Scott's spec: helical slipstream with
  tip vortices, hub rope, turbulence, subtle cavitation — never a straight
  particle cone):
  - The whole effect stays in the spawn-record + vertex-TSL architecture:
    store (hub centre, unit wake axis, initial radial vector) per bubble
    and rotate the radial with Rodrigues about the axis — this needs NO
    basis/angle bookkeeping on the CPU and radial ⊥ axis keeps it to two
    terms. Swirl ∝ axial/(0.4+r0) gives a fast tight hub vortex rope and
    slower tip filaments from one formula.
  - Real tip-vortex filaments are an EMISSION pattern, not a shader
    feature: cluster tip spawns on the live blade angles (visual prop
    rotation + k·2π/blades ± small jitter) and successive frames trace N
    interleaved helices through space for free. Per-spawn axial jitter and
    age-growing angular turbulence then unravel them downstream.
  - Swirl handedness about the WASH axis is invariant under thrust
    reversal (sign(spin)·sign(wash) ≡ −1): no per-instance sign attribute.
  - Cavitation reads as soft-bodied vapour (opacity fullest at the centre,
    faint at the rim — the exact inverse of a bubble's fresnel shell),
    shed at blade tips with tangential velocity, collapsing faster than it
    grew. Gate inception on shaft speed so it only appears near full
    throttle.
  - Ring pools sized ≈ rate × max life so an instance is only recycled
    after its dissipate envelope reaches ~0 — recycling is then invisible
    without any bookkeeping.
- 2026-07-14 wake regimes + the bob that vanished (Scott's screenshots):
  - A submerged prop wake and a surfaced boat wake are DIFFERENT effects —
    cross-fade emission by surfacedness, never one particle system for
    both. Underwater = milky turbulent cloud (soft puffs with seeded,
    age-scrolled fragment mx_noise erosion — reads volumetric/irregular,
    never uniform smoke) + bubble glitter inside it. Surfaced = flattened
    white foam patches churned at the stern: 45% thrown laterally at the
    stern quarters (the V arms), the rest centre churn; the hull's advance
    paints the trail. Foam pins itself to the TRUE surface by sampling the
    ocean's own displacement cascades in its vertex stage — same waves as
    the hull, no plane at y=0.
  - Discrete small rim-lit spheres alone can NEVER read as a dense bubble
    cloud — they read as scattered dots. The cloud is the low-opacity
    overlapping puff layer; bubbles are only its sparkle.
  - A chase camera that follows a floating vehicle's heave 1:1 CANCELS the
    bob on screen — the user sees "the boat stays still and the ocean
    moves" no matter how correct the buoyancy is. Boat-cams hold their own
    height reference: slow vertical follow (~0.45/s) with deviation-gated
    catch-up for real dives, fast look-target tracking. Perception bugs
    can masquerade as physics bugs — check what the camera subtracts
    before touching the simulation.
  - Numeric evidence beats guessing at coupled systems:
    canvas.dataset.submarine (?debug, while piloting) reports hull y, the
    three probe wave heights, surfacedness, and wave attitude at 2 Hz.
- 2026-07-14 wake simplification (Scott's visual ruling; supersedes the cloud,
  helical, and cavitation wake notes above):
  - Underwater wake is intentionally only a high-count pool of small bubbles
    with simple origin/drive/spawn records. There is no aeration cloud, helix,
    cavitation, spray, or secondary layer.
  - Surface wake is intentionally only the accepted foam. A CPU regime gate
    hides bubbles at `surfacedness >= 0.3` and hides foam below it, so old
    instances cannot leak across regimes.
  - The retained foam uses Kelvin arms plus centre churn and samples all three
    FFT displacement components.
  - Artifact diagnosis is deferred. The god-ray hypothesis was falsified and
    its experiment fully reverted; do not treat the stripe cause as known.
- 2026-07-15 submarine residue + facility collision:
  - Surface wake foam must age visibly, not hold nearly constant and then read
    as TTL removal. After a brief settle-in its opacity follows normalized
    remaining life continuously (`remaining^1.35`); geometric collapse is only
    the final overdraw cleanup.
  - Guest-walkable architecture and vehicle-solid architecture need different
    collision representations. Keep detailed floor/post/rail Rapier colliders
    for guests, and broad named envelopes for the submarine's building/ride
    query. The guest controller filters those envelopes by collider handle;
    dynamic game pieces are excluded through active collision types.
- 2026-07-15 lifted-submarine seabed bands:
  - Pass isolation was decisive: the bands remained in `no-rays`, were strong
    in raw `ao`, survived `ao-filtered`, appeared in `ao-applied`, and vanished
    where the AO receiver mask was zero. They did not cross open water. A
    temporary scale-correct sand-normal rewrite cleaned `normal` but left the
    bands unchanged, so it was reverted before the real fix.
  - Three r185's half-resolution GTAO produces false visibility rows when its
    0.25 m world radius is underresolved on a grazing seabed. The old 60→160 m
    view-distance fade missed high-camera pixels nearer than 60 m that covered
    far more world space per gather texel. Applied AO now measures reconstructed
    view-position derivatives, converts them to half-resolution footprint (×2),
    and fades raw AO to neutral over 0.0625→0.25 m/texel.
    `?pass=ao-footprint` proves the rejection field and `?view=seabed-high` is
    the fixed regression camera. Near-seabed contact AO remains; tiers 0/1/2
    are clean from the high camera.
- 2026-07-15 underwater horizon seam:
  - The camera-height-sensitive dotted/white line seen from the descending
    bell and a lifted submarine was the ocean mesh handoff, not another
    seabed/AO/fog defect. The detailed sheet ended at y=0, while the far skirt
    began 2 m inside it at y=-0.14; from below this was an open step with no
    connecting surface, compressed to a sub-pixel line at grazing incidence.
  - Removing the sink and matching the ±350 m edge removed the dotted gaps but
    left one solid antialiased line: exact abutment still let partial MSAA edge
    samples resolve against the bright background. Final seam is a 15 m
    COPLANAR coverage apron: the skirt begins at ±335 m, exactly where the
    detailed sheet's displacement keep reaches zero, and renders underneath
    the flat detailed border. There is no vertical step, shader change, or new
    draw. It adds only 2,048/3,072/3,584 flat triangles by tier.
    `?view=ocean-seam` fixes the failure-sensitive camera; `audit:geometry`
    checks all tiers for the 15 m overlap, zero height error, and positive
    winding. Never lower a coverage apron to hide z-fighting; keep it coplanar
    and entirely inside the detailed sheet's mathematically flat border.
- 2026-07-15 surface wake foam redesign (Scott's spec: part of the ocean, no
  levitation/dipping, never erased by re-crossing; supersedes the instanced
  foam-ribbon notes above — the foam pool is DELETED):
  - Foam that must persist in world space cannot live in the FFT cascades
    (they tile every 250/17/5 m) and should not live in an instance pool
    (ring-buffer recycling erases old trail as new foam emits — the exact
    reported bug). The accepted mechanism is a world-anchored accumulation
    field: `sea/wakeFoamMap.ts`, 1024² RGBA16F ping-pong over the 820 m
    force-field square, R = fresh churn (τ 2.4 s) / G = lacy residue
    (τ 8.5 s + diffusion), gaussian splats via the ChannelSim uniformArray
    impulse pattern, deposits merged by max() so crossing a trail refreshes
    it. Decay needs a small LINEAR bleed on top of the exponential so
    half-float texels reach exact zero — that zero is also what lets the
    compute pass self-gate (skip entirely ~35 s after the last splat).
  - Integration point matters more than the field itself: the ocean material
    merges wake coverage into the EXISTING Jacobian whitecap path (coverage →
    shared lace fbm → footprint keep → foamShade) rather than adding any new
    shading. That single choice buys "part of the ocean" for free: same
    lighting, same LOD hygiene, rides displacement exactly, sloshes with the
    same horizontal chop (both channels sample by undisplaced vWorldXZ).
  - Fixed-offset stamps trailing a moving emitter paint lines PARALLEL to the
    path (each stamp's lateral offset is constant), not a diverging V — you
    cannot Kelvin-arm a splat trail this way. Don't try: real wake FOAM is
    the widening turbulent band (residue diffusion provides the widening);
    the far V arms are wave texture, not foam. A short 3-stamp stern fan at
    the cusp angle covers the near-field opening honestly.
  - Trail persistence through regime changes is a feature: diving or cutting
    the throttle leaves the surface trail to decay naturally instead of a
    CPU gate culling it (only the bubble pool stays gated by surfacedness).
- 2026-07-15 submarine screw hum:
  - New machinery voices follow the startHum family (sine + near-octave
    partial + seeded bandpass noise on the procedural bus), but the global
    submerged lowpass (1.9 kHz) is inaudible on sub-100 Hz hums — a voice
    that must contrast across the waterline needs its OWN medium lowpass
    (260 Hz / 2.4 kHz here, swept on `sea/waterline-crossed`).
  - Continuous pitch coupling stays event-driven: re-emit
    `vehicle/submarine-running` with spin only when it changes >0.015 (start/
    stop keep 1.2/0.6 rad/s hysteresis), engine sweeps every pitched element
    with setTargetAtTime. Amplitude throb belongs on the noise texture gain
    only — on the master gain it reads as tremolo, not machinery.
  - Fade-outs click if you schedule a bare linearRamp: the ramp measures
    from the LAST scheduled event, so the value steps at the stop moment
    (Scott heard it as "a bad recording"). Always cancelScheduledValues +
    setValueAtTime(current) to anchor, then setTargetAtTime for the tail —
    stopHum now does this for every hum, and sources stop only ~8τ later.
    Linear fades also *sound* truncated (loudness is logarithmic); long
    tails must be exponential. Never share one AudioParam between an
    envelope schedule and per-frame sweeps — the submarine's spin-tracked
    loudness lives on its own gain node in series for exactly that reason.
- 2026-07-15 submarine hull shadow segmentation:
  - The hull builder was already equivalent to `refs/submarine.html`: its
    indexed grid shares vertices and writes analytic smooth normals. The visible
    56-ring pattern came from the 112 m moving-caster shadow map, whose 1024²
    projection is 21.875 cm/texel; it grouped several ~5 cm hull rings into
    broad self-shadow steps even though the material shading was smooth.
  - Do not "fix" this by disabling `receiveShadow` on the hull or by rebuilding
    its normals: both hide the symptom by removing valid lighting. Moving
    casters now use a 16 m / 1024² inner map (3.125 cm/texel) that blends to the
    original 112 m map between ~11.8 and 14.1 m from its snapped light-space
    center. The chase eye is 7 m behind the hull, keeping the whole submarine
    inside the fully weighted inner region.
  - Containment is the regression contract: static clipmaps are untouched;
    the original broad dynamic map keeps its resolution, extent, depth range,
    bias scaling, and bounded outside behavior; and it remains the exact shader
    fallback beyond the inner blend. Both dynamic comparison textures are
    sampled unconditionally, avoiding derivative/control-flow seams. Debug
    snapshots expose per-level coverage, texel width, bias, center, and render
    count; total shadow texture count is now six.
  - First visual verification showed the 16 m map narrowed and localized the
    bands, proving shadow quantization was involved, but did not eliminate
    self-acne. It also exposed new fine bands on the porcelain shroud. The cause
    was the inner map's normal bias dropping to 0.02 m while the pre-change
    112 m moving map used 0.08 m. The hierarchy now keeps that existing 0.08 m
    receiver-offset floor on its inner level while retaining the 7× finer texel
    footprint. This restores the old acne protection rather than adding more
    shadow resolution or changing geometry. A suspected duplicate grid index
    was only overlapping inspection output; source and reference both emit one
    triangle pair, so geometry remained untouched.
- 2026-07-15 physical glass correction:
  - The old shared/submarine glass used 7–9% constant-alpha blending because
    the implementation assumed a separate transmission backdrop render was
    required. Three r185 WebGPU already captures the completed opaque viewport
    from the current MRT target for `MeshPhysicalNodeMaterial` transmission;
    no extra scene pass or pipeline hook is needed.
  - `materials/glass.ts` is the one clear-glass recipe: transmission 1, IOR
    1.52 (built-in dielectric Fresnel), 5 cm optical thickness (refraction),
    subtle cyan volume attenuation, clearcoat, and PMREM reflection. Opacity
    stays 1 and alpha blending stays off so the framebuffer is not composed a
    second time.
  - Optical surfaces still write no depth and set normal-MRT AO receiver alpha
    to zero. This preserves the Descent Bell barcode fix and lets downstream
    GTAO/medium effects use the opaque surface behind the pane. Shadow-slot
    classification now checks physical transmission as well as `.transparent`,
    so upgrading glass cannot restore opaque roof/dome shadows.
- 2026-07-15 Descent Bell cage redesign:
  - Physical transmission made the old cage construction error unmissable:
    three straight cylinder chords approximated each smooth shell meridian,
    with sphere knuckles hiding the elbows. Chords inevitably pass inside and
    outside a curved lathe even when every control point appears reasonable.
  - The accepted cage uses four continuous circular tube sweeps over the same
    `CatmullRomCurve3` that generates the glass. Its centreline is offset along
    the profile normal by tube radius + 2 cm, which makes clearance a geometric
    invariant rather than an authored guess. The base and waist collars use
    samples from that identical offset curve; a single crown collar bridges
    the stand-off ribs into the metal crown without buried endpoint knuckles.
- 2026-07-15 Descent Bell glass-belt entrance:
  - Keep the upgraded physical glass constant. The late boarding "zoom" came
    from moving the camera through a refractive shell, so geometry now owns the
    ingress instead of runtime material changes: the shell is split into lower
    and upper lathes with a full 360-degree empty belt from local y = 1.20 to
    1.92. The original shared 1.2 s straight camera blend is restored exactly.
  - Two 4.5 cm brass torus collars replace the former waist collar, follow the
    profile radii at the glass cuts, overlap the raw edges deliberately, and
    join the existing four continuous meridian ribs. `audit:geometry` checks
    that the independently sampled glass sections end at the authored cuts,
    never intrude into the 72 cm opening, and preserve the minimum
    camera-clearance height.
- 2026-07-15 submarine solid-surface parking:
  - Paved path geometry, thin Rapier boxes, and vehicle ground-height queries
    share the segments and exact top heights from `world/pavedWalkways.ts`.
    Keep these authorities unified or a vehicle can visibly bury into a path.
  - The submarine ground probe samples the full scaled ~0.56 × 0.41 m belly
    step (centred at local z +0.3), not the hull-axis capsule.
    `PhysicsSystem.highestStaticSupportY` admits upward-facing real fixed
    floors (station floors, plazas, terraces, decks) as support and valid
    parked states. It excludes sensors, moving bodies, coarse terrain
    heightfields, and broad vehicle-only envelopes.
  - The initial berth moved 3 m east from (6, 311) to (9, 311), preserving its
    north-facing entrance placement while giving the arrival tower more space.
- 2026-07-15 lifted-submarine shadow depth clipping:
  - The clean line that progressively erased the submarine's seabed shadow was
    the 16 m moving-caster map's far plane. Dynamic hierarchy ownership is
    selected in light-space XY, but an out-of-Z bounded sample returns fully
    lit; the fine level therefore suppressed the valid 112 m fallback. Its
    8 m Z-center quantization made the shadow disappear and reappear cyclically
    during forward travel.
  - Dynamic maps now use the same 70 m down-sun receiver allowance as static
    levels. This preserves the 16 m map's 3.125 cm XY texel footprint, both
    existing shadow passes, bias, snapping, cross-fade, and caster layers; only
    the orthographic depth envelope expands.
- 2026-07-16 minimal HUD exception:
  - The approved in-play UI now includes cardless corner control hints and an
    FPS number alongside contextual action prompts. Control ownership is the
    hint authority: on-foot above/below-water state selects arrival/park hints,
    borrowed ride control hides them, and `SubmarineSystem.isAboard` selects
    helm hints. Do not infer ride names or camera positions in the UI.
  - FPS is presentation cadence from `GameLoop.onFrameEnd`, smoothed before a
    restrained 400 ms DOM update; it is not CPU time or a second stats panel.
