# Public BU data pipeline

Python acquires and normalizes public evidence for the revised [Flowcast plan](../.plans/campus-digital-twin-spec.md). The shared TypeScript simulation core will consume approved inputs and generate plans. These scripts do not generate a second Python behavioral model.

The sources come from the supplied *BU population data sources* guide dated 24 October 2026. Source URLs are defined alongside their parsers. No login, university account, private roster, or participant schedule is used.

## Setup and run

Run from the repository root with Python 3.10 or newer:

```sh
python3 -m venv data-pipeline/.venv
data-pipeline/.venv/bin/python -m pip install -r data-pipeline/requirements.txt
data-pipeline/.venv/bin/python data-pipeline/scrape_population_data.py
```

The runner writes one JSON dataset per category plus `data-pipeline/output/manifest.json`. Individual collectors are also standalone commands:

```sh
data-pipeline/.venv/bin/python data-pipeline/scrape_catalog.py --term 'FALL 2026'
data-pipeline/.venv/bin/python data-pipeline/scrape_events.py --max-events 20
data-pipeline/.venv/bin/python data-pipeline/scrape_dining.py
data-pipeline/.venv/bin/python data-pipeline/scrape_libraries.py
data-pipeline/.venv/bin/python data-pipeline/scrape_housing.py --max-pages 45
data-pipeline/.venv/bin/python data-pipeline/scrape_signals.py
```

Each collector supports `--help`, `--output`, `--cache-dir`, `--offline`, `--refresh`, and `--delay`. The runner instead uses `--output-dir` and adds `--only` to select categories:

```sh
data-pipeline/.venv/bin/python data-pipeline/scrape_population_data.py \
  --only events dining libraries --max-events 5 --output-dir /tmp/flowcast-sources
```

## Collected records

| Dataset | Sources and output | Interpretation |
| --- | --- | --- |
| `catalog.json` | Public course meetings, exclusions, building-code/address directory, per-room classroom capacity | Schedules and seats; enrollment is unknown |
| `events.json` | Bounded Terrier Central listing discovery and public event pages | Organizer, Boston timestamps, public location, registrations and registration spots; attendance/capacity remain unknown |
| `dining.json` | Dining location directory, published operating windows, dated BU articles | Seat capacity and meal/customer throughput are separate measurements |
| `libraries.json` | STH Tableau CSV/workbooks and date-specific BU library hours | Historical patron counts with unknown counting method; subtotal rows excluded |
| `housing.json` | Bounded housing directory/details, residence articles, planning PDF page 34 | Residential baselines, inventory-derived bed spaces, explicit aggregate/subset relationships |
| `signals.json` | Warren planning report Table 7-6, FitRec guide/dashboard link, hockey box scores | Pedestrian flows, dated daily gym volume, reported event attendance; no instantaneous occupancy inferred |

Identifiers are stable source identities, not yet the simulator's validated location IDs. `locationId` remains null until the data lead maps aliases and verifies a graph-connected entrance. Building codes, room codes, addresses, source names, raw evidence, and source URLs support that mapping. Do not publish these records as supported simulation destinations without reachability validation.

### Expand classes beyond the three examples

By default, the catalog collector fetches MA 123, EK 103, and CH 101 from the guide. This is a reproducible starting sample, not campus-wide coverage. Select explicit courses with repeated `--course-url`, or discover them through department indexes:

```sh
data-pipeline/.venv/bin/python data-pipeline/scrape_catalog.py \
  --term 'FALL 2026' \
  --index-url https://www.bu.edu/academics/cas/courses/ \
  --index-url https://www.bu.edu/academics/eng/courses/ \
  --max-index-pages 10 --max-courses 500
```

Meeting days use Monday=0 through Sunday=6. `startSec`/`endSec` are seconds from Monday 00:00. The collector selects only the requested term and retains NO ROOM exam reservations, online/arranged locations, malformed rows, and unparsed schedules in `excludedMeetings` with reasons. It never falls back to another term.

Published room identities must match the requested building/room before capacity is attached. Exact meeting duplicates collapse by stable identity. Same-room/time records across courses/sections remain flagged as possible combined sections for review. Public pages do not reliably provide combined-section identifiers; do not sum those records as separate attendance estimates without resolving the flag or obtaining an authorized Registrar export.

### Events and additional sports

The event scraper follows bounded public pages and the public listing endpoint exposed by Terrier Central's own page. It collects no attendee names or login-only locations. Use known URLs when testing a particular event:

```sh
data-pipeline/.venv/bin/python data-pipeline/scrape_events.py \
  --event-url 'https://terriercentral.bu.edu/web/rsvp_boot?id=375534'
data-pipeline/.venv/bin/python data-pipeline/scrape_signals.py \
  --discover-sports --max-boxscores 10
```

Discovery defaults to 20 events and at most three listing requests. Housing defaults to 45 directory/detail pages. Limits and unresolved fields are reported; none of these bounded runs claims exhaustive campus coverage. A zero or missing registration count does not establish attendance. Multiday event spans are preserved rather than expanded into assumed recurring occurrences.

### Historical and date-specific evidence

The library CSV contains historical weekday/time aggregates. Workbook metadata retains semester/filter information and extract refresh timestamps; a refresh or dashboard publication date is not an observation date. Downloaded Tableau workbook archives and their Hyper extracts remain available in the raw cache. Decode section-use rows with the optional native reader:

```sh
data-pipeline/.venv/bin/python -m pip install -r data-pipeline/requirements-hyper.txt
data-pipeline/.venv/bin/python data-pipeline/scrape_libraries.py --extract-hyper --max-hyper-rows 20000
```

The runner also accepts `--extract-hyper` and `--max-hyper-rows`. The reader opens a temporary read-only copy, disables Tableau telemetry, and retains source column names/types/units, observation range, available row count, and truncation status. Distinct observation/date/time/section measures collapse duplicates introduced by the workbook's repeated question records. Library-wide patron totals repeat across section rows; do not sum them over sections. Source percentage values are preserved without an assumed scale. Without the optional package, normal CSV/workbook acquisition still works; explicitly requesting extraction reports a clear error if the dependency is absent.

Dining windows retain the page's available clock values, overnight flag, and raw text. The page does not explicitly establish a service date, so `scheduleDate` is null and the data is labeled as a retrieved-page snapshot. Do not repeat it as a permanent weekly schedule. Library hours retain their actual displayed dates and service labels.

Housing data retains nominal totals and subsets separately. Warren Tower A is part of Warren, and the West figure covers multiple halls. StuVi 1 bed spaces are calculated from the published apartment inventory. These figures are not occupied beds or live dorm counts; target-date closures/relocations require confirmation.

## Provenance, caching, and failure handling

HTTP requests use a research User-Agent, a default minimum 0.5-second interval per host, timeouts, and bounded retries for transient errors. Raw response bytes and metadata are cached under `data-pipeline/.cache/sources`. Metadata includes requested/final URL, original retrieval time, content type, SHA-256, and raw-file path. Cache checksums are verified before reuse. Repeated URLs are fetched once per runner invocation, including a refresh run.

`--refresh` acquires new snapshots. `--offline` uses only cached sources and retains the original collection dates:

```sh
data-pipeline/.venv/bin/python data-pipeline/scrape_population_data.py --offline
```

Offline replay requires the same requested URLs and discovery limits to have been acquired already. The cache and generated output are ignored by Git. Keep the cache with an acquisition when preserving reproducibility; absolute `rawPath` values refer to the collecting machine.

Each dataset has a schema version, generation time, status, source list, warnings, and errors. The runner's manifest records checksums, source counts, record counts, per-category failures, and institutional sources still unavailable. Writes are atomic. A category failure does not prevent the other categories from being saved. Any acquisition/parser failure makes the runner exit nonzero with a `partial` manifest; inspect the error details instead of treating the run as complete.

The first live catalog check found a source identity mismatch: the SCI 268A URL publishes room number 286A. The scraper retains affected meetings with unknown room capacity and reports a partial result instead of assigning that room's capacity to SCI 268A. Verify the source before resolving this discrepancy.

## Institutional access boundaries

Campus Density Mapping population estimates, the Registrar's schedule/enrollment report, confirmed 25Live reservations, dining entries/transactions, and occupied beds are institutional requests. Their status is recorded in the manifest. The scripts do not attempt authentication or claim those exports exist locally. The FitRec Power BI link is retained; underlying chart values are not exported. MyBU seat availability is not scraped through an unverified API.

There is no automatic conversion of seats, beds, registrations, meals, visits, or street crossings into current building occupancy. Arrival patterns, attendance rates, dwell times, enrollment, and capacity assumptions belong in separately documented simulation inputs.

## Verification

Run the focused parser, cache, and orchestration regressions without network access:

```sh
PYTHONPATH=data-pipeline data-pipeline/.venv/bin/python -m unittest discover -s data-pipeline/tests -v
data-pipeline/.venv/bin/python -m compileall -q -x '/\.venv/' data-pipeline
```

Tests cover term selection, invalid schedules, week-second conversion, classroom identity, combined-section flags, count subtotals, event privacy/timezones, overnight dining, source publication dates, housing overlaps, post-renovation PDF evidence, pedestrian columns, cache integrity, and partial-run manifests. Live collection is an additional check because upstream markup can change.

## Existing map fixture

`make_demo_routes.py` is the earlier standalone map demonstration. It writes `map-client/public/data/demo-day.json`; it remains separate from these source acquisitions. Its synthetic day and capacity scaling are not validated population data or the revised shared simulation implementation.

## Map client data (runs today, standard library only)

These scripts feed `map-client/` until the shared simulation core produces its own output.

- `make_demo_routes.py`: placeholder plans for the map. It pulls each campus's walk network and building footprints from OpenStreetMap, routes a synthetic Wednesday for 300 students with Dijkstra, and writes `map-client/public/data/demo-day.json` (format: `map-client/README.md`, "Data contract"). Run `python3 data-pipeline/make_demo_routes.py`.
- `campuses/*.json`: the campuses and real BU locations that script uses (`campus`, `name`, `bbox` [S, W, N, E], `locations` with `id`, `name`, `short`, `kind`, `lat`, `lon`, `capacity`, `osm`, optional `height`). Every file is loaded; files with the same `campus` id merge (bboxes union). Each campus gets its own walk network and at least 40 of the 300 agents.
- `fetch_transit.py`: snapshots the MBTA routes and stops serving each campus into `map-client/public/data/transit.json`. The map polls live vehicles and predictions itself.
