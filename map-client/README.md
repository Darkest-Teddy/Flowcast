# map-client (React + TypeScript)

Owner: 3D Map / Frontend Lead (see `.plans/campus-digital-twin-spec.md` Section 2).

The big-screen 3D campus view. **It runs today:** real BU buildings and walkways, a placeholder Wednesday of 300 students walking between classes as animated Kenney characters, buildings glowing by how full they are, flow trails, a "busiest right now" panel and a time scrubber.

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
| (none) | | **Live** (default): the simulated Wednesday follows the real clock at 1×, so walkers, trains and buses move at true relative speeds |
| `at` | `at=12:20` | Start playback at this time (24h) instead of Live |
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
       ├─ crowd-halo / -ping / -roofs / -edges / -rim   light, not paint: ground glow, roof rim,
       │                                  corner edges, by % full (never hides the building models)
       ├─ TripsLayer     flow-trails      fading trails behind walkers = flows between buildings
       └─ ScenegraphLayer agents-*        Kenney Mini Characters, GPU-instanced, walk animation
HTML overlay (BuildingTags.tsx) ─────────  "CDS · 87% · Packed" tags (number and word, never colour alone)
```

**The crowd look.** Each tracked building gets: a soft pool of light on the ground whose reach and brightness grow with how full it is (`crowd-halo`; the fade is a tiny shader extension in `crowdGlow.ts`); a crisp neon rim with a bloom along the top of the building's model, plus a faint roof wash where the model has a flat top; hairline light edges up its sharp corners, fading out towards the street. Packed buildings breathe and send a slow ring out across the ground. The selected building's rim and edges turn white. All of it sits at the **detailed model's** height (`building-models.json`) and uses the models' depth bias, so models can't swallow it. The tags are HTML: a glass card with a kind icon, the short name, "87% · Packed" and a fill bar, on a stem standing on the roof. React renders only their container; the frame loop moves them with transforms and runs them through the same screen-space placer as the station labels (tags first).

| File | What it does |
|---|---|
| `src/map/basemap.ts` | Creates Mapbox or MapLibre; sets the camera, lighting and URL view params |
| `src/layers/agents.ts` | Character models, facing direction, de-synchronised walk cycles |
| `src/layers/crowd.ts` | Building glow and trails, plus the shared Quiet/Moderate/Busy/Packed scale (`crowdLevel`, `crowdLevelStyle`) |
| `src/BuildingTags.tsx` | The HTML building tags over the map; clicking one selects the building |
| `src/sim/playback.ts` | Where everyone is at time *t* and how full each place is. The server takes this over later (plan Section 8.1) |
| `src/map/camera.ts`, `src/CameraControls.tsx` | Spin (orbit), rotate/tilt steps, Bird's-eye / 3D / Street presets and the landmark tour. Keys: `R` spin, `[` `]` rotate, `,` `.` tilt. Any drag, scroll, pinch or rotate on the map stops the spin and the tour |
| `src/App.tsx` | The frame loop, dashboard panel and timeline |

**Characters walking without lockstep.** A `ScenegraphLayer` plays one animation clock for every instance it draws, so with a single layer all 300 characters would stride in unison. `agents.ts` splits each of the 12 character models across 3 layers whose walk cycles start a third of a stride apart and run at slightly different speeds. Characters face their direction of travel. Anyone not walking is inside a building, which matches the interior-view plan in Section 6.7.

**Accessibility.** Map glow, tags and dashboard bars all come from one four-step scale in `crowd.ts`. Every tag carries the percentage and a word, and its level word keeps 4.5:1 contrast or better on the glass (5.8:1 worst case, over a white map). Tags are real buttons with ARIA labels, like every other control.

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
- Transit is **live (real clock)** while the crowd simulation plays its own **simulated Wednesday**. If a judge asks, say so plainly.

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
- **Anything drawn on the detailed building models needs their depth bias.** `buildings.ts` pulls the models 1200 depth units towards the camera; the crowd glow uses 1600 (`GLOW_PARAMETERS` in `crowd.ts`) and the models' own heights, or the models swallow it (CDS's model is 95 m, its footprint 68 m).
- **`HeatmapLayer` and `CollisionFilterExtension` render nothing in interleaved mode.** Both need an offscreen pass. That's why the "heatmap" is glow around the building footprints plus trails, and why label overlap is handled in screen space (`placement.ts`).
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
