# Sea Park — Implementation Plan

> Targets the **ultimate state** of the game in one continuous build. Design canon: `dev_docs/design.md` (confirmed 2026-07-09). Stages below are dependency ordering, not feature tiers — everything listed ships.

## 0. North star

Photorealism as the base, dream as the layer. Every system is physically grounded (real scale, real light transport, real motion), and the dreamlike quality comes from a small set of deliberate stylization levers applied on top — never from cutting corners:

- **Impossible clarity** — underwater visibility tuned to ~250 m (real seas: <40 m). The single biggest "dream" lever.
- **Color** — turquoise/gold palette pushed slightly past nature; candy accents on ride vehicles and canopies; final 3D LUT grade with lifted teal shadows and warm highlights.
- **Light** — soft wide bloom on glints and lamps, slightly oversized sun sparkle, chromatic shimmer in caustics.
- **Motion** — everything sways gently on a global "current" field: kelp, banners, gondolas, jellies. Nothing is ever perfectly still.
- **Shape** — architecture is strict Art Nouveau realism, but ride vehicles, carousel mounts, and props get slightly plump, rounded, toy-like proportions (the "little cartoonish" note lives in silhouettes, never in shading).

Anti-goals: no toon/cel shading, no demo-scale shortcuts, no placeholder art shipped as final. Each build stage lands at final visual quality for its scope.

## 1. World model (load-bearing decisions)

- **The sea behaves like air.** Physics is ordinary dry-land physics (gravity 9.81, no buoyancy on the player, rides run like air rides). "Underwater" is exclusively a rendering + audio treatment. No swimming, no floating, no diving gear, no airlocks. Never explained in fiction — dream logic.
- **Fixed time of day.** One authored moment — the eternal golden afternoon. Sun elevation ~42°, azimuth ~215° (SW), so shafts rake diagonally across the Esplanade toward the drop-off. No day/night cycle, no dusk arc. The Grotto interior supplies the game's darkness contrast instead.
- **No characters.** No humans, no automatons, no humanoid anything. The park runs itself — machinery is the staff. Sea life is the crowd.
- **Coordinates & scale** (sea level = y 0):
  - Park plateau ~600×600 m; seabed averages −26 m; plaza floors ~−24 m.
  - North rim: drop-off cliff falling to −300 m (fog swallows it — reads as abyss).
  - Great Wheel: radius 20 m, hub at −12 m → crest reaches **+8 m above the surface**.
  - Torrent coaster: station −22 m; 34 m main drop off the shelf edge to −58 m; breach hump apex +3 m; ~950 m of track; peak speed ~26 m/s.
  - Grand Atrium dome ⌀44 m, 26 m tall; Esplanade vault 14 m tall; carousel ⌀16 m, two decks; Pearl Line loop ~1.4 km at 14 m above the floor.
- **Session model:** no persistence, no saves. Every visit is The Day, fresh. Souvenirs (punched ticket, pressed pennies) live for the session.
- **Containment is physical:** balustrades, rock ridges, and kelp walls — no invisible walls. The coaster is the only thing that crosses the rim.

## 2. Tech stack

| Piece | Choice | Notes |
|---|---|---|
| Bundler | Vite + TypeScript (strict) | plain TS, no framework; minimal DOM for UI |
| Renderer | `three` latest at install (≥ r180), `three/webgpu` + `three/tsl` | WebGPU only; boot fails to a styled "WebGPU required" ticket screen |
| Physics | `@dimforge/rapier3d-compat` | character controller, ride constraints, game props. (If constraint stability under the coaster train proves insufficient, escalate to Jolt — raise with Scott first) |
| Lint/type | eslint + @typescript-eslint; `tsc --noEmit` | run after every task |
| Debug-only | `tweakpane`, `stats-gl` as devDependencies, loaded via dynamic import behind `?debug` | never in the shipped path |
| Audio | WebAudio (native + Three PositionalAudio) | fully procedural synthesis by default (§12) |

No react, no CDN assets, no texture downloads — materials are procedural TSL (real PBR textures only if Scott supplies them).

## 3. Code architecture

`src/main.ts` is bootstrap only. `runtime/` owns the loop and system registry and nothing else (CLAUDE.md rule). Every feature is a system module implementing `init/update/dispose`, registered explicitly:

```
src/
  main.ts               bootstrap: WebGPU init, ticket screen, system registration
  runtime/              loop (fixed-step sim + variable render), system registry, shared context
  core/                 seeded PRNG, math, event bus, park clock/scheduler, quality tiers, debug harness
  physics/              rapier world, collider factories, sync helpers
  render/               renderer setup, post pipeline, exposure, grading/LUT
  sky/                  sun + above-water sky
  sea/                  wave spectrum, surface (above/below), Snell window, aquatic perspective,
                        caustics, god rays, particulates, current field
  world/                terrain, drop-off, scatter, parkPlan (master layout data), districts/, props/
  archkit/              procedural Art Nouveau generators (columns, arches, domes, glass, lamps…)
  materials/            procedural TSL material library (brass, marble, nacre, glass, mosaic…)
  player/               controller, interaction raycasting, held items, seating
  rides/                common/ (boarding, restraints, ride cameras) + bell/ wheel/ torrent/
                        carousel/ grotto/ pearline/
  games/                ringtoss, skeeball, hammerbell, pennypress, feeding, wishingwell, sweets
  wildlife/             GPU boids + species, rays, turtles, jellies, whale, seahorses
  audio/                engine, synth instruments, positional sources, acoustic zones
  ui/                   ticket screen, contextual prompts, pause card
```

- **`world/parkPlan.ts` is the single source of truth** for layout: district transforms, path graph, prop scatter seeds, ride placements, schedule table. Every system consumes it; nothing hardcodes positions elsewhere.
- **Determinism:** all generation from seeded PRNG; zero `Math.random()`/`Date.now()` in world gen. Same seed → identical park.
- **Docs:** each system gets `dev_docs/systems/<name>.md` capturing design choices beyond the code, written when the system lands (per CLAUDE.md).
- **Debug harness** (`core/debug`): URL flags — `?view=<postcard>` jumps to a fixed validation camera, `?pass=<name>` shows an isolated render pass (ao / caustics / rays / depth / normals / no-post), `?tier=<0-2>` forces a quality tier, `?debug` opens tweakpane + stats. This is how graphics work stays verifiable (skill: threejs-visual-validation).

## 4. Render pipeline

Skills: threejs-image-pipeline, threejs-bloom, threejs-exposure-color-grading, threejs-screen-space-ambient-occlusion.

- Forward WebGPU with **MSAA 4×**; HDR half-float throughout; per-effect temporal accumulation (volumetrics, caustics soft shadowing) with blue-noise jitter rather than full-frame TAA (avoids ghosting on thousands of fish).
- Pass graph (single `PostProcessing` graph owns tone mapping; renderer tone mapping off):
  1. opaque + MRT (color / normal / depth)
  2. GTAO half-res → bilateral upsample (contact grounding for colonnades, coral, props)
  3. water surface + transparents
  4. volumetric god rays (§5) composited by depth
  5. bloom (scene-relative emissive hierarchy — sun sparkle > lamps > bioluminescence)
  6. exposure (fixed authored EV; the fixed sun makes metering unnecessary) → AgX/filmic tonemap → **32³ LUT dream grade**
- Specular AA (roughness-from-normal-derivative) on all procedural materials — glints must sparkle, not shimmer with aliasing.

## 5. Sea & sky systems

Skills: threejs-spectral-ocean, threejs-water-optics, threejs-atmosphere-aerial-perspective.

- **Wave spectrum core** (`sea/spectrum`): WebGPU-compute FFT, 3 cascades (~250 m / 40 m / 7 m). One spectrum drives: the surface seen from above (arrival), the Silver Ceiling seen from below, the caustics projector, and god-ray flicker. Everything about the light agrees because it shares one wave field.
- **Surface from above** (arrival pavilion): choppy displacement, Jacobian whitecap foam, analytic sky reflection, sun glitter.
- **Silver Ceiling (from below):** side-aware Fresnel with total internal reflection outside the critical angle, **Snell's window** overhead (the refracted circle of sky + sun disc), crest scatter glow. Visible from everywhere in the park; the Observatory exists to stare at it.
- **Aquatic perspective** (`sea/medium`): analytic depth+distance absorption/inscattering (turquoise → deep blue; darker looking down, brighter looking up), applied to every material via a shared TSL fog node. Visibility ~250 m (dream clarity), tuned so the far districts float in haze and the drop-off reads as infinite.
- **Caustics:** generated from the wave normal field (differential-area method) into a 1024² tile, world-projected along the sun direction over ~40 m tiles, 3-tap chromatic offset, attenuated with depth; modulated by the cascaded shadow system so caustics never crawl through shadowed interiors. This is the signature "glints cast down" feature — it touches every lit surface in the park.
- **God rays:** low-step volumetric slab raymarch (surface → seabed) with blue-noise + temporal filter, density modulated by the wave field and sun shadowing; composited by depth. Quality-tiered step count.
- **Particulates:** camera-following 60 m wrap-around volume, ~30 k instanced motes (marine snow, sparkle plankton) + bubble emitters at vents/props; all drift on the current field.
- **Current field** (`sea/current`): global curl-noise flow sampled by kelp, banners, ropes, jellies, particulates, gondola sway — the "nothing is ever still" pillar.
- **Waterline crossing** (bell descent, wheel crest, coaster breach): above/below state swap for fog + audio, meniscus distortion band at the interface, droplet streaks sliding down glass after each breach (skill: threejs-precipitation-surfaces patterns).

## 6. Terrain & flora

Skills: threejs-procedural-fields, threejs-procedural-vegetation.

- 1024² heightfield over 700×700 m (white-sand plateau, gentle dunes, authored flat pads for plazas from parkPlan), plus a sculpted cliff band at the north rim with a skirt to −300 m.
- Shared procedural field stack (one noise "cause" driving many channels): sand ripple normals, path-wear mask (sand compacts along the path graph), seagrass density, coral-cluster placement, rock outcrops.
- Scatter system (BatchedMesh/instancing): coral colonies (staghorn, brain, fans — procedural geometry with nacre/candy accent palettes), rocks, shells, starfish.
- **Kelp forest** boundary: ~300 stalks (8–14 m) with rooted sway on the current field; **seagrass meadows**: ~200 k GPU-instanced blades (realistic GPU grass technique adapted to slow water sway).
- Rapier: heightfield collider + static colliders from archkit + prop colliders.

## 7. Architecture kit & material library

Skills: threejs-procedural-architecture, threejs-procedural-geometry, threejs-procedural-materials.

- **archkit** generators (parametric, seeded, compiled to material-slot meshes): fluted columns with kelp-motif capitals, whiplash arches, ribbed glass domes and barrel vaults, colonnades, balustrades, mosaic floors (radial shell patterns), lamp posts (frosted globes), benches, turnstiles, signage frames, banner rigs, kiosk shells. Since the sea is air, buildings are **open pavilions** — fish drift through the colonnades; glass is decorative (canopies, stained glass) not containment.
- **Stained glass casts colored caustic light** (transmission-tinted shadow/projector treatment) — Atrium rose window and Grotto entrance get hero placements.
- **materials/** library (all TSL, all procedural): polished brass, verdigris copper, white marble (subtle veining), mother-of-pearl (thin-film iridescence), frosted + clear glass (transmission, roughness-graded), mosaic ceramic, gilded trim, wrought iron, painted wood (midway candy tones), sand, coral skins, wet-look varnish on everything near the floor (the world glistens slightly — dream lever).
- Close-inspection budget: geometry and material detail hold up at 0.5 m viewing distance (player can walk up to anything).

## 8. Player, camera, interaction

Skill: threejs-camera-direction.

- Rapier character controller: walk 1.5 m/s, brisk 3 m/s, eye height 1.7 m, smooth step handling on stairs/kerbs, no jump. Head-bob nearly imperceptible; motion tuned for composure.
- Interaction: proximity + view-cone raycast → single contextual DOM prompt (elegant serif caption, fades in/out). Interactables: ride gates, game counters, penny presses, food kiosk, benches, wishing well, the bell.
- **Held items** presented as finely-modeled props floating at hand position with inertia sway (no arm mesh — clean, dreamlike, avoids uncanny gloves): golden ticket (gets punched with a satisfying clip animation at each ride), pocket brass park model (the only map), ice-cream cone (slowly melts), fish-food cone, midway prizes, pressed pennies in a velvet book.
- Seating: benches and ride vehicles use smooth authored camera moves in/out (no cuts anywhere in the game); seated free-look with comfortable limits.

## 9. Rides

Common framework (`rides/common`): boarding gates + queue rails, seat attach/detach, restraint animations, per-ride camera rig (seated free-look + subtle inertial lag), ride audio hooks, schedule integration. All vehicles are physically simulated or physics-faithful spline dynamics — no canned mograph. Skill: threejs-procedural-animation.

1. **The Descent Bell** (arrival + re-ridable): brass-and-glass bell on a cable from the buoy pavilion. Opening sequence: sky, gulls, real FFT ocean from above → waterline crossing → the park revealed in god rays below. One unbroken shot, fully interactive.
2. **The Great Wheel:** 40 m wheel turning in open water, 12 nautilus-shell gondolas on pendulum pivots (constraint-simulated sway), airlock-styled boarding without the airlock fiction. Crest **breaks the surface** every revolution — foam, droplet streaks on the glass, three seconds of sky, then blue again. Full lamp rigging (instanced emissive bulbs).
3. **The Torrent** (coaster): track authored as C² spline network with clothoid-blended curves and solved banking; rail/tie/support geometry generated along it (sculpted rail profiles — skill: threejs-procedural-geometry). Train: 5 articulated brass torpedo cars, longitudinal dynamics integrated from gravity/drag/launch impulses along arc length (energy-correct, not keyframed). Sequence: station → launch → plunge **off the shelf edge into open blue void** → wreck thread-through → helix climb → **surface breach hump** (+3 m, two airborne seconds) → splash-styled re-entry → brake run. ~90 s. Lap-bar restraint interaction; the wreck is a real dressed set piece.
4. **Carrousel des Abysses:** two decks, ~24 mounts (seahorse, dolphin, turtle, ray, narwhal, nautilus chariot) in nacre/brass with candy accents, plump toylike silhouettes; crank-and-gear vertical bob mechanically modeled (rods actually connect); ornate canopy, mirror center, full bulb rigging. Mount choice at boarding.
5. **Grotto of Pearls** (dark ride): moon-pool boat into caverns beneath the reef. The channel is the game's one **real liquid**: bounded RGBA heightfield water sim (skill: threejs-water-optics) — the boat floats via buoyancy samples, bow ripples propagate, drips ring the surface. Scenes: bioluminescent gardens, shell-organ kinetic sculpture (mechanical, not a character), pearl treasury glowing like a galaxy, one gentle drop. ~4 min. The park's darkness contrast lives here.
6. **The Pearl Line:** cable gondola loop (~1.4 km, 14 m up), 8 cabins, 2 stations (Atrium, Wheel Pier); cabins pause at stations for boarding, sway on the current field, and deliver the aerial tour of the whole park.

## 10. Games & small wonders

All real physics toys (Rapier), all diegetic:

- **Ring the Narwhal** — toss brass rings onto narwhal horns (grab, aim, throw with arc assist off).
- **Pearl Diver** — skee-ball: rolling pearls up a lacquered ramp into shell pockets.
- **Kraken Bell** — timing-swing hammer, puck up the rail, bell actually rings the zone's audio.
- Prizes appear on the counter: paper hat (wearable — visible brim edge in first person), tiny plush kraken (held item).
- **Turtle feeding** at the lagoon (pellets toss, wildlife responds), **wishing well** (real small water sim reused from grotto tech; coin ripples + caustics), **penny press machines** (8 across the park, each with a unique park motif; crank interaction, coin drops into the velvet book), **sweets kiosk** (ice cream), **punch ticket** stamped at every ride gate.

## 11. Wildlife

The crowd. Skill: WebGPU compute via TSL throughout.

- **Schooling fish:** GPU boids over storage buffers — target ~15 k fish across 3–4 species (silversides, golden trevally-likes, candy-striped reef fish), coarse park SDF (baked from parkPlan colliders) for obstacle flow, attraction hooks (lamps, feeding, carousel lights), vertex-TSL swim deformation on instanced meshes. Schools split around the player — the Esplanade flyover is a scheduled hero behavior.
- **Rays:** 6 gliding on lazy spline fields with procedural wing undulation; one manta hero pass over the Esplanade on the schedule.
- **Turtles:** 8 lagoon residents with feeding response; **jellies:** ~400 drifting in the Jellyfish Court + 200 bioluminescent in the Grotto, pulse-driven locomotion on the current; **seahorses:** 40 clustered around the carousel exterior (the nod).
- **The whale:** one humpback (~14 m), scheduled pass along the drop-off every ~20 min — approach audio first (sub-bass song), shadow, then the eye past the Overlook glass rail. Fully animated procedural swim on an authored path.

## 12. Audio & the park schedule

- **All-procedural synthesis by default** (WebAudio): music-box waltz for the carousel (composed note sequence, plucked FM voices + long reverb), calliope rag for the Midway, soft harmonic pad + filtered shimmer for the open park, chime peals for the schedule, whale song (filtered noise + sine choir), mechanical layer (gear ticks, cable hums, ratchets) synthesized per ride. If Scott prefers recorded music, he supplies files and they slot into the same source graph.
- **Acoustic zones:** open park = dreamy soft low-pass on distant sources + gentle underwater ambience; pavilion interiors = warmer, clearer; Grotto = long cave reverb; above the surface (bell pavilion, wheel crest, coaster breach) = bright dry air, crossing the waterline audibly swaps worlds.
- Positional audio on every ride and game; distance-muffled carousel waltz across the lagoon is a tuning target, not an accident.
- **Park clock & scheduler** (`core/scheduler`): Bubble Fountain show every 12 min (3 min choreography), whale pass every 20 min, manta flyover every 15, chime peal on the "hour". Announcement boards flip mechanically at each event. The park breathes on a timetable.
- **Bubble Fountain show:** choreographed instanced-bubble columns + shafts of lamplight synced to a composed music cue at the Tidal Court — the park's recurring grand spectacle (skill: threejs-procedural-vfx patterns).

## 13. UI

- **Ticket screen** (entry): park marquee typography over a live blurred view, "click to enter" = pointer lock; doubles as the WebGPU-unsupported notice and the generation/loading progress (park assembles behind it).
- **Contextual prompts** only, single line, serif, fading — no HUD, no minimap, no objective text, ever.
- **Pause card** (Esc): resume, quality tier, volume. Styled as the back of the golden ticket.

## 14. Performance plan

Target: 60 fps at 1440p-class output on Apple-Silicon Pro-class / RTX-3070-class hardware, with dynamic resolution scaling (0.7–1.0) and three quality tiers (auto-benchmarked on first load, overridable in pause).

Frame budget (16.6 ms): opaque scene ~5.0 · sea surface + FFT compute ~1.5 · caustics + god rays ~2.5 · GTAO ~1.2 · bloom/grade ~1.0 · shadows (cached, amortized) ~1.8 · wildlife compute ~1.0 · physics (CPU, off-thread where possible) ~1.0 · headroom ~1.5.

Key strategies:

- **Fixed sun + mostly-static world → cached shadow clipmaps** with targeted invalidation; only rides/wildlife render into a small dynamic near cascade each frame (skill: threejs-shadow-systems). This is the single biggest win the fixed-time decision buys us.
- Instancing/BatchedMesh everywhere (bulbs, balusters, coral, blades, fish); procedural materials = tiny memory + zero texture streaming.
- Distance policy: full geometry to ~120 m, generated LOD swaps beyond, aquatic haze does the rest (fog is free occlusion tuning).
- All park generation at load, async with progress; target < 8 s to open the gates on the reference machine.

## 15. Validation

Skill: threejs-visual-validation.

- **The ten postcards are the visual contract** — fixed bookmark cameras (`?view=descent`, `?view=breach`, …) matching the list in design.md. Any graphics change is judged at these views. Scott inspects in dev; agents verify framing/values against the postcard intent before closing a task.
- `?pass=` isolation for every major effect; no-post baseline view; seed sweep check (3 seeds must all produce a coherent park); GPU timing readout under `?debug`.
- Every stage ends: lint + typecheck clean, relevant `dev_docs/systems/*.md` written/updated, notes.md appended if a lesson surfaced.

## 16. Build order

Dependency-ordered stages; each lands at final quality for its scope and leaves the game runnable.

| # | Stage | Delivers | Acceptance |
|---|---|---|---|
| S0 | Foundation | Vite/TS/eslint strict, WebGPU boot + ticket screen shell, fixed-step loop, system registry, seeded PRNG, debug harness skeleton | app boots to empty HDR scene at 60 fps; `?debug` works |
| S1 | Image pipeline | pass graph, MSAA, GTAO, bloom, exposure, tonemap, LUT hook, specular-AA material base | test scene passes `?pass=` isolation checks |
| S2 | Ocean & sky | sun/sky, FFT cascades, above-water surface, buoy pavilion stub, waterline crossing mechanics | `?view=arrival`: open-ocean shot reads photoreal |
| S3 | Undersea medium | Silver Ceiling + Snell's window, aquatic perspective, caustics projector, god rays, particulates, current field | `?view=ceiling`: sun glints cast down on a test floor; postcard-grade |
| S4 | Seabed & flora | terrain + cliff, field stack, scatter, kelp, seagrass, colliders | `?view=dropoff`: standing at the rim reads as the edge of the world |
| S5 | Player & interaction | character controller, prompts, held-item rig, seating, ticket item | walk the seabed comfortably; sit on a bench; hold the ticket |
| S6 | Archkit & materials | full generator kit + material library, hero-tested on the Grand Atrium | Atrium interior with stained-glass caustics is postcard-grade |
| S7 | Park assembly | parkPlan final layout, all districts/pavilions/props placed, lamps, signage, containment, park clock + chimes, ambient audio engine | full park walkable end to end; `?view=esplanade` |
| S8 | Descent Bell & Pearl Line | arrival sequence polished, gondola loop with 2 stations | unbroken sky→park descent; full aerial loop tour |
| S9 | Wheel & Carousel | both rides fully ridable with restraints, sway physics, bulbs, breach moment, music-box waltz | `?view=breach` from inside a gondola; carousel audible across the lagoon |
| S10 | The Torrent | track + train dynamics + station flow + wreck set piece + breach hump | full 90 s ride, physics-plausible speeds, `?view=dive` |
| S11 | Grotto of Pearls | cave environment, real water channel sim, buoyant boat, bioluminescent scenes, treasury | 4 min ride; `?view=treasury` |
| S12 | Wildlife | boids + species, SDF avoidance, rays, turtles, jellies, seahorses, whale event | Esplanade school-split flyover; `?view=whale` at the Overlook |
| S13 | Games & small wonders | 3 midway games, prizes, feeding, penny presses + velvet book, wishing well, sweets, punch-ticket completion | every interactable on the map works with physics |
| S14 | Opening day | Bubble Fountain grand show, full schedule choreography, final LUT/grade, mix pass, quality tiers + auto-bench, perf pass, full 10-postcard sweep | 60 fps on reference hardware across all postcards |

## 17. Needs from Scott

1. **Package approval** (rule: ask before installing): the dependency list in §2 — three, @dimforge/rapier3d-compat, vite, typescript, eslint stack, tweakpane + stats-gl (dev-only). Approving this plan approves the installs.
2. **Audio direction:** default is fully procedural synthesis (no assets needed). If you'd rather have recorded music (carousel waltz, midway rag, show cue), supply audio files whenever — the source graph accepts either.
3. **Reference hardware:** which machine will you inspect on (Apple Silicon model / GPU)? Perf tier tuning anchors to it. Assumed M-series Pro-class until told otherwise.
4. **Optional at your leisure:** any PBR texture sets or a display font you'd like featured; everything has a procedural default and nothing blocks on this.

## 18. Risks & mitigations

- **TSL/WebGPU API churn** in three releases → pin the installed minor version; upgrade deliberately, never mid-stage; note breakages in notes.md.
- **Coaster train constraint stability** at 26 m/s → primary approach is spline-constrained dynamics (only longitudinal DOF simulated), which cannot explode; full rigid-body articulation only where it's safe (station, sway). Escalate to Jolt only if needed, after asking.
- **Caustics + god rays cost** → both are tiered and temporally amortized by design from day one, not retrofitted.
- **15 k boids vs. draw overhead** → single instanced draw per species, compute-driven; SDF resolution kept coarse (park-scale avoidance, not per-baluster).
- **Scope is genuinely large** → the stage gates + postcard contract keep every increment shippable-quality; parkPlan data-driven layout means content grows without code churn.
