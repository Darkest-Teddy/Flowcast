# Behaviour validation

Generated on 2026-10-25 by `npm run validate:behavior` / `npm run calibrate` (map-client/scripts/validate-behavior.mjs, calibrate-behavior.mjs). Everything runs locally: the simulation is imported headlessly from `map-client/src/sim`, scored against measured BU data in the repo, and no network or AI service is used.

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
| Wednesday, classes, dry 62°F | FitRec entries by hour: correlation | r → 1 | 0.903 | 0.952 | 0.097 → 0.048 |
| Wednesday, classes, dry 62°F | FitRec entries per day: simulated ÷ measured | 1.0 | 0.356 | 0.756 | 1.032 → 0.280 |
| Wednesday, classes, dry 62°F | FitRec busiest hour: simulated − measured (hours) | 0 | 2.000 | 2.000 | 0.333 → 0.333 |
| Wednesday, classes, dry 62°F | Library entries by hour vs historical gate counts: correlation | r → 1 | -0.134 | 0.779 | 1.134 → 0.221 |
| Wednesday, classes, dry 62°F | Library occupancy 19–22h ÷ 13–16h | 0.8–2.5 (busy through the afternoon into the evening) | 1.598 | 0.457 | 0.000 → 0.429 |
| Wednesday, classes, dry 62°F | Library samples at ≥98% of capacity (08–24h) | ≤ 5% | 0.006 | 0.027 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Main dining halls, lunches: simulated ÷ published | 1.0 | 0.496 | 0.984 | 0.701 → 0.016 |
| Wednesday, classes, dry 62°F | Main dining halls, dinners: simulated ÷ published | 1.0 | 0.450 | 0.966 | 0.799 → 0.035 |
| Wednesday, classes, dry 62°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 1.391 | 1.538 | 0.073 → 0.000 |
| Wednesday, classes, dry 62°F | Busiest dining time (hour) | within 11–14h or 17–20h | 13.9 | 17.6 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Walk departures vs Bluebikes dock activity by hour (06–24h): correlation | r → 1 | 0.460 | 0.544 | 0.540 → 0.456 |
| Wednesday, classes, dry 62°F | Walkers 17–18h ÷ 08–09h, relative to published crossing counts | 1.0 | 0.644 | 0.742 | 0.220 → 0.149 |
| Wednesday, classes, dry 62°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.499 | 0.195 | 1.996 → 0.473 |
| Wednesday, classes, dry 62°F | Median walk (minutes) | ≤ 10 | 5.305 | 5.871 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Walks longer than 1.5 km | ≤ 5% | 0.062 | 0.058 | 0.119 → 0.084 |
| Wednesday, classes, dry 62°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.421 | 0.118 | 1.069 → 0.061 |
| Wednesday, classes, dry 62°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Green Line B, BU stops (ons and offs): students’ timing vs counts (r) | r → 1 | 0.779 | 0.788 | 0.221 → 0.212 |
| Wednesday, classes, dry 62°F | Green Line B, BU stops (ons and offs): students’ busiest hour vs counted (hours apart) | 0 | 3.548 | 1.374 | 0.591 → 0.229 |
| Wednesday, classes, dry 62°F | Comm Ave crossings (2018 15-min, 2012 midday): students’ timing vs counts (r) | r → 1 | 0.106 | 0.157 | 0.894 → 0.843 |
| Wednesday, classes, dry 62°F | Comm Ave crossings (2018 15-min, 2012 midday): students’ busiest hour vs counted (hours apart) | 0 | 0.880 | 0.880 | 0.147 → 0.147 |
| Wednesday, classes, dry 62°F | Students above their plausible share of a count (all series, share of counted people) | ≤ 1% (band penalty) | 0.402 | 0.392 | 1.958 → 1.911 |
| Wednesday, classes, dry 62°F | Students + public vs every count: median r | r → 1 | 0.989 | 0.993 | 0.011 → 0.007 |
| Wednesday, classes, dry 62°F | Students + public vs every count: median total ratio | 0.85–1.15 | 1.000 | 1.000 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | **Weighted total loss** | lower is better | | | 10.2 → **4.999** |
| Saturday, dry 62°F | FitRec entries by hour: correlation | r → 1 | 0.921 | 0.944 | 0.079 → 0.056 |
| Saturday, dry 62°F | FitRec entries per day: simulated ÷ measured | 1.0 | 0.972 | 0.987 | 0.028 → 0.013 |
| Saturday, dry 62°F | FitRec busiest hour: simulated − measured (hours) | 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Saturday, dry 62°F | Library entries by hour vs historical gate counts: correlation | r → 1 | 0.859 | 0.752 | 0.141 → 0.248 |
| Saturday, dry 62°F | Library occupancy 19–22h ÷ 13–16h | 0.8–2.5 (busy through the afternoon into the evening) | 0.139 | 0.135 | 0.827 → 0.832 |
| Saturday, dry 62°F | Library samples at ≥98% of capacity (08–24h) | ≤ 5% | 0.003 | 0.022 | 0.000 → 0.000 |
| Saturday, dry 62°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 2.644 | 2.101 | 0.000 → 0.000 |
| Saturday, dry 62°F | Busiest dining time (hour) | within 11–14h or 17–20h | 12.4 | 17.6 | 0.000 → 0.000 |
| Saturday, dry 62°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 |
| Saturday, dry 62°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.195 | 0.137 | 0.474 → 0.184 |
| Saturday, dry 62°F | Median walk (minutes) | ≤ 10 | 3.970 | 4.766 | 0.000 → 0.000 |
| Saturday, dry 62°F | Walks longer than 1.5 km | ≤ 5% | 0.039 | 0.046 | 0.000 → 0.000 |
| Saturday, dry 62°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.427 | 0.127 | 1.091 → 0.089 |
| Saturday, dry 62°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Saturday, dry 62°F | Green Line B, BU stops (ons and offs): students’ timing vs counts (r) | r → 1 | 0.127 | 0.142 | 0.873 → 0.858 |
| Saturday, dry 62°F | Green Line B, BU stops (ons and offs): students’ busiest hour vs counted (hours apart) | 0 | 4.780 | 4.820 | 0.797 → 0.803 |
| Saturday, dry 62°F | Students above their plausible share of a count (all series, share of counted people) | ≤ 1% (band penalty) | 0.003 | 0.003 | 0.000 → 0.000 |
| Saturday, dry 62°F | Students + public vs every count: median r | r → 1 | 1.000 | 1.000 | 0.000 → 0.000 |
| Saturday, dry 62°F | Students + public vs every count: median total ratio | 0.85–1.15 | 1.000 | 1.000 | 0.000 → 0.000 |
| Saturday, dry 62°F | **Weighted total loss** | lower is better | | | 3.379 → **2.220** |
| Finals Wednesday, dry 45°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 1.390 | 1.531 | 0.074 → 0.000 |
| Finals Wednesday, dry 45°F | Busiest dining time (hour) | within 11–14h or 17–20h | 13.9 | 17.6 | 0.000 → 0.000 |
| Finals Wednesday, dry 45°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 |
| Finals Wednesday, dry 45°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.499 | 0.168 | 1.995 → 0.338 |
| Finals Wednesday, dry 45°F | Median walk (minutes) | ≤ 10 | 5.307 | 5.587 | 0.000 → 0.000 |
| Finals Wednesday, dry 45°F | Walks longer than 1.5 km | ≤ 5% | 0.062 | 0.053 | 0.119 → 0.027 |
| Finals Wednesday, dry 45°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.421 | 0.103 | 1.069 → 0.011 |
| Finals Wednesday, dry 45°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Finals Wednesday, dry 45°F | **Weighted total loss** | lower is better | | | 2.680 → **0.278** |
| Rainy Wednesday, 50°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 1.391 | 1.517 | 0.073 → 0.000 |
| Rainy Wednesday, 50°F | Busiest dining time (hour) | within 11–14h or 17–20h | 13.9 | 13.6 | 0.000 → 0.000 |
| Rainy Wednesday, 50°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 |
| Rainy Wednesday, 50°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.499 | 0.201 | 1.996 → 0.507 |
| Rainy Wednesday, 50°F | Median walk (minutes) | ≤ 10 | 5.305 | 5.771 | 0.000 → 0.000 |
| Rainy Wednesday, 50°F | Walks longer than 1.5 km | ≤ 5% | 0.062 | 0.063 | 0.119 → 0.130 |
| Rainy Wednesday, 50°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.421 | 0.092 | 1.069 → 0.000 |
| Rainy Wednesday, 50°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Rainy Wednesday, 50°F | People by the river at 15:00 in rain ÷ same day dry | ≤ 15% | — | 0.018 | — → 0.000 |
| Rainy Wednesday, 50°F | **Weighted total loss** | lower is better | | | 2.680 → **0.445** |

## Realism audit numbers (full roster, Wednesday)

| Quantity | Today’s model | Conditions engine |
|---|---|---|
| Dining halls, people at 12:00 | 233 | 1583 |
| Dining halls, people at 18:30 | 471 | 1749 |
| Mugar, people at 13:00 | 79.0 | 369 |
| Mugar, people at 21:00 | 431 | 555 |
| Mugar capacity (configured) | 800 | 800 |
| Optional visits rejected | 25421 | 35684 |
| Transit-stop walks (share of all walks) | 0.632 | 0.457 |
| Commuters making 4+ stop walks (share) | 0.335 | 0.081 |
| FitRec entries (day) | 1460 | 3097 |
| Largest one-minute rise in walkers | 3253 | 1314 |
| Time of that rise (hour) | 11.0 | 21.3 |
| Peak walkers | 6517 | 6750 |
| People by the river at 15:00 | 0.000 | 165 |
| People by the river at 03:00 | 0.000 | 0.000 |

## Observed MBTA ridership and pedestrian counts

Scored with `scoreObservations` (src/sim/validate.ts) on the series in `public/data/calibration-observations.json` (see docs/calibration-observations.md). Students are the only people in university buildings; streets and the T also carry the public crowd (sim/publicCrowd.ts), which fills observed − students wherever students fall short, so students + public match by construction except where students alone exceed a count. The calibration therefore scores: the **timing of the students' own peaks** at BU-dominated places (B branch BU stops, ons and offs with both directions added; Comm Ave crosswalks, 2018 15-min and 2012 midday), as volume-weighted Pearson r and hours between busiest bins, weighted like FitRec and the library; a **band penalty** where students exceed their plausible share of a count ("overflow": students above observed × the series' high expected student share, as a share of everyone counted); and students + public shape and level over all primary series (public fill per publicCrowd.ts's rule).

**Wednesday, classes, dry 62°F**

| Series group | n | Today’s model: students r / peak h / ratio / overflow | Before this calibration: students r / peak h / ratio / overflow | After calibration: students r / peak h / ratio / overflow |
|---|---|---|---|---|
| Green Line B, BU stops (ons and offs) | 10 | 0.78 / 3.5 / 1.03 / 0.37 | 0.79 / 1.4 / 0.77 / 0.16 | 0.79 / 1.4 / 0.77 / 0.16 |
| Comm Ave crossings (2018 15-min, 2012 midday) | 11 | 0.11 / 0.9 / 1.25 / 0.66 | 0.16 / 0.9 / 1.25 / 0.61 | 0.16 / 0.9 / 1.25 / 0.60 |
| Green Line C and D (St Mary’s, Hawes, Kent, Fenway, Longwood) | 20 | 0.34 / 4.5 / 0.68 / 0.52 | 0.33 / 5.6 / 0.51 / 0.36 | 0.33 / 5.7 / 0.51 / 0.36 |
| Kenmore (gated entries and Green Line at Kenmore) | 7 | — / — / 0.00 / 0.00 | — / — / 0.00 / 0.00 | — / — / 0.00 / 0.00 |
| Buses (routes 1, 8, 10, 47, 57, 749, 751) | 168 | 0.45 / 2.9 / 0.36 / 0.23 | 0.46 / 2.8 / 0.28 / 0.15 | 0.46 / 2.9 / 0.27 / 0.15 |
| All pedestrian count sites | 32 | 0.10 / 1.3 / 0.96 / 0.46 | 0.14 / 1.3 / 1.02 / 0.48 | 0.14 / 1.3 / 1.02 / 0.48 |
| Every scored series | 247 | 0.18 / 1.6 / 0.81 / 0.40 | 0.21 / 1.6 / 0.83 / 0.39 | 0.21 / 1.6 / 0.83 / 0.39 |

- Today’s model: students alone median r 0.42, median ratio 0.15; students + public median r 0.99, median ratio 1.00 (247 series); students through Kenmore's gates 0
- Before this calibration: students alone median r 0.42, median ratio 0.10; students + public median r 0.99, median ratio 1.00 (247 series); students through Kenmore's gates 0
- After calibration: students alone median r 0.42, median ratio 0.10; students + public median r 0.99, median ratio 1.00 (247 series); students through Kenmore's gates 0

**Saturday, dry 62°F**

| Series group | n | Today’s model: students r / peak h / ratio / overflow | Before this calibration: students r / peak h / ratio / overflow | After calibration: students r / peak h / ratio / overflow |
|---|---|---|---|---|
| Green Line B, BU stops (ons and offs) | 10 | 0.13 / 4.8 / 0.02 / 0.00 | 0.14 / 4.8 / 0.02 / 0.00 | 0.14 / 4.8 / 0.02 / 0.00 |
| Comm Ave crossings (2018 15-min, 2012 midday) | 0 | — / — / — / 0.00 | — / — / — / 0.00 | — / — / — / 0.00 |
| Green Line C and D (St Mary’s, Hawes, Kent, Fenway, Longwood) | 20 | 0.03 / 5.9 / 0.02 / 0.01 | 0.10 / 6.2 / 0.02 / 0.01 | 0.10 / 6.1 / 0.02 / 0.01 |
| Kenmore (gated entries and Green Line at Kenmore) | 7 | — / — / 0.00 / 0.00 | — / — / 0.00 / 0.00 | — / — / 0.00 / 0.00 |
| Buses (routes 1, 8, 10, 47, 57, 749, 751) | 160 | 0.10 / 4.9 / 0.01 / 0.01 | 0.11 / 4.9 / 0.01 / 0.01 | 0.11 / 4.9 / 0.01 / 0.01 |
| All pedestrian count sites | 0 | — / — / — / 0.00 | — / — / — / 0.00 | — / — / — / 0.00 |
| Every scored series | 207 | 0.09 / 5.4 / 0.01 / 0.00 | 0.11 / 5.4 / 0.01 / 0.00 | 0.11 / 5.4 / 0.01 / 0.00 |

- Today’s model: students alone median r 0.05, median ratio 0.00; students + public median r 1.00, median ratio 1.00 (207 series); students through Kenmore's gates 0
- Before this calibration: students alone median r 0.05, median ratio 0.00; students + public median r 1.00, median ratio 1.00 (207 series); students through Kenmore's gates 0
- After calibration: students alone median r 0.05, median ratio 0.00; students + public median r 1.00, median ratio 1.00 (207 series); students through Kenmore's gates 0

## Build time

- Conditions engine, Wednesday, classes, dry 62°F: 3971 ms
- Conditions engine, Saturday, dry 62°F: 1026 ms
- Conditions engine, Finals Wednesday, dry 45°F: 2560 ms
- Conditions engine, Rainy Wednesday, 50°F: 4316 ms

## Calibration search

- Method: Seeded random search (¼ of the budget) then coordinate descent with step halving; acceptance requires every metric’s loss to rise by at most the tolerance and the weighted total to fall; winner confirmed on the full roster.
- Seed: 11; inner-loop roster: every 3th student (12,326 of 36,977, capacities scaled to match), days: Wednesday, classes, dry 62°F; Saturday, dry 62°F; Finals Wednesday, dry 45°F
- Evaluations: 110 in 5.0 min; tolerance 0.02 per metric
- Tuned parameters (start → result): `activity.lunch.at` 11.5 → 11.8, `activity.lunch.spread` 2.750 → 2.250, `activity.dinner.at` 16.5 → 16.5, `activity.dinner.spread` 2.000 → 1.500, `activity.lunch.probability` 0.850 → 0.850, `activity.dinner.probability` 1.000 → 1.100, `offCampusMealShare` 0.350 → 0.350, `visitLengthSpread` 0.500 → 0.500, `activity.day-study.at` 10.0 → 10.0, `activity.day-study.spread` 7.500 → 7.500, `activity.day-study.minutes` 1.000 → 1.000, `activity.evening-study.probability` 1.000 → 1.000, `activity.workout.probability` 2.800 → 3.000, `commuterOffCampusGapMinutes` 270 → 300, `commuterActivityWindowMinutes` 90.0 → 90.0, `postClassLingerMinutes` 6.000 → 6.000, `activity.river-lawn.probability` 0.100 → 0.060, `activity.river-loop.probability` 0.050 → 0.040, `classAttendance` 1.000 → 1.000, `homeBreakMinutes` 15.0 → 30.0, `arrivalLeadSpreadMinutes` 10.0 → 10.0
- Inner-loop loss: 9.408 → 8.988
- Full-roster confirmation: accepted (no metric worse beyond tolerance, total improved); values written to behavior.json with provenance `fitted`

## Notes and limitations

- Library gate counts are from a small theology library in 2019–20; only their hourly shape is used. Mugar’s 800-seat capacity is a configured model value, not published.
- Bluebikes dock activity is a proxy for when people move around campus, not a pedestrian count.
- FitRec counts are entries (people can enter more than once) and include all FitRec users with a valid pass.
- Outdoor (BU Beach, Esplanade, river path) shares are assumptions; there are no counts in the data. They are bounded by sanity checks only.
- Only about 64% of catalog offerings map to buildings (unmatched building codes in the pipeline); unmapped course time is placed on BU’s class grid in BU buildings by the conditions engine.
- The simulated day still runs midnight to midnight; late-night presence after 24:00 is not modelled.
- Observed counts, findings for the day builder (not engine parameters): no student enters through Kenmore's gates or rides from the Fenway or Longwood stations, because the transit planner's campus stop set and weights (transitService.ts / sourceDay.ts commutes) never pick them.
- Students alone exceed the counts at Green Line C stops (Hawes Street: 150 student alightings a day toward Cleveland Circle vs 30 counted; Kent Street 144 vs 32) and at several Route 57 stops (e.g. stop 933: 250 student boardings vs 104 counted): the planner weights a commuter's stop by published weekly trips, which loads the C branch and the 57; the engine has no parameter for stop choice.
- Comm Ave crosswalks see 2–4× the counted crossings in the 12:00–12:15 class change (Granby 2,164 vs 543; Cummington 2,176 vs 447; St Mary's 1,696 vs 706): weekly enrollment spreads each student's classes across the campus, so most class changes cross Comm Ave. Attendance below 100% and longer minimum trips home help only a little; the fit kept attendance at 100% because lowering it also cut dining-hall meals below BU Dining's counts.
- On Saturdays almost no students ride (B branch BU stops 2% of counts): commuters only come in on class days and residents' outings walk to a gateway rather than board a published trip.
