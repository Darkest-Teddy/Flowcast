# Flowcast

A live, browser-based 3D model of the BU campus, filled with student agents driven by schedules and stated behavioral assumptions. It projects crowding and movement across a representative week, and lets people join live from their phones via a QR code.

Built for **DS+X**, Boston University's data science hackathon (Hack College track), October 24–25, 2026.

## Tech stack

What the code actually uses today, read from `web/package.json`, `map-client/package.json` and
`data-pipeline/requirements*.txt`. Versions are the declared ranges.

**Languages**: TypeScript 7, Python 3, CSS (CSS Modules plus custom properties)

**`map-client` — the live 3D campus**

| Library | Version | Role |
|---|---|---|
| deck.gl (`core`, `layers`, `mesh-layers`, `geo-layers`, `mapbox`) | 9.4 | GPU layer rendering over the basemap |
| luma.gl (`engine`) | 9.4 | Geometry primitives the personas are composed from |
| loaders.gl (`core`, `gltf`) | 4.5 | Loads the hand-built GLB building models |
| mapbox-gl | 3.33 | Basemap when `VITE_MAPBOX_TOKEN` is set |
| maplibre-gl | 5.24 | Basemap fallback, against OpenFreeMap tiles, when it is not |
| qrcode-generator | 2.0 | The join-from-your-phone QR code |
| React / React DOM | 19.3 | HUD and overlays |
| Vite | 8.3 | Dev server and build |

**`web` — dashboard and marketing landing page**

| Library | Version | Role |
|---|---|---|
| React / React DOM | 19.3 | Application |
| react-router | 8.5 | Routing (`createBrowserRouter`) |
| three | 0.169 | The persona customizer's own canvas |
| lucide-react | 1.61 | Icons |
| Vite | 8.3 | Dev server and build |

Styling is CSS Modules against the shared tokens in `theme/tokens.css`. There is no Tailwind, no
CSS-in-JS, and no animation library; motion is hand-rolled CSS and `requestAnimationFrame`.
The landing page additionally loads Fraunces, Space Grotesk and IBM Plex Mono from Google Fonts.

**`data-pipeline` — Python extraction and normalization**

| Library | Version | Role |
|---|---|---|
| osmnx | ≥ 2.1.1 | OpenStreetMap street and building geometry |
| beautifulsoup4 | 4.12.x | Scraping the course catalog, dining and library pages |
| pypdf | 5.x–6.x | Extracting tables from published PDFs |
| tableauhyperapi | 0.0.26479 | Optional, for `scrape_libraries.py --extract-hyper` |

Everything else is the standard library (`csv`, `json`, `zipfile`, `zoneinfo`, `concurrent.futures`).

**Not built yet.** `server/` and `mobile/` currently contain a `README.md` and nothing else. There is
no Node/Express service, no Socket.IO, no PostgreSQL and no Redis in the repository. The web app
reads from in-memory fixtures behind `web/src/data/api.ts`, the map reads committed JSON written by
the Python pipeline at build time, and personas are shared between the two through `localStorage`.
The target architecture below describes where this is going, not what runs today.

## Read this first

The full project plan lives in [`.plans/campus-digital-twin-spec.md`](.plans/campus-digital-twin-spec.md). It covers:

- Team roles, integration gates, and the deadline/freeze schedule
- The 3D rendering approach (deck.gl over Mapbox GL JS, with a MapLibre fallback) and why
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
