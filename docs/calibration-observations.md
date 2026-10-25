# Calibration observations: MBTA ridership and pedestrian counts

`map-client/public/data/calibration-observations.json` (about 1.5 MB) holds real counts of
people near BU, cleaned into one schema, so the simulation can be scored against them and the
non-student public crowd can be sized from them.

- Built by `data-pipeline/fetch_calibration_observations.py`. Raw downloads are cached under
  `data-pipeline/.cache/observations/` (gitignored). `--offline` rebuilds from the cache only;
  `--refresh` downloads again. Python 3 with `beautifulsoup4` (needed by `common.py`).
- Hand-transcribed pedestrian count sheets are in `data-pipeline/inputs/pedestrian_counts_extra.json`,
  with PDF page numbers. The script reads that file.
- `map-client/src/data/observations.ts` has the types, the loader and the comparison helpers.
- `map-client/src/sim/publicCrowd.ts` builds the public crowd from the same file.

No source needs an API key or an account.

## Schema

```jsonc
{
  "schemaVersion": 1, "generatedAt": "...", "notes": [],   // notes: sources that could not be fetched
  "sources": [{ "id", "title", "url", "license", "period", "notes", "retrievedAt", ... }],
  "transit": [{
    "id": "green-b-bucen-1-weekday-ons",
    "kind": "gated-entries | apc-boardings | apc-alightings",
    "mode": "subway | light-rail | bus",
    "stop": { "name", "mapStopId", "mbtaStopIds": [], "position": [lng, lat] },  // mapStopId = transit.json stop id
    "route": "Green-B | 57 | Green (gated: every branch)", "direction": 0 | 1 | null,  // GTFS direction
    "dayType": "weekday | friday | saturday | sunday",
    "bins": [{ "start": "07:00", "end": "08:00", "value": 23.4 }],
    "unit": "avg per day per hour", "source": "<sources[].id>", "period": "...",
    "expectedStudentShare": [low, high], "role": "primary | comparison", "notes": "..."
  }],
  "pedestrian": [{
    "id": "ped-cds-2018-comm-granby", "site": "...", "siteKey": "comm-granby", "position": [lng, lat],
    "screen": { "type": "lines", "lines": [{ "from", "to", "group" }], "mergeMetres": 40 }
            | { "type": "cordon", "radiusMetres": 25 },
    "countMethod": "half-leg | leg", "date": "2018-04-12", "dayType": "weekday", "weekdays": [3],
    "bins": [{ "start": "07:00", "end": "07:15", "value": 61 }],   // all crosswalk legs added
    "legCounts": { "NE": [..], "S": [..] },                        // per leg, same bins (when published)
    "unit": "...", "direction": null, "source": "...", "page": "...",
    "quality": "primary | context", "expectedStudentShare": [low, high], "notes": "..."
  }]
}
```

Times are Boston local time on the calendar day. Gated entries after midnight are filed on the
calendar day they happen (the MBTA files them on the previous service day).

## Sources

| id | What | Period | URL |
|---|---|---|---|
| `mbta-gse-fall-2025` | MBTA Gated Station Entries, Kenmore, 30-min bins, averaged per day type | 2025-09-02 to 2025-11-25 (59 weekdays, 12 Sat, 12 Sun), holidays removed | https://mbta-massdot.opendata.arcgis.com/datasets/001c177f07594e7c99f193dde32284c9 (feature service `.../GSE/FeatureServer/0`) |
| `mbta-gse-fall-2026` | Same, current term so far | 2026-09-02 to 2026-09-25 (17 weekdays, 2 Sat, 2 Sun) | same |
| `mbta-rail-hourly-fall-2025` | Fall 2025 MBTA Rail Ridership by Hour, Route/Line, and Stop: ons and offs per stop, branch, direction, hour | MBTA Fall 2025 rating, holidays and line diversion days excluded | https://mbta-massdot.opendata.arcgis.com/datasets/6494749a29c648018820d0e49636205c |
| `mbta-bus-apc-fall-2025` | MBTA Bus Ridership by Trip, Season, Route/Line, and Stop (APC), Fall 2025 file | Fall 2025 rating; Wkdy = Mon-Thu, Fri, Sat, Sun | https://mbta-massdot.opendata.arcgis.com/datasets/8daf4a33925a4df59183f860826d29ee |
| `mbta-gtfs-fall-2025` | MBTA GTFS archive (feed of 2025-10-21), only to put each APC trip row in the hour it reaches the stop | Fall 2025 | https://cdn.mbtace.com/archive/20251021.zip |
| `bu-warren-epnf-2024` | Warren Towers EPNF Table 7-6: peak-hour crossings at 7 intersections | 2023-10-18/19 (Wed/Thu), 8-9 AM and 5-6 PM | https://www.bu.edu/community/files/2024/02/Warren-Towers-EPNF.pdf |
| `bu-cds-pnf-2018` | Data Sciences Center PNF: 15-min crosswalk counts per leg, 7 intersections | 2018-04-12 (Thu): 7-9, 11-13, 16-18 | https://www.bu.edu/community/files/2018/10/BU-Data-Sciences-Center-PNF-Final-Draft-9-27-18.pdf (raw sheets: .../2019/04/BUDataSciences-Vol-2.pdf) |
| `bu-tmp-2013` | BU 2013-2023 Transportation Master Plan: midday 15-min counts, 6 intersections | 2012-03-20 (Tue) 12-14 | https://www.bu.edu/community/files/2016/03/2013-2023-BU-Charles-River-Campus-Transportation-Master-Plan_January-17-2013.pdf |
| `bmc-imp-2021` | BMC Institutional Master Plan appendix: 15-min crosswalk counts per leg, 12 Medical Campus intersections | 2019-12-05 (Thu): 7-9, 16-18 | https://www.bostonplans.org/getattachment/3a581fc0-10ce-42c8-8d09-d41dc0d304d7 |
| `ctps-bp-counts` | Boston Region MPO bicycle/pedestrian counts, pedestrian rows in the map area | 2001-2012 only | https://www.ctps.org/geoserver/www/apps/bp-counts-app-01262024/index.html |
| `osm-overpass` | OpenStreetMap: count sites at the nodes shared by their two streets; screens across mapped crosswalks | retrieval date | https://overpass-api.de/api/interpreter |

MBTA data is CC0. The BU and BMC filings are public Article 80 / IMP documents; only the counted
facts are reused, with page citations. The City of Boston's BTD count archive has newer
(2022-2023) Comm Ave counts, but it needs a login and its downloads failed, so it isn't used.

## Coverage

| Series | Stops / sites | Bins | Day types |
|---|---|---|---|
| Kenmore gated entries | Kenmore (all Green branches) | 48 x 30 min | weekday, Sat, Sun; Fall 2025 (`primary`) and Fall 2026 to date (`comparison`) |
| Green Line ons/offs | B: Kenmore, Blandford, BU East, BU Central, Amory, Babcock; C: Kenmore, St Mary's, Hawes, Kent; D: Kenmore, Fenway, Longwood | 24 x 1 h, per direction | weekday, Sat, Sun (156 series) |
| Bus boardings/alightings | 57 map bus stops on routes 1, 8, 10, 47, 57, 749, 751 (Charles River, Fenway, Medical) | 24 x 1 h, per stop and route | weekday (Mon-Thu), Fri, Sat, Sun (655 series) |
| Pedestrian, primary | 7 Comm Ave / Bay State Rd intersections (2023 peak hours, 2018 15-min, 2012 midday 15-min), Buick St, BU Bridge, University Rd (2012 midday), 12 Medical Campus intersections (2019 15-min) | 15 min or 1 h | weekday (32 series) |
| Pedestrian, context | CTPS counts on the Esplanade path, BU Bridge and the Muddy River, 2001-2012 | 15 min | mixed (25 series) |

Packard's Corner and Harvard Ave are left out because the simulation has no stop there.

## How the simulated equivalents are measured

- **Transit** (`simulatedTransit(rides, series)`): simulated rides at `stop.mapStopId` with the
  series' route (any `Green-*` for `Green`), direction (if set) and kind. APC boardings are counted
  at the vehicle's departure, alightings at its arrival, and gated entries when the rider reaches
  the station (`waitStart`). Cancelled rides are skipped.
- **Pedestrians** (`simulatedPedestrians(trips, site)`): each walk that crosses the site's screen
  counts once for each pass, timed where it crosses. At an intersection the screen is a 10 m line
  across every mapped OSM crosswalk segment. `countMethod: half-leg` (2018, 2023) counts Comm Ave's
  two halves (westbound and eastbound lanes) separately, as the count sheets do. `leg` (2012, BMC,
  Bay State Rd) counts a crossing of a leg once (passes within 40 m merged). Sites without mapped
  crosswalks, or whose position is only transcribed, use a 25 m cordon.

## Metrics, and how the validator should use each series

`compareSeries(id, kind, bins, simulated, expected)` and `scoreDay(data, weekday, counts, options)`
return, per series:

- `pearson`: shape (Pearson r of the bin values). It is null for fewer than 3 bins, so the 2-bin
  Warren peaks have no r.
- `peakHoursApart`: the hours between the busiest observed bin and the busiest simulated bin.
- `ratio`: simulated / observed total, with `inBand` against `expected`. `binsOutOfBand` counts
  the bins outside observed x [low, high].

For students alone, `expected` is the series' `expectedStudentShare`. For students plus the
public crowd (`{ everyone: true }`), it is `EVERYONE_BAND` = [0.85, 1.15].

Usage, per series type:

- **Kenmore gated (`primary`, Fall 2025)**: the shape and level of Kenmore boardings.
  Compare it with `simulatedTransit` and kind `gated-entries` on the matching day type. Use Fall
  2026 only as a sense of the spread: it covers September alone and includes Red Sox home games.
- **Green Line ons/offs**: score each stop and direction for shape (r, peak). Also score the
  sum over both directions per stop, which is more robust at small simulated counts. Kenmore ons
  are `comparison`, because the gate counts measure Kenmore boardings directly. Kenmore offs are
  `primary`.
- **Bus APC**: many stop-hours have only a handful of riders. Weigh bins by observed volume, or
  add up a route's stops by direction. The Friday series pair with a simulated Friday.
- **Pedestrian (`primary`)**: Comm Ave sites give the daytime shape (2018: 7-9, 11-13, 16-18 at
  15-min resolution, including class-change peaks) and the level (2023 peak hours). Use 2012
  midday for midday shape only, since it is 14 years old. Medical Campus (2019) is almost entirely
  non-students. `legCounts` lets the validator score single crosswalks.
- **Pedestrian (`context`)**: do not score these. They are old, summer or out-of-term counts.

## Expected student share (documented assumptions)

These bands are judgement calls, not measurements. They exist so a magnitude check can say
"plausible" rather than demand a perfect match.

| Where | Band | Why |
|---|---|---|
| B branch, Blandford St to Babcock St | 0.55-0.85 | BU frontage on both sides of Comm Ave |
| B branch at Kenmore, Kenmore gates | 0.2-0.45 | BU plus Fenway Park, hotels, offices, Brookline commuters |
| C branch (St Mary's, Hawes, Kent) | 0.2-0.5 | Brookline residents; some BU housing nearby |
| D branch (Fenway, Longwood) | 0.1-0.3 | Longwood Medical Area workers |
| Bus, Charles River / Fenway / Medical | 0.25-0.6 / 0.05-0.25 / 0.03-0.15 | 57/47 serve BU; the Albany St and Mass Ave stops serve BMC |
| Comm Ave crossings | 0.6-0.9 | inside the Charles River Campus |
| Bay State Rd | 0.7-0.95 | BU residences on both sides |
| BU Bridge | 0.2-0.5 | a regional walking and cycling route |
| Medical Campus intersections | 0.05-0.25 | hospital staff, patients and visitors |

## The public crowd (students + public = observed)

`sim/publicCrowd.ts` turns the gap between the students and the counts into walkers who are not
students:

- **Riders.** For each primary transit series on the day's type, the public count per bin is
  `max(0, observed - students (smoothed 1-2-1) - extra sources counted in the baseline)`. These
  riders step off at the published arrival times (or walk to the stop and board), then walk
  120-450 m along the saved sidewalk routes.
- **Through walkers.** The public count per counted hour is `observed - students - public
  riders passing`. The target for each hour comes from the newest study that covers it. Other
  hours follow the observed all-rider activity curve (B branch BU stops plus Kenmore gates),
  scaled by people-per-activity interpolated between the counted hours. Weekends apply the weekday
  ratio to the weekend curve. Walkers pass inside the quarter hours the count shows.
- **Never at a university building.** Walks use stretches of the routes at least 40 m from any
  route end that is a BU location, and they start and end at least 20 m from every BU location.
  Public walkers are in their own list. They never reach occupancy, student counts, the
  "N walking" header or the student panels. The header shows "N public on streets".
- **Event visitors.** Pass them as `extraSources` (`PublicSource`). Use `inObservedCounts: false`
  (the usual case) when the observed averages are ordinary term days, so visitors add on top and
  the baseline stays as it is. Use `inObservedCounts: true` only when a count was taken on that
  event's day, so the visitors replace part of the public fill and nobody is counted twice.

If the observations file is missing, the map shows students only.

## Caveats

- **Seasons differ.** The counts are fall 2025 (MBTA), fall 2023 / spring 2018 / spring 2012
  (Comm Ave), and December 2019 (BMC). The simulation is a week in October 2026. The 2018 and
  2012 counts predate the Comm Ave redesign and today's enrolment.
- **APC sampling.** MBTA bus and light-rail figures are APC samples expanded by the MBTA. Bus
  values are sums of per-trip averages. A stop-hour of 2.3 riders is an average, not a count.
  Bus rows are placed in an hour by the Fall 2025 timetable: 19,499 trip rows matched exactly and
  880 used the median stop offset.
- **Gated entries are unscaled.** They miss fare evaders and children, and they include employee
  taps. Kenmore Fall 2025 averages 4,285 weekday entries; September 2026 averages 6,544.
- **Student shares are assumptions** (see above), not measured.
- **The pedestrian screen only approximates the count method.** OSM crosswalk geometry decides
  which crossings count. Where OSM maps one segment for a whole divided-road crossing (Comm Ave at
  St Mary's, east leg), a half-leg count is undercounted. Silber Way at Bay State Rd and
  Harrison Ave at E Newton have no mapped crosswalks, and three Medical Campus sites have only
  transcribed positions; these use a cordon. Albany St at E Concord and at E Stoughton get no
  public walkers, because no saved walk route crosses their crosswalks.
- **Missing legs.** At Cummington Mall, the 2018 NW and SW legs (3-7 people an hour) are not
  in the 15-min rows.
