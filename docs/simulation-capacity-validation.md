# Simulation capacity fixes

The model retains published/configured capacities and published class times. It does not clamp displayed occupancy or invent extra seats.

- Classroom buildings now participate in the optional-visit capacity ledger. Published classes reserve seats first; class waits reserve the remaining space in a stable student order. A class and adjacent wait reserve each student only once per minute.
- When a class wait would exceed the available seats, the planner tries the minimum arrival lead with no post-class lingering, then an immediate walk to the next destination. It keeps a variant only if it reduces overflowing classroom minutes. Consecutive classes in the same building, minimum arrival leads, transit arrival times and full next destinations can still leave waits above capacity. These people remain visible; this is not a guarantee that all building occupancy stays below 100%.
- Optional venue weights now grow linearly with capacity instead of its square root. At equal travel cost the base weight per seat is equal. Stable favorite-venue preferences still apply, so equal realized occupancy is not promised. Capacities were not increased.
- Venues whose opening hours never intersect their kind's modeled visit windows are marked not modeled. After Hours West therefore does not imply measured or simulated emptiness Monday–Thursday. Friday overlaps the dinner window and remains modeled. Known closures remain known zeroes.
- Shared buildings containing only amenities use the largest amenity as their main tag, with deterministic ties by ID. Mugar keeps its own load and label while the Music and African Studies libraries receive separate tags.

Verification uses the committed population of 36,977. The capacity regression scans the unconditioned week every five minutes and sweeps every stay boundary for all seven conditioned days with published transit, reference-week events and null weather. The conditioned scan checks full-day itinerary coverage, spatial continuity, finite ordered trip timestamps, unchanged capacities, seated occupancy and optional-venue occupancy including waits. Classroom wait overflow is reported explicitly. Existing source-day and transit tests cover route speed and source schedule constraints.

These are deterministic model regression checks, not validation against observed BU occupancy. Weather variants and presenter scenarios remain covered by the existing sampled scenario suite; the full-roster scan does not enumerate every possible condition. The earlier calibration report in `behavior-validation.md` predates these venue-weight changes and is not a new calibration result.

Verified on 2026-10-24:

- `cd map-client && npm run typecheck`: passed.
- `cd map-client && ../server/node_modules/.bin/tsx --test tests/campusCapacity.test.mjs`: 6 passed, 0 failed/cancelled (92.7 s). All seven conditioned days had 36,977 complete itineraries, zero seated-capacity violations and zero optional-venue capacity violations. Unconditioned five-minute samples also stayed within capacity, and the small-venue saturation, After Hours and shared-tag regressions passed.
- Retained classroom wait peaks (people / unchanged seats): Monday Yawkey 70/68; Tuesday Religion 26/24; Thursday African American Studies, IRB and Religion each 25/24; Friday Cello 254/253. Wednesday, Saturday and Sunday had none. The maximum remaining excess was two people. The planner shortened baseline waits for 51, 52, 157, 50, 95, 0 and 0 students respectively. These limits describe this reference-week run, not a bound for arbitrary scenarios.
- The initial `cd map-client && npm test` run reported 263 passed, 0 assertion failures and 7 module cancellations (`Promise resolution is still pending but the event loop has already resolved`) under concurrent load. It was not a clean full-suite pass. The completed capacity run above used the existing server tsx runtime; integration testing is left to the parent after cherry-picking.
