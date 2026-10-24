# How Flowcast uses Kiro

We built Flowcast's student fatigue model with Kiro. This document lists each Kiro feature we used, where its files are, and how to check that it works. All paths are relative to the repository root.

The feature being built is a per-student fatigue score, from 0 to 1, computed from a student's schedule. The code is in `web/src/lib/fatigue.ts`, with tests in `web/tests/fatigue.test.ts` and a comparison script in `web/scripts/fatigue-sweep.ts`.

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
