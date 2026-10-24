# Behaviour validation

Generated on 2026-10-24 by `npm run validate:behavior` / `npm run calibrate` (map-client/scripts/validate-behavior.mjs, calibrate-behavior.mjs). Everything runs locally: the simulation is imported headlessly from `map-client/src/sim`, scored against measured BU data in the repo, and no network or AI service is used.

**Columns.** *Today’s model* is `buildSourceDay` with no conditions (the unconditioned model, unchanged). *Conditions engine* is the same roster with `behavior.json` + `personas.json` + `outdoor.json` and the day's conditions, which is what the map runs. Loss is ≥ 0 per metric (0 = on target); a proposal is accepted only if no metric's loss rises by more than the tolerance and the weighted total falls.

## Measured series and targets

- **FitRec** hourly entries, Oct 17–23 2026 (BU FitRec peak/quiet hours report), same weekday: hourly correlation, daily total ratio, busiest hour.
- **Library** historical gate counts by hour (School of Theology Library, 2019–20; the only BU library series in the data, used for shape only) vs simulated library entries by hour; plus occupancy shape checks.
- **Bluebikes** dock arrivals + departures at Charles River BU docks, average September 2026 Wednesday, hourly, vs simulated walk departures (activity-timing proxy).
- **Dining**: BU Dining's published 5,000 lunches and 5,000 dinners a day at the three main halls (BU Today 2017), and occupancy at meal times.
- **Pedestrian counts**: Comm Ave / Bay State Road crossings 17–18h vs 08–09h (Warren Towers EPNF, 2023), as a ratio.
- **Sanity**: walkers at 3 am, one-minute walker spikes, median and long walks, commuter stop walks, people by the river at 3 am and in rain.

## Scores

| Day | Metric | Target | Today’s model | Conditions engine | Loss before → after |
|---|---|---|---|---|---|
| Wednesday, classes, dry 62°F | FitRec entries by hour: correlation | r → 1 | 0.897 | 0.942 | 0.103 → 0.058 |
| Wednesday, classes, dry 62°F | FitRec entries per day: simulated ÷ measured | 1.0 | 0.357 | 0.713 | 1.030 → 0.339 |
| Wednesday, classes, dry 62°F | FitRec busiest hour: simulated − measured (hours) | 0 | 2.000 | 2.000 | 0.333 → 0.333 |
| Wednesday, classes, dry 62°F | Library entries by hour vs historical gate counts: correlation | r → 1 | -0.251 | 0.272 | 1.251 → 0.728 |
| Wednesday, classes, dry 62°F | Library occupancy 19–22h ÷ 13–16h | 0.8–2.5 (busy through the afternoon into the evening) | 0.904 | 0.714 | 0.000 → 0.108 |
| Wednesday, classes, dry 62°F | Library samples at ≥98% of capacity (08–24h) | ≤ 5% | 0.063 | 0.078 | 0.062 → 0.141 |
| Wednesday, classes, dry 62°F | Main dining halls, lunches: simulated ÷ published | 1.0 | 0.585 | 1.023 | 0.536 → 0.022 |
| Wednesday, classes, dry 62°F | Main dining halls, dinners: simulated ÷ published | 1.0 | 0.546 | 0.919 | 0.606 → 0.084 |
| Wednesday, classes, dry 62°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 1.354 | 1.577 | 0.098 → 0.000 |
| Wednesday, classes, dry 62°F | Busiest dining time (hour) | within 11–14h or 17–20h | 13.9 | 17.9 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Walk departures vs Bluebikes dock activity by hour (06–24h): correlation | r → 1 | 0.456 | 0.552 | 0.544 → 0.448 |
| Wednesday, classes, dry 62°F | Walkers 17–18h ÷ 08–09h, relative to published crossing counts | 1.0 | 0.641 | 0.747 | 0.222 → 0.146 |
| Wednesday, classes, dry 62°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.477 | 0.219 | 1.887 → 0.596 |
| Wednesday, classes, dry 62°F | Median walk (minutes) | ≤ 10 | 5.058 | 5.753 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Walks longer than 1.5 km | ≤ 5% | 0.045 | 0.046 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.425 | 0.121 | 1.085 → 0.070 |
| Wednesday, classes, dry 62°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | **Weighted total loss** | lower is better | | | 6.530 → **2.422** |
| Saturday, dry 62°F | FitRec entries by hour: correlation | r → 1 | 0.923 | 0.948 | 0.077 → 0.052 |
| Saturday, dry 62°F | FitRec entries per day: simulated ÷ measured | 1.0 | 0.971 | 0.989 | 0.030 → 0.011 |
| Saturday, dry 62°F | FitRec busiest hour: simulated − measured (hours) | 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Saturday, dry 62°F | Library entries by hour vs historical gate counts: correlation | r → 1 | 0.858 | 0.782 | 0.142 → 0.218 |
| Saturday, dry 62°F | Library occupancy 19–22h ÷ 13–16h | 0.8–2.5 (busy through the afternoon into the evening) | 0.140 | 0.168 | 0.826 → 0.790 |
| Saturday, dry 62°F | Library samples at ≥98% of capacity (08–24h) | ≤ 5% | 0.000 | 0.036 | 0.000 → 0.000 |
| Saturday, dry 62°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 2.644 | 2.337 | 0.000 → 0.000 |
| Saturday, dry 62°F | Busiest dining time (hour) | within 11–14h or 17–20h | 12.4 | 12.1 | 0.000 → 0.000 |
| Saturday, dry 62°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 |
| Saturday, dry 62°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.188 | 0.166 | 0.441 → 0.332 |
| Saturday, dry 62°F | Median walk (minutes) | ≤ 10 | 4.224 | 4.958 | 0.000 → 0.000 |
| Saturday, dry 62°F | Walks longer than 1.5 km | ≤ 5% | 0.041 | 0.053 | 0.000 → 0.028 |
| Saturday, dry 62°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.429 | 0.171 | 1.095 → 0.237 |
| Saturday, dry 62°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Saturday, dry 62°F | **Weighted total loss** | lower is better | | | 2.087 → **1.177** |
| Finals Wednesday, dry 45°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 1.355 | 1.561 | 0.096 → 0.000 |
| Finals Wednesday, dry 45°F | Busiest dining time (hour) | within 11–14h or 17–20h | 13.9 | 17.9 | 0.000 → 0.000 |
| Finals Wednesday, dry 45°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 |
| Finals Wednesday, dry 45°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.477 | 0.160 | 1.887 → 0.299 |
| Finals Wednesday, dry 45°F | Median walk (minutes) | ≤ 10 | 5.058 | 5.452 | 0.000 → 0.000 |
| Finals Wednesday, dry 45°F | Walks longer than 1.5 km | ≤ 5% | 0.045 | 0.042 | 0.000 → 0.000 |
| Finals Wednesday, dry 45°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.426 | 0.129 | 1.085 → 0.096 |
| Finals Wednesday, dry 45°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Finals Wednesday, dry 45°F | **Weighted total loss** | lower is better | | | 2.572 → **0.321** |
| Rainy Wednesday, 50°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 1.354 | 1.557 | 0.098 → 0.000 |
| Rainy Wednesday, 50°F | Busiest dining time (hour) | within 11–14h or 17–20h | 13.9 | 17.9 | 0.000 → 0.000 |
| Rainy Wednesday, 50°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 |
| Rainy Wednesday, 50°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.477 | 0.228 | 1.887 → 0.638 |
| Rainy Wednesday, 50°F | Median walk (minutes) | ≤ 10 | 5.058 | 5.662 | 0.000 → 0.000 |
| Rainy Wednesday, 50°F | Walks longer than 1.5 km | ≤ 5% | 0.045 | 0.050 | 0.000 → 0.004 |
| Rainy Wednesday, 50°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.425 | 0.101 | 1.085 → 0.002 |
| Rainy Wednesday, 50°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Rainy Wednesday, 50°F | People by the river at 15:00 in rain ÷ same day dry | ≤ 15% | — | 0.036 | — → 0.000 |
| Rainy Wednesday, 50°F | **Weighted total loss** | lower is better | | | 2.573 → **0.483** |

## Realism audit numbers (full roster, Wednesday)

| Quantity | Today’s model | Conditions engine |
|---|---|---|
| Dining halls, people at 12:00 | 182 | 1253 |
| Dining halls, people at 18:30 | 494 | 1571 |
| Mugar, people at 13:00 | 574 | 774 |
| Mugar, people at 21:00 | 617 | 689 |
| Mugar capacity (configured) | 800 | 800 |
| Optional visits rejected | 17893 | 31983 |
| Transit-stop walks (share of all walks) | 0.623 | 0.470 |
| Commuters making 4+ stop walks (share) | 0.327 | 0.073 |
| FitRec entries (day) | 1462 | 2919 |
| Largest one-minute rise in walkers | 2052 | 970 |
| Time of that rise (hour) | 11.0 | 21.3 |
| Peak walkers | 4299 | 4424 |
| People by the river at 15:00 | 0.000 | 275 |
| People by the river at 03:00 | 0.000 | 0.000 |

## Build time

- Conditions engine, Wednesday, classes, dry 62°F: 2485 ms
- Conditions engine, Saturday, dry 62°F: 1020 ms
- Conditions engine, Finals Wednesday, dry 45°F: 1618 ms
- Conditions engine, Rainy Wednesday, 50°F: 2561 ms

## Calibration search

- Method: Seeded random search (¼ of the budget) then coordinate descent with step halving; acceptance requires every metric’s loss to rise by at most the tolerance and the weighted total to fall; winner confirmed on the full roster.
- Seed: 7; inner-loop roster: every 4th student (9,245 of 36,977, capacities scaled to match), days: Wednesday, classes, dry 62°F; Saturday, dry 62°F; Finals Wednesday, dry 45°F
- Evaluations: 140 in 3.7 min; tolerance 0.02 per metric
- Tuned parameters (start → result): `activity.lunch.at` 11.5 → 11.5, `activity.lunch.spread` 3.000 → 2.750, `activity.dinner.at` 16.8 → 16.5, `activity.dinner.spread` 2.000 → 2.000, `activity.lunch.probability` 0.900 → 0.850, `activity.dinner.probability` 1.000 → 1.000, `offCampusMealShare` 0.350 → 0.350, `visitLengthSpread` 0.400 → 0.500, `activity.day-study.at` 10.0 → 10.0, `activity.day-study.spread` 7.500 → 7.500, `activity.day-study.minutes` 1.000 → 1.000, `activity.evening-study.probability` 1.000 → 1.000, `activity.workout.probability` 2.500 → 2.800, `commuterOffCampusGapMinutes` 240 → 270, `commuterActivityWindowMinutes` 90.0 → 90.0, `postClassLingerMinutes` 9.000 → 6.000, `activity.river-lawn.probability` 0.100 → 0.100, `activity.river-loop.probability` 0.070 → 0.050
- Inner-loop loss: 6.521 → 5.687
- Full-roster confirmation: accepted (no metric worse beyond tolerance, total improved); values written to behavior.json with provenance `fitted`

## Notes and limitations

- Library gate counts are from a small theology library in 2019–20; only their hourly shape is used. Mugar’s 800-seat capacity is a configured model value, not published.
- Bluebikes dock activity is a proxy for when people move around campus, not a pedestrian count.
- FitRec counts are entries (people can enter more than once) and include all FitRec users with a valid pass.
- Outdoor (BU Beach, Esplanade, river path) shares are assumptions; there are no counts in the data. They are bounded by sanity checks only.
- Only about 64% of catalog offerings map to buildings (unmatched building codes in the pipeline); unmapped course time is placed on BU’s class grid in BU buildings by the conditions engine.
- The simulated day still runs midnight to midnight; late-night presence after 24:00 is not modelled.
