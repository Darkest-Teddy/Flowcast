# Implementation Plan

- [x] 1. Define the assumption set and component functions
  - Add `FATIGUE_ASSUMPTIONS`, `sleepPressure`, `circadian` to `web/src/lib/fatigue.ts`
  - _Requirements: 3.1_

- [x] 2. Implement `modelFatigue`
  - [x] 2.1 Filter items, map location kinds, detect rushed transitions
    - _Requirements: 2.3, 2.5, 2.6_
  - [x] 2.2 Step loop producing samples with components and current item ID
    - _Requirements: 1.1, 1.2, 1.3_
  - [x] 2.3 Range and date validation
    - _Requirements: 1.4, 1.5_

- [x] 3. Unit tests in `web/tests/fatigue.test.ts`
  - Sleep pressure and circadian shape; packed vs. empty day; meal vs. class; suggestions; invalid ranges
  - _Requirements: 1.1–1.5, 2.1–2.3, 2.6_

- [x] 4. Fix issues from subagent review
  - [x] 4.1 Replace Euler load update with exact exponential step, midpoint rate
    - _Requirements: 3.2_
  - [x] 4.2 Sum load across overlapping items
    - _Requirements: 2.4_

- [x] 5. Determinism test (same inputs twice give identical output)
  - _Requirements: 3.3_

- [ ] 6. Move `fatigue.ts` into `packages/sim-core` when that package exists
  - Keep the public signature; re-export from `web` during migration
  - _Requirements: 3.3_

- [ ] 7. Show fatigue on the map
  - Tint each agent in `map-client/src/layers/crowd.ts` by its current score
  - Add the student's own curve to the phone view, rendered only in their session
  - _Requirements: 1.2, 3.4_
