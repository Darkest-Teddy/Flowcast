# server (Node.js + TypeScript)

Owner: Realtime Backend Lead (see `.plans/campus-digital-twin-spec.md` Section 2).

The single authoritative source of live state (Section 8.1). Loads the precomputed week from `/data-pipeline`'s output, runs the live simulation tick loop, and broadcasts to both clients.

## What goes here
- Socket.IO server: broadcasts agent positions to `/map-client` and `/mobile`
- REST endpoints: persona create/delete, vote submit
- Redis pub/sub + agent position cache
- PostgreSQL schema: schedules, the precomputed week, prediction model output, personas, votes
- Live vote/event override logic layered on top of the precomputed baseline (Section 3.5–3.6)

See Section 8.2 for the full system diagram and Section 8.4 for hosting (Railway).
