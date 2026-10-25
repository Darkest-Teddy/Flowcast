# Published traffic-signal plans

`bu-signal-plans.json` transcribes the **Existing Conditions** weekday AM/PM
Synchro sheets dated May 16, 2012 in BU's 2013–2023 Transportation Master Plan.
`sourcePages` contains one-based PDF page numbers, not printed report numbers.
Each AM/PM tuple contains cycle seconds, offset seconds, and movement windows.
Green excludes yellow and all-red clearance. Windows can wrap past cycle end.

The map replays these historical plans on its simulation clock. It does not
reproduce detector actuation or guarantee present-day timings. The five daily
switching periods are assumptions; midday, evening, and night reuse AM timings.
The separate Audubon Circle plan is a published proposal. Other intersections
use estimated splits, even where a published cycle length is available.

Refresh the checked-in map data without fetching street geometry:

```sh
python3 data-pipeline/fetch_street.py --timings-only
```

To refresh OSM geometry and all plans, omit `--timings-only` (requires network).
The client displays each active plan's basis, date, and source page in its tooltip.

# Transcribed pedestrian counts

`pedestrian_counts_extra.json` holds public pedestrian count sheets near BU (BU Data Sciences
Center PNF 2018, BU Transportation Master Plan 2013, BMC IMP 2021 appendix), with PDF pages.
`fetch_calibration_observations.py` locates each site in OSM and writes
`map-client/public/data/calibration-observations.json`. See `docs/calibration-observations.md`.
