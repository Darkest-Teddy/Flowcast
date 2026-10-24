# Flowcast

A live, browser-based 3D model of the BU campus, filled with student agents driven by schedules and stated behavioral assumptions. It projects crowding and movement across a representative week, and lets people join live from their phones via a QR code.

Built for **DS+X**, Boston University's data science hackathon (Hack College track), October 24–25, 2026.

## Read this first

The full project plan lives in [`.plans/campus-digital-twin-spec.md`](.plans/campus-digital-twin-spec.md). It covers:

- Team roles, integration gates, and the deadline/freeze schedule
- The 3D rendering approach (Mapbox GL JS + deck.gl) and why
- The shared TypeScript simulation, direct projections, and paired scenario analysis
- The realtime backend design
- Privacy, ethics, bias, and accessibility commitments
- How the plan maps to the published judging rubric

The on-site kickoff checklist is in [`.plans/kickoff-checklist.md`](.plans/kickoff-checklist.md); use it when adopting the revision.

## Repository layout and target architecture

Current code lives in `data-pipeline`, `server`, `map-client`, and `mobile`. The revised plan specifies this target layout; the documentation rewrite does not migrate the application:

```text
packages/contracts   Shared IDs, Zod schemas, command/update contracts
packages/sim-core    TypeScript planner, routes, events, aggregates, comparisons
server               One Node/Express/Socket.IO service, PostgreSQL persistence
web                  One React app: /display, /present, /join
data-pipeline        Python extraction, normalization, provenance, analysis inputs
data/campus-v1       Versioned bundle with separate public and server-only inputs
```

Reuse the existing frontend code when consolidating it into `web`. The baseline-generation command and live server import the same simulation core. Cloud deployment uses one application replica plus PostgreSQL; local recovery uses the same Node build and a prepared PostgreSQL container. Redis and Prophet are excluded from the required stack.
