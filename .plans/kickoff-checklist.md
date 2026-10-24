# Flowcast: Adoption and Kickoff Checklist

Use this with the revised [master plan](campus-digital-twin-spec.md). T means adoption of the revision, not a new hackathon start. The original planned endpoint is Sunday, 25 October 2026, 11:00 AM America/New_York; confirm the actual submission and judging deadlines immediately.

## 1. Logistics and deadlines

- [ ] Confirm power, the presentation laptop, HDMI adapter/cable, and actual display output.
- [ ] Confirm submission format, deadline, judging time, and any required write-up or recording. Assign a submission owner and schedule preparation before the deadline.
- [ ] Preserve the final four hours for freeze, checks, fixes, and two timed rehearsals. The original planned freeze is Sunday 7:00 AM; move it earlier if submission requires it.
- [ ] Pin the repository, revised master plan, public run URL, and deployment information in the team's existing communication channel.
- [ ] Share credentials securely; commit only configuration examples. Keep presenter authority distinct from participant sessions.

## 2. Ownership and decisions

- [ ] Assign the four leads: Data & Schedules, Simulation & Backend, Map/Frontend, and Mobile/Product & Pitch.
- [ ] Name the scope decision owner, pitch speaker, and separate demo operator. Agree on shift coverage.
- [ ] Simulation owns the shared TypeScript behavior implementation. Backend owns authority/persistence; Python prepares data and analysis inputs.
- [ ] Confirm the real MyBU example and consent, or use a labeled synthetic baseline.
- [ ] Finalize the retention notice and removal behavior before collecting real personas.

## 3. Contracts, data, and deployment: target T + 30 minutes

- [ ] Agree on stable location, agent, activity, trip, route, run, and ballot IDs; shared Zod schemas; and distinct epoch/scenario/clock/ballot versions.
- [ ] Scaffold `packages/contracts` and `packages/sim-core`; both the baseline command and live server use the same planner.
- [ ] Plan consolidation of existing `map-client` and `mobile` code into one `web` app with `/display`, `/present`, and `/join`. Keep the phone bundle lightweight.
- [ ] Deliver a versioned 12-building/50-agent fixture with reachable entrances, at least two dining destinations, an assembly location, and provenance.
- [ ] Separate public geometry from private schedules/population/baseline inputs. Validate bundle identity on startup.
- [ ] Set up one Railway Node application replica plus PostgreSQL; use REST commands and Socket.IO updates. No Redis or live Python API.
- [ ] Establish the public origin, run-specific QR, and readable backup URL.

## 4. First rendered and connected slice: target T + 90 minutes

- [ ] Render the actual BU area using Mapbox Standard, interleaved deck.gl, explicit Mercator, and terrain off. Verify slot placement and selection.
- [ ] Show one moving/selectable multipart avatar with independent body and hat choices.
- [ ] Connect a physical phone through the QR route and ownership session.
- [ ] Verify local PostgreSQL starts and the basic standalone deck view loads bundled geometry.
- [ ] Check package compatibility, match all deck package versions, and commit the chosen lockfile.

## 5. Complete audience interaction: target T + 2 hours

- [ ] Two physical phones join with distinct avatars and clearly labeled synthetic schedule presets.
- [ ] Open a three/four-option, 30-real-second ballot. Verify replacement votes, receipt-time ordering, deadline rejection, and the stated tie rule.
- [ ] Vote to close one dining destination while students are heading to lunch.
- [ ] Commit the winning event and changed plans before publishing; preserve current positions and semantic trips.
- [ ] Observe redirected students and the matching occupancy/arrival curve under the same accepted scenario revision.
- [ ] Confirm analysis work does not delay the command queue or direct chart.

## 6. Expand and verify

- [ ] Full week, route-cache misses, feasible travel, joins/edits/deletion, seek, and reconnect follow the master plan.
- [ ] Complete all event families, five schematic interiors, avatar controls, manual/CSV schedules, own-agent 2D view, and removal.
- [ ] Model 500 baseline students plus accepted participants; draw at most 500 avatars and 100 interior figures. Hidden agents remain in all aggregates.
- [ ] Complete 20 paired future rollouts over the two-hour horizon, the empirical 10th-90th percentile band, stale-result handling, and evidence panel.
- [ ] Record the full-scene FPS target of at least 30, 50 connected participant clients including two real phones, p95 command acknowledgement under one second, accepted map/chart visibility within one second, and analysis under three seconds. These remain targets until measured.
- [ ] Verify failed commits, retries, ownership, deletion cleanup, generated-route restoration, ordered checkpoints, and paused restart with canceled unfinished ballot.
- [ ] Cold-start the same Node build and local PostgreSQL with external services unavailable; test bundled assets, a fresh local run, new LAN QR, and two phones on the actual hotspot/router.
- [ ] Rehearse the pitch and recovery twice. Verify the saved submission. Optional animation/LLM/holographic polish follows required gates.

Use the master plan's definition of done for evidence. Checking a deployment command or rendering a placeholder alone does not complete an integration gate.
