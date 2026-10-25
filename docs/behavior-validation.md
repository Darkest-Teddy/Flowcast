# Behaviour validation

Generated on 2026-10-25 by `npm run validate:behavior` / `npm run calibrate` (map-client/scripts/validate-behavior.mjs, calibrate-behavior.mjs). Everything runs locally: the simulation is imported headlessly from `map-client/src/sim`, scored against measured BU data in the repo, and no network or AI service is used.

**Columns.** *Today’s model* is `buildSourceDay` with no conditions (the unconditioned planner from this checkout). *Conditions engine* is the same roster with `behavior.json` + `personas.json` + `outdoor.json` and the day's conditions, which is what the map runs. Both columns use the same implementation; they do not compare before and after a code change. Loss is ≥ 0 per metric (0 = on target); a proposal is accepted only if every existing metric remains present, no positively weighted non-assumption metric's loss rises by more than the tolerance, and the weighted total falls. Historical comparisons retain their original weights. Assumed sanity targets contribute soft penalties at 10% of their original weights, without individual regression vetoes. This factor is a modeling choice, not an empirical estimate. Indirect proxies, historical context with unknown comparability, and input reconstructions have zero weight. Rain/finals with no comparable observations are not evaluated for accuracy. Relative metric weights still encode modeling priorities; this total is not an accuracy percentage. Totals using these weights are not comparable with older reports.

## Measured series and targets

- **FitRec** hourly entries, Oct 17–23 2026 (BU FitRec peak/quiet hours report), same weekday: daily total ratio is diagnostic because measured entries include non-students; hourly correlation and busiest hour are diagnostic only because the planner samples arrival times from these same observations.
- **Library** historical patron/zone aggregates (School of Theology Library, 2019–20) vs simulated Theology Library entries. The source counting method is unknown, so this is context only; it is not verified gate-count or occupancy validation.
- **Bluebikes** dock arrivals + departures at Charles River BU docks, average September 2026 Wednesday, hourly, vs simulated walk departures (activity-timing proxy).
- **Dining**: 2017 published meal aggregates are historical context, not current occupancy targets. Meal-time and saturation checks are assumed sanity targets only.
- **Pedestrian counts**: simulated crossings at the surveyed locations and measured intervals, on the recorded weekdays. The Warren 2023 PM/AM ratio uses paired crossing bins at those same sites. Tuesday 2012 and Thursday 2018 surveys are evaluated on Tuesday and Thursday respectively, not Wednesday.
- **Sanity**: walkers at 3 am, one-minute walker spikes, median and long walks, commuter stop walks, people by the river at 3 am and in rain.

## Observation coverage

Simulation reference week starts 2026-10-26. Historical observations are not measurements of that simulated week.

FitRec snapshot: 2026-10-17 to 2026-10-23; 119 observed hour cells. Entries include all pass holders, not student-only occupancy.

Library: School of Theology Library; 2019-06-18 to 2020-02-29. Historical patron/zone counts; counting method unknown, not verified occupancy.

Transit and pedestrian source periods in the saved bundle:

- [Fall 2025 MBTA Rail Ridership by Hour, Route/Line, and Stop](https://mbta-massdot.opendata.arcgis.com/datasets/6494749a29c648018820d0e49636205c): Fall 2025 service rating; averages over non-holiday days, diversion days excluded per line; 156 series, 3744 recorded bins.
- [MBTA Bus Ridership by Trip, Season, Route/Line, and Stop (Fall 2025)](https://mbta-massdot.opendata.arcgis.com/datasets/8daf4a33925a4df59183f860826d29ee): Fall 2025 APC rating; day types Wkdy (Mon-Thu), Fri, Sat, Sun; holidays excluded; 655 series, 15720 recorded bins.
- [BU Data Sciences Center Project Notification Form (AECOM, 2018): pedestrian crosswalk counts](https://www.bu.edu/community/files/2018/10/BU-Data-Sciences-Center-PNF-Final-Draft-9-27-18.pdf): 2018-04-12 (Thursday, spring term): 07:00-09:00, 11:00-13:00, 16:00-18:00 in 15-minute bins; 7 series, 124 recorded bins.
- [BU Charles River Campus 2013-2023 Transportation Master Plan (Tetra Tech, Jan 2013): midday pedestrian counts](https://www.bu.edu/community/files/2016/03/2013-2023-BU-Charles-River-Campus-Transportation-Master-Plan_January-17-2013.pdf): 2012-03-20 (Tuesday, spring term), 12:00-14:00 in 15-minute bins; 6 series, 48 recorded bins.
- [Boston Medical Center Institutional Master Plan 2021-2031, appendix: PDI pedestrian counts for VHB](https://www.bostonplans.org/getattachment/3a581fc0-10ce-42c8-8d09-d41dc0d304d7): 2019-12-05 (Thursday, the week before BU finals): 07:00-09:00 and 16:00-18:00 in 15-minute bins; 12 series, 192 recorded bins.
- [Boston University Warren Towers Expanded Project Notification Form (Feb 2024), Table 7-6](https://www.bu.edu/community/files/2024/02/Warren-Towers-EPNF.pdf): 2023-10-18 to 2023-10-19 (Wed/Thu), AM 8-9 and PM 5-6 peak hours; 7 series, 14 recorded bins.
- [Boston Region MPO (CTPS) Bicycle/Pedestrian Counts](https://www.ctps.org/geoserver/www/apps/bp-counts-app-01262024/index.html): 2001-08-15, 2005-05-10, 2007-09-08, 2008-05-06, 2008-07-12, 2008-07-15, 2008-07-19, 2009-05-09, 2009-07-22, 2009-07-25, 2010-05-04, 2010-05-11, 2010-09-11, 2010-09-14, 2012-09-12, 2012-09-13, 2012-09-15, 2012-09-22; 25 series, 652 recorded bins.
- [MBTA Gated Station Entries (station, service date, 30-minute period)](https://mbta-massdot.opendata.arcgis.com/datasets/001c177f07594e7c99f193dde32284c9): 2025-09-02 to 2025-11-25; 3 series, 139 recorded bins.
- [MBTA Gated Station Entries (station, service date, 30-minute period)](https://mbta-massdot.opendata.arcgis.com/datasets/001c177f07594e7c99f193dde32284c9): 2026-09-02 to 2026-09-26; 3 series, 137 recorded bins.

Transit and crossing observations count all people; simulated students are a subset. Correlations are historical reference comparisons, not measured student shares. Sparse faregate-bin means have varying reporting-date denominators; their sum is not a measured daily total.

No date-matched rainy-day pedestrian series is provided. Rain multipliers are assumptions and are not fitted or validated by this report.

## Scores

| Day | Metric | Target | Today’s model | Conditions engine | Loss before → after | Evidence basis | Calibration weight |
|---|---|---|---|---|---|---|---|
| Tuesday, classes, dry 62°F | FitRec input-profile reconstruction: hourly correlation | r → 1 | 0.796 | 0.878 | 0.204 → 0.122 | input reconstruction | 0 (diagnostic) |
| Tuesday, classes, dry 62°F | FitRec entries per day: simulated ÷ measured | 1.0 | 0.518 | 0.941 | 0.658 → 0.061 | indirect proxy | 0 (diagnostic) |
| Tuesday, classes, dry 62°F | FitRec input-profile reconstruction: peak gap (hours) | 0 | 1.000 | 1.000 | 0.167 → 0.167 | input reconstruction | 0 (diagnostic) |
| Tuesday, classes, dry 62°F | Theology Library entries vs historical patron/zone counts (method unknown): correlation | r → 1 | 0.519 | 0.810 | 0.481 → 0.190 | historical context | 0 (diagnostic) |
| Tuesday, classes, dry 62°F | Library occupancy 19–22h ÷ 13–16h | 0.8–2.5 (busy through the afternoon into the evening) | 1.950 | 0.478 | 0.000 → 0.403 | assumed sanity target | 0.05 |
| Tuesday, classes, dry 62°F | Library samples at ≥98% of capacity (08–24h) | ≤ 5% | 0.000 | 0.037 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Tuesday, classes, dry 62°F | Main dining halls, lunches: simulated ÷ published | 1.0 | 0.697 | 1.077 | 0.361 → 0.074 | historical context | 0 (diagnostic) |
| Tuesday, classes, dry 62°F | Main dining halls, dinners: simulated ÷ published | 1.0 | 0.525 | 1.058 | 0.644 → 0.056 | historical context | 0 (diagnostic) |
| Tuesday, classes, dry 62°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 1.697 | 1.658 | 0.000 → 0.000 | assumed sanity target | 0.07500000000000001 |
| Tuesday, classes, dry 62°F | Busiest dining time (hour) | within 11–14h or 17–20h | 12.9 | 17.6 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Tuesday, classes, dry 62°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 | assumed sanity target | 0.1 |
| Tuesday, classes, dry 62°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.307 | 0.209 | 1.037 → 0.547 | assumed sanity target | 0.07500000000000001 |
| Tuesday, classes, dry 62°F | Median walk (minutes) | ≤ 10 | 5.139 | 5.497 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Tuesday, classes, dry 62°F | Walks longer than 1.5 km | ≤ 5% | 0.056 | 0.054 | 0.061 → 0.038 | assumed sanity target | 0.05 |
| Tuesday, classes, dry 62°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.304 | 0.102 | 0.679 → 0.005 | assumed sanity target | 0.1 |
| Tuesday, classes, dry 62°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Tuesday, classes, dry 62°F | Green Line B, BU stops (ons and offs): students’ timing vs counts (r) | r → 1 | 0.665 | 0.714 | 0.335 → 0.286 | historical comparison | 1 |
| Tuesday, classes, dry 62°F | Green Line B, BU stops (ons and offs): students’ busiest hour vs counted (hours apart) | 0 | 2.661 | 1.666 | 0.443 → 0.278 | historical comparison | 0.5 |
| Tuesday, classes, dry 62°F | Comm Ave crossings (2018 15-min, 2012 midday): students’ timing vs counts (r) | r → 1 | 0.728 | 0.723 | 0.272 → 0.277 | historical comparison | 1 |
| Tuesday, classes, dry 62°F | Comm Ave crossings (2018 15-min, 2012 midday): students’ busiest hour vs counted (hours apart) | 0 | 0.597 | 0.597 | 0.100 → 0.100 | historical comparison | 0.5 |
| Tuesday, classes, dry 62°F | Student trips above historical all-person counts, divided by observed trips | 0 (historical count comparison) | 0.289 | 0.189 | 0.289 → 0.189 | historical comparison | 1 |
| Tuesday, classes, dry 62°F | Students above their plausible share of a count (all series, share of counted people) | ≤ 1% (band penalty) | 0.359 | 0.257 | 1.744 → 1.237 | assumed sanity target | 0.010000000000000002 |
| Tuesday, classes, dry 62°F | Students, staff and public reconstruction: median r | r → 1 | 0.970 | 0.973 | 0.030 → 0.027 | input reconstruction | 0 (diagnostic) |
| Tuesday, classes, dry 62°F | Students, staff and public vs every count: median total ratio | 0.85–1.15 | 1.005 | 1.004 | 0.000 → 0.000 | input reconstruction | 0 (diagnostic) |
| Tuesday, classes, dry 62°F | **Calibration objective** | lower is better | | | 1.333 → **1.016** | | |
| Wednesday, classes, dry 62°F | FitRec input-profile reconstruction: hourly correlation | r → 1 | 0.791 | 0.898 | 0.209 → 0.102 | input reconstruction | 0 (diagnostic) |
| Wednesday, classes, dry 62°F | FitRec entries per day: simulated ÷ measured | 1.0 | 0.503 | 0.901 | 0.687 → 0.105 | indirect proxy | 0 (diagnostic) |
| Wednesday, classes, dry 62°F | FitRec input-profile reconstruction: peak gap (hours) | 0 | 0.000 | 0.000 | 0.000 → 0.000 | input reconstruction | 0 (diagnostic) |
| Wednesday, classes, dry 62°F | Theology Library entries vs historical patron/zone counts (method unknown): correlation | r → 1 | 0.512 | 0.897 | 0.488 → 0.103 | historical context | 0 (diagnostic) |
| Wednesday, classes, dry 62°F | Library occupancy 19–22h ÷ 13–16h | 0.8–2.5 (busy through the afternoon into the evening) | 1.733 | 0.455 | 0.000 → 0.431 | assumed sanity target | 0.05 |
| Wednesday, classes, dry 62°F | Library samples at ≥98% of capacity (08–24h) | ≤ 5% | 0.000 | 0.017 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Wednesday, classes, dry 62°F | Main dining halls, lunches: simulated ÷ published | 1.0 | 0.716 | 1.061 | 0.334 → 0.059 | historical context | 0 (diagnostic) |
| Wednesday, classes, dry 62°F | Main dining halls, dinners: simulated ÷ published | 1.0 | 0.528 | 1.062 | 0.638 → 0.061 | historical context | 0 (diagnostic) |
| Wednesday, classes, dry 62°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 1.641 | 1.605 | 0.000 → 0.000 | assumed sanity target | 0.07500000000000001 |
| Wednesday, classes, dry 62°F | Busiest dining time (hour) | within 11–14h or 17–20h | 13.1 | 17.6 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Wednesday, classes, dry 62°F | Walk departures vs Bluebikes dock activity by hour (06–24h): correlation | r → 1 | 0.541 | 0.597 | 0.459 → 0.403 | indirect proxy | 0 (diagnostic) |
| Wednesday, classes, dry 62°F | Survey-site crossings 17–18h ÷ 08–09h, relative to observed crossings | 1.0 | 0.591 | 0.635 | 0.263 → 0.227 | historical comparison | 0.5 |
| Wednesday, classes, dry 62°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 | assumed sanity target | 0.1 |
| Wednesday, classes, dry 62°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.197 | 0.182 | 0.486 → 0.412 | assumed sanity target | 0.07500000000000001 |
| Wednesday, classes, dry 62°F | Median walk (minutes) | ≤ 10 | 5.266 | 5.682 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Wednesday, classes, dry 62°F | Walks longer than 1.5 km | ≤ 5% | 0.058 | 0.056 | 0.081 → 0.057 | assumed sanity target | 0.05 |
| Wednesday, classes, dry 62°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.332 | 0.106 | 0.775 → 0.020 | assumed sanity target | 0.1 |
| Wednesday, classes, dry 62°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Wednesday, classes, dry 62°F | Green Line B, BU stops (ons and offs): students’ timing vs counts (r) | r → 1 | 0.770 | 0.781 | 0.230 → 0.219 | historical comparison | 1 |
| Wednesday, classes, dry 62°F | Green Line B, BU stops (ons and offs): students’ busiest hour vs counted (hours apart) | 0 | 2.939 | 0.922 | 0.490 → 0.154 | historical comparison | 0.5 |
| Wednesday, classes, dry 62°F | Student trips above historical all-person counts, divided by observed trips | 0 (historical count comparison) | 0.192 | 0.229 | 0.192 → 0.229 | historical comparison | 1 |
| Wednesday, classes, dry 62°F | Students above their plausible share of a count (all series, share of counted people) | ≤ 1% (band penalty) | 0.251 | 0.278 | 1.207 → 1.342 | assumed sanity target | 0.010000000000000002 |
| Wednesday, classes, dry 62°F | Students, staff and public reconstruction: median r | r → 1 | 0.968 | 0.973 | 0.032 → 0.027 | input reconstruction | 0 (diagnostic) |
| Wednesday, classes, dry 62°F | Students, staff and public vs every count: median total ratio | 0.85–1.15 | 1.009 | 1.003 | 0.000 → 0.000 | input reconstruction | 0 (diagnostic) |
| Wednesday, classes, dry 62°F | **Calibration objective** | lower is better | | | 0.929 → **0.709** | | |
| Thursday, classes, dry 62°F | FitRec input-profile reconstruction: hourly correlation | r → 1 | 0.842 | 0.943 | 0.158 → 0.057 | input reconstruction | 0 (diagnostic) |
| Thursday, classes, dry 62°F | FitRec entries per day: simulated ÷ measured | 1.0 | 0.484 | 0.888 | 0.725 → 0.119 | indirect proxy | 0 (diagnostic) |
| Thursday, classes, dry 62°F | FitRec input-profile reconstruction: peak gap (hours) | 0 | 1.000 | 1.000 | 0.167 → 0.167 | input reconstruction | 0 (diagnostic) |
| Thursday, classes, dry 62°F | Theology Library entries vs historical patron/zone counts (method unknown): correlation | r → 1 | 0.523 | 0.729 | 0.477 → 0.271 | historical context | 0 (diagnostic) |
| Thursday, classes, dry 62°F | Library occupancy 19–22h ÷ 13–16h | 0.8–2.5 (busy through the afternoon into the evening) | 1.968 | 0.493 | 0.000 → 0.383 | assumed sanity target | 0.05 |
| Thursday, classes, dry 62°F | Library samples at ≥98% of capacity (08–24h) | ≤ 5% | 0.000 | 0.037 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Thursday, classes, dry 62°F | Main dining halls, lunches: simulated ÷ published | 1.0 | 0.699 | 1.097 | 0.358 → 0.093 | historical context | 0 (diagnostic) |
| Thursday, classes, dry 62°F | Main dining halls, dinners: simulated ÷ published | 1.0 | 0.519 | 1.038 | 0.655 → 0.037 | historical context | 0 (diagnostic) |
| Thursday, classes, dry 62°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 1.681 | 1.664 | 0.000 → 0.000 | assumed sanity target | 0.07500000000000001 |
| Thursday, classes, dry 62°F | Busiest dining time (hour) | within 11–14h or 17–20h | 13.1 | 17.6 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Thursday, classes, dry 62°F | Survey-site crossings 17–18h ÷ 08–09h, relative to observed crossings | 1.0 | 0.532 | 0.616 | 0.316 → 0.242 | historical comparison | 0.5 |
| Thursday, classes, dry 62°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 | assumed sanity target | 0.1 |
| Thursday, classes, dry 62°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.292 | 0.196 | 0.959 → 0.482 | assumed sanity target | 0.07500000000000001 |
| Thursday, classes, dry 62°F | Median walk (minutes) | ≤ 10 | 5.108 | 5.471 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Thursday, classes, dry 62°F | Walks longer than 1.5 km | ≤ 5% | 0.055 | 0.052 | 0.050 → 0.025 | assumed sanity target | 0.05 |
| Thursday, classes, dry 62°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.305 | 0.104 | 0.682 → 0.013 | assumed sanity target | 0.1 |
| Thursday, classes, dry 62°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Thursday, classes, dry 62°F | Green Line B, BU stops (ons and offs): students’ timing vs counts (r) | r → 1 | 0.659 | 0.706 | 0.341 → 0.294 | historical comparison | 1 |
| Thursday, classes, dry 62°F | Green Line B, BU stops (ons and offs): students’ busiest hour vs counted (hours apart) | 0 | 3.516 | 1.662 | 0.586 → 0.277 | historical comparison | 0.5 |
| Thursday, classes, dry 62°F | Comm Ave crossings (2018 15-min, 2012 midday): students’ timing vs counts (r) | r → 1 | 0.705 | 0.721 | 0.295 → 0.279 | historical comparison | 1 |
| Thursday, classes, dry 62°F | Comm Ave crossings (2018 15-min, 2012 midday): students’ busiest hour vs counted (hours apart) | 0 | 0.018 | 0.018 | 0.003 → 0.003 | historical comparison | 0.5 |
| Thursday, classes, dry 62°F | Student trips above historical all-person counts, divided by observed trips | 0 (historical count comparison) | 0.205 | 0.233 | 0.205 → 0.233 | historical comparison | 1 |
| Thursday, classes, dry 62°F | Students above their plausible share of a count (all series, share of counted people) | ≤ 1% (band penalty) | 0.237 | 0.270 | 1.134 → 1.299 | assumed sanity target | 0.010000000000000002 |
| Thursday, classes, dry 62°F | Students, staff and public reconstruction: median r | r → 1 | 0.968 | 0.976 | 0.032 → 0.024 | input reconstruction | 0 (diagnostic) |
| Thursday, classes, dry 62°F | Students, staff and public vs every count: median total ratio | 0.85–1.15 | 1.000 | 1.000 | 0.000 → 0.000 | input reconstruction | 0 (diagnostic) |
| Thursday, classes, dry 62°F | **Calibration objective** | lower is better | | | 1.448 → **1.137** | | |
| Saturday, dry 62°F | FitRec input-profile reconstruction: hourly correlation | r → 1 | 0.936 | 0.950 | 0.064 → 0.050 | input reconstruction | 0 (diagnostic) |
| Saturday, dry 62°F | FitRec entries per day: simulated ÷ measured | 1.0 | 0.903 | 0.946 | 0.102 → 0.056 | indirect proxy | 0 (diagnostic) |
| Saturday, dry 62°F | FitRec input-profile reconstruction: peak gap (hours) | 0 | 0.000 | 0.000 | 0.000 → 0.000 | input reconstruction | 0 (diagnostic) |
| Saturday, dry 62°F | Theology Library entries vs historical patron/zone counts (method unknown): correlation | r → 1 | 0.000 | 0.000 | 1.000 → 1.000 | historical context | 0 (diagnostic) |
| Saturday, dry 62°F | Library occupancy 19–22h ÷ 13–16h | 0.8–2.5 (busy through the afternoon into the evening) | 0.160 | 0.153 | 0.800 → 0.809 | assumed sanity target | 0.05 |
| Saturday, dry 62°F | Library samples at ≥98% of capacity (08–24h) | ≤ 5% | 0.000 | 0.025 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Saturday, dry 62°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 2.576 | 2.095 | 0.000 → 0.000 | assumed sanity target | 0.07500000000000001 |
| Saturday, dry 62°F | Busiest dining time (hour) | within 11–14h or 17–20h | 12.4 | 12.1 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Saturday, dry 62°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 | assumed sanity target | 0.1 |
| Saturday, dry 62°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.184 | 0.155 | 0.420 → 0.276 | assumed sanity target | 0.07500000000000001 |
| Saturday, dry 62°F | Median walk (minutes) | ≤ 10 | 4.162 | 4.493 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Saturday, dry 62°F | Walks longer than 1.5 km | ≤ 5% | 0.040 | 0.040 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Saturday, dry 62°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.413 | 0.126 | 1.044 → 0.086 | assumed sanity target | 0.1 |
| Saturday, dry 62°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Saturday, dry 62°F | Green Line B, BU stops (ons and offs): students’ timing vs counts (r) | r → 1 | 0.099 | 0.087 | 0.901 → 0.913 | historical comparison | 1 |
| Saturday, dry 62°F | Green Line B, BU stops (ons and offs): students’ busiest hour vs counted (hours apart) | 0 | 5.031 | 5.031 | 0.838 → 0.838 | historical comparison | 0.5 |
| Saturday, dry 62°F | Student trips above historical all-person counts, divided by observed trips | 0 (historical count comparison) | 0.002 | 0.002 | 0.002 → 0.002 | historical comparison | 1 |
| Saturday, dry 62°F | Students above their plausible share of a count (all series, share of counted people) | ≤ 1% (band penalty) | 0.003 | 0.003 | 0.000 → 0.000 | assumed sanity target | 0.010000000000000002 |
| Saturday, dry 62°F | Students, staff and public reconstruction: median r | r → 1 | 1.000 | 1.000 | 0.000 → 0.000 | input reconstruction | 0 (diagnostic) |
| Saturday, dry 62°F | Students, staff and public vs every count: median total ratio | 0.85–1.15 | 1.000 | 1.000 | 0.000 → 0.000 | input reconstruction | 0 (diagnostic) |
| Saturday, dry 62°F | **Calibration objective** | lower is better | | | 1.498 → **1.404** | | |
| Finals Wednesday, dry 45°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 1.641 | 1.683 | 0.000 → 0.000 | assumed sanity target | 0.07500000000000001 |
| Finals Wednesday, dry 45°F | Busiest dining time (hour) | within 11–14h or 17–20h | 13.1 | 13.1 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Finals Wednesday, dry 45°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 | assumed sanity target | 0.1 |
| Finals Wednesday, dry 45°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.197 | 0.143 | 0.486 → 0.214 | assumed sanity target | 0.07500000000000001 |
| Finals Wednesday, dry 45°F | Median walk (minutes) | ≤ 10 | 5.264 | 5.345 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Finals Wednesday, dry 45°F | Walks longer than 1.5 km | ≤ 5% | 0.058 | 0.048 | 0.081 → 0.000 | assumed sanity target | 0.05 |
| Finals Wednesday, dry 45°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.332 | 0.104 | 0.774 → 0.012 | assumed sanity target | 0.1 |
| Finals Wednesday, dry 45°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Finals Wednesday, dry 45°F | **Calibration objective** | lower is better | | | 0.118 → **0.017** | | |
| Rainy Wednesday, 50°F | Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average | ≥ 1.5 | 1.641 | 1.554 | 0.000 → 0.000 | assumed sanity target | 0.07500000000000001 |
| Rainy Wednesday, 50°F | Busiest dining time (hour) | within 11–14h or 17–20h | 13.1 | 13.6 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Rainy Wednesday, 50°F | Walkers at 03:00 ÷ peak walkers | ≤ 1% | 0.000 | 0.000 | 0.000 → 0.000 | assumed sanity target | 0.1 |
| Rainy Wednesday, 50°F | Largest one-minute jump in walkers ÷ peak | ≤ 10% | 0.197 | 0.153 | 0.486 → 0.266 | assumed sanity target | 0.07500000000000001 |
| Rainy Wednesday, 50°F | Median walk (minutes) | ≤ 10 | 5.266 | 5.617 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Rainy Wednesday, 50°F | Walks longer than 1.5 km | ≤ 5% | 0.058 | 0.060 | 0.081 → 0.097 | assumed sanity target | 0.05 |
| Rainy Wednesday, 50°F | Commuters on campus making 4+ transit-stop walks | ≤ 10% (2 is typical: in and out) | 0.332 | 0.089 | 0.775 → 0.000 | assumed sanity target | 0.1 |
| Rainy Wednesday, 50°F | People by the river at 03:00 | ≈ 0 | 0.000 | 0.000 | 0.000 → 0.000 | assumed sanity target | 0.05 |
| Rainy Wednesday, 50°F | People by the river at 15:00 in rain ÷ same day dry | ≤ 15% (assumed) | — | 0.027 | — → 0.000 | assumed sanity target | 0.1 |
| Rainy Wednesday, 50°F | **Calibration objective** | lower is better | | | 0.118 → **0.025** | | |

## Realism audit numbers (full roster, Wednesday)

| Quantity | Today’s model | Conditions engine |
|---|---|---|
| Dining halls, people at 12:00 | 529 | 1790 |
| Dining halls, people at 18:30 | 445 | 1721 |
| Mugar, people at 13:00 | 82.0 | 479 |
| Mugar, people at 21:00 | 514 | 663 |
| Mugar capacity (configured) | 800 | 800 |
| Optional visits rejected | 25275 | 34448 |
| Transit-stop walks (share of all walks) | 0.644 | 0.502 |
| Commuters making 4+ stop walks (share) | 0.268 | 0.081 |
| FitRec entries (day) | 2060 | 3689 |
| Largest one-minute rise in walkers | 1336 | 1175 |
| Time of that rise (hour) | 11.0 | 12.2 |
| Peak walkers | 6778 | 6440 |
| People by the river at 15:00 | 0.000 | 75.0 |
| People by the river at 03:00 | 0.000 | 0.000 |

## Observed MBTA ridership and pedestrian counts

Scored with `scoreObservations` (src/sim/validate.ts) on the series in `public/data/calibration-observations.json` (see docs/calibration-observations.md). Students are the only people in university buildings; streets and the T also carry the public crowd (sim/publicCrowd.ts), which fills observed − students wherever students fall short, so students + public match by construction except where students alone exceed a count. The calibration therefore scores: the **timing of the students' own peaks** at BU-dominated places (B branch BU stops, ons and offs with both directions added; Comm Ave crosswalks, 2018 15-min and 2012 midday), as volume-weighted Pearson r and hours between busiest bins, with positive calibration weights; a direct count-excess term when simulated students exceed the historical all-person count in a bin. The displayed "overflow" relative to assumed student-share bands contributes a reduced-weight assumption penalty; students + public shape and level are shown as zero-weight reconstruction diagnostics, not evidence of predictive accuracy.

**Tuesday, classes, dry 62°F**

| Series group | n | Today’s model: students r / peak h / ratio / overflow | Conditions engine: students r / peak h / ratio / overflow |
|---|---|---|---|
| Green Line B, BU stops (ons and offs) | 10 | 0.66 / 2.7 / 0.84 / 0.29 | 0.71 / 1.7 / 0.66 / 0.14 |
| Comm Ave crossings (2018 15-min, 2012 midday) | 6 | 0.73 / 0.6 / 1.24 / 0.53 | 0.72 / 0.6 / 1.13 / 0.40 |
| Green Line C and D (St Mary’s, Hawes, Kent, Fenway, Longwood) | 20 | 0.29 / 4.9 / 0.70 / 0.55 | 0.29 / 5.2 / 0.53 / 0.38 |
| Kenmore (gated entries and Green Line at Kenmore) | 7 | — / — / 0.00 / 0.00 | — / — / 0.00 / 0.00 |
| Buses (routes 1, 8, 10, 47, 57, 749, 751) | 168 | 0.43 / 3.3 / 0.38 / 0.25 | 0.40 / 3.3 / 0.30 / 0.17 |
| All pedestrian count sites | 6 | 0.73 / 0.6 / 1.24 / 0.53 | 0.72 / 0.6 / 1.13 / 0.40 |
| Every scored series | 221 | 0.61 / 1.8 / 0.75 / 0.36 | 0.60 / 1.8 / 0.66 / 0.26 |

- Today’s model: students alone median r 0.43, median ratio 0.13; students + public median r 0.97, median ratio 1.00 (221 series); students through Kenmore's gates 0
- Conditions engine: students alone median r 0.39, median ratio 0.10; students + public median r 0.97, median ratio 1.00 (221 series); students through Kenmore's gates 0

**Wednesday, classes, dry 62°F**

| Series group | n | Today’s model: students r / peak h / ratio / overflow | Conditions engine: students r / peak h / ratio / overflow |
|---|---|---|---|
| Green Line B, BU stops (ons and offs) | 10 | 0.77 / 2.9 / 0.88 / 0.26 | 0.78 / 0.9 / 0.65 / 0.10 |
| Comm Ave crossings (2018 15-min, 2012 midday) | 0 | — / — / — / 0.00 | — / — / — / 0.00 |
| Green Line C and D (St Mary’s, Hawes, Kent, Fenway, Longwood) | 20 | 0.36 / 5.4 / 0.71 / 0.54 | 0.34 / 5.7 / 0.53 / 0.37 |
| Kenmore (gated entries and Green Line at Kenmore) | 7 | — / — / 0.00 / 0.00 | — / — / 0.00 / 0.00 |
| Buses (routes 1, 8, 10, 47, 57, 749, 751) | 168 | 0.45 / 3.0 / 0.38 / 0.24 | 0.46 / 3.3 / 0.28 / 0.16 |
| All pedestrian count sites | 7 | — / 0.0 / 1.25 / 0.36 | — / 0.0 / 1.58 / 0.67 |
| Every scored series | 222 | 0.49 / 2.1 / 0.60 / 0.25 | 0.50 / 2.0 / 0.62 / 0.28 |

- Today’s model: students alone median r 0.44, median ratio 0.14; students + public median r 0.97, median ratio 1.01 (222 series); students through Kenmore's gates 0
- Conditions engine: students alone median r 0.41, median ratio 0.10; students + public median r 0.97, median ratio 1.00 (222 series); students through Kenmore's gates 0

**Thursday, classes, dry 62°F**

| Series group | n | Today’s model: students r / peak h / ratio / overflow | Conditions engine: students r / peak h / ratio / overflow |
|---|---|---|---|
| Green Line B, BU stops (ons and offs) | 10 | 0.66 / 3.5 / 0.83 / 0.29 | 0.71 / 1.7 / 0.65 / 0.14 |
| Comm Ave crossings (2018 15-min, 2012 midday) | 5 | 0.71 / 0.0 / 1.08 / 0.47 | 0.72 / 0.0 / 1.21 / 0.49 |
| Green Line C and D (St Mary’s, Hawes, Kent, Fenway, Longwood) | 20 | 0.26 / 5.1 / 0.66 / 0.51 | 0.27 / 5.2 / 0.51 / 0.36 |
| Kenmore (gated entries and Green Line at Kenmore) | 7 | — / — / 0.00 / 0.00 | — / — / 0.00 / 0.00 |
| Buses (routes 1, 8, 10, 47, 57, 749, 751) | 168 | 0.41 / 4.0 / 0.37 / 0.24 | 0.40 / 3.8 / 0.29 / 0.16 |
| All pedestrian count sites | 26 | 0.51 / 1.4 / 0.71 / 0.25 | 0.53 / 1.5 / 0.87 / 0.33 |
| Every scored series | 241 | 0.49 / 2.0 / 0.60 / 0.24 | 0.50 / 2.0 / 0.68 / 0.27 |

- Today’s model: students alone median r 0.39, median ratio 0.13; students + public median r 0.97, median ratio 1.00 (241 series); students through Kenmore's gates 0
- Conditions engine: students alone median r 0.36, median ratio 0.11; students + public median r 0.98, median ratio 1.00 (241 series); students through Kenmore's gates 0

**Saturday, dry 62°F**

| Series group | n | Today’s model: students r / peak h / ratio / overflow | Conditions engine: students r / peak h / ratio / overflow |
|---|---|---|---|
| Green Line B, BU stops (ons and offs) | 10 | 0.10 / 5.0 / 0.00 / 0.00 | 0.09 / 5.0 / 0.00 / 0.00 |
| Comm Ave crossings (2018 15-min, 2012 midday) | 0 | — / — / — / 0.00 | — / — / — / 0.00 |
| Green Line C and D (St Mary’s, Hawes, Kent, Fenway, Longwood) | 20 | 0.00 / 5.8 / 0.02 / 0.01 | 0.10 / 5.5 / 0.02 / 0.01 |
| Kenmore (gated entries and Green Line at Kenmore) | 7 | — / — / 0.00 / 0.00 | — / — / 0.00 / 0.00 |
| Buses (routes 1, 8, 10, 47, 57, 749, 751) | 160 | 0.12 / 4.7 / 0.01 / 0.01 | 0.12 / 4.7 / 0.01 / 0.01 |
| All pedestrian count sites | 0 | — / — / — / 0.00 | — / — / — / 0.00 |
| Every scored series | 207 | 0.09 / 5.2 / 0.01 / 0.00 | 0.12 / 5.1 / 0.01 / 0.00 |

- Today’s model: students alone median r 0.07, median ratio 0.00; students + public median r 1.00, median ratio 1.00 (207 series); students through Kenmore's gates 0
- Conditions engine: students alone median r 0.10, median ratio 0.00; students + public median r 1.00, median ratio 1.00 (207 series); students through Kenmore's gates 0

## Build time

- Today’s model, Tuesday, classes, dry 62°F: 6888 ms
- Today’s model, Wednesday, classes, dry 62°F: 5609 ms
- Today’s model, Thursday, classes, dry 62°F: 5468 ms
- Today’s model, Saturday, dry 62°F: 1645 ms
- Today’s model, Finals Wednesday, dry 45°F: 5608 ms
- Today’s model, Rainy Wednesday, 50°F (cached weekday): 0 ms
- Conditions engine, Tuesday, classes, dry 62°F: 10439 ms
- Conditions engine, Wednesday, classes, dry 62°F: 9615 ms
- Conditions engine, Thursday, classes, dry 62°F: 11033 ms
- Conditions engine, Saturday, dry 62°F: 1997 ms
- Conditions engine, Finals Wednesday, dry 45°F: 5923 ms
- Conditions engine, Rainy Wednesday, 50°F: 10703 ms

## Recorded calibration search

This records the saved parameter search, not a new search performed by validation. Its losses may use earlier objective weights. Full-roster confirmation reuses calibration targets and is not an independent empirical holdout.

- Method: Seeded random search (¼ of the budget) then coordinate descent with step halving; acceptance requires every metric’s loss to rise by at most the tolerance and the weighted total to fall; winner confirmed on the full roster.
- Seed: 7; inner-loop roster: every 4th student (12,030 of 48,117, capacities scaled to match), days: Wednesday, classes, dry 62°F; Saturday, dry 62°F; Finals Wednesday, dry 45°F
- Evaluations: 40 in 3.6 min; tolerance 0.02 per metric
- Tuned parameters (start → result): `activity.lunch.at` 11.8 → 11.8, `activity.lunch.spread` 2.250 → 2.250, `activity.dinner.at` 16.5 → 16.5, `activity.dinner.spread` 1.500 → 1.500, `activity.lunch.probability` 0.850 → 0.800, `activity.dinner.probability` 1.100 → 1.100, `offCampusMealShare` 0.350 → 0.350, `visitLengthSpread` 0.450 → 0.450, `activity.day-study.at` 10.0 → 10.0, `activity.day-study.spread` 7.500 → 7.500, `activity.day-study.minutes` 1.000 → 1.000, `activity.evening-study.probability` 1.000 → 1.000, `activity.workout.probability` 3.000 → 3.100, `commuterOffCampusGapMinutes` 300 → 300, `commuterActivityWindowMinutes` 90.0 → 90.0, `postClassLingerMinutes` 6.000 → 5.000, `activity.river-lawn.probability` 0.025 → 0.025, `activity.river-loop.probability` 0.020 → 0.010, `classAttendance` 1.000 → 1.000, `homeBreakMinutes` 30.0 → 30.0, `arrivalLeadSpreadMinutes` 10.0 → 10.0
- Inner-loop loss: 7.615 → 7.479
- Full-roster confirmation: accepted (no metric worse beyond tolerance, total improved); values written to behavior.json with provenance `fitted`

## Notes and limitations

- The historical Theology Library counting method is unknown; the comparison is restricted to that library and excluded from calibration. Mugar’s 800-seat capacity is configured, not published.
- Bluebikes dock activity is a proxy for when people move around campus, not a pedestrian count.
- FitRec counts are entries (people can enter more than once) and include all FitRec users with a valid pass.
- Outdoor (BU Beach, Esplanade, river path) shares are assumptions; there are no counts in the data. They are bounded by sanity checks only.
- Only about 64% of catalog offerings map to buildings (unmatched building codes in the pipeline); unmapped course time is placed on BU’s class grid in BU buildings by the conditions engine.
- The simulated day still runs midnight to midnight; late-night presence after 24:00 is not modelled.
- Synthetic enrollment, class attendance and commuter mode shares are model assumptions. Passing capacity and itinerary checks does not validate actual building occupancy.
- Transit and pedestrian comparison counts combine different years, populations and counting methods; expected student shares are assumed bands. The table reports current discrepancies without treating those bands as measured student counts.
- Weather and finals scenarios are checked for plausibility, not against date-matched observed outcomes. No independent empirical holdout is available in this validation run.
