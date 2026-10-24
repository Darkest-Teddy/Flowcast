# Public BU data pipeline

Python acquires and normalizes public evidence for the revised [Flowcast plan](../.plans/campus-digital-twin-spec.md). The shared TypeScript simulation core will consume approved inputs and generate plans. These scripts do not generate a second Python behavioral model.

The sources come from the supplied *BU population data sources* guide dated 24 October 2026. Source URLs are defined alongside their parsers. No login, university account, private roster, or participant schedule is used.

## Use the saved datasets

The normalized public datasets in [`output/`](output/) are committed. Use them directly; application setup and data analysis do not require another scrape or the scraper dependencies.

- [`output/catalog.json`](output/catalog.json): the campus-wide Fall 2026 snapshot, with 8,900 course pages, 8,454 unique course codes, 6,944 physical meeting records, and 437 verified classroom capacities.
- [`output/manifest.json`](output/manifest.json): checksums and collection status for all six categories.
- [`output/campus-wide/coverage.json`](output/campus-wide/coverage.json): per-school coverage and explicit schedule/capacity gaps.
- The other category JSON files contain the saved events, dining, library, housing, and supplemental-signal records.

Additional saved inputs for population scale and traffic:

| Snapshot / collector | Source and use |
|---|---|
| `population.json` / `scrape_population.py` | BU 2025–26 Common Data Set and FY2026 fact sheet. Census headcount and attendance cohorts are distinct from FTE, staff, and residence capacity. |
| `transit_schedule.json` / `scrape_transit_schedule.py` | Official MBTA GTFS, reference week October 19–25, 2026. Arrival/departure times, calendar exceptions, and previous-day after-midnight service. |
| `road_counts.json` / `scrape_road_counts.py` | Boston Streets Hourly Bike Counts feature service, including motor vehicles. Latest available campaign per site; 15 sites in campus/approach bounds. |
| `bluebikes.json` / `scrape_bluebikes.py` | September 2026 public trip archive. 13,788 trips with both endpoints in the study areas; weekday/hour OD means include zero-activity dates. These riders are not assumed to be BU students. |
| `pedestrian_counts.json` / `scrape_pedestrian_counts.py` | Saved Warren Towers 2023 intersection counts mapped to three verified intersections. Pooled Wednesday/Thursday observations are not expanded to other weekdays. Incomplete or historical CTPS counts are excluded. |

Each snapshot retains provenance and coverage. Each collector supports cached offline replay; refreshing is explicit. `fetch_bikes.py` is the merged dock replay feature (selected actual day near BU docks), while `scrape_bluebikes.py` retains month-wide aggregate flows. The two views have different geographic coverage and must not be summed.

`build_runtime_data.py` and `build_mobility_data.py` produce compact browser bundles from these committed files. No network requests run during `npm run prepare:data` or production builds. Run the complete acquisition/parser suite from this directory with `.venv/bin/python -m unittest discover -s tests -v`.

The campus-wide folder also retains discovered URLs and parsed JSONL records for resuming an intentional update. Root and campus-wide catalogs are identical snapshots. Raw HTTP response bodies and run logs remain local; published provenance uses repository-relative cache paths, and the cache is not required to consume these JSON datasets.

## Refresh the data only when needed

The commands below perform acquisition and can overwrite the saved outputs. Run them only when intentionally updating the snapshot, from the repository root with Python 3.10 or newer:

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

### Campus-wide crawl

Use the dedicated crawler to discover every course index linked by the BU Academics school/area pages and follow its full numeric pagination:

```sh
data-pipeline/.venv/bin/python data-pipeline/crawl_campus_catalog.py \
  --term 'FALL 2026' --workers 8 --delay 0.25 --resume
```

It writes `output/campus-wide/catalog.json`, a per-area/per-school `coverage.json`, discovered URLs, progressive course/meeting JSONL files, and a checksum manifest. `coverage.json` is checkpointed during the run. With `--resume`, complete parsed JSONL records are reused as well as HTTP snapshots. Incomplete records and failed details are retried; excluded records must also be present before a course can be reused. `--offline` reconstructs from a complete cache.

The request interval is shared across workers, so eight workers do not multiply the configured request rate. A 0.25-second interval caps new requests at four per second. HTTP 429 responses slow all workers, and `Retry-After` establishes a shared host cooldown. The room pass first follows the public classroom search pagination, then uses its canonical room-page links. Rooms without a matching directory entry remain unknown, avoiding unnecessary requests for guessed URLs. Combined-room entries are kept distinct from individual rooms.

The crawler verifies final URLs before attributing a page to a school and records source failures. Areas with external sites or no own public course index are listed separately. Courses without target-term schedules remain in the course catalogue with explicit status. Fall-term rows retain their notes and a calendar-review flag because intensive/block sessions may cover only selected dates.

This output is separate from the three-example dataset produced by the ordinary `scrape_catalog.py` default. Catalogue coverage is not a verified complete MyBU offering list, and public classroom capacities remain distinct from enrollment.

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

Offline replay requires the same requested URLs and discovery limits to have been acquired already. The raw HTTP cache and run logs are ignored by Git. Normalized datasets and manifests are versioned. Keep the cache with an acquisition when preserving reproducibility; committed `rawPath` values are relative to the repository root. Fresh local acquisitions may initially record absolute paths.

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
- `fetch_bikes.py`: real Bluebikes rides at BU's docks into `map-client/public/data/bikes.json`. It downloads the month's public trip file once (`--month`, default `202609`, ~130 MB, cached in `.cache/bluebikes/`). It keeps docks within 200 m of a location in `campuses/*.json`, profiles each dock's typical weekday (`--weekday`, default Wednesday), and routes every ride on the median day (or `--replay-date`) over OSM's bike network. Dock times are real; street paths are inferred (see the map client README). It reads `campuses/*.json` but doesn't change them. Tests: `tests/test_bikes.py`.

### Map integration (offline)

`python3 data-pipeline/build_map_data.py` transforms the six committed snapshots into
`map-client/public/data/campus-data.json`. It reads local files only and records input
SHA-256 hashes. Rebuild this bundle after deliberately refreshing source datasets;
opening the map does not scrape BU again.

Mappings target existing map location IDs. Unknown building codes and ambiguous event
venues remain explicitly unmapped. The map displays source facts with dates and units,
while `map-client/src/sim/sourceDay.ts` generates fictional student attendance against
published class times. Historical library counts, registrations, residential baselines,
and dining volumes are not treated as live occupancy.
