# Design Document

## Overview

A pure function, `modelFatigue(items, locations, options)`, in `web/src/lib/fatigue.ts`. It has no I/O and no randomness, so the live server and the baseline generator can both call it once it moves into `packages/sim-core` (master plan Section 5.1, "one behavioral implementation").

## Architecture

```mermaid
flowchart LR
  S[ScheduleItem list] --> F[filter: drop unaccepted suggestions, invalid times]
  L[CampusLocation list] --> K[locationId → LocationKind map]
  F --> R[rush detection: gap < 15 min, different place]
  F --> LOOP
  K --> LOOP
  R --> LOOP
  LOOP[step loop, default 15 min] --> P[sleep pressure S]
  LOOP --> C[circadian C]
  LOOP --> A[activity load L]
  P & C & A --> SCORE[score = clamp01(0.6·S + 0.4·min(1, L/0.25) + C)]
  SCORE --> OUT[FatigueSummary: samples, peak, mean, rushes]
```

## Components and Interfaces

```ts
modelFatigue(items: ScheduleItem[], locations: CampusLocation[], options: FatigueOptions): FatigueSummary
sleepPressure(hoursAwake: number, a?: FatigueAssumptions): number
circadian(hourOfDay: number, a?: FatigueAssumptions): number
FATIGUE_ASSUMPTIONS // every constant
```

`ScheduleItem`, `CampusLocation` and `LocationKind` come from `web/src/data/types.ts` unchanged.

## Data Models

| Component | Equation | Source of the constant |
| --- | --- | --- |
| Sleep pressure S | `1 − (1 − S₀)·e^(−t/18.2)` | Borbély two-process model, rise time from Daan et al. (1984) |
| Circadian C | `−0.1·cos(2π(h − 17)/24)` | Assumption: alertness peaks late afternoon |
| Activity load L | `dL/dt = rate − L/3`, solved exactly per step | Assumption, per-kind rates in `loadPerHour` |

The load ODE is integrated with the exact exponential solution and the rate sampled at each step's midpoint. An earlier version used forward Euler, which moved results by about 18% between 1-minute and 60-minute steps (found in review, see tasks.md 4).

## Error Handling

- Invalid ISO dates throw. Inverted ranges return an empty summary. Non-positive step size throws.
- Items with `end <= start` or unparseable times are dropped silently, matching how the schedule UI already tolerates partial imports.

## Testing Strategy

`node --test web/tests/fatigue.test.ts`, using Node's built-in type stripping, so no test dependency is added. Each acceptance criterion maps to at least one test (see tasks.md).
