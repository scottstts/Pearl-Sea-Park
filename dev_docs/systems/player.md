# Player, physics & interaction (S5)

- **Physics**: Rapier world in `physics/physicsWorld.ts`; plain gravity (the sea is air). Terrain collider is a 128² heightfield sampled from `terrainHeight` — **column-major** (`heights[col*(nrows+1)+row]`), verified by a downward-raycast self-check under `?debug` (tolerance 1.5 m grid interpolation). `addStaticBox()` is the helper structures use (archkit must add colliders for anything walkable/blocking).
- **Player** (`player/player.ts`): kinematic capsule + Rapier character controller (autostep 0.45/0.25, snap-to-ground, slope 52°), walk 1.6 / brisk 3.1 m/s, eased acceleration, no jump, near-imperceptible bob. Look = pointer lock; movement keys work without lock (automation relies on this). **yaw 0 faces −z = north = toward the park**; camera and movement share yaw so they can never disagree.
- Rides/seats borrow control via `player.controlEnabled = false` + `placeAt()` on return.
- **Pause card** (`ui/pauseCard.ts`): Escape's pointer-lock release opens the
  back of Golden Ticket No. 1, freezes fixed simulation and authored time,
  suspends Web Audio so scheduled music cannot drift, preserves ride-owned player control, and offers resume, persistent master
  volume, or Auto/Gentle/Fine/Grand quality. Tier changes reload intentionally
  because wildlife, water, shadow, and VFX storage budgets are allocated once
  before world initialization.
- **Interaction** (`player/interact.ts`): registry of `{position, radius, prompt, key, onInteract}`; nearest eligible within radius + view cone shows the single serif caption (`.prompt` CSS). All gates/games/benches register here — never build bespoke prompt UI.
- **Seats** (`player/seats.ts`): smooth eased camera in/out (0.9 s), any move key leaves, `player.placeAt(exit)` on stand-up. Rides reuse `enter/leave`.
- **Held items** (`player/heldItems.ts`): rig parented to the camera (note: `scene.add(camera)` is required for camera children to render) with rotation-delta inertial sway. It now owns the stamped golden ticket, throwable ring/pearl/coin, eight-pellet food cone, melting ice cream, pocket park model, plush kraken, and eight-pocket velvet penny book. The wearable paper hat is a separate camera child so its brim stays visible. `T` hides the rig; `1–4` recall persistent ticket/book/model/plush props.
- `?debug` exposes `window.__pearl = { ctx, registry, qualitySelection, postcardAudit }` for console/automation inspection. Canvas datasets also carry performance, exposure, shadow, fountain, wildlife, games, and postcard snapshots.
- Mode rule in main.ts: `?view=` → DevOrbit inspection camera; no view → player.
