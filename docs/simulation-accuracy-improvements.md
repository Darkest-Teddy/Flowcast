# Simulation accuracy changes — October 25, 2026

**Historical implementation comparison:** the numbers below used the earlier mixed objective. The subsequent data-quality pass removed assumed thresholds and indirect proxies from calibration, corrected survey-weekday alignment, and refreshed sparse Kenmore observations. The 1.7% score change below is retained as an audit record, not evidence of increased real-world accuracy. See [calibration-observations.md](calibration-observations.md) and the regenerated [behavior-validation.md](behavior-validation.md) for the current data-grounded evaluation.

The planner now prefers nearby academic locations within each deterministic four-section candidate batch. It retains school/level eligibility, course-load targets, published class times, room limits, linked components and route feasibility. This is an explicit synthetic scheduling preference; observed traffic counts do not drive enrollment.

## Comparable before/after results

The baseline uses `sourceDay.ts` from `dbdf5a1`; both runs use the revised scoring weights and the same bundled inputs, 36,977-person roster and conditions. These are calibration-reference comparisons, not held-out predictions. Wednesday is the reference-week class day with clear weather at 62°F; Saturday is clear at 62°F.

- Wednesday B-line peak-time error: **1.403 → 0.798 hours** (about 84 → 48 minutes).
- Wednesday B-line hourly correlation: **0.779 → 0.784**.
- Wednesday median walk: **5.983 → 5.918 minutes**.
- Student overflow above assumed shares of observed counts: **0.388 → 0.382**. The student-share bands are assumptions, not measured student counts.
- Wednesday commuters on campus making four or more stop walks: **0.113 → 0.107**.
- Saturday B-line correlation: **0.087 → 0.099**; peak-time error remains **5.031 hours**.
- Wednesday weighted loss: **4.831 → 4.711**; Saturday **2.232 → 2.216**; finals **0.259 → 0.252**; rain **0.448 → 0.458**.

The sum of the four rounded losses falls **7.770 → 7.637** (about 1.7%); this is an objective-score change, not an accuracy percentage.

Tradeoffs remain: Comm Ave correlation slightly decreases (**0.159 → 0.158**), rainy-day loss increases, and one fewer weekly enrollment is feasible. The rainy one-minute walker spike rises from **20.0% → 20.5%** of peak walkers; its loss increases by **0.024**, above the parameter calibrator’s strict 0.02 per-metric tolerance. This structural change is retained as an explicit tradeoff for the larger transit-timing gain, not presented as a parameter candidate accepted by that gate. The enrolled-student count is unchanged. In the unconditioned planner, Wednesday B-line peak error worsens (**3.515 → 3.973 hours**), despite a small overall loss improvement. The conditioned planner is the map's normal behavior path. This change does not establish accurate weekend transit demand or building occupancy.

## Validation safeguards

The rainy-day walker spike is a simulation sanity check, not an observed rainy-day count. `walkersPerMinute` counts simulated trips active in each minute; `scoreDay` divides the largest positive one-minute change by that day's peak walker count. The 10% target is a hand-set plausibility threshold. The scenario uses rain at 50°F, and the rain multipliers in `behavior.json` are explicitly assumptions. A worse rain sanity score does not establish worse real-world rain prediction.

- Calibration rejects missing days/metrics, duplicate days/metrics, invalid losses and changed metric weights.
- FitRec timing and combined student/public count fits remain visible with zero calibration weight. FitRec timing is sampled from the reference profile, and public traffic fills observed minus student counts; neither is independent predictive validation.
- The report identifies these reconstruction diagnostics and separates the recorded parameter search from current validation. Older total losses using different weights are not comparable.
- The occupancy display range is documented as heuristic, without a claim of measured 90% coverage.
- The dining-hours regression now checks the actual bundled weekend availability and preserves the unknown-place case.

The fixture regression checks clustered choices, deterministic results, full course loads, published times, room capacity and playable itineraries. Full-roster validation is reproducible with `cd map-client && npm run validate:behavior`; its latest results are in [behavior-validation.md](behavior-validation.md). That report compares the unconditioned and conditioned planners in the current checkout, not the code revisions above.

## Verification

From `map-client`:

- `npm run typecheck` — passed.
- `npm run validate:behavior` — completed and regenerated the report.
- `../server/node_modules/.bin/tsx --test --test-concurrency=2 tests/*.test.mjs` — 434 passed, zero failed or cancelled.

The full suite checked 642,792 trips and 672 population snapshots. All seven conditioned days retained 36,977 complete itineraries with no seated or optional-venue capacity violations. Classroom waiting overflow remains visible: Tuesday Religion 25/24; Thursday IRB 26/24 and ERA 45/44. No other conditioned day overflowed in this reference-week scan.
