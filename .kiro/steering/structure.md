# Structure and conventions

## Where things live

- `data-pipeline/scrape_*.py`: collectors. `build_map_data.py`: compiles snapshots into `map-client/public/data/campus-data.json`.
- `map-client/src/sim/`: the shared simulation core. `sourceDay.ts` plans each student's day; `playback.ts` answers "who is where at time t"; `gatherings.ts` turns campus events into Gathering scenarios.
- `web/src/data/api.ts`: the only data door for dashboard pages. Pages never import `fixtures.ts`.
- `.plans/campus-digital-twin-spec.md`: the product spec. Event semantics are in Section 5.6; projections in 5.8.

## Conventions

- Match the surrounding style; keep functions small and named for what they decide.
- Dashboard styling comes only from `theme/tokens.css` variables; each page keeps CSS in a sibling `*.module.css`; reuse `web/src/ui` and `web/src/lib/format.ts`.
- Simulation changes must keep the existing invariants tested in `map-client/tests/`: every student has exactly one stay or trip at every second, trips move at the modeled walking speed, optional visits respect opening hours and capacity, and published class times never move.
- New behavior gets tests next to the existing ones (`tests/*.test.mjs`, `data-pipeline/tests/test_*.py`).
