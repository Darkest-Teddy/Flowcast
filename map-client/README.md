# map-client (React + TypeScript)

Owner: 3D Map / Frontend Lead (see `.plans/campus-digital-twin-spec.md` Section 2).

The 3D campus view uses saved Fall 2026 class schedules to place a synthetic cohort of 1,200 students. The weekday selector rebuilds their trips locally over existing pedestrian routes. Building labels show simulated counts; colors use a model activity scale, not measured occupancy.

The **Data** tab exposes published class times, room seats, housing baselines, dining and library hours, events, historical library counts, and source links. The compact bundle maps 3,805 of 6,944 physical meeting records onto existing map locations; unmatched building codes are listed in the coverage panel. Date-restricted classes are excluded from the representative week. Seats and registrations never become observed attendance.

`npm run prepare:data` rebuilds `public/data/campus-data.json` from the committed acquisition snapshots without network access. Production builds run this automatically. `npm test` checks scheduling, routing, and population invariants. The TypeScript simulation lives in `src/sim/sourceDay.ts`; the offline adapter is `../data-pipeline/build_map_data.py`.

## Run it

```bash
cd map-client
npm install
cp .env.example .env.local   # optional: paste a Mapbox token (see below)
npm run dev                  # http://localhost:5173
```

**Without a token** the map falls back to MapLibre + OpenFreeMap (free, no account). The buildings are plain grey extrusions, but everything else works. **With `VITE_MAPBOX_TOKEN`** set, you get Mapbox Standard: textured, lit buildings plus a Dawn/Day/Dusk/Night lighting control. The team's public `pk.` token lives in each person's `map-client/.env.local`, which is gitignored; ask in the team chat rather than committing it. For a hosted build (Railway), set `VITE_MAPBOX_TOKEN` as a build-time variable.

### URL parameters (handy for rehearsing demo moments)

| Param | Example | Effect |
|---|---|---|
| (none) | | **Clock** (default): the selected simulated weekday follows Boston time at 1×, so walkers, trains and buses move at true relative speeds |
| `at` | `at=12:20` | Start playback at this time (24h) instead of Clock |
| `speed` | `speed=120` | Start at this playback speed |
| `lng`, `lat`, `zoom`, `pitch`, `bearing` | `lng=-71.1058&lat=42.3501&zoom=19` | Start camera |
| `spin` | `spin=0` | Don't start the slow camera orbit on load (it never auto-starts under prefers-reduced-motion) |
| `interleaved` | `interleaved=0` | Draw deck.gl as a plain overlay instead of mixing into the map (debug fallback; characters will no longer hide behind buildings) |

Example: <http://localhost:5173/?at=12:15&speed=30> shows the lunch rush.

## How the rendering works

```
Mapbox GL JS (Standard) or MapLibre ──── base map, real 3D buildings
  └─ deck.gl MapboxOverlay, interleaved ── our layers share the map's depth buffer,
       │                                  so buildings hide characters behind them
       ├─ PolygonLayer   crowd-buildings  real OSM footprints, extruded, tinted by model activity
       ├─ TripsLayer     flow-trails      fading trails behind walkers = flows between buildings
       ├─ ScenegraphLayer agents-*        Kenney Mini Characters, GPU-instanced, walk animation
       └─ TextLayer      crowd-labels     "CDS · 87 simulated" (number and word, never colour alone)
```

| File | What it does |
|---|---|
| `src/map/basemap.ts` | Creates Mapbox or MapLibre; sets the camera, lighting and URL view params |
| `src/layers/agents.ts` | Character models, facing direction, de-synchronised walk cycles |
| `src/layers/crowd.ts` | Building glow, trails, labels, and the shared Quiet/Moderate/Busy/Packed scale |
| `src/sim/playback.ts` | Where everyone is at time *t* and how full each place is. The server takes this over later (plan Section 8.1) |
| `src/map/camera.ts`, `src/CameraControls.tsx` | Spin (orbit), rotate/tilt steps, Bird's-eye / 3D / Street presets and the landmark tour. Keys: `R` spin, `[` `]` rotate, `,` `.` tilt. Any drag, scroll, pinch or rotate on the map stops the spin and the tour |
| `src/App.tsx` | The frame loop, dashboard panel and timeline |

**Characters walking without lockstep.** A `ScenegraphLayer` plays one animation clock for every instance it draws, so with a single layer all 1,200 characters would stride in unison. `agents.ts` splits each of the 12 character models across 3 layers whose walk cycles start a third of a stride apart and run at slightly different speeds. Characters face their direction of travel. Anyone not walking is inside a building, which matches the interior-view plan in Section 6.7.

**Accessibility.** Glow, label background and dashboard bar all come from one four-step scale in `crowd.ts`. Every label carries a simulated count. Label text meets 4.5:1 contrast. All controls are real buttons with ARIA labels.

## Live MBTA and traffic

The **Transit & traffic** tab and the map show live data for whichever campus is selected:

| Campus | Lines |
|---|---|
| Charles River | Green Line B (and C at St. Mary's St), buses 57 and 47 |
| Fenway | Green Line D (Fenway, Longwood), bus 47 |
| Medical | Silver Line SL4/SL5, buses 1, 8, 10, 47 |

- **Static data** (routes, shapes, stops, platform ids) is snapshotted by `python3 data-pipeline/fetch_transit.py` into `public/data/transit.json`. Re-run it if routes change. Campus areas and route lists live at the top of that script.
- **Live data** comes from `src/transit/mbta.ts`, which polls MBTA v3 `/vehicles` every 12 s and `/predictions` every 30 s, straight from the browser (CORS is open). Vehicles glide between reports.
- **Rate limit:** without a key the MBTA allows **20 requests/minute per IP**, and the whole venue shares one IP. One open tab uses about 7/min. If the panel says "rate limit reached", it backs off and retries automatically. For the demo, get a free key at <https://api-v3.mbta.com> and put `VITE_MBTA_API_KEY=...` in `map-client/.env.local` (gitignored); that raises the limit to 1000/min.
- **Traffic** is Mapbox's live traffic tileset (needs the Mapbox token). Congestion is shown by line width as well as colour. Free-flowing traffic is only drawn on main roads.
- Transit is **live (real clock)** while the crowd simulation plays its own **selected simulated weekday**. If a judge asks, say so plainly.

## Real Bluebikes rides

The **Bikes** tab and the blue riders are the only *measured* movement on the map so far. A rider is a blue block with a fading blue trail, and a BU dock is a white dot with a blue ring. Hover over either for details.

- **Replay:** every real Bluebikes ride on Wednesday, Sep 23, 2026 that started or ended at one of the 16 docks within 200 m of a BU building (2,367 rides), played on the same clock as the simulation. The time a bike leaves or reaches a BU dock is real. The street route is **inferred**, because rides record only their two docks. It's the most bike-friendly OSM path: lanes and paths first, one-way streets respected. Rides to docks off the map run to its edge.
- **Typical day:** each dock's rides docked and undocked per 15 minutes, averaged over the five Wednesdays in September 2026. This is the panel's chart, and the "next hour" figure in dock tooltips.
- **Live:** `src/bikes/bluebikes.ts` polls Bluebikes' public GBFS `station_status` every 60 s, straight from the browser (CORS open, no key needed): bikes, e-bikes and empty docks per BU dock.
- **Rebuild** with `python3 data-pipeline/fetch_bikes.py` (standard library only). Use `--month 202610` once that month is published, or `--replay-date 2026-09-16`. Output: `public/data/bikes.json` (~2 MB). The map still starts without it; the Bikes tab is just hidden.
- **How it compares with the simulation:** real bike activity at Charles River docks peaks 4–7 PM, with a smaller 8 AM rush. The simulated day peaks at lunch. Hour by hour, they're uncorrelated (r ≈ 0, 7 AM–11 PM). Bluebikes riders aren't only students, but it suggests the simulation under-weights the evening.

## Data contract (what the pipeline / server must provide)

`public/data/demo-day.json`, currently generated by `data-pipeline/make_demo_routes.py`:

```jsonc
{
  "day": "Wednesday",
  "campuses":  [{ "id": "charles-river", "name": "Charles River Campus",
                  "bbox": [south, west, north, east], "center": [lng, lat] }],  // agents never walk between campuses
  "buildings": [{ "id": "way/277434241", "name": "…", "polygon": [[lng, lat], …], "height": 68.4, "campus": "charles-river" }],
  "locations": [{ "id": "cds", "name": "Computing & Data Sciences", "short": "CDS", "kind": "classroom",
                  "position": [lng, lat], "capacity": 33, "building": "way/277434241", "campus": "charles-river" }],
  "agents":    [{ "id": "a000", "home": "warren", "model": 0, "campus": "charles-river" }], // model = Kenney character 0–11
  // Each walk route once; a trip names its route by "from>to". The map rebuilds
  // timestamps = depart + metres / speed (seconds since midnight, one per point).
  "walkRoutes": { "warren>cds": { "path": [[lng, lat], …], "cumulative": [0, 12.4, …] } },
  "trips":     [{ "agent": "a0000", "from": "warren", "to": "cds", "depart": 32400.0, "speed": 1.31 }]
}
```

Trips (a path plus timestamps) are what deck.gl's TripsLayer reads natively. They're also far smaller than minute-by-minute positions, and the client interpolates between points. When the Simulation Lead's `simulate_week.py` exists, it should emit this shape (one file per day). The live server can then broadcast the same objects.

## Pitfalls we already hit (don't re-debug these)

- **Mapbox must use `projection: 'mercator'`.** Mapbox Standard defaults to a globe, which flips deck.gl into GlobeView. Text labels and the 3D characters then draw nothing, with no error.
- **MBTA headings and GPS are noisy** (stopped trains often report a stale bearing), so drawn as-is, vehicles sat off the rails at odd angles. `src/transit/tracks.ts` snaps each vehicle onto its direction's track, points it along the track and glides it along the curve between reports.
- **Tiny vehicles vanish.** At campus zoom a real-width train is under a pixel wide, so `transit.ts` scales vehicles up as the camera pulls back.
- **MapLibre is pinned to v5.** MapLibre 6 removed `map.transform`, which deck.gl 9.4's interleaved mode reads, and every deck layer crashes.
- **`HeatmapLayer` and `CollisionFilterExtension` render nothing in interleaved mode.** Both need an offscreen pass. That's why the "heatmap" is tinted building footprints plus trails, and why label overlap is handled in screen space in `crowd.ts`.
- **Kenney GLBs render grey unless re-packed.** They carry a no-op `KHR_texture_transform` that loaders.gl turns into a `TEXCOORD_2` luma.gl won't sample. `scripts/embed_glb_textures.py` strips it and embeds the texture. Re-run it if you add models (wheelchairs and canes are in the same pack, which would make a good accessibility feature).
- **The map's container CSS needs two classes** (`.app .map`): in production builds the map library's own CSS loads later and sets `position: relative`.
- **Overpass (OpenStreetMap) returns 406 without a User-Agent**, and often 502s when busy. The pipeline sends one, retries, and caches responses in `data-pipeline/.cache/`.

## Assets

`public/models/`: [Kenney Mini Characters](https://kenney.nl/assets/mini-characters), CC0 (`LICENSE-kenney.txt`). To regenerate from a fresh download:

```bash
python3 map-client/scripts/embed_glb_textures.py "<unzipped pack>/Models/GLB format"
```

## Next up for this folder

- Click-to-inspect building panel with the day's occupancy curve (plan Section 3.3); `Playback.occupancyAt` already gives every point of it.
- Swap `loadDay()` for the server's Socket.IO stream once `/server` exists.
- Interior view (Section 6.7): the characters already ship a `sit` animation.
