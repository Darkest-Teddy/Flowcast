---
inclusion: always
---

# Tech and structure

- Web: React 19, TypeScript, Vite in `web/`. Map rendering in `map-client/` (Mapbox GL JS + deck.gl). Python data prep in `data-pipeline/`.
- Target layout (not migrated yet): `packages/contracts`, `packages/sim-core`, `server`, `web`, `data-pipeline`, `data/campus-v1`.
- Simulation code must be pure and deterministic so the live server and the baseline generator can share it. No `Math.random()` without a seeded generator, no `Date.now()` inside model code.
- Shared types live in `web/src/data/types.ts` until `packages/contracts` exists. Reuse them; don't redefine `ScheduleItem` or `CampusLocation`.
- Tests: Node's built-in runner with type stripping, `node --test web/tests/*.test.ts`. Use type-only imports in model code so Node can run it directly.
- Do not add Redis, Prophet, Threebox, or a second Three.js renderer.
