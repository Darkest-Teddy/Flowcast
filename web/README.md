# web (React + TypeScript)

The Flowcast platform around the map, served as one site: the public landing page (at `/` for signed-out visitors and at `/landing` for everyone), Google sign-in, the "Get started" tour, the student dashboard (Home, Schedule, Forecasts, Events, Clubs, account pages), club registration and `.ics` uploads, and a separate admin area at `/admin` (data sources, simulation, live demo controls, club verification, users, agent brain, settings). The 3D map's code stays in `/map-client`, but this app serves it at `/map` (`map.html` runs map-client's own entry point), along with its data and models, so everyone uses one server and one address.

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

- **No hard-coded design values.** Colours, fonts, sizes, spacing, radii, shadows and motion come from `/theme/tokens.css` (shared by every app). `/theme/tokens.ts` exposes the same names and the crowd scale to code. The crowd scale itself (Quiet under 40%, Moderate from 40%, Busy from 65%, Packed from 85%, and its colours) is defined once in `/theme/crowd.ts`; `tokens.css` mirrors its colours and `map-client/tests/crowdScale.test.mjs` keeps them in step. Need something new? Add a token.
- **Data only through `src/data/api.ts`.** It answers from `fixtures.ts` today; when `/server` exists each function becomes a request and pages don't change. Pages never import `fixtures.ts`.
- **Reuse `src/ui`** (buttons, lists, tables, fields, status badges, page headers) and `src/lib/format.ts` for dates and percentages.
- Each page keeps its CSS in a sibling `*.module.css`.
- **Glass, not opaque boxes.** Pages sit on the canvas gradient. A card or bar that needs a surface writes `composes: glass from global;` (or `glass-strong` for big panels and anything content scrolls under) and `border-radius: var(--radius-card)`. Don't paint `--color-surface` or `--color-canvas` over the page. Reduce transparency (Settings, or the device setting) turns all glass solid by itself.
- **Dark parts of a light page.** Put `data-theme="dark"` on any element and `tokens.css` gives it and everything inside the dark values (the landing page's nav, hero and closing). Give that element `color: var(--color-ink)` and its own background, since the inherited text colour was computed outside it.

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
