# web (React + TypeScript)

The Flowcast platform around the map, served as one site: Google sign-in, the "Get started" tour, the student dashboard (Home, Schedule, Forecasts, Events, Clubs, account pages), club registration and `.ics` uploads, and a separate admin area at `/admin` (data sources, simulation, live demo controls, club verification, users, agent brain, settings). The 3D map's code stays in `/map-client`, but this app serves it at `/map` (`map.html` runs map-client's own entry point), along with its data and models, so everyone uses one server and one address.

## Run it

```bash
cd web
npm install
npm --prefix ../map-client install   # the map's own dependencies
npm run dev -- --host                # dashboard http://localhost:5174, map http://localhost:5174/map
```

Map keys (Mapbox, MBTA) are read from `map-client/.env.local` as before. `--host` lets other devices on the same network open it at this computer's address.

Sign-in is mocked: "Continue with Google" signs you in as a sample user with student, club officer and admin roles.

## Rules for adding to it

- **No hard-coded design values.** Colours, fonts, sizes, spacing, radii, shadows and motion come from `/theme/tokens.css` (shared by every app). `/theme/tokens.ts` exposes the same names and the crowd scale to code. Need something new? Add a token.
- **Data only through `src/data/api.ts`.** It answers from `fixtures.ts` today; when `/server` exists each function becomes a request and pages don't change. Pages never import `fixtures.ts`.
- **Reuse `src/ui`** (buttons, lists, tables, fields, status badges, page headers) and `src/lib/format.ts` for dates and percentages.
- Each page keeps its CSS in a sibling `*.module.css`.

## Layout

```
src/
  auth/session.tsx     who is signed in, route guards (mock Google sign-in)
  data/                types, sample data, the api
  layouts/             sidebar shell, student and admin layouts
  pages/               student and account pages; club/ and admin/ subfolders
  ui/                  shared components
  lib/                 formatting and theme (light/dark) helpers
```
