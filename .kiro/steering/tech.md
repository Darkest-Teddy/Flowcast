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

## Stack details and verification

| Area | Stack |
| --- | --- |
| `data-pipeline/` | Python 3.10+, standard library + BeautifulSoup, `unittest` |
| `map-client/` | React 19, TypeScript, Vite, Mapbox GL / MapLibre, deck.gl; tests with `node --test` |
| `web/` | React 19, TypeScript, Vite, react-router; serves the map at `/map` |
| `theme/` | Shared CSS tokens (`tokens.css`) and their TS view (`tokens.ts`) |

### Verify every change

```bash
# Python pipeline (from data-pipeline/)
.venv/bin/python -m unittest discover -s tests

# Rebuild browser bundles offline from committed snapshots (from repo root)
python3 data-pipeline/build_map_data.py && python3 data-pipeline/build_runtime_data.py

# Map client (from map-client/)
npx tsc -b && npm test

# Dashboard (from web/)
npx tsc -b
```

- Saved snapshots in `data-pipeline/output/` are checksummed in `manifest.json`; update the manifest entry when a snapshot changes, or `build_map_data.py` refuses to run.
- Scrapers hit live public sites: run them only when refreshing data, keep `--delay`, and prefer `--offline` replays from `.cache/`.
- Do not add dependencies without asking; pin exact versions when you do.
