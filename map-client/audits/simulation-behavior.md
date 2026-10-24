# Simulation behavior audit

Baseline: `8e0548e`. The review focuses on student occupancy and movement, including the reported full-or-empty pattern. Changes are local; this audit does not establish measured attendance accuracy.

## Confirmed problems and corrections

- **Demand forced into a partial map.** The planner tried to place each student's entire degree load into mapped buildings. Mapped demand now uses eligible mapped/full distinct catalog offerings as an explicit proxy. Required lecture/lab/discussion components are admitted together. Missing or unresolved required components remain uncovered instead of becoming incomplete courses.
- **Missing hours appeared as empty buildings.** The old reference week was October 19–25, while CRC dining hours covered October 24–30. The builder now selects the best-covered nearby Monday week, currently October 26–November 1. Official Fenway and medical schedules were reviewed for that week. Missing service dates display as unknown; explicit closures still produce zero attendance. Warren's 600 verified Tower A beds and the Fenway relocation minimum were reviewed for the new week too.
- **Home campus replaced academic campus.** All 595 Fenway residents previously lost access to Charles River classes. Those assignments are now separate. Cached OSM corridors supply real pedestrian connections of about 2.1 km from Fenway homes to CAS.
- **A clipped walking network forced a river detour.** DeWolfe–Mugar now follows a verified 759 m route via the BU Bridge sidewalk, instead of a 3,754 m Mass Ave Bridge detour. No straight-line walking shortcuts were added.
- **Unrealistic timing and detours.** Class arrivals have stable 2–12 minute leads when feasible. Home breaks require enough time to justify their additional walking. Optional added walking cannot exceed the activity duration. Off-map gateway changes reserve at least the straight-line walking time plus the planned off-map dwell; the actual off-map path remains unknown. Zero-duration trips are omitted.
- **Hard-coded empty periods.** Gym arrivals were forbidden before 17:00, study arrivals before 14:00, and meals outside narrow bands. The model retains its core preference windows but distributes 25% of attempts across broader daytime windows, still enforcing published hours and travel feasibility. This is an explicit behavioral assumption, not a fitted occupancy target.
- **Missing academic load implied staying home.** Uncovered course slots can generate explicit estimated 120-minute weekly off-map academic/study blocks, using existing people and actual gateway access walks. They are not published classes or inferred registrations.
- **Displayed people and percentages could bypass the roster.** Removed independent demo transit riders and display-only weather occupancy adjustments from the production map. Weather still affects its visual presentation.

The coverage implementation also caught and corrected correlated adjacent hash draws. For 10,000 synthetic students, five slots and 60% coverage, 91.6% now receive a partial mapped load, instead of only 4.2%. The distribution is deterministic and regression-tested.

## Evidence and reproduction

`occupancy-before.json` retains the old seven-day samples. `occupancy-after.json` contains the new samples, explicit unknown counts, source statistics, and snapshots at 09:00, 11:30, 15:00 and 18:00. Sampling covers every 15 minutes from 08:00–22:00. The two scenarios use different reference weeks to correct service-hour coverage; this is not an observed before/after experiment.

| Modeled samples | Before | After |
| --- | ---: | ---: |
| Empty | 37.9% | 26.6% |
| Nonempty, below 90% of reference capacity | 58.2% | 69.1% |
| At least 90% of reference capacity | 4.0% | 4.2% |
| Unknown samples, excluded from percentages | 0 | 684 |

There are 19,950 total building/time samples. Unknown service dates are no longer counted as empty. Near-full residences remain possible; the correction does not force every building toward a middle percentage. Monday at 15:00, for example: Warren 370/600, CAS 1,370/2,817, CDS 327/632, Questrom 1,065/1,924, Mugar 429/800, GSU 21/600, and FitRec 11/1,200. These are simulated student counts against existing reference capacities.

Run from the repository root:

```sh
npm --prefix map-client test
npm --prefix map-client run build
node map-client/scripts/audit-occupancy.mjs map-client map-client/audits/occupancy-after.json
node map-client/scripts/audit-buildings.mjs
```

Run the acquisition tests from `data-pipeline` with `.venv/bin/python -m unittest discover -s tests`.

The occupancy audit asserts that each of the 36,977 people has a complete, non-overlapping 24-hour timeline on all seven days. The scale test independently checks physical walking speeds, population snapshots, complete dining stays within published hours, and estimated activity quotas. The building audit covers all 50 mapped locations using exact stay boundaries. Browser checks verify startup, day switching, preserved capacities, displayed-roster membership, and unchanged headcounts when weather changes.

Final verification: 88 client tests passed; 148 pipeline tests passed; production build passed. The scale test checked 475,671 trips and 672 population snapshots. The building audit found no locations above their reference capacity and no visits outside applicable hours. Chrome rendered 357 student walkers, all from the institutional roster, with no independent idle demo riders and no page errors; a weather toggle left counts unchanged. The build retains its existing large-chunk warning.

## Remaining limits

The model still lacks actual section enrollment, attendance, student major distributions, and measured building headcounts. Offering coverage, optional preferences, off-campus meals, and missing-location activities are estimates. Staff and visitors are outside the student roster. Residences can legitimately approach capacity at night; closed venues can be empty. These states are not artificially flattened to make the map look busy.

CRC dining hours for October 31–November 1 and Mugar/Pardee hours for November 1 remain unknown. Medical cafe weekends are also unknown. The separate MBTA schedule remains an October 19–25 snapshot. The map is a scenario using saved evidence, not a live occupancy measurement.
