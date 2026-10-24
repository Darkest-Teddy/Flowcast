# Flowcast: DS+X Hackathon Master Plan

Revision: 24 October 2026. This document integrates the supplied plan amendments and accompanying recommendations into the master plan. It specifies intended work; it does not certify that the application implements these contracts or meets the acceptance targets.

Event details carried forward from the original plan: DS+X at Boston University, run by BU Spark! and the Faculty of Computing & Data Sciences; Hack College track. Now entered in Hackachusetts (Civic Action track) as a four-person team. Planned working window: Saturday, 24 October 2026, 8:00 AM through Sunday, 25 October 2026, 11:00 AM, America/New_York, totaling 27 hours. Confirm the actual submission and judging deadlines with the organizers. Revision work does not restart this clock.

Numerical behavior settings are implementation defaults and assumptions. Performance figures are targets to measure on the presentation setup. Neither is evidence of validated BU foot traffic.

The judging weights recorded in the original plan are retained:

| Criterion | Weight | Planning emphasis |
| --- | --- | --- |
| Problem | 20% | A concrete campus crowding and scheduling need |
| Idea & Relevance | 25% | Useful scenario exploration for students and campus planners |
| Technical Execution | 25% | A stable, accessible, working demonstration |
| Design | 15% | Clear navigation, visual consistency, and usable controls |
| Responsibility & Ethics | 10% | Consent, provenance, transparency, and limitations |
| Presentation | 5% | A clear pitch and rehearsed interaction |

## 1. What we are building

Flowcast is a live, browser-based 3D campus simulation. Student agents follow schedules and travel along the BU pedestrian network between classes, dining halls, libraries, dorms, study spaces, and the gym. A representative Monday-to-Sunday week supports playback and time selection.

The product helps people explore where crowding may occur and how a scenario redistributes demand. Accepted activity and travel plans drive the moving agents, occupancy curves, arrivals, departures, and flows. A separate paired simulation analysis shows how results vary across stated behavioral assumptions. These are model-derived projections; measured real-world accuracy is future work.

Audience members scan a QR code, choose a name and avatar, start from a synthetic schedule preset or enter their own schedule, and watch their agent join the same simulation. They vote on events that change future plans and the matching charts. Presenters can also trigger events directly.

The first complete demonstration is lunchtime: two phones join and vote to close a dining hall; affected students redirect to another reachable dining destination; the map and occupancy/arrival charts show the same accepted change.

## 2. Team, ownership, and stack

Assign real names at adoption. Prefer simple geometry and shared contracts given the team's limited 3D experience.

| Role | Owns | Main tools |
| --- | --- | --- |
| Data & Schedules lead | Location registry, pedestrian graph, schedule/source mapping, route preparation, provenance, fixture expansion | Python, OSMnx, NetworkX, pandas, source-specific extraction tools |
| Simulation & Backend lead | Shared TypeScript planner, aggregation, event semantics, deterministic choices, paired analysis; authority, command queue, persistence, REST/socket contracts, deployment, recovery | TypeScript, `@flowcast/sim-core`, Node.js, Express, Socket.IO, PostgreSQL, `pg`, Zod, Python |
| Map/Frontend lead | Campus composition, multipart avatars, movement, selection, five interiors | React, TypeScript, Mapbox GL JS, deck.gl |
| Mobile/Product & Pitch lead | Fast join, schedule editing/import, own-agent view, voting/removal, charts, accessibility, pitch | React, TypeScript, Tailwind CSS |

The team has four people, one per role. The Simulation & Backend lead owns both behavior and the server contracts, so the backend calls the shared core rather than maintaining a second planner. Map and Mobile share one web application. Once the bundle is stable, Data assists with scenario evidence, fixture checks, and interior layout data. Name a scope decision owner, pitch speaker, and demo operator.

### 2.1 Concrete stack


- Web: React, TypeScript, Vite, Tailwind CSS, Mapbox GL JS, deck.gl.
- Server: Node.js, TypeScript, Express, Socket.IO, PostgreSQL using the pg client.
- Shared validation: Zod schemas in a contracts package.
- Preparation/analysis: Python, OSMnx, NetworkX, pandas; requests/BeautifulSoup where required by the actual source.
- Optional analysis: scikit-learn for a separately specified experiment.
- Hosting: one Railway application replica plus PostgreSQL.
- Local mode: the same Node build plus a prepared local PostgreSQL container.
- Exclude from required dependencies: Redis, Prophet, Threebox, a second Three.js renderer, InstancedMesh2, and a live Python API.

Pin compatible stable package versions after the first build and rendering check. All deck packages must use one matching version. Commit the lockfile; do not independently force a luma upgrade or introduce a new rendering dependency during the freeze.

## 3. Product scope

### 3.1 Campus and population

Use real BU building footprints and pedestrian paths from OpenStreetMap, with available height metadata. Supported destinations have stable IDs, reachable entrances, operating hours, and provenance. Capacity can be published, estimated with a stated basis, or unknown.

The integration fixture has 12 connected buildings, 50 agents, at least two dining destinations, and an outdoor assembly location. Expand to the intended campus coverage and a baseline of 500 modeled students, including a consented real example if available. Live personas add to that population. Drawing limits do not reduce the modeled population.

### 3.2 Required views and interactions

- A campus map with moving/selectable agents and a crowd-density overlay.
- A full-week timeline, pause and speed controls, day selection, and presenter controls.
- A dashboard with occupancy curves, peaks, capacity comparisons where supported, arrivals/departures, and inter-building flows.
- Click-to-inspect building statistics, tied to the same building IDs as schedules and the map.
- Five schematic interior templates: dining, library/study, classroom, dorm common room, and gym.
- Independent clothing/hat customization, a live own-agent phone view, schedule editing/import, and removal.
- Live audience voting and presenter-triggered events across the complete catalog in Section 5.6.
- Paired scenario analysis and an evidence panel explaining changes and sensitivity.
- Interactive cloud deployment and a tested cold local deployment using the same Node build and PostgreSQL implementation.

Visual weather effects can accompany events after behavioral changes work. Decorative effects never substitute for changed plans and charts. Kenney animation, LLM flavor text, detailed facades, and holographic styling are optional upgrades after required integration gates.

### 3.3 Product routes

Use `/display` for the big screen, `/present` for authorized controls, and `/join` for the run-specific phone entry. The QR carries run identity. Keep phone forms and voting usable without loading the full 3D presentation bundle. Serve web, API, and sockets from one origin.

## 4. Data sources, package boundaries, and pipeline

| Source | Use | Constraint |
| --- | --- | --- |
| Consented team member's MyBU export | A labeled real schedule example | Optional if unavailable; explicit public-demo consent required |
| Public BU course meeting information | Normalize schedule templates and synthetic population inputs | Verify that the selected source actually provides meeting times and supported locations |
| 25Live and public dining pages | Hours, room/event metadata, and published capacity where accessible | Record provenance; label estimates and missing values |
| OpenStreetMap | Footprints, height metadata, and pedestrian graph | Check coverage/connectivity and preserve source attribution |
| Live persona submissions | Participant-selected schedule and preferences | Private inputs, anonymous ownership, retention notice, removal |

Python extracts and normalizes data. Synthetic enrollment assumptions should document major/year sampling, conflict handling, and coverage. Public course information does not establish observed enrollment or crowd counts; describe the resulting population as synthetic rather than empirically calibrated without evidence.

The pipeline runs in this order:

1. Verify the BU extraction area. If a named-place boundary is unsuitable, use an explicit central-campus bounding box.
2. Extract footprints, entrances, and the pedestrian graph; resolve aliases and operating hours into the registry.
3. Normalize available public meeting data and the consented example. Record unresolved locations for correction.
4. Prepare synthetic agent specifications, schedule templates, route-cache inputs, assumptions, and provenance.
5. Publish and validate the versioned campus bundle.
6. Invoke the shared TypeScript `buildBaseline` command to generate the representative week's interval plans.
7. Derive occupancy and semantic flow outputs from those plans; load the same bundle and planner in the live server.

### 4.1 Package boundaries and target layout

This is the target repository layout. The current `map-client` and `mobile` code should be consolidated into `web` during implementation, reusing working components. This plan rewrite does not perform that migration.

| Location | Responsibility | Owner |
| --- | --- | --- |
| packages/contracts (`@flowcast/contracts`) | Runtime validation, shared IDs, command/update schemas | Simulation & Backend |
| packages/sim-core (`@flowcast/sim-core`) | Planner, routes, events, position evaluation, aggregation, comparisons | Simulation & Backend |
| server | HTTP/socket handlers, authority, command queue, persistence, deployment | Simulation & Backend |
| web | Display, presenter, and phone routes with separate rendering bundles | Map + Mobile/Product |
| data-pipeline | Python extraction, normalization, route preparation, provenance | Data |
| data/campus-v1 | Versioned public and private input artifacts | Data + Simulation |

Use one web application with /display, /present, and /join routes. Keep the phone route from eagerly loading the presentation's full rendering code. Serve the web build, API, and socket endpoint from one origin.

### 4.2 Versioned campus bundle

The manifest records schemaVersion, datasetVersion, coordinate conventions, time conventions, generation seed, routing-policy version, provenance, and the expected files.

Validate the schema and dataset identity at startup. Resume a retained run only with its matching bundle; if that bundle is unavailable, report the mismatch and require a fresh run instead of silently mixing building IDs or plans from different datasets.

Public assets:

- Building footprints and display metadata.
- Pedestrian graph geometry and supported outdoor assembly locations.
- Reusable route geometry.
- Avatar catalog and mesh assets.

Server-only inputs:

- Normalized schedules, synthetic population specifications, the consented example, and full baseline plans.
- Private persona definitions and complete imported timetables.

Do not place the entire data directory under the web server's static-file root.

The first fixture contains 12 connected buildings spanning dorm, teaching, dining, library, and gym categories, at least two alternative dining destinations, an assembly location, and 50 agents. This is an integration fixture; expand it to the intended campus coverage afterward.

For every supported destination, require a stable buildingId/locationId, source aliases, footprint or marker, graph-connected entrance, category, operating hours, and provenance. Capacity may be estimated but must include its basis and an estimated flag. Unknown capacity must not silently become an authoritative crowding percentage.

Only publish destinations that the planner can reach. Unresolved imported locations remain visible for user correction.

## 5. Simulation, live changes, and scenario analysis

### 5.1 One behavioral implementation

Python produces geometry, the pedestrian graph, normalized schedule templates, agent inputs, and analysis datasets. The baseline-generation command and live Node server import the same TypeScript package. That package generates the baseline week and handles new personas, edits, deletions, and scenario events. There is one behavioral implementation.

Do not make minute-by-minute positions the canonical dataset. Use these records:

| Record | Required fields |
| --- | --- |
| Location | Stable ID, kind, source aliases, entrance/graph node, hours, capacity metadata, interior template if applicable |
| Route | ID, ordered edges, geometry, cumulative distance in meters, routing-policy key |
| Fixed schedule anchor | Stable activity ID, location ID, activity, startSec, endSec |
| Agent specification | ID, source label, home location, fixed anchors, preferences, semantic avatar choices |
| Trip | Stable trip ID, agent ID, origin location, intended/actual destination, semantic departure and arrival |
| Travel segment | Agent ID, trip ID, route ID, startSec, endSec, fromMeters, toMeters |
| Stay segment | Agent ID, location ID, activity, startSec, endSec |
| Scenario event | ID, family, parameters, startSec, endSec, source ballot/presenter command |
| Run state | Dataset version, seed, week mode, epoch, scenario revision, clock anchor, active agents and plans |

Intervals are half open: [startSec, endSec). Every active agent occupies exactly one segment. Assembly locations are outdoor locations, not artificial buildings.

Partial route offsets are required: a speed change or mid-route reroute must preserve current position without pretending the agent restarted the full route.

Multiple travel segments may belong to one trip. Count departure when the agent leaves a location, arrival when it enters its actual destination, and origin-destination flow once at completed arrival. Splitting or retiming a segment creates none of these events. A reroute changes the unresolved destination while preserving the original departure; it does not invent a trip originating at a junction. Inter-building flow excludes trips returning to the same building.

### 5.2 Core operations

The package must expose the following contracts; these are names and responsibilities to implement, not existing runnable APIs.

| Operation | Responsibility |
| --- | --- |
| buildBaseline | Produce the representative week from bundle, population, seed, and week mode |
| evaluateAgent | Evaluate location, activity, heading, and progress at a simulation time |
| stageMutation | Produce proposed plan replacements and exact aggregate changes from a frozen run snapshot and an authorized command |
| aggregateOccupancy | Compute instantaneous counts or explicitly requested mean-occupancy bins |
| aggregateFlows | Count semantic departures, arrivals, and completed trips; never count a route split as a new trip |
| rebuildForSeek | Rebuild a fresh scenario epoch at the selected week time |
| compareScenarios | Run paired future scenarios from one saved initial state using specified replicate seeds |

The core contains no HTTP handlers, socket subscriptions, database calls, or credential logic.

### 5.3 Time and behavior defaults

- Time: seconds from Monday 00:00 of a representative seven-day week; range 0-604800.
- UI: campus weekday/time labels, independent of the viewer's device timezone.
- Initial presentation time: Monday 11:30.
- Playback: 60× by default; 1×, 10×, 60×, 300×, and pause.
- At the end of the week, pause. Restart begins a new epoch.
- Advance from monotonic elapsed time; do not assume timer callbacks occurred exactly on schedule.
- Base walking speed: 1.4 m/s as a labeled simulation assumption.
- Discretionary timing jitter: up to ±10 minutes.
- Fixed classes retain their entered start/end times.

Reject overlapping fixed schedule anchors. Include travel time when scheduling optional activities. Impossible travel produces a late arrival or missed activity; it never produces an unexplained speed increase or teleport.

Priority is: evacuation/access restrictions, fixed schedule anchors, optional event attendance, discretionary meals/study/gym, home.

Capacity is initially a comparison metric. Do not clamp occupancy to capacity or report queue waits without separately implementing admission and service rules.

### 5.4 Routes and deterministic choices

Precomputed routes are a cache. Ship the graph so sim-core can compute and cache a missing route, including one beginning at a junction during an existing trip. Cache keys include origin, destination, and routing-policy identity. Route preferences may use only graph attributes actually available.

When a route cannot be found, keep the agent at a valid location and expose the data problem. There is no straight-line fallback.

Use stable random choices keyed by runSeed, agentId, activityId, choiceName, and replicateId; add eventId for an event-specific choice. A global revision or iteration-order RNG must not reshuffle unrelated students after a new participant joins.

### 5.5 Accepted changes replace future plans

At an event's effective simulation time:

1. Freeze the authoritative clock anchor and evaluate affected agents.
2. Preserve executed plan prefixes.
3. Replace future segments from that exact state.
4. Subtract replaced future occupancy/flow contributions and add the replacements.
5. Commit the scenario, changed plans, and durable command result.
6. Publish one accepted scenario revision and resume the clock from the held time.

For a walking agent, retain a valid continuation to the next junction before taking a new route. A speed change retimes remaining distance from the current position. Include newly generated route geometry with a patch before the client needs to evaluate it.

For an indoor agent, exterior movement starts at the recorded entrance. The schematic interior does not establish a measured indoor exit time.

Known event end times are included in the future plans. At expiry, the agent proceeds from its actual location to its next feasible activity. It never jumps to the coordinate stored in an old baseline.

### 5.6 Event catalog and rule families

| Family | Preserved catalog | Rule | Default duration |
| --- | --- | --- | --- |
| Weather | Clear, rain, snow, heatwave | One weather regime modifies walking and discretionary indoor/outdoor preferences; clear removes the modifier | 120 simulated minutes |
| Gathering | Career fair, sports game, club fair, concert | Venue, time window, and configurable attendance probability attract eligible agents in free time | 120 simulated minutes |
| Access restriction | Dining closure, evacuation drill | Close destinations; redirect meals; send current drill occupants to a configured assembly point | Closure 120 minutes; drill 30 minutes |
| Week mode | Normal, move-in, finals | Change synthetic schedule/discretionary assumptions and rebuild the epoch | Whole representative week |

Duration and effect strengths are presenter-configurable scenario assumptions. Initial gathering attendance probability is 25% of eligible agents, explicitly a tunable assumption. Do not invent a relocation for a canceled fixed class; mark it unavailable and select a feasible optional activity or wait.

Weather is an independent modifier. Access restrictions override gathering attendance. Optional gatherings use stable preferences and deterministic ties. Week-mode changes preserve submitted fixed anchors unless the participant edits them.

Weather effects adjust travel speed and discretionary choices; they do not remove necessary outdoor trips. Rain favors direct trips and indoor discretionary destinations, snow slows walking and reduces outdoor lingering, and heatwave reduces midday outdoor stays. Clear restores the unmodified regime. Apply covered-route preferences only when the graph contains that attribute. Gathering venues may include a student union/gym for a career fair, a supported sports venue for a game, an outdoor location for a club fair, or a performance venue for a concert. Validate actual supported destinations rather than inventing unreachable venues. Finals mode emphasizes later library use; move-in changes synthetic assumptions while preserving participants' fixed anchors.

### 5.7 Persona lifecycle

- Join: generate a valid schedule with the same core; activate at a plausible state at the current time. Do not retroactively add the new person to earlier counts in the current epoch.
- Edit: preserve current location and executed prefix, then replace future plans.
- Delete: remove the persona from current/future plans and retained identifiable records. Discard saved comparisons, queued work, and published analysis containing its identifiable definition or future plan. Resume analysis from the remaining population; do not generate a deletion-effect comparison.
- Seek/day change: increment epoch, clear transient events and the current ballot, preserve confirmed personas/seed/week mode, rebuild from the week start, and evaluate at the target time.
- A seek deliberately begins a fresh scenario with retained personas included in the rebuilt week. It does not replay the previous audience session.
- Pause and speed change preserve the scenario.
- Place "Changing time resets current events and voting" beside seek/day controls. Changing week mode uses the same reset behavior: clear transient events and the current ballot, preserve confirmed personas and seed, and rebuild with the selected mode. Pause and rate changes preserve the current ballot as well as plans/events.

### 5.8 Required live projection

Compute the remaining week's projected occupancy from accepted plans. Show:

- Current instantaneous building occupancy.
- A full-week curve of mean occupancy in 15-minute intervals.
- Arrivals/departures and inter-location flows.
- Peak occupancy and peak timing.
- Estimated capacity comparisons where a stated capacity exists.

Mean occupancy in a bin equals the sum of each stay's overlap seconds divided by the bin duration. It is not the same quantity as the instantaneous current count; label both.

For an event/edit/join comparison, save the state immediately before the change and compare with the accepted scenario using the same starting state and shared random choices. Label the comparison "Before this change" and "Current scenario," including the population difference when the change was a join. Deletion is an exception: clear any affected comparison and begin subsequent analysis using only the remaining population.

The baseline week remains available for reference, but it must identify its population and mode. Do not label an old baseline containing fewer participants as a controlled estimate of an event's effect.

### 5.9 Paired scenario analysis

Use the same sim-core to run 20 paired future rollouts for selected buildings over the two simulated hours following the saved comparison origin. Capture that origin at initial startup or an accepted event/edit/join. Clip the horizon at the week end. Building selection can request results from that same comparison context while its horizon remains relevant.

- Start every pair from the same saved authoritative state.
- Use the same replicate choices in reference and treatment.
- Vary only future assumptions; do not resample completed history.
- Show mean occupancy and the empirical 10th-90th percentile range.
- Label the band "range across simulated behaviors."
- Record originSimTime, horizon, replicate count, runId, epoch, scenarioRevision, and requestId.

Run this work in one worker thread within the Node service. Keep only the newest queued request, supersede stale work, and never hold the command queue for analysis. Publish only results matching the current run/epoch/scenario revision and requested comparison.

An old band is marked updating or hidden after a mutation. Keep its origin time visible; hide it when playback passes its horizon, and reject a result whose horizon has already elapsed. A new accepted change starts a new comparison. The direct full-week plan-derived curve remains available throughout. A three-second completion target is proposed and must be measured; a slow analysis must not delay an accepted vote.

### 5.10 Data-science evidence panel

The Simulation & Backend lead supplies a compact evidence panel with:

- Baseline and changed occupancy curves.
- Peak occupancy/peak-time change.
- Arrival/departure or flow redistribution.
- Sensitivity across the stated assumptions.
- Provenance and synthetic-population labels.

Remove Prophet from required dependencies. Keep scikit-learn only for a separate defined question, such as approximating simulator outputs on held-out scenario runs. Such a model must have a comparison baseline and error report; it does not replace the live TypeScript projection without an explicitly tested serving path.

No result is described as validated real BU foot-traffic accuracy.

### 5.11 Optional persona descriptions

An optional LLM call may produce a short persona description from non-sensitive, deliberately supplied flavor inputs. Keep credentials server-side and exclude private timetables. Give the call a 1.5-second budget with a deterministic template fallback. Joining, movement, votes, and projections never depend on a successful model response. Do not place an LLM on the simulation tick path.

## 6. Campus rendering and interiors

### 6.1 Campus composition

Use Mapbox GL JS Standard and deck.gl MapboxOverlay with interleaved mode, Mercator projection, and terrain disabled. Start agents/ground density in Standard's middle slot, then verify building occlusion at the actual BU camera. Use a separately tested placement for labels.

Own the building registry and selection layer. Include visible named selection markers so tall-roof versus ground-footprint hit testing does not block selection. Every chart and interior opens by the same application buildingId.

Detailed facades are optional; their absence does not block the campus demo.

Use available map building geometry and application footprints without assuming detailed facade coverage. Preserve attribution on bundled geometry. Verify the actual presentation camera, selection behavior, and HDMI/projector output on the demo laptop.

### 6.2 Population and display budgets

The baseline contains 500 modeled agents, including the consented example if available. Every accepted live persona adds to the modeled population.

The main display renders at most 500 avatars. Selected and recently joined participants take priority, followed by other participants and a stable sample of background agents. If participants alone exceed the display budget, selection/recent-join priority and stable sampling still apply; every phone retains its own view.

Hidden agents remain in occupancy and flow calculations. Displayed-character count and modeled-population count are separate values.

Show the selected agent's label plus at most 24 other prioritized labels. Refresh density every five real seconds and after accepted scenario changes, using matching scenario data. Never draw an old event's heatmap as the new scenario.

### 6.3 Five schematic interiors

Use one separate deck canvas with OrbitView and local coordinates. Provide data-defined furniture layouts for dining, library, classroom, dorm common room, and gym.

Supply current occupant IDs from the same run state. Assign schematic positions deterministically so seats do not reshuffle on every update. Show at most 100 occupant figures and the full numeric occupancy; selected participants receive priority.

Label rooms schematic. Suspend unnecessary background-map rendering while the room is open, but keep the simulation running. Return to the current campus time and state. Holographic styling is polish after this flow passes.

These layouts show the simulation's occupants and activities, not measured rooms or architectural floor plans. The mobile building view may use the same IDs and schematic data while retaining a lightweight default 2D map.

## 7. Avatar and persona customization

### 7.1 Committed multipart implementation

Use untextured instanced parts: clothing/body, head, hat, and optional backpack.

Initial editor choices:

- Four clothing colors.
- Four hat colors.
- Two hat shapes.
- Six head/skin presets.
- Backpack on/off.

Store semantic IDs, not renderer-specific material objects. Share each agent's position, heading, scale, and bobbing offset across parts. Use route-aligned orientation and subtle bobbing only while walking.

Each geometry type uses SimpleMeshLayer; color choices are per instance. The two hat shapes may use separate batches. Continuous motion is keyed by stable agent ID and evaluated outside ordinary React component state updates.

Use the simple peg-doll visual direction from the original plan: a body, head, distinct topper, optional backpack, and selected name/activity label. Named palettes, hat shapes, and text identifiers provide alternatives to color alone. The display label budget in Section 6.2 applies even when every agent has a name.

### 7.2 Optional Kenney upgrade gate

Only after the complete phone/vote/forecast fixture works, allow a 45-minute animation spike:

- Load one Kenney GLB with its external Textures/colormap.png.
- Play a named walking clip with the locked dependencies.
- Preserve independent clothing and hat choices for two agents.
- Show correct stationary/moving state and avatar edits.
- Add/delete an agent without moving or recoloring an existing one.

If the gate fails, retain the completed multipart renderer. No separate Threebox/Three.js/InstancedMesh2 integration or unrestricted palette-baking project enters the required build.

## 8. Authoritative backend and persistence

Deploy one authoritative Node process with one replica. Redis is removed.

### REST surface

| Endpoint | Contract |
| --- | --- |
| GET /api/catalog | Public run metadata, supported locations, avatar options, schedule-import template |
| POST /api/session | Create/resume anonymous ownership for the selected run |
| POST /api/personas | Create the caller's persona |
| PATCH /api/personas/me | Update the caller's persona |
| DELETE /api/personas/me | Remove the caller's persona and retained identifiable definition |
| POST /api/ballots/:id/vote | Submit or replace the caller's choice |
| POST /api/presenter/commands | Authorized playback, ballot, event, and week-mode commands |

Use runtime schemas. Mutations carry an idempotency key and relevant run/epoch/ballot identity. Do not require an unchanged global scenario revision for every unrelated participant's vote or join; serialize them against the latest accepted state. Use a persona version for conflicting edits of the same persona.

REST is the only mutation path. Socket handlers subscribe and publish updates; they do not implement an independent persona, vote, or presenter-command handler.

### Commit before publishing

One in-process queue orders mutations:

1. At HTTP ingress, stamp receipt time and reserve the request's FIFO position before asynchronous work; then authenticate, validate, and identify duplicates. Invalid requests are rejected without a state change.
2. At the queue head, recheck current epoch and relevant entity state.
3. Stage the proposed change from the current authoritative state.
4. Commit durable state and command result in one PostgreSQL transaction.
5. Swap in the accepted in-memory state.
6. Broadcast the accepted update and acknowledge success.

For a plan-changing mutation, broadcast a temporary clock hold before asynchronous staging/commit, then resume from the held simulation time. On failure, resume the old state and return an error. Show an applying indicator if the hold lasts over 250 ms. Analysis jobs are outside this transaction and queue.

A database failure cannot produce an apparently accepted but unpersisted mutation. Existing playback can continue while new mutations report unavailable.

### Separate state versions

- runId identifies a session.
- epoch identifies a playback discontinuity/rebuild.
- scenarioRevision changes only when plans/population/scenario meaning changes.
- clockSeq orders pause, rate, and clock-anchor corrections.
- ballotVersion orders ballot/tally changes.
- Motion updates have a sequence and current simulation timestamp.

A raw vote tally update does not invalidate unchanged movement plans or an otherwise valid analysis job. The winning event does.

### Socket messages and update defaults

| Message or stream | Recipient | Rule |
| --- | --- | --- |
| session.snapshot | Authorized subscription | Complete snapshot on connect, reconnect, seek, and recovery |
| world.patch | Display; relevant subset to phones | Accepted plan/scenario change with new route geometry |
| clock.sync / clock.hold | Connected views | Authoritative time anchor, rate, clock sequence |
| agents.update | Display | Up to 4 Hz; current motion state and sufficient next-leg information |
| persona.update | Owning phone | Up to 2 Hz and immediately for accepted edits/activity changes |
| ballot.update | Participants/display | On change, coalesced to at most 4 Hz |
| forecast.update | Display/selected phone panels | Matching exact projection or separately identified analysis result |

Public updates contain display identity, visible avatar/activity/location data, and motion segments needed for playback. They do not expose the participant's full private timetable or the whole baseline week.

Server-side ownership selects private rooms. On an unknown epoch or incompatible state, request a new snapshot. Discard old-epoch packets and obsolete analysis.

### Durable data

Use PostgreSQL for participants, personas, runs, agent_plan_overrides, ballots, votes, and command_results.

Store accepted changed itineraries as interval records, not per-frame positions. Keep the immutable baseline in the shipped bundle. Its identity includes datasetVersion, seed, and weekMode. Store event definitions and clock checkpoints. Persist the ordered edge IDs or complete definition of newly generated routes in the same transaction as plan overrides referencing them; reconstruct those routes before evaluating restored plans.

Checkpoint the clock every five real seconds and during world-changing commands. Checkpoints use the same mutation queue and include epoch, scenarioRevision, clockSeq, rate, paused state, and the simulation-time anchor. Do not let an older asynchronous checkpoint overwrite a later pause, rate change, or scenario mutation.

After a server restart, restore the dataset and accepted overrides at the latest saved simulation time, increment epoch to invalidate old streams, start paused, and visibly cancel any unfinished ballot. Before accepting connections, transactionally save that new epoch, paused anchor, restored scenario state/overrides, and canceled ballot status. Restart preserves scenario plans/events; seek resets transient events. Derive active/expired status from event intervals and restored simulation time, never wall-clock expiry timers. The presenter resumes; downtime is not silently added to simulated time.

Keep idempotency records free of historical copies of private schedules/names. After deletion, retain only a minimal tombstone if necessary to stop an old retry from recreating the persona.

### System boundary

```text
Python preparation -> versioned campus bundle -> shared TypeScript sim-core
                                                   |              |
                                       baseline-generation CLI    |
                                                                  v
React /display, /present, /join <--- REST + Socket.IO ---> one Node service
                                                                  |
                                                           PostgreSQL

Node service -> one analysis worker importing the same sim-core
```

The deployed server serves the web build and owns live state. PostgreSQL is durable authority for accepted changes; memory holds evaluated state and the current clock. The worker computes comparisons independently and returns versioned results. Python has no live API or realtime database handoff responsibility.

## 9. Phone interaction and audience voting

### Fast phone flow

1. Open the run-specific QR URL.
2. Enter a display name and choose avatar options.
3. Start with a clearly labeled synthetic schedule preset; optionally edit manually or import CSV.
4. Review the data/retention notice and confirm.
5. See own live location, activity, and the current ballot.

The CSV import format is weekday, start, end, buildingId, activity. Provide a template and a location-mapping preview. Reject overlapping anchors and unresolved destinations; do not silently guess. Importing a private university portal is not part of this phone flow.

Keep name length and schedule size bounded by the shared schema. Suggested initial limits are 32 characters for the public display name and 50 weekly fixed anchors.

Use an anonymous opaque session token, with server-enforced ownership, and a distinct presenter credential. No account wall is required. Preserve the planned notice about future retention and the removal control. Do not broadcast private source schedules.

The phone's default map is 2D and follows its own marker. Provide recentering after a pan. Forms, activity text, voting, and removal remain usable if the remote map fails.

### Vote rules

- Only one ballot may be open or closing per run; each contains three or four configured options.
- Thirty real seconds per ballot.
- One current choice per participant session per ballot.
- A participant can change that choice before the deadline.
- The server receipt timestamp reserved with the FIFO position at HTTP ingress determines timeliness.
- The deadline timer appends closure to that same queue, after previously received requests; valid timely votes are processed before closure. Requests stamped at or after the deadline are rejected.
- Late requests are rejected even if the close timer was delayed.
- A duplicate command returns its stored result.
- Zero votes means no event.
- Ties use displayed option order; state that rule in the ballot UI.
- Ballot closure, winner, resulting event, and plan changes commit together.
- The event begins at the simulation time at which it is accepted.
- A seek cancels the current vote; a stale buffered vote cannot enter a different round.

This is one vote per participant session, not proof of one vote per unique person.

After confirmation, offer a clear "Find me" action and live status text such as "In class at CAS." Keep optional habit/home controls simple and bounded by the shared schema. The participant can edit their own persona or remove it through the same ownership session. Public activity display does not grant access to the underlying private timetable.

## 10. Privacy, ethics, bias, and accessibility

### 10.1 Consent, retention, and ownership

Use the real team-member schedule only with explicit consent. Most agents are synthetic. Audience participants supply only a public display name, avatar selections, chosen schedule, home/preferences, and retention choice; no email address or account is required. The anonymous session token establishes ownership, not verified identity.

Retain the original decision to keep consented participant data for possible future demos or portfolio use. Show the notice before confirmation and record the accepted notice/retention choice. Suggested wording: "Your display name, avatar, and submitted schedule may be retained for future demos. Your name, avatar, and current activity may appear publicly. Your full timetable is private. Use Remove me to delete your persona." Finalize the wording and intended use before collecting real submissions.

A visible "Remove me" control deletes the retained identifiable definition and current/future contribution. Apply the deletion and analysis cleanup rules in Section 5.7, including comparison snapshots, queued work, and published analysis that contains the deleted definition or plan. Do not retain private schedules or names inside historical command responses. Historical non-identifying aggregate counts may remain only where they no longer identify the participant.

Publish only public geometry, display metadata, and bounded live display state. Never expose the full server data directory, imported schedules, or private baseline population through static assets, public socket rooms, logs, or optional model prompts. A phone receives only its authorized private state and relevant public panels. Presenter authority is separate from participant ownership.

### 10.2 Limits and fairness

Document synthetic schedule sampling and behavioral assumptions, including who is underrepresented and which locations are missing. Hackathon attendees are not a representative sample of BU students. Model results depend on those inputs and the simulated behavior rules; comparisons do not prove an event's real-world causal impact.

Show provenance, synthetic-population labels, population counts, week mode, capacity estimates, and scenario identity. A percentile range across simulated behaviors is not a confidence interval for actual BU traffic. Collecting measured foot-traffic data and evaluating accuracy is future work.

### 10.3 Accessibility

Provide readable text, sufficient contrast, labeled inputs, keyboard focus, large voting targets, and text equivalents for crowding and avatar choices. Do not rely on color, dragging, or map gestures for an essential action. Offer pause/reduced-motion behavior for viewers and expose building statistics in text alongside graphics.

The phone must support joining, status, voting, and removal when its remote map fails. Give validation errors next to the relevant schedule row, retain user input, and provide a clear correction path for unresolved locations and overlaps.

## 11. Reliability and local recovery

Cloud: one Railway Node service and PostgreSQL.

Local: prepare a PostgreSQL container and the same built Node application on the presentation laptop. Confirm the container runtime works and pull/cache its image before relying on disconnected recovery.

Package JS/CSS, local fonts, avatar geometry/textures, campus footprints, paths, routing graph, the baseline bundle, database migrations, and local configuration.

Provide a standalone deck campus view using the exported geometry when Mapbox content is unavailable. The fallback remains interactive and supports moving agents, charts, interiors, personas, and votes. It does not depend on cached remote tiles or a static video.

Local fallback starts a fresh run from the bundled baseline. It does not automatically merge the cloud's active votes or browser sessions. Publish a new LAN QR and let participants join that run.

The server binds to a reachable network interface, and the QR uses the laptop's LAN address rather than localhost. Test the actual hotspot/router with two phones.

Optional LLM descriptions have a 1.5-second budget and a deterministic template. Joining never waits for a successful model response.

### Risk register

| Risk | Required response |
| --- | --- |
| Venue/cloud access fails | Cold local Node + PostgreSQL startup, bundled geometry, fresh LAN QR, two-phone test |
| Mapbox content is unavailable | Standalone deck campus view; forms, voting, and charts remain interactive |
| Database transaction fails | Keep the accepted world intact; return unavailable for new mutations; never publish an uncommitted change |
| Process restarts | Restore retained plans and routes at the saved checkpoint, commit recovery state, start paused, cancel unfinished ballot |
| Campus bundle does not match retained run | Report the mismatch and require a compatible bundle or explicit fresh run |
| Crowd data sources are missing | Use stated synthetic assumptions and labeled capacity estimates or unknown values |
| Rendering slows | Respect avatar/label budgets, interpolate by stable ID, suspend hidden views, profile the complete scene; keep all agents in calculations |
| More audience clients connect | Use authorized subscriptions, bounded schemas, write rate limits, and measured load targets; do not introduce Redis or multiple replicas |
| Analysis runs slowly | Keep only newest queued work, hide stale bands, continue direct projections and command processing |
| Optional LLM/animation fails | Use template descriptions and the completed multipart renderer |

Preserve the team's decision to demonstrate an interactive live system rather than use a prerecorded video or static screenshot as a substitute. A recording required by submission rules is a separate deliverable. Rehearse the local switch and a concise explanation of any visible interruption. Measure recovery time before promising a switching duration.

## 12. Project name

Flowcast combines flow, how people move, with forecast, the scenario projection. It remains the chosen name and does not tie the project to one school's mascot.

Earlier candidates were TerrierTwin, PulseBU, DenCast, TerrierTrace, CampusFlow, and Hivemind@BU. Footfall, GroundTruth, and Haunts remain reserve alternatives. Naming work does not block implementation.

## 13. Delivery sequence and acceptance gates

T is when the team adopts this revision. These are coordination targets, not guaranteed estimates. Preserve the real submission deadline and the final four hours for freeze, fixes, and rehearsals; do not restart an imaginary 27-hour clock.

| Target | Deliverable | Primary owners |
| --- | --- | --- |
| T + 30 minutes | Shared schemas, IDs, 12-building/50-agent fixture, package skeleton, public origin | Simulation & Backend + Data |
| T + 90 minutes | Actual BU map, one moving/selectable multipart avatar, one connected phone; verify local PostgreSQL starts and the basic bundled-geometry view loads | Map + Simulation & Backend + Mobile |
| T + 2 hours | Two phones create personas, vote, reroute students, and update the matching occupancy curve | All four |
| Next two hours | Full baseline week, route-cache misses, joins/edits/deletion, seek and reconnect behavior | Simulation & Backend + Data |
| Following integration block | 500-agent composition, all four event families, five interiors, supported avatar controls, imported schedules | Map + Mobile + Simulation |
| Remaining feature window | Paired analysis, evidence panel, expanded data coverage, local recovery; optional animation/LLM/shader only after required gates | All four |
| Final four hours | Freeze dependencies/features, verify target workload and recovery, rehearse the live audience interaction | All four |

### Updated role boundaries

- Data lead: registry, graph, route preparation, schedule/source mapping, provenance, fixture expansion.
- Simulation & Backend lead: TypeScript planner and aggregation; Python analysis and optional ML evaluation; authority, persistence, REST/socket contracts, cloud/local deployment, recovery.
- Map lead: campus composition, multipart avatars, motion, selection, five interiors.
- Mobile/Product lead: fast join, schedule editing/import, own-agent view, voting/removal, chart panels, accessibility, pitch/rehearsal.

Once the bundle is stable, the Data lead assists with fixture checks, scenario evidence, and template/layout data. The Simulation & Backend lead owns the contract boundary, so server code never writes its own behavior rules.

### Submission, freeze, and rehearsal

Use Sunday, 25 October, 7:00 AM as the planned feature/dependency freeze for the original 11:00 AM endpoint. If the verified submission deadline is earlier, schedule the required artifact preparation and submission before it; move the freeze earlier as needed. Do not treat the T-relative targets as permission to miss the deadline.

Reserve the final four hours for workload/recovery checks, fixes, and two timed rehearsals. Carry forward the original rehearsal windows of 7:00-8:00 AM and 9:00-10:00 AM if organizer timing permits; use 8:00-9:00 AM for fixes and the final hour for the verified presentation/submission obligations. Prepare required write-up, repository link, screenshots, or submission recording before their actual deadline. Assign an owner to verify the saved submission.

Rehearse the dining-closure story, a building/interior inspection, a paired-analysis explanation, privacy/removal, reconnect, and the local fallback. Test the actual display adapter and two physical phones. Agree on sleep/shift coverage and name a presenter and a separate demo operator.

### Definition of done

| Check | Required evidence |
| --- | --- |
| Complete interaction | Two physical phones join, create different avatars, vote, and observe matching route/occupancy changes |
| Data coverage | Every supported schedule location resolves to a reachable entrance or is explicitly rejected |
| Population conservation | Every active agent occupies one valid segment; travel and indoor counts never double-count a person |
| Determinism | Same seed/inputs/commands reproduce plans; unrelated joins do not redraw existing choices |
| Event continuity | Mid-route closure and expiry produce valid continuous paths without restoring old baseline coordinates |
| Time/recovery | Seek rejects old-epoch updates; reconnect restores current state; restart opens paused at the saved checkpoint |
| Ownership/removal | Duplicate votes follow policy; participants cannot issue presenter commands or edit others; removed personas stay removed |
| Graphics | Complete 500-avatar scene targets at least 30 FPS on the presentation laptop, including labels, heatmap, pan, and joins |
| Audience load | Proposed verification budget: 50 connected participant clients, with at least two real phones; this is a test target, not a claimed maximum |
| Latency | Proposed p95 command acknowledgement under one second; accepted plan/curve change visible within one second; analysis target under three seconds |
| Interiors | All five templates select the correct occupants and return to the current map state |
| Disconnected start | Cold local startup with external services unavailable supports the same live join/vote/chart interaction |
| Analytical honesty | Charts identify modeled population, estimates, scenario assumptions, mean versus instantaneous occupancy, and analysis revision |

The first acceptance gate is the deployed interactive chain: phone submission → accepted command → changed future plans → matching occupancy curve → visible campus response.

No acceptance row is marked complete without recorded evidence. The workload test records laptop/browser versions, modeled versus rendered population, client count, scenario mix, observed FPS, latency percentiles, analysis duration, and recovery outcome. Exercise the following correctness cases alongside the demonstration:

- A speed change and closure during travel preserve position and trip identity; event expiry resumes from the actual location.
- A route-cache miss finds a valid graph path or produces an explicit wait/error.
- A failed commit leaves old plans/aggregates intact; a duplicate accepted command returns the original result.
- Timely votes queued before closure count; at/after-deadline votes and old-ballot retries fail; zero votes and ties follow policy.
- A delayed checkpoint or old-epoch packet cannot overwrite a newer state; restored plans resolve their generated routes.
- Deleting a persona clears affected analysis and retained identifiers; a retry cannot recreate it.
- Building selection and scenario mutations cannot publish an obsolete or elapsed analysis result.

## 14. Judging and pitch

| Criterion | Weight | Evidence to demonstrate |
| --- | --- | --- |
| Problem | 20% | Open with a concrete lunch crowding problem; show why knowing destinations and timing helps |
| Idea & Relevance | 25% | Explain student planning and campus scenario exploration, with clearly stated assumptions |
| Technical Execution | 25% | Two phones join/vote; movement and direct charts share the accepted revision; show recovery and shared planner boundaries |
| Design | 15% | Fast phone join, understandable charts, clear building selection, five schematic interiors, accessible controls |
| Responsibility & Ethics | 10% | Synthetic population, consent, retention/removal, provenance, capacity estimates, and unvalidated accuracy stated plainly |
| Presentation | 5% | Timed rehearsals with separate speaker/operator and a practiced recovery path |

Explain what is prepared ahead of time, what changes live, and what the paired analysis varies. Show "Before this change" and "Current scenario," the comparison origin, and the range across simulated behaviors. Do not describe the direct plan projection as a trained ML forecast. If an optional learned surrogate is shown, provide its held-out comparison and error report.

## 15. Open items to settle at adoption

- Assign real names, the scope decision owner, submission owner, speaker, and demo operator.
- Confirm event/submission/judging requirements and deadlines, and reserve the final four-hour window.
- Confirm the consented MyBU example or proceed with a labeled synthetic baseline.
- Agree on the retention notice and intended future-demo use before collecting real submissions.
- Configure the Mapbox account/token and check current account limits, credentials, and supported presentation setup. This plan assumes no particular free-tier entitlement.
- Confirm Railway credentials, one application replica, PostgreSQL, public origin, and the run-specific QR URL.
- Verify the presentation laptop's container runtime, cached PostgreSQL image, complete local assets, reachable LAN/hotspot, and two-phone connectivity.
- Record campus coverage, capacity-estimate basis, and configurable scenario defaults. Validate package compatibility before locking dependencies.

## Reference basis

The supplied `Flowcast_Plan_Amendments.md` and accompanying pasted recommendations provide the revised design. The existing master plan supplies the original product scope, event context, rubric, naming history, and team commitments. Where the pasted summary omits details, this rewrite follows the more explicit amendment contracts, including `rebuildForSeek`, durable generated routes, deletion cleanup, and ordered ingress/checkpoints.

Technical references carried forward from the supplied amendments are implementation reading, not proof that this repository has passed runtime checks:

- [deck.gl MapboxOverlay](https://deck.gl/docs/api-reference/mapbox/mapbox-overlay) and [Mapbox integration](https://deck.gl/docs/api-reference/mapbox/overview).
- [Mapbox Standard configuration](https://docs.mapbox.com/map-styles/reference/standard/).
- [SimpleMeshLayer](https://deck.gl/docs/api-reference/mesh-layers/simple-mesh-layer), [ScenegraphLayer](https://deck.gl/docs/api-reference/mesh-layers/scenegraph-layer), [transitions](https://deck.gl/docs/developer-guide/animations-and-transitions), and [OrbitView](https://deck.gl/docs/api-reference/core/orbit-view).
- [Socket.IO delivery](https://socket.io/docs/v4/delivery-guarantees/), [connection recovery](https://socket.io/docs/v4/connection-state-recovery/), and [Redis adapter](https://socket.io/docs/v4/redis-adapter/).
- [Node worker threads](https://nodejs.org/api/worker_threads.html).
- [Prophet seasonality documentation](https://facebook.github.io/prophet/docs/seasonality,_holiday_effects,_and_regressors.html), background for the removed forecasting dependency.
- [Kenney Mini Characters](https://kenney.nl/assets/mini-characters), subject to the optional runtime gate.
- [Railway networking](https://docs.railway.com/networking/public-networking/specs-and-limits).
