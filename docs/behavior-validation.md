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
| Wednesday, classes, dry 62°F | FitRec entries by hour: correlation | r → 1 | 0.769 | 0.895 | 0.231 → 0.105 |
| Wednesday, classes, dry 62°F | FitRec entries per day: simulated ÷ measured | 1.0 | 0.503 | 0.908 | 0.687 → 0.097 |
| Wednesday, classes, dry 62°F | FitRec busiest hour: simulated − measured (hours) | 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Library entries by hour vs historical gate counts: correlation | r → 1 | -0.119 | 0.768 | 1.119 → 0.232 |
| Wednesday, classes, dry 62°F | Library occupancy 19–22h ÷ 13–16h | 0.8–2.5 (busy through the afternoon into the evening) | 1.835 | 0.459 | 0.000 → 0.427 |
| Wednesday, classes, dry 62°F | Library samples at ≥98% of capacity (08–24h) | ≤ 5% | 0.000 | 0.027 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Main dining halls, lunches: simulated ÷ published | 1.0 | 0.718 | 1.074 | 0.331 → 0.072 |
| Wednesday, classes, dry 62°F | Main dining halls, dinners: simulated ÷ published | 1.0 | 0.531 | 1.061 | 0.633 → 0.059 |
| Wednesday, classes, dry 62°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 1.670 | 1.619 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Busiest dining time (hour) | within 11–14h or 17–20h | 13.1 | 17.6 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Walk departures vs Bluebikes dock activity by hour (06–24h): correlation | r → 1 | 0.542 | 0.600 | 0.458 → 0.400 |
| Wednesday, classes, dry 62°F | Walkers 17–18h ÷ 08–09h, relative to published crossing counts | 1.0 | 0.569 | 0.623 | 0.282 → 0.237 |
| Wednesday, classes, dry 62°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.192 | 0.168 | 0.459 → 0.338 |
| Wednesday, classes, dry 62°F | Median walk (minutes) | ≤ 10 | 5.271 | 5.751 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Walks longer than 1.5 km | ≤ 5% | 0.058 | 0.056 | 0.085 → 0.062 |
| Wednesday, classes, dry 62°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.333 | 0.108 | 0.778 → 0.027 |
| Wednesday, classes, dry 62°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | Green Line B, BU stops (ons and offs): students’ timing vs counts (r) | r → 1 | 0.765 | 0.772 | 0.235 → 0.228 |
| Wednesday, classes, dry 62°F | Green Line B, BU stops (ons and offs): students’ busiest hour vs counted (hours apart) | 0 | 3.858 | 1.017 | 0.643 → 0.169 |
| Wednesday, classes, dry 62°F | Comm Ave crossings (2018 15-min, 2012 midday): students’ timing vs counts (r) | r → 1 | 0.124 | 0.176 | 0.876 → 0.824 |
| Wednesday, classes, dry 62°F | Comm Ave crossings (2018 15-min, 2012 midday): students’ busiest hour vs counted (hours apart) | 0 | 0.880 | 0.880 | 0.147 → 0.147 |
| Wednesday, classes, dry 62°F | Students above their plausible share of a count (all series, share of counted people) | ≤ 1% (band penalty) | 0.407 | 0.409 | 1.984 → 1.993 |
| Wednesday, classes, dry 62°F | Students, staff and public vs every count: median r | r → 1 | 0.970 | 0.974 | 0.030 → 0.026 |
| Wednesday, classes, dry 62°F | Students, staff and public vs every count: median total ratio | 0.85–1.15 | 1.007 | 1.008 | 0.000 → 0.000 |
| Wednesday, classes, dry 62°F | **Weighted total loss** | lower is better | | | 7.914 → **4.691** |
| Saturday, dry 62°F | FitRec entries by hour: correlation | r → 1 | 0.936 | 0.951 | 0.064 → 0.049 |
| Saturday, dry 62°F | FitRec entries per day: simulated ÷ measured | 1.0 | 0.903 | 0.944 | 0.102 → 0.057 |
| Saturday, dry 62°F | FitRec busiest hour: simulated − measured (hours) | 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Saturday, dry 62°F | Library entries by hour vs historical gate counts: correlation | r → 1 | 0.862 | 0.762 | 0.138 → 0.238 |
| Saturday, dry 62°F | Library occupancy 19–22h ÷ 13–16h | 0.8–2.5 (busy through the afternoon into the evening) | 0.160 | 0.152 | 0.800 → 0.809 |
| Saturday, dry 62°F | Library samples at ≥98% of capacity (08–24h) | ≤ 5% | 0.000 | 0.025 | 0.000 → 0.000 |
| Saturday, dry 62°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 2.576 | 2.094 | 0.000 → 0.000 |
| Saturday, dry 62°F | Busiest dining time (hour) | within 11–14h or 17–20h | 12.4 | 12.1 | 0.000 → 0.000 |
| Saturday, dry 62°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 |
| Saturday, dry 62°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.184 | 0.156 | 0.419 → 0.281 |
| Saturday, dry 62°F | Median walk (minutes) | ≤ 10 | 4.172 | 4.493 | 0.000 → 0.000 |
| Saturday, dry 62°F | Walks longer than 1.5 km | ≤ 5% | 0.040 | 0.040 | 0.000 → 0.000 |
| Saturday, dry 62°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.415 | 0.126 | 1.051 → 0.086 |
| Saturday, dry 62°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Saturday, dry 62°F | Green Line B, BU stops (ons and offs): students’ timing vs counts (r) | r → 1 | 0.051 | 0.051 | 0.949 → 0.949 |
| Saturday, dry 62°F | Green Line B, BU stops (ons and offs): students’ busiest hour vs counted (hours apart) | 0 | 7.744 | 7.744 | 1.291 → 1.291 |
| Saturday, dry 62°F | Students above their plausible share of a count (all series, share of counted people) | ≤ 1% (band penalty) | 0.003 | 0.003 | 0.000 → 0.000 |
| Saturday, dry 62°F | Students, staff and public vs every count: median r | r → 1 | 1.000 | 1.000 | 0.000 → 0.000 |
| Saturday, dry 62°F | Students, staff and public vs every count: median total ratio | 0.85–1.15 | 1.000 | 1.000 | 0.000 → 0.000 |
| Saturday, dry 62°F | **Weighted total loss** | lower is better | | | 3.664 → **2.640** |
| Finals Wednesday, dry 45°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 1.667 | 1.688 | 0.000 → 0.000 |
| Finals Wednesday, dry 45°F | Busiest dining time (hour) | within 11–14h or 17–20h | 13.1 | 13.1 | 0.000 → 0.000 |
| Finals Wednesday, dry 45°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 |
| Finals Wednesday, dry 45°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.192 | 0.143 | 0.459 → 0.217 |
| Finals Wednesday, dry 45°F | Median walk (minutes) | ≤ 10 | 5.271 | 5.373 | 0.000 → 0.000 |
| Finals Wednesday, dry 45°F | Walks longer than 1.5 km | ≤ 5% | 0.058 | 0.049 | 0.084 → 0.000 |
| Finals Wednesday, dry 45°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.333 | 0.104 | 0.778 → 0.012 |
| Finals Wednesday, dry 45°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Finals Wednesday, dry 45°F | **Weighted total loss** | lower is better | | | 1.164 → **0.175** |
| Rainy Wednesday, 50°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 1.670 | 1.573 | 0.000 → 0.000 |
| Rainy Wednesday, 50°F | Busiest dining time (hour) | within 11–14h or 17–20h | 13.1 | 13.4 | 0.000 → 0.000 |
| Rainy Wednesday, 50°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 |
| Rainy Wednesday, 50°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.192 | 0.140 | 0.459 → 0.202 |
| Rainy Wednesday, 50°F | Median walk (minutes) | ≤ 10 | 5.271 | 5.658 | 0.000 → 0.000 |
| Rainy Wednesday, 50°F | Walks longer than 1.5 km | ≤ 5% | 0.058 | 0.060 | 0.085 → 0.100 |
| Rainy Wednesday, 50°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.333 | 0.090 | 0.778 → 0.000 |
| Rainy Wednesday, 50°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 |
| Rainy Wednesday, 50°F | People by the river at 15:00 in rain ÷ same day dry | ≤ 15% | — | 0.047 | — → 0.000 |
| Rainy Wednesday, 50°F | **Weighted total loss** | lower is better | | | 1.164 → **0.202** |

## Realism audit numbers (full roster, Wednesday)

| Quantity | Today’s model | Conditions engine |
|---|---|---|
| Dining halls, people at 12:00 | 544 | 1811 |
| Dining halls, people at 18:30 | 452 | 1777 |
| Mugar, people at 13:00 | 95.0 | 501 |
| Mugar, people at 21:00 | 518 | 668 |
| Mugar capacity (configured) | 800 | 800 |
| Optional visits rejected | 25208 | 34536 |
| Transit-stop walks (share of all walks) | 0.643 | 0.500 |
| Commuters making 4+ stop walks (share) | 0.270 | 0.083 |
| FitRec entries (day) | 2061 | 3719 |
| Largest one-minute rise in walkers | 1325 | 1121 |
| Time of that rise (hour) | 11.0 | 12.2 |
| Peak walkers | 6909 | 6685 |
| People by the river at 15:00 | 0.000 | 64.0 |
| People by the river at 03:00 | 0.000 | 0.000 |

## Observed MBTA ridership and pedestrian counts

Scored with `scoreObservations` (src/sim/validate.ts) on the series in `public/data/calibration-observations.json` (see docs/calibration-observations.md). Students are the only people in university buildings; streets and the T also carry the public crowd (sim/publicCrowd.ts), which fills observed − students wherever students fall short, so students + public match by construction except where students alone exceed a count. The calibration therefore scores: the **timing of the students' own peaks** at BU-dominated places (B branch BU stops, ons and offs with both directions added; Comm Ave crosswalks, 2018 15-min and 2012 midday), as volume-weighted Pearson r and hours between busiest bins, weighted like FitRec and the library; a **band penalty** where students exceed their plausible share of a count ("overflow": students above observed × the series' high expected student share, as a share of everyone counted); and students + public shape and level over all primary series (public fill per publicCrowd.ts's rule).

**Wednesday, classes, dry 62°F**

| Series group | n | Today’s model: students r / peak h / ratio / overflow | Before this calibration: students r / peak h / ratio / overflow | After calibration: students r / peak h / ratio / overflow |
|---|---|---|---|---|
| Green Line B, BU stops (ons and offs) | 10 | 0.76 / 3.9 / 0.88 / 0.27 | 0.77 / 1.0 / 0.65 / 0.11 | 0.77 / 1.0 / 0.65 / 0.11 |
| Comm Ave crossings (2018 15-min, 2012 midday) | 11 | 0.12 / 0.9 / 1.27 / 0.67 | 0.18 / 0.9 / 1.29 / 0.63 | 0.18 / 0.9 / 1.28 / 0.63 |
| Green Line C and D (St Mary’s, Hawes, Kent, Fenway, Longwood) | 20 | 0.34 / 4.9 / 0.72 / 0.56 | 0.33 / 6.0 / 0.53 / 0.38 | 0.33 / 6.0 / 0.54 / 0.38 |
| Kenmore (gated entries and Green Line at Kenmore) | 7 | — / — / 0.00 / 0.00 | — / — / 0.00 / 0.00 | — / — / 0.00 / 0.00 |
| Buses (routes 1, 8, 10, 47, 57, 749, 751) | 168 | 0.45 / 2.8 / 0.38 / 0.24 | 0.46 / 2.8 / 0.29 / 0.16 | 0.46 / 2.8 / 0.29 / 0.16 |
| All pedestrian count sites | 32 | 0.11 / 1.3 / 0.98 / 0.47 | 0.16 / 1.3 / 1.05 / 0.50 | 0.16 / 1.3 / 1.05 / 0.50 |
| Every scored series | 247 | 0.19 / 1.6 / 0.83 / 0.41 | 0.23 / 1.6 / 0.86 / 0.41 | 0.23 / 1.6 / 0.85 / 0.41 |

- Today’s model: students alone median r 0.42, median ratio 0.15; students + public median r 0.97, median ratio 1.01 (247 series); students through Kenmore's gates 0
- Before this calibration: students alone median r 0.41, median ratio 0.10; students + public median r 0.97, median ratio 1.01 (247 series); students through Kenmore's gates 0
- After calibration: students alone median r 0.42, median ratio 0.10; students + public median r 0.97, median ratio 1.01 (247 series); students through Kenmore's gates 0

**Saturday, dry 62°F**

| Series group | n | Today’s model: students r / peak h / ratio / overflow | Before this calibration: students r / peak h / ratio / overflow | After calibration: students r / peak h / ratio / overflow |
|---|---|---|---|---|
| Green Line B, BU stops (ons and offs) | 10 | 0.05 / 7.7 / 0.00 / 0.00 | 0.05 / 7.7 / 0.00 / 0.00 | 0.05 / 7.7 / 0.00 / 0.00 |
| Comm Ave crossings (2018 15-min, 2012 midday) | 0 | — / — / — / 0.00 | — / — / — / 0.00 | — / — / — / 0.00 |
| Green Line C and D (St Mary’s, Hawes, Kent, Fenway, Longwood) | 20 | 0.01 / 5.9 / 0.02 / 0.00 | 0.07 / 5.8 / 0.02 / 0.00 | 0.08 / 6.0 / 0.02 / 0.00 |
| Kenmore (gated entries and Green Line at Kenmore) | 7 | — / — / 0.00 / 0.00 | — / — / 0.00 / 0.00 | — / — / 0.00 / 0.00 |
| Buses (routes 1, 8, 10, 47, 57, 749, 751) | 160 | 0.13 / 4.9 / 0.01 / 0.01 | 0.13 / 4.8 / 0.01 / 0.01 | 0.13 / 4.8 / 0.01 / 0.01 |
| All pedestrian count sites | 0 | — / — / — / 0.00 | — / — / — / 0.00 | — / — / — / 0.00 |
| Every scored series | 207 | 0.09 / 5.3 / 0.01 / 0.00 | 0.11 / 5.2 / 0.01 / 0.00 | 0.11 / 5.2 / 0.01 / 0.00 |

- Today’s model: students alone median r 0.13, median ratio 0.00; students + public median r 1.00, median ratio 1.00 (207 series); students through Kenmore's gates 0
- Before this calibration: students alone median r 0.13, median ratio 0.00; students + public median r 1.00, median ratio 1.00 (207 series); students through Kenmore's gates 0
- After calibration: students alone median r 0.13, median ratio 0.00; students + public median r 1.00, median ratio 1.00 (207 series); students through Kenmore's gates 0

## Build time

- Conditions engine, Wednesday, classes, dry 62°F: 8386 ms
- Conditions engine, Saturday, dry 62°F: 1678 ms
- Conditions engine, Finals Wednesday, dry 45°F: 5081 ms
- Conditions engine, Rainy Wednesday, 50°F: 9029 ms

## Calibration search

- Method: Seeded random search (¼ of the budget) then coordinate descent with step halving; acceptance requires every metric’s loss to rise by at most the tolerance and the weighted total to fall; winner confirmed on the full roster.
- Seed: 7; inner-loop roster: every 4th student (12,030 of 48,117, capacities scaled to match), days: Wednesday, classes, dry 62°F; Saturday, dry 62°F; Finals Wednesday, dry 45°F
- Evaluations: 40 in 3.6 min; tolerance 0.02 per metric
- Tuned parameters (start → result): `activity.lunch.at` 11.8 → 11.8, `activity.lunch.spread` 2.250 → 2.250, `activity.dinner.at` 16.5 → 16.5, `activity.dinner.spread` 1.500 → 1.500, `activity.lunch.probability` 0.850 → 0.800, `activity.dinner.probability` 1.100 → 1.100, `offCampusMealShare` 0.350 → 0.350, `visitLengthSpread` 0.450 → 0.450, `activity.day-study.at` 10.0 → 10.0, `activity.day-study.spread` 7.500 → 7.500, `activity.day-study.minutes` 1.000 → 1.000, `activity.evening-study.probability` 1.000 → 1.000, `activity.workout.probability` 3.000 → 3.100, `commuterOffCampusGapMinutes` 300 → 300, `commuterActivityWindowMinutes` 90.0 → 90.0, `postClassLingerMinutes` 6.000 → 5.000, `activity.river-lawn.probability` 0.025 → 0.025, `activity.river-loop.probability` 0.020 → 0.010, `classAttendance` 1.000 → 1.000, `homeBreakMinutes` 30.0 → 30.0, `arrivalLeadSpreadMinutes` 10.0 → 10.0
- Inner-loop loss: 7.615 → 7.479
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
