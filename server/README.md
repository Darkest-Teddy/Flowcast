# server (Node.js + TypeScript)

The Ask server. `POST /api/ask` answers one campus question with an OpenAI agent (`gpt-6-luna` by default, via `@openai/agents`) that reads the same simulation, walking routes, class schedule and opening hours the map plays. The model only picks tools and words the reply; every number comes from a tool. The OpenAI key stays on this server.

It loads the public campus bundle, builds the population, and simulates each weekday of the reference week (2026-10-26 to 2026-11-01) in the background at startup, one day at a time.

The realtime backend in the plan (`.plans/campus-digital-twin-spec.md` Section 8) is not built yet.

## Run

```sh
cd server
npm install
# server/.env (gitignored, chmod 600):  OPENAI_KEY=...
npm start            # or npm run dev to restart on changes
npm run typecheck && npm test   # offline; no key needed
```

## Endpoints

- `GET /api/health` → `{ ok, model, keyConfigured, privateBundle }`
- `POST /api/ask` with `{ question (1–300 chars), weekday (0 = Monday … 6), time (seconds since midnight), campus ("charles-river" | "medical" | "fenway") }`
  - 200 → `{ answer, model, show: { route, select, points } | null, rows: [{ id, name, percent, level, students, modeled, open, walkMinutes }], calls: [tool names] }`. `show` and `rows` come from the last tool call that changes the map.
  - 400 bad input · 429 rate limit (12/min per client, 600/hour overall) · 503 no key, or the day is still being simulated (`Retry-After`) · 504 model timeout (25 s) · 502 model error.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_KEY` or `OPENAI_API_KEY` | none | OpenAI key. Without it `/api/ask` returns 503. Never logged. |
| `FLOWCAST_ASK_MODEL` | `gpt-6-luna` | Model name. |
| `FLOWCAST_ASK_PRIVATE_BUNDLE` | unset | `1` uses `data-pipeline/.cache/hackathon/campus-data.json` if it exists. |
| `FLOWCAST_ASK_DAYS_CACHED` | `7` | Built days kept (1–7, LRU). |
| `TRUST_PROXY_HOPS` | `0` | Proxies in front, for per-client rate limits. |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Listen address. |

## Tools

| Tool | Purpose |
| --- | --- |
| `rank_places_by_crowd` | Places ranked by simulated crowding (least or most), in tiers: open, hours unknown, closed, not modeled. |
| `place_day` | One place over a day: published hours, now, an hourly table, quietest and busiest open hours. |
| `place_info` | Published hours, open now and next change, capacity basis and confidence, estimated profiles, evidence. |
| `campus_overview` | Whole-map totals: indoors, walking, not on the map, by campus; busiest places. |
| `list_events` | Published events in the reference week or on one day, in Boston time. |
| `free_rooms` | Rooms in a building with no published class at a time. |
| `model_basis` | Short statements of the model's assumptions by topic. |
| `published_counts` | Observed FitRec hourly entries and Commonwealth Avenue pedestrian counts, labelled as published counts. |
| `walking_route` | Walking distance and time between two places or courses. |
| `find_course` | Where and when a course meets next. |
| `find_places` | Mapped places by kind, campus or name, with hours status. |

Tools other than the shown day's never wait for a build: an unbuilt day returns `{ available: false, reason, retryAfterSec }` and starts building.

## Never sent to the model

The private bundle (unless `FLOWCAST_ASK_PRIVATE_BUNDLE=1`), stays, trips, agent ids, source assignments and activities, bike ride records, live MBTA/GBFS data, source URL lists, and the full simulation assumption list. Questions are not logged and tracing is off.
