# How Flowcast uses Kiro

We built Flowcast with Kiro. This document lists each Kiro feature we used, where its files are, and how to check that it works. All paths are relative to the repository root. Two features are documented in depth: the student fatigue model (first) and real campus events on the map (second).

The first feature is a per-student fatigue score, from 0 to 1, computed from a student's schedule. The code is in `web/src/lib/fatigue.ts`, with tests in `web/tests/fatigue.test.ts` and a comparison script in `web/scripts/fatigue-sweep.ts`.

## Summary

| Feature | Location | Purpose |
| --- | --- | --- |
| Spec | `.kiro/specs/student-fatigue/` | Requirements, design and task list for the fatigue model |
| Steering | `.kiro/steering/` | Project rules loaded into every Kiro session, plus one rule file that loads only for the fatigue model |
| Skill | `.kiro/skills/fatigue-calibration/` | Step-by-step procedure for tuning a model constant |
| Custom agent | `.kiro/agents/fatigue-modeler.json` | An agent limited to the fatigue work, with its own permissions and context |
| Agent hooks | inside `fatigue-modeler.json` | Run tests and the sweep automatically at set points |
| IDE hook | `.kiro/hooks/fatigue-spec-sync.kiro.hook` | Re-checks the spec when `fatigue.ts` is saved in the Kiro IDE |
| Knowledge base | indexes `.plans/` | Semantic search over the project master plan |
| Subagent | used during development | Independent code review that found two bugs |
| Task list | used during development | Tracked the build steps in the chat session |
| Code intelligence, introspect | used during development | Searched the codebase and looked up Kiro's own documentation |

## Spec

Directory: `.kiro/specs/student-fatigue/`

A Kiro spec splits a feature into three files that are written in order.

- **`requirements.md`** has user stories and acceptance criteria in EARS format ("WHEN … THEN the system SHALL …"). Each criterion is specific enough to test. Requirement 3 covers the ethics side: all constants in one place, results that don't depend on the time step, and no fatigue data leaving the student's session.
- **`design.md`** has the architecture diagram, the public functions, the equation for each model component with its source, error handling and test strategy.
- **`tasks.md`** is the implementation plan as checkboxes. Each task names the requirement numbers it satisfies.

Current task status:

- Done: tasks 1–5. These cover the model, the tests, two fixes from code review, and a determinism test.
- Open: task 6, move the model into `packages/sim-core`.
- Open: task 7, color agents on the map by fatigue and show each student their own curve on their phone.

## Steering

Directory: `.kiro/steering/`

Steering files are Markdown with a front-matter header that says when Kiro loads them.

| File | Loaded | Contents |
| --- | --- | --- |
| `product.md` | Always | What Flowcast is, judging weights, the rule that model output is a "projection" and not a "prediction", and keeping personal data private |
| `tech.md` | Always | Stack, target package layout, determinism rules for simulation code, test command, banned dependencies |
| `fatigue-model.md` | Only when `web/src/lib/fatigue.ts` is in context (`fileMatch`) | Constants stay in `FATIGUE_ASSUMPTIONS`, results must not depend on the time step, and behavior changes must update the spec |

The always-loaded files repeat key rules from `.plans/campus-digital-twin-spec.md`, so Kiro follows them without anyone pasting the plan into each chat.

## Skill

File: `.kiro/skills/fatigue-calibration/SKILL.md`

A skill is a procedure Kiro loads only when it's needed. Its front matter gives a name and a description saying when to use it. This skill covers changing a model constant:

1. Record why the new value is better and where it comes from.
2. Run `node web/scripts/fatigue-sweep.ts` before and after the change.
3. Confirm that mean fatigue still ranks the rest day below the typical day, and the typical day below the packed day.
4. Run the tests.
5. Update the equation table in `design.md` if an equation changed.

It also says not to tune constants to make the demo look more dramatic.

## Custom agent

File: `.kiro/agents/fatigue-modeler.json`

An agent configuration for working on the fatigue model only.

- **Prompt:** follow the spec, trace every change to an acceptance criterion, and never present scores as measurements of real students.
- **Write access:** limited to `web/src/lib/`, `web/tests/`, `web/scripts/` and the fatigue spec folder.
- **Shell access:** the test command, the sweep script and read-only `git` commands are approved automatically. `git push`, `git reset --hard` and `rm -rf` are always denied.
- **Resources:** loads the steering files, the spec, `web/src/data/types.ts`, and the skills folder.
- **Shortcut:** `ctrl+shift+f` switches to this agent during a chat session. Pressing it again switches back.

Start it with:

```bash
kiro-cli chat --agent fatigue-modeler
```

## Agent hooks

These are defined in the `hooks` section of `fatigue-modeler.json`.

| Trigger | Command | Effect |
| --- | --- | --- |
| `agentSpawn` | `node --test web/tests/fatigue.test.ts`, then a count of unchecked tasks in `tasks.md` | The agent starts each session knowing whether tests pass and how much work is left |
| `postToolUse` on `write` | `node --test web/tests/fatigue.test.ts` | Tests run after every file the agent writes |
| `stop` | `node web/scripts/fatigue-sweep.ts` | The rest/typical/packed comparison prints when the agent finishes a reply |

## IDE hook

File: `.kiro/hooks/fatigue-spec-sync.kiro.hook`

This is a Kiro IDE hook. When `web/src/lib/fatigue.ts` is edited, it asks the agent to run the tests and the sweep, check every acceptance criterion in `requirements.md`, and update `design.md` if an equation changed.

The CLI documentation does not describe this file format, so the CLI has not validated this file. Open the project in the Kiro IDE to confirm the hook appears.

## Knowledge base

The `.plans/` folder is indexed as the knowledge base `flowcast-plan-and-fatigue-spec`, using semantic ("best") indexing. Kiro can search the master plan by meaning instead of exact words. For example, the query "behavioral assumptions are defaults not validated measurements" returns the relevant sections of `campus-digital-twin-spec.md`.

## Tools used during development

These Kiro features were used while building the model. They leave no files behind.

- **Task list:** tracked the three build steps (write the model, test it, review it) and recorded progress as each finished.
- **Subagent:** a separate review agent read the code with no shared context and ran the tests. It found two real bugs:
  - Results changed by about 18% depending on the time-step size.
  - When two schedule items overlapped, only the first one counted.

  Both are fixed and have regression tests (spec task 4).
- **Code intelligence and search:** `grep`, `glob` and the `code` tool were used to find the existing `ScheduleItem` and `CampusLocation` types, so the model reuses them instead of defining new ones.
- **Introspect:** looked up Kiro's own documentation for the agent, hook and resource formats before writing those files.

## Verifying everything

Run these from the repository root:

```bash
# Tests: expect "pass 9, fail 0"
node --test web/tests/fatigue.test.ts

# Comparison of three reference days: expect mean rest < typical < packed
node web/scripts/fatigue-sweep.ts

# Agent configuration is valid and listed
kiro-cli agent validate --path .kiro/agents/fatigue-modeler.json
kiro-cli agent list
```

Results when this document was written (24 October 2026):

| Day | Mean | Peak | Rushed transitions |
| --- | --- | --- | --- |
| Rest | 0.224 | 0.401 | 1 |
| Typical | 0.292 | 0.421 | 0 |
| Packed | 0.483 | 0.688 | 4 |

Every reference day peaks at 11:30 PM. That is the last modeled time, and sleep pressure keeps rising until the student goes to sleep.

## Limits

- Fatigue scores come from stated assumptions. They have not been checked against data from real BU students.
- The model is not yet connected to the map or the phone view (spec task 7).
- The IDE hook has not been checked in the Kiro IDE.

# Campus events: a second spec-driven feature

The second feature brings BU's real public events into the simulation: scrape them, match venues to mapped buildings, have them pull simulated students on the map, and show their crowd impact by date on the dashboard. It was built in the Kiro CLI with the default agent, then the project agent below.

## How the work went

1. **Plan before code.** Kiro read the master plan and the code, then explained back what it understood: "events" meant two different things in the repo (the dashboard list and the plan's scenario events, Section 5.6). It asked which we meant before touching files. It also flagged two limits: venues hidden behind a login can't move the map, and the simulation only models one representative week.
2. **Decisions we made from that.** Events inside the simulated week play on their real date; later events are projected onto the same weekday and labelled; a new dashboard tab lets anyone pick a date. Kiro implemented those choices exactly.
3. **Spec.** `.kiro/specs/campus-events/` holds `requirements.md` (EARS criteria, including "never invent a venue" and "class times never move"), `design.md` (data flow and key decisions), and `tasks.md`, ticked only after test output showed each task worked.
4. **Live steering mid-task.** While Kiro worked we redirected it twice (create the `.kiro` folder from the rules PDF; reduce approval prompts). It paused, handled the request, and resumed the plan.

## What Kiro found that we would have missed

- **Scraper bugs on real pages.** Three public events failed to parse. Kiro read the cached HTML and found organizer descriptions with raw newlines and invalid `\&quot;` escapes inside the JSON-LD; it fixed both and added tests.
- **Wrong venues.** Terrier Central fills in 775 Commonwealth Ave for rooms in other buildings, so the old matcher rejected "CAS B36". Kiro changed matching to trust the venue name first, which raised mapped events from 4 to 33.
- **Unrealistic attendance.** The first trial put 2,345 students in a 56-seat room. Kiro looked up the classroom directory and capped each event by its room's published seats.
- **A capacity bug, caught by a property test.** `map-client/tests/gatherings.test.mjs` generates 100 random worlds and event days and checks that everyone is accounted for every second, caps hold, and classes never change. Seed 1014 failed: events in classrooms could push a building over capacity, because classrooms weren't in the minute-by-minute capacity ledger. The fix puts event venues into that shared ledger.
- **Merge conflicts with teammates.** Teammates changed the same simulation function (adding transit) at the same time. Kiro merged both: transit stayed the 4th argument, and events became a 5th options argument. It added the new "gathering" stay purpose their incident code needed, then re-ran all 181 tests.

## Kiro files for this feature

| Feature | Location | Purpose |
| --- | --- | --- |
| Spec | `.kiro/specs/campus-events/` | Requirements, design and tasks for real campus events |
| Steering | `.kiro/steering/product.md`, `tech.md`, `structure.md` | Data-honesty rules (registrations are never attendance, no invented venues), where code lives, and the commands that verify a change |
| Custom agent | `.kiro/agents/flowcast.json` | Project agent: loads steering and skills, auto-approves built-in tools, always denies `rm -rf`, force push, `git reset --hard`, `git clean -f`, `git branch -D` and `sudo` |
| Agent hooks | `.kiro/hooks/verify.sh`, `check_manifest.py`, wired into `flowcast.json` | On start: git status and open spec tasks. After every write: warns if a data snapshot changed without updating its checksum (this exact mistake once blocked a build). On stop: Python tests and both typechecks, about 8 seconds |
| Skills | `.kiro/skills/refresh-events/`, `.kiro/skills/spec/` | `/refresh-events` re-scrapes and rebuilds; `/spec <feature>` starts or continues a spec |
| Property-based test | `map-client/tests/gatherings.test.mjs` | 100 generated event days with a seeded generator, so failures are reproducible |

## Other Kiro tools used

- **Code intelligence and search** to trace `buildSourceDay`, the planner and every consumer of the event types before changing them.
- **Task list** to track the seven build steps across a long session with context compaction.
- **Introspect** to read Kiro's own docs on steering, agent, hook and trust formats before writing those files.
- **Shell and browser checks**: Kiro drove headless Chrome to screenshot the new pages and the map, then revised the event-impact layout after seeing it (it moved small ripple effects into the table and switched to a clearer event-hour marker).

## Verify

```bash
(cd data-pipeline && .venv/bin/python -m unittest discover -s tests)   # pipeline, incl. scraper and venue tests
(cd map-client && node --test tests/gatherings.test.mjs)                # event behavior + property test
bash .kiro/hooks/verify.sh                                               # the stop hook
kiro-cli agent validate --path .kiro/agents/flowcast.json
```

## Limits

- Event attendance (25% of free students) is the plan's default assumption, not measured attendance.
- 55 of 88 events can't change the map: their location is login-only, their building isn't mapped yet (the Howard Thurman Center has 22), or they are multi-day listings.
- MCP servers and Kiro powers were not used for this feature.
