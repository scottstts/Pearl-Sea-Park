# Foundation (S0)

Design choices beyond what the code shows:

- **Compatibility is resolved before the game module graph loads.** `index.html` loads the dependency-light `bootstrap.ts`; only desktop Chromium imports `main.ts`. Keep the unsupported-browser gate free of game, renderer, and WebGPU dependencies.
- **WebGPU is enforced twice**: `webgpuAvailable()` pre-checks the adapter, and `createRenderer()` throws if three silently fell back to WebGL (`backend.isWebGPUBackend !== true`). Never remove the second check — three's fallback is silent and would violate the WebGPU-only rule invisibly.
- **The loop owns no rendering.** `GameLoop.renderFrame` is assigned by whoever owns the image (S0: plain `renderer.render`; S1+: the post pipeline). Systems never call render themselves.
- **Fixed 60 Hz sim / variable render** with 5-substep panic clamp. Ride physics and the scheduler run in `fixedUpdate`; visuals in `update(dt, alpha)`.
- **Determinism contract:** every system that generates content must draw from `ctx.rng.fork('<label>')` — forks are order-independent (derived from root seed + label only). Default seed 19051906.
- **Tone mapping is temporarily on the renderer** (AgX) and moves into the S1 post graph; S1 must set `renderer.toneMapping = NoToneMapping` when it takes ownership.
- `TestGallerySystem` remains an isolated proving ground behind `?view=gallery` for material auditing; postcard views use the same DevOrbit inspection controls while normal play uses the first-person guest.
- Ticket screen maps system ids to loading copy (`ui/ticketScreen.ts`) — when adding a system with a visible init cost, add a line to that map.
