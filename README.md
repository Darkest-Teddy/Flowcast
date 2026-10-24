# Flowcast

A live, browser-based 3D model of Boston University's campuses, filled with 36,977 simulated students who follow BU's published Fall 2026 class schedules. It projects how crowded each building, dining hall, library and gym gets, hour by hour, and how campus events change that, so students can plan around crowds and the university can see where people concentrate.

**Hackachusetts submission · Challenge track: Civic Action (Civic Services) · Team of 4 · Built with Kiro**

## The problem

Campus spaces fill up unevenly. Dining halls are packed at 12:20 and empty at 2, libraries overflow before finals, and a club event can double the people in a building for two hours. Students have no way to see this ahead of time, and the public data that could predict it (class schedules, room seats, opening hours, event listings, transit timetables) is scattered across dozens of BU pages. Flowcast collects that public data, runs a transparent simulation on it, and shows the result on a map anyone can open in a browser.

Every number is a projection from stated assumptions, not a measurement of real students; the app says which values are published and which are modeled.

## Features

- **3D campus map** (`/map`): Charles River, Fenway and Medical campuses with detailed building models. Simulated students walk between buildings on real pedestrian routes; buildings glow by how full they are, with a level word and percentage on every tag (never colour alone).
- **Schedule-driven simulation**: 3,805 published class meetings, 437 published classroom capacities, dated dining, library and gym hours, and published residence-hall bed counts drive each student's week. Optional meals, study and gym visits follow named, tunable assumptions.
- **Real campus events**: all 88 public events on BU's Terrier Central are collected. Events at mapped buildings (33 of them) pull free students to the venue, capped by the room's published seats, and change crowding on the map. Events whose location is hidden or unmapped are listed with the reason.
- **Event impact by date** (dashboard, *Event impact* tab): pick any date on a calendar to see that day's events and, for every place, hourly crowding with and without the events.
- **Live transit and bikes**: live MBTA Green Line and bus positions, BU Shuttle, Bluebikes dock status, and replays of real Bluebikes rides. Simulated commuters ride published MBTA and shuttle trips.
- **What-if incidents**: fire drills and building closures send the students inside to other places, compared against the normal day.
- **Student dashboard** (`/`): today's schedule, crowd forecasts, events, clubs, a fatigue estimate, and privacy controls. Admin area (`/admin`) for data sources and simulation settings.
- **Accessibility**: keyboard-operable controls with labels, a 4-step crowd scale with words and 4.5:1 contrast, and reduced-motion support.

## Try it

Requirements: Node.js 22+ and Python 3.10+. No account or API key is needed; the map uses free OpenFreeMap tiles without a Mapbox token.

```bash
git clone https://github.com/Darkest-Teddy/Flowcast.git
cd Flowcast
npm --prefix map-client install
npm --prefix web install
npm --prefix map-client run prepare:data   # builds browser data from the committed snapshots, offline
npm --prefix web run dev                   # http://localhost:5174
```

Then open:

| Page | URL |
| --- | --- |
| Dashboard | http://localhost:5174 (click **Continue with Google**: sign-in is mocked, no real account or password) |
| Event impact | http://localhost:5174/event-impact?date=2026-10-29 |
| 3D map | http://localhost:5174/map (first load takes about 20 seconds while the week is simulated) |
| Map during an event | http://localhost:5174/map?date=2026-10-29&at=20:15&speed=1 |
| Admin | http://localhost:5174/admin |

Optional keys go in `map-client/.env.local` (see `map-client/.env.example`): `VITE_MAPBOX_TOKEN` for textured Mapbox buildings, `VITE_MBTA_API_KEY` for a higher MBTA rate limit.

Tests:

```bash
(cd data-pipeline && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python -m unittest discover -s tests)
npm --prefix map-client test
```

## How we used Kiro

The `.kiro/` folder holds our specs, steering docs, agents, hooks and skills. [`docs/kiro-features.md`](docs/kiro-features.md) explains each one and how it changed the way we built Flowcast.

## Data and licenses

All data comes from public pages (BU course catalog, classrooms, dining, libraries, housing, Terrier Central events, MBTA, Bluebikes, City of Boston counts). No login-only or personal data is collected; private events are skipped. Sources and checksums are recorded in `data-pipeline/output/manifest.json`. Character models are [Kenney](https://kenney.nl) assets under CC0 (`map-client/public/models/LICENSE-kenney.txt`).

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
