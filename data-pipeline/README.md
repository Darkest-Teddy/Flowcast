# data-pipeline (Python)

Owner: Data & Schedules Lead + Simulation & ML Lead (see `.plans/campus-digital-twin-spec.md` Section 2).

Runs ahead of time, not live. Produces the files `/server` loads at startup.

## What goes here
- OSM extraction (`osmnx`) — BU campus building footprints + walkway graph → GeoJSON (Section 6.5 of the plan)
- Course-catalog scrape → course meeting-time table
- Synthetic schedule generator (Section 4.1)
- Agent movement simulator → the precomputed full-week position timeline (Section 5.1–5.2)
- Crowd-prediction ML model (Section 5.3)

## Planned entry points (not yet built)
- `extract_campus.py` — pulls buildings + walkway graph from OSM
- `scrape_catalog.py` — pulls public course meeting times
- `generate_population.py` — builds the synthetic schedule population
- `simulate_week.py` — runs the agent behavior loop, outputs the precomputed week
- `train_prediction_model.py` — fits the crowd-forecasting model, outputs per-location forecasts

Output format and the handoff to PostgreSQL are defined in Section 8.2 of the plan.
