# Tech stack and commands

| Area | Stack |
| --- | --- |
| `data-pipeline/` | Python 3.10+, standard library + BeautifulSoup, `unittest` |
| `map-client/` | React 19, TypeScript, Vite, Mapbox GL / MapLibre, deck.gl; tests with `node --test` |
| `web/` | React 19, TypeScript, Vite, react-router; serves the map at `/map` |
| `theme/` | Shared CSS tokens (`tokens.css`) and their TS view (`tokens.ts`) |

## Verify every change

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
