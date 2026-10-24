# map-client (React + TypeScript)

Owner: 3D Map / Frontend Lead (see `.plans/campus-digital-twin-spec.md` Section 2).

The 3D campus view uses saved Fall 2026 class schedules and a 36,977-student roster matching BU's Fall 2025 CDS census. The roster includes full-time and part-time undergraduate and graduate cohorts. Students keep the same modeled course sections throughout the week. Building labels show simulated counts, not measured occupancy.

Mapped course demand uses the fraction of eligible catalog offerings that the map can represent, rather than forcing each student's entire degree load into mapped classrooms. Distinct courses and complete cross-listed timetables count once. This catalog-coverage fraction is a modeling proxy, not an enrollment measurement. Explicit lecture/lab/discussion requirements are assigned together; unresolved requirements or missing essential locations prevent partial enrollment in those courses.

Course assignment follows the [BU Bulletin’s default course levels](https://www.bu.edu/academics/bulletin/abbreviations-and-symbols/): 100–399 undergraduate, 400–599 shared, and 600–999 graduate, with professional MD and graduate-school exceptions. The registrar describes 400–499 more narrowly, so the model keeps the broader Bulletin eligibility rather than excluding possible graduate enrollment. Mixed-level cross-listings share one physical roster and use the eligible course alias when reporting attendance. Individual prerequisites and special permissions are unknown. Each student has a stable modeled school preference: the planner tries to place all but one course there, then allows electives and feasible alternatives; this is not a recovered major. Nondegree 000–099 listings and [PDP classes, which became noncredit in Fall 2024](https://www.bu.edu/fitrec/2024/02/27/fall-2024-changes-to-physical-education-pdp-program-offerings/), do not pad the degree-course load. Their published listings remain visible, but this planner does not infer their registrations.

The roster is university-wide, not a claim that 36,977 people attend the mapped campuses. Published bed evidence supports 3,613 mapped residential slots, including 600 verified Tower A beds at Warren. Twelve explicit low-confidence housing scenarios assign another 3,293 students to estimated mapped homes, for 6,906 modeled residents in total; these extra allocations are not observed occupancy. Remaining residents and commuters use saved stop-to-building paths for modeled campus entry and exit, with the rest of their commute off-map. Non-riders' gateways are modeled walking access points; transit riders are described in [Students on the bus and T](#students-on-the-bus-and-t). Primary campus allocation uses degree-eligible weekly section-seat weights, deduplicated across repeated meetings and cross-listings. Undergraduate primary campuses start at Charles River, with Fenway housing allocated afterward; the saved fact sheet lists Medical graduate/nondegree FTE, not an undergraduate campus cohort. FTE is not converted to headcount. These weights remain sensitive to mapped catalog coverage because campus headcounts and online enrollment are unavailable. Course loads, enrollment, attendance, and between-class locations remain assumptions. Staff and visitors are not added without a defensible allocation.

Walking duration is route length in metres divided by a stable 1.4 m/s modeled speed. This is a typical adult walking assumption, not a BU measurement or accessible crossing-design speed ([FHWA research](https://www.fhwa.dot.gov/publications/research/safety/pedbike/98107/section2.cfm)). Travel must fit between weekly classes. The playback clock advances by actual elapsed wall time even when rendering slows. Capacities retain their published or configured basis; they are not enlarged to fit predicted occupancy, and weather does not multiply simulated counts.

Mapped residents also receive probabilistic meal, study, and gym visits on class days and weekends. These are explicit behavioral assumptions, not observed attendance; their rates and timing windows are named in `RESIDENT_ACTIVITIES`. Ordinary optional visits require applicable published hours for the whole stay: exact-date hours and closures override valid seasonal weekday schedules. Missing or merely undated hours do not permit ordinary visits. The exported `venueWindows` helper retains an explicit `estimatedFallback` option for nearest-week or typical-kind assumptions; these are model inputs, not published availability. Published classes remain governed by their own meeting times.

Optional arrivals retain their core timing preferences, with 25% sampled across broader daytime windows so morning gym use, morning study, and late meals are possible. Uncovered academic course slots can reserve estimated two-hour weekly off-map study commitments; actual courses, locations and times are unknown. Both behaviors use existing students and preserve feasible physical travel. Neither is calibrated attendance evidence.

The opening-hours audit covers all 13 activity venues. Eleven have published schedules; Agganis Arena and DeWolfe Boathouse are excluded from ordinary gym visits because they serve events and teams. GSU uses dated meal-vendor service windows, not general building hours or coffee-shop availability. Dining pages publish dates rather than a permanent weekly pattern. A missing service date is unknown, not a confirmed empty venue. The builder selects the current or next Monday week with the most published venue-day coverage; the saved student scenario currently uses October 26–November 1. Library schedules use general hours, not departmental desks. The separately saved MBTA timetable still represents October 19–25.

Fenway residence and academic campus are separate assignments. Verified OSM pedestrian corridors connect Fenway homes to Charles River classes and provide the BU Bridge route to DeWolfe. Rebuild these routes with `python3 ../data-pipeline/make_demo_routes.py && python3 ../data-pipeline/build_cross_campus_routes.py --rebuild-source`; the compressed corridor extracts are committed and campus networks come from the Overpass cache. All saved walks keep to sidewalks and cross at crosswalks; any stretch still along a road is drawn beside it, not on the centre line (`data-pipeline/pedestrian_network.py`). The map no longer adds the old independent demo transit riders to the institutional student roster.

On-campus venues are selected only after checking hours, routes, and class conflicts, weighted by modeled capacity and travel time. Rejected visits are not redirected sequentially into an unknown-hours venue. `MODELED_OFF_CAMPUS_MEAL_SHARE` defaults to 0.35 of attempted resident meal visits, an explicit uncalibrated assumption. Those students walk to a saved gateway, spend their meal off-map, and return; they are not counted inside a campus building while away. Other unassigned meals can remain at home. Access arrivals vary by 2–12 minutes before classes, and long commuter gaps can include an exit and return walk.

Nine additional academic, research, community, arena, and rowing locations have explicit low-confidence activity scenarios. These use existing students, prefer students without mapped published classes, preserve class times, and reserve their full presence within configured activity quotas. Restricted arena and rowing profiles describe purpose-specific student participants rather than public opening hours. Estimated activities carry separate provenance and never become published course assignments.

The **Data** tab exposes published class times, room seats, housing baselines, dining and library hours, events, historical library counts, and source links. The compact bundle maps 3,805 of 6,944 physical meeting records onto existing map locations; unmatched building codes are listed in the coverage panel. Date-restricted classes are excluded from the representative week. Seats and registrations never become observed attendance.

`npm run prepare:data` rebuilds campus, population, timetable, and historical mobility bundles from committed snapshots without network access. Production builds run this automatically. `npm test` checks scheduling, routing, population conservation, clock timing, and transit freshness. The TypeScript simulation lives in `src/sim/sourceDay.ts` and `src/sim/population.ts`.

The `Simulation accuracy checks` workflow builds these saved datasets and runs the Python and client tests on pull requests and pushes to main. The seven-day checks cover complete student timelines, physical walking speeds, room occupancy, venue hours, and estimated attendance quotas. Playback rejects duplicate student IDs and capacities changed after their source/model basis was selected. Display percentages are calculated from counts and capacities rather than independent visual adjustments.

These checks establish internal consistency, not measured attendance accuracy. Course enrollment, optional visits, housing estimates, and the off-campus dining share remain assumptions. The 21 estimated building profiles are low-confidence scenarios; compare them with dated occupancy or pedestrian counts before treating their output as calibrated predictions. Staff, visitors, and unobserved off-map trips remain outside the student model. The source reference week is fixed; a live clock does not turn these saved schedules into current attendance data.

## Incident scenarios

Open **Incidents** in the map's side panel to start a fire drill (30 simulated minutes by default) or a building closure (120 minutes). Select a location and duration, then start the scenario at the displayed time. Playback speed and pause apply to incidents too. For fire drills, occupants react, descend estimated stairs, and pass through a shared exit queue before walking to an outdoor assembly point. All modeled spaces sharing the target's footprint use the same exit bottleneck. Incoming students wait at their origin or turn back along the part of their route already traveled.

Assembly points are selected on saved pedestrian geometry with at least a 10 metre gap from mapped building footprints. This buffer is an uncalibrated modeling choice. The map outlines the closed building and shows an aggregate outdoor headcount at assembly; these students are counted separately from indoor occupancy, walkers, and off-map students. The panel reports evacuation, assembly, diversion, and recovery progress. Fire-drill reopening can extend beyond the requested duration to allow clearance and muster. Release is staggered; recovery resumes from actual positions, shortens or skips missed stays, and keeps original activity end times instead of moving every class later.

Routine building closures have no assembly, muster, or automatic extension. Untagged stays retain the generic behavior: leave early on the saved onward walk when the visit would expire before returning, otherwise wait at the nearest connected saved location. Waiting-location access and capacity remain unverified. Arrivals can skip an expired visit when saved geometry connects to their next destination. The panel distinguishes canceled, interrupted, and relocated visits.

Incident choices use each stay's purpose: published classes are fixed to their scheduled location, while dining, studying, and exercise can consider another compatible venue during a closure. Relocation must fit the remaining activity time, use saved walking geometry, respect venue hours and capacity, and preserve the next commitment. Arrivals that have not started walking can also choose another venue; those already walking retain the turnback behavior. The **Why students moved** section groups decisions by activity, destination, and reason; it only reveals decisions reached by the current simulation time. Fire-drill occupants complete evacuation and muster, then resume or abandon the interrupted activity. These choices are deterministic scenario rules, not measured student preferences.

The activity contract is shared with the weekend free-time planner: `Stay.purpose` distinguishes actual class or activity time from home time and waits. Older days can be classified from matching source assignments and activities. Optional destination hours may use the same weekday's dated hours one week away only outside the published schedule horizon; explicit closures still take precedence. Restricted venues are excluded from relocation.

This version runs locally in one map, with one incident per scenario. **Reset scenario** restores the baseline at the current clock time; changing days or returning to Clock mode clears the scenario. Scrubbing within the day replays the same incident deterministically. The admin Live demo fixture is not connected to this local simulation.

These are what-if scenarios, not campus alerts or evacuation guidance. Reaction times, floor assignments, stair descent, exit throughput, and muster are explicit uncalibrated assumptions in `INCIDENT_ASSUMPTIONS`. The outdoor point is not an official or verified safe assembly area, and its capacity is unknown. Restrictions apply to building visits; unchanged through-traffic on saved paths may still cross the closed footprint. Saved paths are treated as reversible; emergency exits, accessibility constraints, hazard spread, and exclusion zones are not modeled. Recovery retains original walks when no saved shortcut exists. The panel's **Model assumptions** lists these limitations.

### Fire alarms and Boston Fire's response

**Fire alarm (Boston Fire responds)** in the Incidents tab is an unplanned alarm: occupants evacuate exactly as in a drill, and the Boston Fire Department sends apparatus. A **scheduled fire drill** is run by building staff and arranged with the fire department in advance, so no apparatus come.

- **Dispatch** (`src/sim/fireResponse.ts`): BFD's first alarm for a building fire is 3 engines, 2 ladders, a rescue and a district chief; the map sends the 3 engines, 2 ladders and the chief nearest by modeled drive time from eight firehouses around BU (Engine 33 / Ladder 15 on Boylston St, Engine 7 / Tower Ladder 17 / District 4 on Columbus Ave, Engines 22 and 3 in the South End, Engine 37 / Ladder 26 on Huntington Ave, Engine 14 / Ladder 4 in Roxbury, Engine 41 / Ladder 14 in Allston, Engine 29 / Ladder 11 / District 11 in Brighton). Busy units, move-ups, mutual aid and the rescue company aren't modeled.
- **Routing**: Dijkstra once per firehouse when the alarm sounds (~15 ms for the whole response) on the OSM street graph from `data-pipeline/fetch_fire_response.py`: one-way streets respected (no U-turn back down the street just driven), Storrow Drive's low underpasses avoided, up to 60 m against a one-way street allowed only on the final approach. Each route becomes a speed profile: 60–80 s turnout, then about 30–50 km/h on main roads, slowing for corners and through every red signal at ~10 km/h with lights and siren (signal phases from `sim/signals.ts`). On scene they park at the kerb: the first ladder nearest the building, the first engine at a mapped hydrant when one is on its approach, the rest behind. They stay until access reopens plus a few minutes, then drive back to quarters at normal speed, lights off, stopping for red lights.
- Positions are a pure function of sim time (binary search on the profile), so any playback speed, pausing and scrubbing agree. Starting an alarm from Clock mode carries on at 1× from the same moment, as all incidents do.
- **Models**: `bfd-engine.glb`, `bfd-ladder.glb` (rear-mount aerial) and `bfd-chief.glb` from `scripts/make_vehicle_models.py`, red with a white cab roof and gold "BFD". Strobes alternate red and white side to side on a 0.8 s double-flash cycle of real time (a slow 1 Hz swap under prefers-reduced-motion), flashed in the vertex shader from a bitmask in each truck's instance colour (`layers/fireTrucks.ts`). Hover a truck: "BFD Ladder 15 · responding to Photonics Center".
- **Siren** sound is off by default; the panel's checkbox turns on a synthesized wail, louder when responding apparatus are near the middle of the view, silent while paused.
- **Cost**: no layers at all until an alarm; while one is under way, one ScenegraphLayer per apparatus model on the map (one draw each) and one strobe-halo layer. Measured in headless Chrome on an M4 Pro (1728×1080 @2x) at the same view: fire drill 48.7–51.2 FPS, fire alarm with apparatus in view 48.8–50.1 FPS; the fire layers add ~120 GL calls a frame to ~12,200.

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
| `quality` | `quality=speed` | Performance setting for this load: `auto` (default), `quality` or `speed` (also on the perf panel, `P`) |
| `fps` | `fps=60` | Cap the frame rate on a steady beat (off by default) |
| `msaa`, `dpr` | `msaa=1&dpr=1.5` | Force 4x MSAA on or off, or cap the pixel ratio (for perf testing) |
| `debug` | `debug` | Expose `window.__flowcast` (overlay, basemap, playback, quality) in a production build |

Example: <http://localhost:5173/?at=12:15&speed=30> shows midday class movements.

## How the rendering works

```
Mapbox GL JS (Standard) or MapLibre ──── base map, real 3D buildings
  └─ deck.gl MapboxOverlay, interleaved ── our layers share the map's depth buffer,
       │                                  so buildings hide characters behind them
       ├─ crowd-halo / -ping / -roofs / -edges / -rim   light, not paint: ground glow, roof rim,
       │                                  corner edges, by % full (never hides the building models)
       ├─ TripsLayer     flow-trails      fading trails behind walkers = flows between buildings
       └─ ScenegraphLayer agents-*        Kenney Mini Characters, GPU-instanced, walk animation
HTML overlays (BuildingTags.tsx, TransitTags.tsx)  glass tags for buildings, stations, stops, docks, vehicles
```

**The crowd look.** Each tracked building gets: a soft pool of light on the ground whose reach and brightness grow with how full it is (`crowd-halo`; the fade is a tiny shader extension in `crowdGlow.ts`); a crisp neon rim with a bloom along the top of the building's model, plus a faint roof wash where the model has a flat top; hairline light edges up its sharp corners, fading out towards the street. Packed buildings breathe and send a slow ring out across the ground. The selected building's rim and edges turn white. All of it sits at the **detailed model's** height (`building-models.json`) and uses the models' depth bias, so models can't swallow it. Where the model is several volumes or its walls stop well below its top (CDS's stacked pieces, Warren's towers on their podium, CAS's tower, pitched roofs, the Law Tower's mast), the manifest lists its `volumes` and the rim and edges trace each volume's open roof edges and corners instead of one box over the footprint (`volumeGeometry` in `crowdGeometry.ts`; same layers, more paths). The tags are HTML, on a stem standing on the roof. By default each is a small pill: a level dot, the short name and the %, so never colour alone. Hovering the pill, its roof dot or the building on the map (deck.gl `onHover`), focusing it (Tab), tapping it, or selecting the building expands it into the full glass card: kind icon, name, "87% · Packed" and a fill bar. React renders only their container; the frame loop moves them with transforms and runs them through the shared screen-space placer.

**Context buildings.** The building models also cover the city along campus so it isn't plain grey boxes: both sides of Comm Ave from Kenmore out to 1019 Comm Ave / New Balance Field, the Kenmore Square blocks round Myles Standish, Lansdowne Street and Fenway Park (`CONTEXT_AREAS` in `data-pipeline/make_building_models.py`). They're in the same campus GLBs (more vertices, no more draws), marked `"context": true` in `building-models.json`, and are scenery only: `modelRoofHeights` / `modelVolumes` leave them out, and they never get glow, tags or occupancy. Fenway Park's entry carries a `clip` ring that hides Mapbox Standard's own Fenway model under ours (`landmarkClips`, the same clip layer that keeps trees off the Green Line).

**Transit and Bluebikes tags** (`TransitTags.tsx` on the shared engine in `tags/glassTags.ts`) work the same way, each a pill that expands on hover, focus or tap of the pill or its dot on the map:

| Tag | Pill | Card |
|---|---|---|
| Green Line station (from zoom 16.2) | T roundel and name | Branch badges and the next train each way ("Inbound B 2 min · Outbound 7 min"); pulses while one is arriving |
| Bus / BU shuttle stop (zoom 17+, on screen, with predictions) | Route badges in route colours ("BU" red) | The stop and the next arrival per route |
| Bluebikes dock (zoom 16+) | Bikes, plus EMPTY / FULL | Bikes, empty docks, e-bikes, "Est." at playback times |
| Vehicle (hover or click) | (none) | Route, direction, status |
| Place (`PlaceTags.tsx`): monument, landmark, public art, open space, field (same zooms as before: landmarks 15.8, fields 16, areas 16.5, monuments 16.8, minor art 17.8) | Kind icon and name | Name and subtitle: artist and year, or what a field is for and its seats |

Places open on hover of the model, outline or field itself too, through invisible pick targets (`placeHitLayers`). Placement order through the one placer is building tags, stations, stops, docks, then places.

| File | What it does |
|---|---|
| `src/map/basemap.ts` | Creates Mapbox or MapLibre; sets the camera, lighting and URL view params |
| `src/layers/agents.ts` | Character models, facing direction, de-synchronised walk cycles |
| `src/layers/crowd.ts` | Building glow and trails, plus the shared Quiet/Moderate/Busy/Packed scale (`crowdLevel`, `crowdLevelStyle`) |
| `src/BuildingTags.tsx` | The HTML building tags over the map; clicking one selects the building |
| `src/TransitTags.tsx`, `src/tags/glassTags.ts` | HTML tags for stations, bus and shuttle stops, Bluebikes docks and the hovered vehicle |
| `src/PlaceTags.tsx` | HTML tags for monuments, landmarks, public art, open spaces and fields |
| `src/sim/playback.ts` | Where everyone is at time *t* and how full each place is. The server takes this over later (plan Section 8.1) |
| `src/sim/riders.ts`, `src/layers/riders.ts` | Legacy demo rider model; not used by the production map |
| `src/map/camera.ts`, `src/CameraControls.tsx` | Spin (orbit), rotate/tilt steps, Bird's-eye / 3D / Street presets and the landmark tour. Keys: `R` spin, `[` `]` rotate, `,` `.` tilt. Any drag, scroll, pinch or rotate on the map stops the spin and the tour |
| `src/App.tsx` | The frame loop, dashboard panel and timeline |

**Characters walking without lockstep.** `agents.ts` splits each of the 12 character models across 3 layers whose walk cycles start a third of a stride apart. These animation offsets do not change physical movement speed. Each student is accounted for in a mapped building, on a walking route, or off-map.

**Accessibility.** Map glow, tags and dashboard bars all come from one four-step scale in `crowd.ts`. Every tag carries the percentage full and a word (never colour alone), and its level word keeps 4.5:1 contrast or better. All controls are real buttons with ARIA labels.

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
- Clock mode uses live transit. Playback uses the saved official MBTA timetable for October 19–25, 2026, including stop dwell, weekday calendars, and after-midnight service. BU Shuttle playback uses `shuttle-schedule.json` (see [BU Shuttle timetable](#bu-shuttle-timetable)). Live MBTA reports expire after 90 seconds; BU reports with an incoherent source clock expire 90 seconds after the first sighting of each timestamp, even if repeated polling succeeds.

## Students on the bus and T

When the saved MBTA timetable loads, a stable **31.5%** of commuting students ride transit (`TRANSIT_COMMUTER_SHARE` in `src/sim/transitService.ts`). That is the public-transportation share of all Charles River Campus commuters, employees and students together, in [BU's 2013–2023 Institutional Master Plan](https://www.bu.edu/community/files/2012/09/BU-IMP-1-17-13.pdf), Section 8.4 (December 2010 data). It is the only published BU mode split we found; it is not a student-only or per-campus measurement. On a modeled Wednesday about 4,500 of 14,600 campus-visiting commuters ride.

- Each rider keeps one stop and route direction for the week, chosen in proportion to its published weekly trips (Green Line B/C/D, buses 1, 8, 10, 47, 57, SL4/SL5 and the BU Shuttle lines). They go home from the nearest stop within 400 m that the same route serves the other way. BU Shuttle lines are one-way loops, so shuttle riders go home onward round the same line.
- Inbound, a rider steps off a real GTFS trip at its published arrival and starts walking 30 s later. The planner picks the last trip that still keeps their usual 2–12-minute class lead, at most an hour early; venue hours still apply to the extra wait.
- Outbound, a rider walks to the stop and waits, at most 30 minutes, for the next published departure. While waiting they stand at the platform or kerb as idle characters, and the stop's tag shows how many BU students are waiting.
- Modeled students on one trip never exceed the [MBTA Service Delivery Policy](https://cdn.mbta.com/sites/default/files/2026-01/20260128_Service%20Delivery%20Policy_December%202025.pdf) peak maximum load: 200 for a two-car Green Line train (100 per car) and 54 for a 40-ft bus. BU Shuttle trips are capped at 100, the capacity BU configures for every shuttle in TransLoc (`GetVehicleCapacities`). Other riders are not modeled. In playback, a vehicle's card shows "N BU aboard" for its published trip; live vehicles carry no trip match.
- Non-riders never walk in from Green Line platforms. Legs with no published trip that fits (about 1%) are walked from the stop and counted in `transitUnmatchedLegs`.
- Origins, transfers and the off-map part of each journey are unknown. The MBTA timetable week (October 19–25) is aligned to the scenario week by weekday. Only commuters ride; residents' trips between campuses on the Fenway or Albany/E Newton shuttles are not modeled yet.

### BU Shuttle timetable

`public/data/shuttle-schedule.json` is built offline by `python3 ../data-pipeline/build_shuttle_schedule.py` (part of `npm run prepare:data`) from two published sources. Every route and weekday records which one it used (`provenance`).

1. **Recorded current schedules.** `python3 ../data-pipeline/capture_shuttle_times.py --watch` polls TransLoc's scheduled stop times every 30 minutes and appends them to `data-pipeline/snapshots/transloc/<date>.json`. TransLoc only shows about the next one to three hours, so each poll records the window it could see. Inside a recorded window, those times replace the baseline for that route and weekday, including the absence of service. The most recent date wins for each weekday.
2. **Baseline.** Outside recorded windows, the timetable uses BU's own TransLoc GTFS feed ([api.transloc.com/gtfs/bu.zip](https://api.transloc.com/gtfs/bu.zip), snapshot in `snapshots/transloc/bu-gtfs-2024-25.zip`). It is the most recent complete machine-readable BU Shuttle timetable, but its calendars cover the 2024–25 academic year. It is applied to Fall 2026 by weekday from the same fall-term week (Monday 21 October 2024). It is not a Fall 2026 timetable.

`validation` compares each recorded window with the baseline. On Saturday 24 October 2026 the 1BU matched the baseline exactly (30-minute service, same stop-to-stop times). Fenway now runs every 40 minutes, not 30. Night runs every 15 minutes, not about 16.5. Albany/E Newton runs on Saturdays, which the baseline does not have. Weekday times stay on the baseline until a weekday is recorded. Hyatt and Thanksgiving services are left out because they have no current route on the map. In playback, scheduled shuttles now run on their TransLoc routes, and a published timetable, rather than the estimated service hours, decides when a line is shown.

`tests/transitRides.test.mjs` checks that every ride matches a published stop time, that walks start and waits end at the stop, the rider share, the vehicle load limits and continuous timelines.

## Real Bluebikes rides

The **Bikes** tab replays measured dock departures and arrivals. Blue riders follow inferred routes between those endpoints; a BU dock is a white dot with a blue ring. Hover over either for details.

- **Replay:** every real Bluebikes ride on Wednesday, Sep 23, 2026 that started or ended at one of the 16 docks within 200 m of a BU building (2,367 rides), played on the same clock as the simulation. The time a bike leaves or reaches a BU dock is real. The street route is **inferred**, because rides record only their two docks. It's the most bike-friendly OSM path: lanes and paths first, one-way streets respected. Rides to docks off the map run to its edge.
- **Typical day:** each dock's rides docked and undocked per 15 minutes, averaged over the five Wednesdays in September 2026. This is the panel's chart, and the "next hour" figure in dock tooltips.
- **Live:** `src/bikes/bluebikes.ts` polls Bluebikes' public GBFS `station_status` every 60 s, straight from the browser (CORS open, no key needed): bikes, e-bikes and empty docks per BU dock.
- **Rebuild** with `python3 data-pipeline/fetch_bikes.py` (standard library only). Use `--month 202610` once that month is published, or `--replay-date 2026-09-16`. Output: `public/data/bikes.json` (~2 MB). The map still starts without it; the Bikes tab is just hidden.
- **How it compares with the simulation:** real bike activity at Charles River docks peaks 4–7 PM, with a smaller 8 AM rush. The simulated day peaks at lunch. Hour by hour, they're uncorrelated (r ≈ 0, 7 AM–11 PM). Bluebikes riders aren't only students, but it suggests the simulation under-weights the evening.

## Parking (estimate, off by default)

The **Parking** toggle in the Transit tab (remembered in `localStorage` as `flowcast.parking`) shows how full the garages and lots around BU and its event venues probably are at the shown day and time. While it's off, nothing loads or runs: no data fetch, no layers, no tags, no per-frame work.

- **Lots** (`public/data/parking.json`, built by `python3 data-pipeline/fetch_parking.py`): BU's garages and lots (Agganis, Warren Towers, Langsam under New Balance Field, Buick Street, Lots F/H/R, the Medical Campus garages) and the public ones near Fenway Park, MGM Music Hall and Kenmore Square. Geometry and names from OpenStreetMap; capacity from a published figure, the OSM `capacity` tag, or footprint × levels ÷ 30 m² per space, and each lot says which (`capacityBasis`, `capacityNote`, `sourceUrl`).
- **Demand** (`src/sim/parking.ts`, deterministic): a fill curve per kind of lot (BU commuter garages fill 7–9 AM, hold, drain 4–7 PM; medical garages run 24/7; public garages follow shops and restaurants), lower on weekends and on BU holidays and breaks (from the academic calendar). Events add cars: they arrive over the 2 h before the start, stay to the end and leave over the following hour, going to the nearest lot that sells event parking until it's FULL, then spilling to the next nearest within the venue's walking radius. Cars that find no lot are counted in the panel. Events: Red Sox home games, Agganis Arena, MGM Music Hall, Nickerson Field, commencement and move-in, and BU's own events from `campus-data.json` (small). Undated placeholders are labelled **Sample**.
- **Which day:** Clock mode uses today's date in Boston; playback uses the chosen day of the simulated week.
- **Drawing:** two deck.gl layers for every lot (`layers/parking.ts`: one `SolidPolygonLayer` of fills, one `PathLayer` of outlines) with data arrays built once; only the colour accessors re-run, when a lot changes level. The estimate is recomputed at most twice a second, like the HUD. Tags ("Agganis Garage · 82% · Busy", "FULL") go through the shared placer (`ParkingTags.tsx`), on the same four-step scale as the crowds.
- **It's an estimate layer only.** Students in the simulation don't drive, and parking never changes timelines, occupancy or counts.

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
  "trips":     [{ "agent": "a0000", "from": "warren", "to": "cds", "depart": 32400.0, "speed": 1.31 }],
  // Riders: from each Green Line station / bus / BU Shuttle stop near a campus to its 8 nearest
  // locations (within 1.2 km), same form as walkRoutes; path[0] is the stop itself.
  "stopRoutes": { "place-bucen>cas": { "path": [[lng, lat], …], "cumulative": [0, 9.8, …] } }
}
```

Trips (a path plus timestamps) are what deck.gl's TripsLayer reads natively. They're also far smaller than minute-by-minute positions, and the client interpolates between points. When the Simulation Lead's `simulate_week.py` exists, it should emit this shape (one file per day). The live server can then broadcast the same objects.

## Near-zero buildings

No building is ever truly empty (staff, visitors and people the model doesn't simulate), so a place whose simulated share rounds below 5% reads "<N%" (N from the upper end of a 90% band in `src/sim/uncertainty.ts`: day-to-day variation, ±15% model uncertainty, plus at least 2 people or 3% of capacity unmodelled), and a student-count place under 3 reads "<3 students". Everything else is the plain simulated percentage. Display only: counts, colours and totals are unchanged.

## Performance (keep it smooth)

The frame rate is set by the **number of WebGL calls per frame**, not by shader work: Chrome runs every call from Mapbox and deck.gl through one GPU-process thread at roughly 2 µs each, and the browser's own compositing shares that thread. Mapbox Standard alone makes ~10,000 calls a frame with shadows and 3D trees on. On an M4 Pro in Chrome the map went from ~11 to ~59 FPS (Auto) by cutting calls:

- **Draw only what's on screen and under way.** The walker trails get the trips active near the shown time (`Playback.trailsAt`), never the whole day (36,000 trips, 2 million segments). Off-screen, empty and pick-only layers are skipped in `layers/culling.ts`.
- **One draw per model, not one per part.** glTF parts are batched at load (`layers/gltf-materials.ts`, drawn by `MaterialScenegraphLayer`); animated bike riders swap to a still, merged copy below zoom 17 (`layers/gltf-static.ts`); walkers use one animation layer per model below zoom 16.
- **Same arrays every frame** for moving things (`layers/stable.ts`), so deck.gl re-uploads only positions.
- **Mapbox VAO cache** (`map/vaoCache.ts`): Mapbox rebuilt ~130 vertex arrays a frame with shadows on.
- **No MSAA at pixel ratio ≥ 1.75**: it doubled GPU time on Retina screens, whose density already smooths edges.
- **No `backdrop-filter` on panels**: re-blurring the moving map behind each panel every frame cost a third of the frame rate.
- **No per-frame Mapbox style churn**: @deck.gl/mapbox moved one of its two slot layer groups on every `setProps`, re-running Mapbox's style update each frame (`skipSlotGroupMoves` in `map/basemap.ts`). Standard's flat 2D building footprints, hidden under the city extrusions anyway, are switched off.
- **Auto** (`perf/quality.ts`) drops shadows, then footpaths and building ambient occlusion, then 3D trees when the 1% low stays under 45 FPS, never the resolution, and remembers where it settled.
- **Optional frame cap**: `?fps=60` renders on a steady beat (every other refresh on a 120 Hz screen) via `perf/pacer.ts`; off by default.

To measure a change, open the perf panel (`P`) or use `?debug` and the browser's Performance tab. Watch the per-frame GL call count, not just FPS.

## Pitfalls we already hit (don't re-debug these)

- **luma.gl shader injection keys need the `#`**: `'vs:#main-end'`, not `'vs:main-end'`. An unknown key is ignored without a warning (batched models then lost their colours).
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

### BU hackathon sources (local, restricted access)

Put `CATALOG_API_KEY` in the ignored `map-client/.env.local` and restart Vite to prefer
BU's authenticated transit API. The key stays in the Vite server; only an enabled flag
enters the browser bundle. Without a key the existing public TransLoc integration is
used. Configured API failures do not switch sources silently. Routes and physical-stop
arrivals retain the same BU IDs; vehicle freshness uses `reported_at`, never fetch time,
and stale upstream responses are rejected.

The local server and `vite preview` expose only GET routes, vehicles, and numeric-stop
arrivals under `/api/bu/transit/bus`. They cache routes/arrivals for five minutes and
vehicles for one minute, deduplicate concurrent fetches, and limit each server process
to 80 upstream requests per minute and 8,000 per UTC day. These budgets reset on server
restart and do not coordinate with other team processes; the shared key still has the
provider's 100/minute and 10,000/day limits. Arrival predictions can lag by five minutes;
old vehicle observations still expire under the normal 90-second freshness rule.

If `data-pipeline/.cache/hackathon/campus-data.json` exists, the local server serves that
private bundle at `/data/campus-data.json` with `Cache-Control: no-store`. It is not copied
into `dist` or committed. Keep this server on localhost for the team’s hackathon use.
A static public deployment does not supply this proxy or private bundle: deployment of
restricted data requires an authenticated server and permission consistent with the
access terms. Rebuild without the key for the ordinary public-data static app.
