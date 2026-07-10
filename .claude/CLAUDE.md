# Context

This repo is building **Sea Park**: a production-quality, WebGPU-only 3D game in Three.js using **TSL (Three.js Shading Language)**. The player (first person pov) can roam in a luxurious and big amusement park built under the sea, and enjoy various facilities.

Core principles:

- WebGPU + TSL first-class: no WebGL fallback; shader work is NodeMaterial/TSL-driven.
- Scale correctness: use correct scale to be maximum realistic.
- Realistic-feeling physics: fully physics base interactions and graphics, no cheap graphics. Try to achieve AAA game level graphics
- Minimal UI: no HUD/stat overlays; only contextual action prompts when needed.

**Important:** DO NOT stuff everything in a generic GameRuntime.ts, over time it has become a monolithic code file. runtime should just be an entry point, if you need specific side logic, define it elsewhere and import into runtime code

# Rules

- there are threejs skills to use, you don't have to, but they contain some exceptional examples, the kind of examples that can achieve AAA grade graphics. so use them if you need to
- if there are ambiguities or issues during building that you can't solve or you need to clarify, stop the job and ask me and report issues so i can help you (like installing packages, look for assets, etc.). DO NOT fall back to any inferior choices without asking me first!
- If you have any unresolved questions about standing ambiguities, seemingly contradicting instructions, seeming mistakes on my part, raise them and resolve them explicitly before proceeding to any implementation
- run lint and typecheck every time you finish a coding task to make sure code is clean
- run dev server when you need to inspect the in game graphics, but do so sparingly. and when you're done, make sure you close the preview window because 3d render taxing on the gpu
- commit code regularly when you need to, to main branch
- Use WebGPU instead of WebGL throughout the build
- most material needed will be procedural, but some can use real PBR texture, if so, you can ask me to supply it
- pay attention to relevant md docs in `dev_docs/` dir, these can include intentions and design principles derived or surfaced during implementation beyond the code itself that are important for further implementing related features. Make sure you always update relevant docs in dev_docs/ after new implementation to avoid stale and outdated references. During the initial implementation, add separate modular docs to document different parts of the game system
- When asked to write implementation documentations, do NOT include verbose and irrelevant things like broad project rules, what text was used, etc. The point of documentation for a specific session of implementation is to capture only design choices that were discussed or surfaced during coding beyond what code alone can tell that could potentially impact future implementations, not to repeat what the code or project rules already says
- When asked for plan or proposal for implementation, always plan for the ultimate state, do NOT plan or propose anything like "V1 fix for now and V2 for later", there is no later, there's only now

# Notes & Lessons

`dev_docs/notes.md` is a scratch pad that you will write to concisely about things you've notes and learned during the implementation, including but not limited to design choices. Whenever you feel like there's something that other coding agents after you will benefit from in later implementation, write to it

This serves as the agent continuous memory so even when i start a new coding agent, you will also benefit from the notes the agents before you have noted.

You can write to it and read it as well. Over time, this notes.md will contain all the accumulated lessons about this project, dos and don'ts, preferred and not preferred

Try MOSTLY to append to it. only delete or edit existing notes when they explicitly contradict with new approved design choices
