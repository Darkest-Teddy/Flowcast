# Flowcast — DS+X Hackathon Master Plan

**Event:** DS+X, Boston University. Starts Saturday, October 24, 2026 at 8:00 AM. Ends Sunday, October 25, 2026 at 11:00 AM. Run by BU Spark! and the Faculty of Computing & Data Sciences. Total working time: 27 hours.
**Track:** Hack College
**Team size:** 5 people. Roles are proposed in Section 2; assign real names at kickoff.
**Project name:** Flowcast (chosen — see Section 12 for the full naming brainstorm and other candidates considered).

**Judging criteria (from the organizers):**

| Criterion | Weight | What it checks |
|---|---|---|
| Problem | 20% | The project names a real problem and solves a real user need. |
| Idea & Relevance | 25% | The solution is creative and could have real impact. |
| Technical Execution | 25% | The product works, is stable, is usable, and uses tools well. The rubric says explicitly: emphasis on accessibility and working demos, not unrealistic deployment. |
| Design | 15% | The interface is clear, easy to navigate, visually consistent, accessible, and shows attention to detail. |
| Responsibility & Ethics | 10% | The team reflects on bias, fairness, accessibility, and transparency in how it uses data and AI. |
| Presentation | 5% | The pitch is clear, engaging, and communicates the project's purpose and impact. |

Section 14 matches each rubric line to a specific part of this plan and tells you what to say about it during judging.

---

## 1. What we are building

We are building a live, browser-based 3D model of the BU campus. The model is filled with AI agents — one agent per student. Each agent follows a class schedule and moves between real campus buildings (classrooms, dining halls, libraries, dorms, the gym) the way an actual student moves through a day.

The system's main output is a prediction: how crowded each place will be, at each hour, across a full week, and how people flow between buildings. This prediction is the product. The 3D map is how we show the prediction, not the point of the project by itself.

People in the room join the live model from their phones. They scan a QR code, which opens a web page — no app install. On that page, they build a persona of themselves (their real schedule, their habits, a simple avatar), watch their own agent move on the big screen, and vote on live events (weather, campus events) that visibly change what happens on the map.

DS+X is a data-science hackathon. Every design choice in this plan protects one goal: the prediction model must be real, explainable, and demonstrable — not just a visual effect sitting on top of a game.

---

## 2. Team and roles

No one on the team has built a 3D scene or used a game engine before. This fact drives every technical choice in this plan. We pick tools that work through configuration, not tools that require graphics programming or 3D modeling skill the team does not have.

Proposed role split for 5 people (swap in real names at kickoff):

| Role | What this person owns | Main tools |
|---|---|---|
| 1. Data & Schedules Lead | Gets real BU schedule data (their own MyBU export, plus a scrape of the public course catalog), builds the synthetic-schedule generator, pulls campus geometry from OpenStreetMap, gathers 25Live and dining-hall data | Python, `osmnx`, `requests`/`BeautifulSoup`, the Overpass API |
| 2. Simulation & ML Lead | Builds the agent-movement simulator and the crowd-prediction machine-learning (ML) model. Owns proving the project is real data science, not just a visual demo. | Python, `pandas`, `scikit-learn` or `Prophet`, `networkx` |
| 3. Realtime Backend Lead | Owns the one live-state server: it broadcasts agent positions, accepts persona joins, counts votes, and injects events | Node.js, TypeScript, Socket.IO, Redis, PostgreSQL |
| 4. 3D Map / Frontend Lead | Owns the big-screen 3D client: terrain and buildings, agent rendering, the heatmap overlay, the scrub-through timeline | React, TypeScript, Mapbox GL JS, deck.gl |
| 5. Mobile Web / Product & Pitch Lead | Owns the phone-facing QR web app (persona builder, follow-your-agent view, voting) and leads the pitch script | React, TypeScript, Tailwind CSS |

Roles 3 and 4 will work side by side for most of the event, because they share one live data contract (what the server sends, the client must render). Role 5 shifts into QA and demo rehearsal in the final hours. The hour-by-hour plan in Section 13 reflects this.

---

## 3. Product scope

The team's direction is to build the full feature list below, not a cut-down version. Section 11 lists engineering safety nets that protect the demo. A safety net is not a missing feature — it is a backup plan that activates only if something breaks.

### 3.1 The simulated campus
- Real BU campus geometry — building footprints, building heights, paths, and roads — comes from OpenStreetMap.
- Each location (dining hall, classroom building, library, study spot, dorm, gym) has an identity and a capacity.
- The walkway and street network connects every location.
- The simulation covers a full week (Monday through Sunday), not one day. The team computes this week of data before the live demo runs.

### 3.2 Agents
- Each agent represents one student profile, real or synthetic. Each agent has its own schedule, home dorm, and simple behavior preferences (usual eating time, preferred study spot).
- Agents move between locations along the real walkway network. They arrive and leave around class times, with small randomized timing so the crowd looks organic, not mechanical.
- Render target: 200 to 500 agents visible and animated at once in the 3D view. Section 6 explains how we keep this smooth.

### 3.3 Prediction — the core data-science deliverable
The prediction system outputs three things:
1. **Occupancy over time**, per location, per hour, across the week. Example: "Warren Towers dining hall peaks at 78% capacity at 12:15 PM on Wednesdays."
2. **Arrival and departure patterns**, per location — what time people typically show up and leave.
3. **Movement between buildings** — which routes and walkways carry the most traffic, and when.

We show this prediction three ways, all three built, not a choice between them:
1. **Heatmap overlay** on the 3D map — buildings and ground glow by predicted crowd density.
2. **Side dashboard** with time-series charts per location — peak times, capacity curves.
3. **Click-to-inspect building stats** — tap a building, see its predicted occupancy curve and peak time.

### 3.4 Phone interaction (QR-code web app, no install)
- Scanning the QR code opens a mobile web page directly. No app store, no login wall.
- **Step A — Persona builder.** The user enters their class schedule, picks a home dorm, answers one or two habit questions (meal time, study spot), and chooses a name and a simple avatar (color and accessory — see Section 7).
- **Step B — Follow your agent.** Once created, the phone shows a live mini-view centered on the user's own agent: where it is, and what it is currently doing ("in class," "eating," "studying").
- The schedule a user enters is not cosmetic. It feeds directly into the live simulation and into the crowd predictions.

### 3.5 Voting and live events
- The team sets a short list of options before the demo: weather conditions, campus events.
- People vote from their phones in real time. Results show live on the big screen.
- The winning option changes agent behavior, not just the visuals. Example: if "rain" wins, fewer agents use outdoor walkways and more crowd into indoor locations. If a "campus event" wins, a visible stream of agents moves toward the event location. A matching visual effect (rain particles, a lighting change) plays alongside the behavior change.
- Presenters can also trigger an event manually during the live demo, separate from audience voting, to create a "watch this happen right now" moment for judges.

### 3.6 Concrete event list to simulate
Keep the actual vote list short (3–4 options per ballot, so a phone vote takes one tap), but build the underlying simulation to support all of the following, grouped by how they change agent behavior. Each one only needs a simple rule — no new system per event, just a new entry in a lookup table the agent behavior loop already checks.

**Weather conditions** (change walkway use and indoor/outdoor balance):
- Clear/sunny — baseline behavior, plus a visible bump in outdoor gathering spots (e.g., the BU Beach lawn) as a "relaxed" state.
- Rain — fewer agents on outdoor walkways and the Beach; more crowding in indoor spaces (dining halls, library) and faster, more direct walking routes.
- Snow — similar to rain but stronger: slower overall walking speed (a visible, easy effect), and noticeably heavier dining-hall and library crowding since outdoor lingering drops to near zero.
- Heatwave — less time spent outdoors at midday specifically, with gym and air-conditioned study spaces seeing a localized spike.

**Campus events** (pull agents toward one real or plausible BU location, at one real or plausible time):
- A career fair or job fair in a large venue (e.g., a gym or student union space) — draws a visible stream of agents from classroom buildings toward the venue in the hour before it starts.
- A home sports game (e.g., at Agganis Arena or Nickerson Field) — draws a large, timed crowd surge toward one building at a specific hour, then a matching surge away from it afterward, which is a strong visual "flow" moment for the heatmap.
- A club fair / activities fair (BU's real "Splash" or similar event) — draws a broad, campus-wide crowd into one central outdoor area rather than a single building.
- A concert or large on-campus performance — similar to the sports-game pattern, concentrated at one venue and one time window.
- A fire alarm / building evacuation drill — the sharpest, most visually dramatic option: one building empties out almost immediately, which is an excellent "watch this happen live" moment for a presenter-triggered manual event rather than a pre-vote option, since it's instant and highly legible even to someone glancing at the screen for the first time.
- A dining hall closure or reduced hours (e.g., for a holiday or a maintenance issue) — redirects agents who would normally eat there to the next-nearest dining hall, which is a good demonstration of the model reacting to a supply-side change, not just a demand-side one.
- Move-in day or finals week, if the team wants a week-level rather than single-event option — these change the whole week's baseline pattern (finals week: heavier, later library occupancy across every day) rather than a single moment, and are better shown via the scrub-through timeline (Section 3.3) than the live vote.

Pick 3–4 of these for the actual audience ballot (a weather option plus one or two campus events is a good default), and keep the rest as presenter-triggered manual events or scrub-timeline-only scenarios, per Section 3.5's note that presenters can also spawn events outside the voted list.

### 3.7 Live demo mode
- During the presentation, the team picks one real weekday from the precomputed week and plays it back live.
- Different days look different — a Tuesday full of back-to-back classes looks busier than a light Friday — because the schedule data drives it directly. This is the clearest way to show judges the prediction engine is real, not decorative.
- While the demo plays, the audience's live joins, personas, and votes change the playback in real time, on top of the precomputed baseline.
- Playback speed (real time or sped up) is a control the presenter adjusts. The team decides the exact speed at rehearsal (Section 13), not in code ahead of time.

---

## 4. Data sources and the data pipeline

| Source | What it gives us | Plan |
|---|---|---|
| MyBU Student | One real class schedule | One team member exports their own schedule, with their consent, as a real-data example |
| BU public course catalog (Schedule of Classes / Bulletin) | Public course meeting times and locations, no login required | Scraped to build many realistic student schedules at scale |
| 25Live | Room and event scheduling | Used for room capacity and campus events if we reach it in time; otherwise we estimate capacity from the catalog data |
| Dining hall hours and capacity | Public operating hours; capacity estimated where not published | BU's public dining pages |
| OpenStreetMap | Building footprints, heights, and the path/street network for the whole campus | Pulled with the Overpass API or `osmnx`, free, no login required |
| Persona submissions | Real schedules and preferences from people who join live | Collected during the event itself |

### 4.1 The synthetic schedule generator
BU will not hand over bulk real student data, so we build our own population instead of waiting for one. The Data Lead writes a generator that takes the public catalog (course → meeting time → room) and enrolls many synthetic students in realistic course combinations. "Realistic" means the generator respects patterns like class year and major — it should not, for example, mix a senior computer-science elective with an intro biology section at a rate that would never happen in real life.

This technique — building a calibrated synthetic population from public aggregate data instead of private individual records — is standard practice in simulation work (the same idea drives traffic and epidemiology simulations). Present it to judges as a deliberate, named design choice, not an admission that "we didn't get the real data." It is also the stronger answer under the Responsibility & Ethics criterion (Section 10).

### 4.2 Pipeline steps, in order
1. Pull the BU campus area from OpenStreetMap (via Overpass or `osmnx`) → building footprints, heights, and the walkway graph, saved as GeoJSON.
2. Scrape the course catalog → a table of course meeting times and locations.
3. Run the synthetic population generator → produces the target number of student schedules (the number matches the agent-count target in Section 3.2).
4. Add the one real MyBU schedule as a labeled "real data" example.
5. Feed the schedules and the walkway graph into the simulation engine (Section 5) → produces a minute-by-minute position for every agent, for the full week. Compute this once, ahead of the live demo.
6. Feed the precomputed week into the crowd-prediction ML model (Section 5.3) → produces the per-location, per-hour forecasts shown on the dashboard and heatmap.
7. At runtime, the live server loads this precomputed week as the baseline for both the scrub-through timeline and the live demo-day playback, then layers live persona and vote data on top.

---

## 5. Simulation and AI/ML architecture

### 5.1 Movement simulation — rule-based, not machine learning
Each agent runs a simple state loop: `AT_HOME → TRAVEL → IN_CLASS → TRAVEL → EATING or STUDYING → TRAVEL → ... → AT_HOME`. The agent's own schedule, for that day of the week, drives every transition. We add small randomized timing (plus or minus 5 to 10 minutes) and a randomized pick among an agent's preferred locations (which dining hall, which study spot), so the crowd does not look identical and mechanical.

This layer is deliberately not deep learning. It is agent-based simulation — a well-established, well-understood technique. It runs fast, and it is easy to debug, which matters most in a 27-hour build.

### 5.2 Pathfinding — computed once, not live
Computing a walking route for every agent transition, live, would be expensive at hundreds of agents. Instead, we compute the shortest walking route between every pair of locations the simulation needs (dorm ↔ classroom building ↔ dining hall ↔ library ↔ gym) one time, offline, using a standard shortest-path algorithm (`networkx`, Dijkstra or A*) on the OpenStreetMap walkway graph. At simulation or playback time, "an agent moving" is just the agent's position interpolating along a stored route over its known travel time. This is cheap enough for thousands of agents and trivial at our 200–500 target.

### 5.3 Crowd prediction model — the real ML component
**Input:** the full precomputed week of agent positions (Section 4.2, step 5) — in effect, a large, realistic event log of who was where, and when.
**Output:** for each location, a predicted occupancy curve across the week, predicted peak arrival and departure times, and predicted flow volumes between buildings.
**Method:** aggregate the simulated event log into occupancy counts per location, per 15-minute window. Then fit a standard forecasting model over features like hour of day, day of week, and location — a seasonal decomposition, or a gradient-boosted regression, built with `scikit-learn` or `Prophet`. Fitting a model instead of just replaying raw counts gives smooth, explainable forecasts, which is what a judge can be shown and asked about directly.

This model is the single most important artifact for the Idea & Relevance and Technical Execution criteria. Keep it visibly separate from the simulation layer in the demo, so you can explain "this part predicts; this part shows" as two distinct, understandable systems.

### 5.4 LLM usage — scoped narrowly, never on the hot path
"LLM" means large language model — an AI model, accessed through an API, that generates text from a prompt. The team already has API access. We use an LLM for exactly one job: persona flavor, not agent movement.

- When a user builds a persona, one LLM call turns their inputs into a short flavor line (example: "computer-science major, lives in West Campus, eats late" becomes a one-sentence personality blurb shown on their phone and on the big screen).
- We keep this call off the simulation's hot path (the loop that ticks hundreds of agents every second), because that loop is the single biggest performance risk in the whole system. If the LLM call is slow or the API is down during the demo, the system falls back automatically to a template-built description. The persona still works. This fallback is part of the implementation, built in from the start — not a feature we might cut.

---

## 6. 3D map and rendering architecture

### 6.1 Choosing the 3D library
Because no one on the team has built a 3D scene before, the deciding question is: how much of "a realistic 3D campus with hundreds of moving agents" can we get from configuration files, and how much would require graphics programming or hand-built 3D models?

Options we considered:

| Option | Assessment |
|---|---|
| Unity or Unreal (full game engine) | The most visually powerful option, but it requires real game-development experience, a slower build-test loop, and awkward web deployment for a product people join by scanning a QR code. Not recommended — too much risk for a team with zero prior experience. |
| Three.js, built from scratch | Full control, but "realistic campus" from scratch means someone has to build or source 3D building models by hand. Too slow to finish in 27 hours without a map-data integration layer on top. |
| CesiumJS | Strong photorealistic global 3D terrain and buildings (it can use Google's Photorealistic 3D Tiles), but it is a heavier, more complex library, built for whole-planet precision that we do not need for one campus. |
| MapLibre GL JS, plus deck.gl | Fully open source and free with no account needed, and reads OpenStreetMap data directly. However, MapLibre's built-in 3D buildings are flat-colored extrusions only — it does **not** include Mapbox's textured, lit "Standard" style, because that style is a Mapbox-proprietary feature, not part of the open fork. Getting a textured look on MapLibre would mean building custom building materials by hand, which the team does not have time for. |
| **Mapbox GL JS, plus deck.gl (recommended)** | A standard, widely used geospatial stack (Uber and Mapbox both use it in production). It reads real OpenStreetMap data directly and extrudes real building footprints into 3D. Its built-in "Standard" style gives textured-looking, lit, shadowed 3D buildings with zero custom modeling — this is a Mapbox-only feature, confirmed not available in MapLibre (see Section 6.2). deck.gl adds GPU-instanced layers (`ScenegraphLayer`, `IconLayer`, `TextLayer`, `HeatmapLayer`) built specifically to animate hundreds to thousands of moving objects smoothly. Nearly everything here is configuration, not graphics code — which is exactly what a team with no 3D experience needs. |

**Decision, corrected from an earlier draft of this plan: use Mapbox GL JS, not MapLibre, as the base 3D map, with deck.gl layered on top for agents, routes, and the heatmap.** An earlier version of this plan recommended MapLibre "to avoid billing" on the mistaken assumption that it includes Mapbox's realistic building style. It does not — that style is proprietary to Mapbox. Mapbox's free tier is 50,000 map loads per month with no credit card required, which comfortably covers a single hackathon weekend on a handful of devices, so there is no real billing risk to avoid. Create the free Mapbox account and generate an access token in the first setup hour.

### 6.2 Meeting the "detailed, textured buildings" goal
The team wants detailed, textured building models — normally a high-risk ask for a first-time 3D team. Mapbox's built-in "Standard" style solves this directly: it extrudes real building footprint and height data from OpenStreetMap automatically, with realistic facade texturing, shadows, and time-of-day lighting, entirely through map style settings. No one on the team models or textures a single building by hand. This gets the visual quality the team wants without the modeling risk the team cannot absorb in 27 hours. (MapLibre's equivalent community plugin, `maplibre-landmarks`, exists but only covers specific pre-built landmark models — it is not a general substitute for every building on a real campus, which is why Mapbox is the better fit here.)

### 6.3 How agents render and "walk" — two options, one clear default

There are two real ways to make hundreds of characters look like they are walking in a browser. They trade off build complexity against animation realism, and the team should pick the default in Hour 0 rather than discover the trade-off mid-build.

**Option A — deck.gl `ScenegraphLayer`, no true leg animation (recommended default).**
Each agent is one small, simple 3D shape — a capsule body with a sphere head, or a free, low-poly glTF humanoid model used once and reused for every agent. deck.gl's `ScenegraphLayer` draws that one model hundreds of times using GPU instancing: one render call handles every agent, each tinted by its own avatar color and placed at its current position. Agents do not have moving legs; instead, each agent rotates to face its direction of travel and bobs gently as it glides along its route. At the camera distance a city-scale map is viewed from, this reads as walking — a judge will not be zoomed in far enough to notice a missing knee bend. This is the technique behind the "simple shapes with color and label customization" approach the team already chose, it is the standard way to render large numbers of moving objects in a browser, and it is the safest choice to finish in 27 hours with zero prior 3D experience.

**Option B — Mapbox GL JS + `threebox` + three.js `InstancedMesh2`, true per-instance walk cycles (stretch upgrade only).**
`threebox` is a maintained plugin that embeds a full three.js scene inside a Mapbox GL JS map, keeping the two cameras in sync. Inside that three.js scene, `InstancedMesh2` (a community library built specifically for this problem) supports real per-instance skeletal walk-cycle animation at GPU-instanced scale — it has been demonstrated with 3,000 simultaneously animated characters, each on its own animation clock, with built-in level-of-detail so distant characters animate less often. This produces visibly more realistic walking than Option A. **Do not start with this option.** It requires three.js and skeletal-animation concepts on top of everything else, which is a large jump for a team with zero 3D experience, and it is not needed to hit the Technical Execution or Design rubric lines — a smooth, correctly moving crowd matters more to a judge than literal leg movement. Attempt it only after Option A is fully working and only if there is real time left (realistically, no earlier than the Sunday 5:00–7:00 AM polish block in Section 13).

If the team tries deck.gl's own animation support instead of Option B: `ScenegraphLayer` does support glTF animation through its `_animations` setting, but that setting plays one shared animation clock for every instance of the model — left as the default, all agents would visibly walk in perfect lockstep, which looks obviously fake. If this is attempted, split the agent population across several `ScenegraphLayer` instances, each started at a different point in the walk-cycle loop, so the crowd does not move in unison. This is a real but fiddly workaround, which is another reason Option A's simpler bob-and-rotate approach is the better default.

A `TextLayer` floats each agent's name above it. If hundreds of labels look cluttered, limit labels to agents near the camera.
The heatmap overlay uses deck.gl's `HeatmapLayer`, driven by agent density, recalculated every 5 to 10 seconds rather than every single frame.

### 6.4 Keeping 200–500 agents smooth
- The client interpolates agent positions between server updates. The server does not need to broadcast 60 times per second — broadcasting every 250 milliseconds to 1 second, with the client smoothing the motion in between, looks smooth and uses a fraction of the bandwidth and processing power.
- All agents share one instanced draw call per layer, instead of one draw call per agent. This is the single most important performance decision in the whole rendering pipeline, and deck.gl provides it automatically — this is the main reason Option A is the default over building the renderer by hand in Three.js.

### 6.5 Pulling BU's campus data with OSMnx
`osmnx` is a Python library built exactly for this extraction job. Two calls cover everything Section 4's pipeline needs:
- Buildings: `ox.features_from_place("Boston University, Boston, MA, USA", tags={"building": True})` returns every tagged building footprint as a GeoPandas table, ready to export to GeoJSON for the map client.
- Walkways: `ox.graph_from_place("Boston University, Boston, MA, USA", network_type="walk")` returns the pedestrian path network as a graph, ready for the shortest-path precompute step in Section 5.2.

Confirm the named-place query actually resolves to a sensible boundary before relying on it (OpenStreetMap's boundary for "Boston University" may be incomplete or oddly shaped); if it does not, fall back to a manually drawn bounding box around central campus and pass that box's coordinates to `ox.features_from_bbox` / `ox.graph_from_bbox` instead. Do this check in the first setup hour, not after other work already depends on it.

### 6.6 Whether an existing 3D model of BU's campus can be reused
We checked for a ready-made 3D model of the BU campus that could be extracted and improved instead of built from OSM data. The answer is no, for two different reasons:
- **SketchUp's 3D Warehouse** has only generic, unofficial "college campus" stock models — nothing that is actually BU's real layout.
- **Google's Photorealistic 3D Tiles** do cover Boston at high visual quality, but they are not a model the team can legally "extract and remodel." Google's terms require rendering these tiles live, in real time, through an approved renderer (CesiumJS, or Google Maps/Earth) with attribution shown — they do not permit pulling the underlying 3D mesh out, editing it, and redistributing or rebuilding it as a separate asset. Treating this as a source to extract from would put the project outside Google's terms of use, which is not worth the risk for a hackathon project with public visibility.

This does not change the plan. It confirms that the OpenStreetMap-building-extrusion approach in Section 6.1, combined with Mapbox's "Standard" style, is the correct choice rather than a compromise: it is real BU geometry, free, and has no licensing restriction on how the team uses or shows it.

### 6.7 Seeing what's happening inside a building

A real building's interior is not modeled in the outdoor 3D campus view — the OpenStreetMap-driven buildings in Section 6.1 are exterior shells only, extruded to the right height, with no rooms inside them. True architectural "cutaway" or "dollhouse" rendering (the kind real-estate visualization tools do, slicing a building open to show every floor) is built for pre-rendered, static images, not a real-time browser scene with moving characters, and it is not worth attempting here.

**Use the same pattern the reference image already shows: a separate, simplified interior scene, not a literal cutaway of the real building.** This is the same technique Gather.town and similar apps use, and it is well suited to a team with no 3D-modeling experience:

- Build a small number of **reusable interior scene templates** — one for a generic dining hall, one for a library/study space, one for a classroom, one for a dorm common room, one for the gym. Every building of a given type reuses the same template; there is no need to model a unique interior for every real building on campus. Five templates is enough to cover everything in Section 3.1.
- Each template is a small, self-contained scene (built with simple box/plane geometry for tables, chairs, shelves, and a floor — exactly the level of detail in the reference image) that does **not** need real-world coordinates. It is a flat "stage," separate from the geospatial map.
- When someone taps a building — on the big screen, or from their own phone — the UI swaps to that building's interior template and places the Kenney characters (Section 7.1) who are currently simulated as being inside it, using the position/action data the realtime server already tracks. A character currently "eating" is shown seated at a table in the dining hall template; a character "studying" is shown seated at a desk in the library template. No new simulation logic is needed — the interior view is a different camera and a different stage for state the system already has.
- Exiting the interior view returns to the main 3D campus map. This can be a simple UI panel/modal rather than a literal camera fly-through, which is faster to build and just as clear to a judge.

This gives the team a genuine "what's happening inside this building right now" feature — directly answering the brief's "see what's going on inside a building" request — without any of the real architectural modeling or true 3D cutaway rendering that would be far too slow to build from scratch in 27 hours.

**Optional presentation upgrade: show the interior as a hologram, not a plain popup.** Free, open-source Three.js shader materials already exist for a convincing "holographic projection" look — glowing edges (a Fresnel rim-light effect, which brightens the outline of a shape and darkens its flat faces), horizontal scan lines, and partial transparency — with no custom shader-writing needed, just dropping the material onto the interior scene's meshes (for example, `ektogamat/threejs-vanilla-holographic-material` or `OtanoStudio/Hologram-Material`, both free and built for exactly this). Visually, tapping a building could make its interior scene rise up out of the building as a glowing, semi-transparent projection instead of opening a flat modal panel. This is a genuine "wow" upgrade for the Design criterion (Section 14) and costs very little engineering time because the shader is pre-built — but treat it as a polish pass on top of the plain-popup version, not a dependency: build the interior-view feature with a normal panel first, and only layer the holographic material on top once that baseline works, since a shader that never gets applied in time still leaves a fully working feature behind.

---

## 7. Avatar and persona customization

### 7.1 Visual reference and the concrete asset to use
The team's reference image shows the exact right target: a "peg-doll" style character — a plain capsule/cylinder body in one color, a separate rounded block on top standing in for hair or a hat in a second color, simple dot eyes, and a floating name/status bubble above the head ("Social Sam — finished lunch"). This is the same style used by Gather.town, Topia, and similar browser-based avatar spaces, and it is deliberately simple: two or three colored primitive shapes, not a sculpted character.

**Use Kenney's "Mini Characters" pack as the base model.** It is a free, CC0-licensed (meaning free for any use, no attribution required) asset pack of 12 blocky, rounded low-poly characters, already rigged and shipped with 32 animations including walking, in glTF/GLB format — the exact file format both deck.gl's `ScenegraphLayer` and three.js load natively. Three things make this the right fit:
1. **It already has a walk animation built in**, which removes the single hardest part of Section 6.3's Option A/B trade-off — the team does not need to author any animation, only trigger the one that ships with the model.
2. **It matches the reference image's visual style closely** — simple, blocky, friendly, not photorealistic — so very little additional styling work is needed to match the look the team wants.
3. **It is pre-built and free**, which matters directly for "simple and easily reproducible": no one on the team needs any 3D-modeling skill to use it; it is a drag-in asset.

Get it from `kenney.nl/assets/mini-characters`.

### 7.2 What is actually customizable
Avatars are not a full character-creator system. Each persona has:
- **Body color** — a straight material-color tint applied to the Kenney model's base body mesh, chosen by the user from a small fixed palette (see Section 10.3 for why the palette must not rely on color alone to be distinguishable).
- **"Hair/hat" color** — a second, independent material-color tint on the model's head-topper mesh, which is the same two-tone trick the reference image uses (body color ≠ topper color, so each persona reads as visually distinct at a glance).
- **An optional small accessory** — a backpack, a bag, or a simple icon — implemented as a second small shape attached to the model or a swapped texture, not a modeling system.
- **A floating name and status label**, shown above the head exactly as in the reference image (e.g., "Jordan — in class at CAS," "Jordan — eating at Warren Towers").

This keeps the customization promise real — what a user picks is visibly different on the map — while staying inside the "simple, easily reproducible" scope the team wants. Building this is two material-color swaps per agent, not a modeling pipeline, so it requires no 3D-authoring skill from anyone on the team.

---

## 8. Realtime backend and system architecture

### 8.1 Why one backend owns the live state
The team decided one server should hold the authoritative live state — the single current truth about where every agent is, right now. This avoids a common distributed-system bug: two clients disagreeing about an agent's position because each computed it independently. One source of truth is also the simplest model to build and debug under a tight deadline.

### 8.2 System diagram

```
 ┌────────────────────┐        ┌──────────────────────────────┐
 │  Python ML/Sim job  │──────▶ │   PostgreSQL (hosted on       │
 │  (runs ahead of time,│       │   Railway)                    │
 │  not live)           │       │   - schedules                 │
 │  - pulls OSM data     │       │   - the precomputed week      │
 │  - generates synthetic │      │   - prediction model output   │
 │    schedules           │      │   - personas, votes           │
 │  - runs crowd prediction│      └───────────────┬───────────────┘
 └────────────────────┘                           │
                                   ┌─────────────▼─────────────┐
                                   │  Node.js + TypeScript       │
                                   │  realtime server            │
                                   │  (hosted on Railway)         │
                                   │  - Socket.IO: live state      │
                                   │  - REST API: persona/vote      │
                                   │    submission                  │
                                   │  - Redis: pub/sub and agent     │
                                   │    position cache                │
                                   │  - the live simulation tick loop:│
                                   │    reads the precomputed week,   │
                                   │    applies live vote/event       │
                                   │    overrides                     │
                                   └─────┬───────────────┬───────────┘
                                         │               │
                          WebSocket (Socket.IO)   WebSocket + REST
                                         │               │
                             ┌───────────▼───────┐  ┌────▼─────────────┐
                             │ Big-screen 3D client│  │ Phone web app      │
                             │ React + Mapbox GL +  │  │ React (mobile)      │
                             │ deck.gl               │  │ - persona builder    │
                             │ - heatmap and dashboard│  │ - follow-your-agent   │
                             │ - scrub-through timeline│ │   view                 │
                             └──────────────────────┘  │ - voting UI             │
                                                        └────────────────────────┘
```

Background agents follow a cheap, precomputed, schedule-based path. Live persona joins and votes are injected at runtime by the Node.js realtime server, which is the single authoritative source of live state. This matches the hybrid approach the team chose during planning.

### 8.3 Why Node.js/Socket.IO for the live layer, and Python for the ML layer
Socket.IO, running on Node.js with TypeScript, is the standard tool for browser realtime broadcast at hackathon scale. It is well documented, and it handles reconnection and grouping clients into "rooms" without extra work. It also matches the team's existing comfort with JavaScript and TypeScript.

Python stays on the ML and data-pipeline side, because the team's scraping tools, `osmnx`, and `scikit-learn`/`Prophet` are strongest there. That work runs ahead of time, as a precompute job, not inside the live request path. The two languages never need to talk to each other in real time — they share state only through the PostgreSQL database.

### 8.4 Hosting
Railway, as the team decided, hosts both the Node.js realtime server and the PostgreSQL/Redis databases. As an operational safety net (not a feature cut), keep a local backup ready: the same Node.js server, run on a laptop, with phones joining through a shared personal hotspot, in case venue wifi makes Railway unreachable during the judging walk-through.

### 8.5 Display setup for the demo
The big-screen 3D view runs on a team laptop, connected by HDMI to whatever monitor or projector the venue provides. Test the actual laptop that will run the demo against an HDMI output well before judging — resolution and refresh-rate mismatches between a laptop and an unfamiliar external display are a common, avoidable failure mode.

---

## 9. Mobile web app (the QR-code entry point)

- No install, no account wall: scanning the QR code opens a mobile-responsive React page directly.
- **Step 1 — Persona builder.** The user enters a name, a schedule (a quick manual entry grid, since most attendees will not have a BU schedule to import — or an import option, for anyone who does), a home building, one or two preference questions (meal time, study spot), and an avatar color/accessory.
- **Step 2 — Confirmation and "Find me on the map."** The phone shows a simplified live view centered on the user's own agent, with a plain status line such as "Currently: in class at CAS."
- **Step 3 — Voting.** When a vote is open, the page switches to a single-tap ballot (weather or event options) with a live results bar.
- Build this mobile-first, in React, TypeScript, and Tailwind CSS. No native app — this keeps the "no install" promise and keeps the build simple.

---

## 10. Privacy, ethics, bias, and accessibility

The rubric scores this directly: Responsibility & Ethics is its own 10% line, and Design's 15% separately names accessibility. Treat every item below as something the pitch states out loud, not just something the code happens to do correctly.

### 10.1 Data provenance and consent
- The one real MyBU schedule used as a seed example belongs to a consenting team member. We do not scrape or use any other real BU student's private schedule data without their consent.
- The bulk student population is synthetic, built from public course-catalog data, not real individuals. State this plainly and early in the pitch. Naming this choice yourselves — as a deliberate privacy-preserving design decision — turns a limitation into evidence of responsible design, which is exactly what this rubric line rewards.
- For live phone personas, we store only the display name, avatar choice, and the schedule the user chooses to enter. We require no account and no contact information. State this on the persona-builder page itself, in one visible sentence — not only in this planning document.
- Give every user a visible "remove me" control on their own phone page, so they can delete their own data on the spot. This is small to build, and it directly answers a live "what happens to the data you just collected from this room" question.
- **Data retention after the event:** the team's decision is to keep persona data collected during the hackathon for possible future use in a post-hackathon demo or portfolio. Because of this, the persona-builder page must show a clear notice before submission — for example: "Your name, avatar, and schedule may be kept and shown in future demos of this project." This notice is required precisely because we are keeping the data; it is the minimum honest disclosure the Responsibility & Ethics criterion expects.

### 10.2 Bias and fairness
- The synthetic schedule generator can accidentally encode skewed assumptions — for example, over-representing certain majors or living patterns if the catalog sampling is not balanced. Document the sampling method and its known limitations in one slide or paragraph. Judges score reflection here, not a bias-free system, which does not exist after 27 hours of work.
- The crowd-prediction model (Section 5.3) trains on simulated data, not on observed real-world crowd counts. State plainly that its forecasts depend entirely on the behavioral assumptions built into the simulation (for example, "students go to the nearest dining hall at lunch"), and that checking the model against real foot-traffic data is explicit future work — not something the demo claims is already done.
- Persona-driven behavior is self-reported by whoever joins from their phone during the event. A room of hackathon attendees is not a representative sample of the BU student body. Say this directly, rather than implying the live room's behavior generalizes to the whole campus.

### 10.3 Accessibility
Accessibility is scored under both Technical Execution and Design, so treat it as a requirement, not a polish item.
- Mobile web app: use sufficient color contrast; give every avatar color a non-color way to tell it apart (so colorblind users are not blocked at the persona builder); use readable font sizes; use large tap targets on the voting buttons; label every form input with standard HTML and ARIA attributes, which needs no extra library.
- Big-screen 3D view: never show crowd level through color alone. Pair every color with a number or label — for example, "78% full" — so the data reads correctly for colorblind viewers, and still reads correctly in a screenshot used as a backup slide.
- Keep every voting and persona-building step usable with a plain tap and plain text entry. Avoid any gesture-only or drag-only control, because a demo audience is using unfamiliar phones quickly, often for the first time.
- None of this needs new tools. It is standard, correct HTML and CSS, applied on purpose from the start. Retrofitting it at hour 25 is far more expensive than building it in from hour 1.

---

## 11. Risk register and engineering safety nets

The team's direction is to build the full feature set and not decide in advance which feature to drop. This table lists the safety nets built in parallel, so that decision never has to happen live during judging.

| Risk | Safety net |
|---|---|
| Venue wifi fails during judging | A pre-tested local laptop-hotspot fallback server, ready to switch to in under a minute |
| The LLM API is slow or down during the demo | A template-built fallback description generates instantly if the LLM call does not return within about 1.5 seconds |
| The live simulation drifts or breaks mid-demo | The precomputed week always exists as the playback baseline. Live overrides (votes, personas) are additive, so disabling the live layer loses nothing of the underlying demo |
| More phones join than expected | Socket.IO rooms and basic rate limits on write actions (creating a persona, voting), plus Redis pub/sub, which scales broadcast cheaply even under a read-traffic spike |
| 25Live or dining data is not reachable in time | Public dining-hours pages and estimated capacities substitute directly, and nothing else in the pipeline depends on this data arriving |
| 500 agents cause frame drops on the demo laptop | Client-side position interpolation and a single instanced draw call (Section 6.4) absorb most of this. If it persists, lower the server's broadcast rate, not the agent count |

**Explicit team decision — no fallback video or static-screenshot backup for the live demo itself.** If the live system fails completely during judging, the team presents live or not at all. This is a deliberate, accepted risk, not an oversight — it is recorded here so the whole team knows the stakes and rehearses accordingly (Section 13 builds in two full rehearsal passes specifically because of this decision).

---

## 12. Project name

**Chosen name: Flowcast** — a blend of "flow" (how people move between buildings) and "forecast" (the core prediction the project delivers). It describes what the product does in one word, reads cleanly on a slide and in a URL, and avoids tying the brand to any single school or mascot, which keeps it usable if the idea is ever shown outside a BU-specific context.

An earlier naming pass considered BU/mascot-specific options first (TerrierTwin, PulseBU, DenCast, TerrierTrace) alongside more generic alternatives (CampusFlow, Hivemind@BU). The team moved away from the BU/Terrier-themed options in favor of a name tied to the product's function rather than its venue — Flowcast was the strongest result of that direction, alongside runner-up candidates Footfall (the real urban-planning term for measured pedestrian traffic), GroundTruth (a data-science pun on verified real-world reference data), and Haunts (informal for "the places someone frequents"). Keep these three in reserve in case the team wants a quick alternative during kickoff.

---

## 13. Hour-by-hour roadmap (Saturday 8:00 AM to Sunday 11:00 AM, 27 hours)

Heavier, more exacting tasks sit in daylight hours. Lighter, more mechanical tasks sit in the overnight block, when the team is more tired. Adjust clock times if the organizers publish a different kickoff time, but keep this ordering and these block lengths.

| Time block | Focus | Owners |
|---|---|---|
| Sat 8:00–9:00 AM | Kickoff: assign real names to roles, lock this plan as the scope, set up the shared repository, the Railway project, and the PostgreSQL/Redis instances | All |
| Sat 9:00–11:00 AM | Data Lead pulls the OSM campus bounding box (buildings and walkway graph) and starts the catalog scrape. Sim/ML Lead scaffolds the synthetic schedule generator. Backend Lead scaffolds the Node.js server, Socket.IO, and the database schema. Frontend Lead scaffolds the React app with Mapbox GL JS (Standard style) rendering the real campus outline, no agents yet. Mobile Lead scaffolds the phone web app shell and the QR-code flow. | All, in parallel |
| Sat 11:00 AM–2:00 PM | Data Lead delivers the walkway graph and the building list with capacities, even if some capacities are estimates. Sim Lead precomputes shortest paths between key locations and builds the finite-state agent behavior loop. | Data, Sim |
| Sat 2:00–5:00 PM | First end-to-end slice: a handful of hardcoded agents move along real precomputed paths, render as instanced shapes in the 3D client, and broadcast over Socket.IO. | Backend, Frontend, Sim |
| Sat 5:00–8:00 PM | Scale up to the full synthetic population (200–500 agents). Generate the full week's precomputed timeline. Start the crowd-prediction model: aggregate occupancy, fit the forecasting model. | Sim/ML, Data |
| Sat 8:00–11:00 PM | Build the prediction UI: the heatmap overlay, the side dashboard charts, click-to-inspect building stats, the scrub-through week timeline. | Frontend, Sim/ML |
| Sat 11:00 PM–Sun 2:00 AM | Mobile app: the persona builder works end to end — submit a persona, see it appear on the big map, see the live "follow me" view. Wire a submitted real schedule into the live simulation layer. | Mobile, Backend |
| Sun 2:00–5:00 AM | Voting system: the vote UI on the phone, live tallying, the winning option triggering both a visual effect and an agent-behavior change. Presenter-triggered manual event spawning. This block sits in the lowest-energy overnight hours on purpose — it is more mechanical and lower-risk than the data and simulation work. | Backend, Frontend, Mobile |
| Sun 5:00–7:00 AM | LLM persona-flavor integration, with its instant fallback (Section 5.4) in place from the start. Polish the avatar color/accessory picker. | Mobile, Backend |
| Sun 7:00–8:00 AM | Hard feature freeze. One full run-through of the live demo exactly as it will be presented, including a deliberate test of the wifi-fallback switch. | All |
| Sun 8:00–9:00 AM | Bug-fix buffer, for problems found in the run-through only — no new features past this point. | All |
| Sun 9:00–10:00 AM | Final rehearsal, with the real pitch script and a timer. | Pitch Lead drives; all support |
| Sun 10:00–11:00 AM | Judging and presentation window. | All |

---

## 14. How this plan maps to the judging rubric

Score the pitch script and demo flow against this table before the Sunday 7:00 AM feature freeze — it takes about fifteen minutes and catches gaps early.

| Criterion | Weight | What in this plan earns the score | What to say or show during judging |
|---|---|---|---|
| Problem | 20% | Sections 1 and 4 ground the project in a real, everyday campus problem — crowding and scheduling friction — using real BU locations and real-shaped data, not an invented scenario. | Open with one concrete, specific moment ("you show up at Warren Towers at 12:15 and it's slammed") before showing any technology. |
| Idea & Relevance | 25% | The prediction engine (Section 5.3) plus the "BU intelligence" framing (Section 1) gives two distinct beneficiaries from one dataset: students and the university itself. | State both audiences out loud: "this helps a student plan their day, and it helps BU plan its campus." |
| Technical Execution | 25% | Sections 5 through 8 describe a real ML forecasting layer, a real-time multi-client sync architecture, and a 3D rendering pipeline the team can actually finish in 27 hours. Every choice favors things that run live over things that only look good in a slide. The rubric rewards "working demos, not unrealistic deployment" directly — which is why Section 11's safety nets exist, and why the full-scope plan leans on configuration-driven libraries (Section 6.1) instead of custom engineering the team has never done before. | Demo everything live. Where something is precomputed ahead of time (the week-long prediction, Section 4.2), say so plainly instead of implying it runs live on the spot — stating "this part is precomputed, this part is live" reads as more credible, not less. |
| Design | 15% | Section 9 (the mobile flow), Section 6 (map and heatmap clarity), and Section 10.3 (accessibility). | Walk the judges through the phone flow yourself, on a real phone, not a screenshot. |
| Responsibility & Ethics | 10% | Section 10 in full: transparency about the synthetic population, consent for the one real schedule, the bias and fairness limits of the forecasting model, and accessibility. | Give this its own 20 to 30 seconds in the pitch, not only an answer to a question. Most teams skip this section entirely, which makes covering it well a real differentiator. |
| Presentation | 5% | Section 13's two rehearsal blocks (Sunday 7:00–8:00 AM and 9:00–10:00 AM). | Low weight, but a low floor too — two timed dry runs cover this criterion cheaply. |

**Why "build everything, cut nothing" still fits this rubric:** the rubric's own wording — "not unrealistic deployment" — rewards honestly scoped, fully working features over a longer list with weak spots. This plan reaches full scope by choosing low-risk, configuration-driven tools at every layer (Section 6.1, Section 8.3), so the complete feature list can actually run live, instead of by attempting custom engineering the team has not done before.

---

## 15. Open items to confirm at kickoff

- Confirm which team member's MyBU schedule is the real-data seed, and get their explicit agreement to use it in the public demo.
- ~~Confirm Mapbox versus MapLibre~~ — resolved in Section 6.1: use Mapbox GL JS. Its free tier (50,000 map loads/month, no card required) covers the event, and only Mapbox's proprietary "Standard" style gives the textured/lit buildings the team wants without custom modeling. Create the free Mapbox account and access token in Hour 0.
- Confirm the exact persona-data retention notice wording (Section 10.1) with the whole team before the first real persona is collected, since the team has already decided to keep this data after the event.
- Confirm the DS+X kickoff and judging time if the organizers publish anything more specific than "8:00 AM Saturday to 11:00 AM Sunday," and re-map Section 13's blocks if needed.
