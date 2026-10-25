# Public BU data pipeline

Python acquires and normalizes public evidence for the revised [Flowcast plan](../.plans/campus-digital-twin-spec.md). The shared TypeScript simulation core will consume approved inputs and generate plans. These scripts do not generate a second Python behavioral model.

The sources come from the supplied *BU population data sources* guide dated 24 October 2026. Source URLs are defined alongside their parsers. No login, university account, private roster, or participant schedule is used.

## Use the saved datasets

### BU hackathon sources (restricted, local use)

The DS+X course database and dining/transit API take priority wherever their
verified fields overlap public evidence. Credentials and restricted results are
not committed. The API's live OpenAPI reference is
`https://public.api-nonprod.bu.edu/docs`; its actual routes use `/api/v1/`, unlike
some examples in the access handout.

For dining, set `CATALOG_API_KEY` in the process environment, then run:

```sh
python3 data-pipeline/hackathon_dining.py --date 2026-10-24 --date 2026-10-25
python3 data-pipeline/build_map_data.py \
  --hackathon-dining data-pipeline/.cache/hackathon/dining.json \
  --output data-pipeline/.cache/hackathon/campus-data.json
```

Acquisition reuses the local snapshot unless `--refresh` is requested. Menu
responses contain dated meal-service hours; those replace only matching hall/date
records in the map bundle. Adjacent meal windows merge, overnight service retains
the following-day end time, empty schedules do not establish closure, and stale
responses fail validation. Other venues, dates, seating/throughput measurements,
and non-dining datasets retain their public evidence. Menu items stay in the
private acquisition cache; no menu UI is added.

The restricted bundle can only be written under `data-pipeline/.cache/hackathon`.
The map's Vite development/preview server serves it locally in preference to the
public bundle. Ordinary data preparation/builds still generate only public data.
Do not publish the private cache or redistribute it; the supplied access handout
limits data use to this hackathon project. Removing the private bundle restores
the public bundle. Transit API setup is documented in `map-client/README.md`.

The course database requires BU VPN and SSL. Install the optional dependency with
`data-pipeline/.venv/bin/python -m pip install -r data-pipeline/requirements-hackathon.txt`.
Set `CATALOG_DB_HOST`, `CATALOG_DB_USER`, and `CATALOG_DB_PASSWORD` in the process
environment using the access handout. The verified database is `hackathon`
(`CATALOG_DB_NAME` can override it), with schema `catalog`. Acquisition uses one
read-only, repeatable-read transaction and a 60-second statement timeout:

```sh
data-pipeline/.venv/bin/python data-pipeline/hackathon_catalog.py --term-code 2268
python3 data-pipeline/build_map_data.py \
  --hackathon-catalog data-pipeline/.cache/hackathon/catalog.json \
  --hackathon-dining data-pipeline/.cache/hackathon/dining.json \
  --output data-pipeline/.cache/hackathon/campus-data.json
```

The importer currently normalizes Fall 2026 (`2268`) only. It replaces courses and
all schedules for database-covered display codes, including courses whose database
rows have no usable physical meetings. Courses outside that coverage retain public
records. Display suffixes remain distinct. Exact room identities retain separately
published capacities; the database provides neither capacities nor enrollment.
Section dates constrain simulation days, and database section keys keep distinct
sessions separate. Existing verified component requirements remain evidence;
component types alone do not establish registration requirements.

Raw database rows and the resulting bundle stay under the ignored private cache.
The bundle's `hackathonCatalogCoverage` reports imported, excluded, and fallback
records plus the upstream refresh timestamp. The October 24 acquisition contains
5,870 Fall course records, 14,529 sections, and 15,122 meeting rows; the upstream
snapshot identifies an October 12 refresh. Cached replay needs no VPN or credentials;
use `--refresh` only to intentionally reacquire data.

The normalized public datasets in [`output/`](output/) are committed. Use them directly; application setup and data analysis do not require another scrape or the scraper dependencies.

The student scenario uses October 26–November 1, selected for the best nearby service-hour coverage. `extend_opening_hours.py --week-start 2026-10-26 --reviewed-regular-hours --offline` replays the reviewed Fenway and medical schedules without discarding earlier dates. The review flag requires checking published holiday notices for the requested week. CRC dining hours for October 31–November 1 and library hours for November 1 remain unknown; the map does not turn those gaps into confirmed closures. The existing weekly housing and activity scenarios were reviewed and retained for this week as estimates.

`build_component_rules.py` preserves explicit lecture/lab/discussion dependencies from the saved catalog; unresolved notes remain unresolved. `build_map_data.py` also exports distinct full-catalog course groups so the planner can estimate mapped course-load coverage without treating repeated sections or component rows as extra courses. Neither field supplies actual enrollment.

`build_cross_campus_routes.py --rebuild-source` rebuilds Fenway–Charles River and DeWolfe pedestrian connections from the compressed OSM extracts in `snapshots/osm/`, routed together with the Fenway and Charles River walk networks from `make_demo_routes.py`'s Overpass cache (run that first). Ways join only at shared vertices, routes keep each location's mapped endpoint, and results merge into `demo-day.json`; ordinary application builds reuse that saved result.

Both scripts route on `pedestrian_network.py`: footways, sidewalks, crossings, paths and plazas cost their length; walking in a roadway costs 2.5× (service) to 8× (primary/secondary) its length, and 10× where OSM maps the road's sidewalks as separate ways, so routes use the sidewalk and cross at crosswalks. A road with `sidewalk=yes/both/left/right` costs 1.1×. Any stretch still along a road is drawn offset to its sidewalk side (half the carriageway from `width`/`lanes`, capped by the lanes because Boston's MassGIS widths often span the whole street, plus 1.5 m); one-way carriageways such as either half of Commonwealth Avenue offset to their kerb, never the median.

- [`output/catalog.json`](output/catalog.json): the campus-wide Fall 2026 snapshot, with 8,900 course pages, 8,454 unique course codes, 6,944 physical meeting records, and 437 verified classroom capacities.
- [`output/manifest.json`](output/manifest.json): checksums and collection status for all six categories.
- [`output/campus-wide/coverage.json`](output/campus-wide/coverage.json): per-school coverage and explicit schedule/capacity gaps.
- The other category JSON files contain the saved events, dining, library, housing, and supplemental-signal records.
- [`output/opening_hours.json`](output/opening_hours.json) audits all 27 mapped dining, library, and recreation venues, including the branch libraries listed on the BU Libraries hours page, the law libraries' published fall schedule, and BU Dining cafés with dated hours. `scrape_opening_hours.py` extracts dated dining hours, library general hours, FitRec seasonal weekly schedules and closures, and the official Fenway provider's embedded schedule. It records restricted event/team facilities separately. The map uses these audited records instead of undated dining snapshots and mixed departmental hours.
- [`output/residential_availability.json`](output/residential_availability.json) records dated residential availability separately from nominal complex totals. `scrape_residential_availability.py` verifies reopened Warren Tower A's 600 spaces and Tower B's relocation from BU publications; Tower C remains outside the verified subtotal. The runtime labels this partial allocation explicitly.

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
data-pipeline/.venv/bin/python data-pipeline/scrape_academic_calendar.py
data-pipeline/.venv/bin/python data-pipeline/scrape_fitrec_usage.py
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

### Venue events, popularity and visitor walks

Ticketed events at venues on or near the map (Agganis Arena, Walter Brown Arena, Case Gym, Nickerson Field, New Balance Field, Fenway Park, MGM Music Hall) bring crowds of non-students, which the map draws as a separate "visitor" population. Three scripts, none needing an API key or account, all cached under `.cache/` and run by hand (never during `npm run prepare:data`):

```sh
data-pipeline/.venv/bin/python data-pipeline/scrape_venue_events.py   # goterriers.com, agganisarena.com, Live Nation (MGM), MLB Stats API -> event-calendar.json
python3 data-pipeline/event_popularity.py                              # Google Trends (public endpoints, cached, backoff on 429) -> event-popularity.json
python3 data-pipeline/build_visitor_routes.py                          # OSM doors, stations, garages, drop-offs, sidewalk routes -> event-visitor-routes.json
```

`event_popularity.py` scores each event's search terms (performers, teams) over the 90 days before it in the Boston DMA, rescaled through anchor terms queried in the same request (TD Garden = 100), and fits fill-vs-popularity on past games with published attendance. If Trends is unreachable or keeps rate limiting, the affected events are written with `source: "prior"` and the map uses its kind's documented prior; re-running later resumes from the cache (`--offline` uses the cache only). The attendance model, student/visitor split and arrival curves live in `map-client/src/sim/eventAttendance.ts`.

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

- `make_demo_routes.py`: placeholder plans for the map. It pulls each campus's walk network and building footprints from OpenStreetMap, routes a synthetic Wednesday for 300 students with Dijkstra on sidewalks and crosswalks (`pedestrian_network.py`), and writes `map-client/public/data/demo-day.json` (format: `map-client/README.md`, "Data contract"). Run `python3 data-pipeline/make_demo_routes.py`.
- `campuses/*.json`: the campuses and real BU locations that script uses (`campus`, `name`, `bbox` [S, W, N, E], `locations` with `id`, `name`, `short`, `kind`, `lat`, `lon`, `capacity`, `osm`, optional `height`). Every file is loaded; files with the same `campus` id merge (bboxes union). Each campus gets its own walk network and at least 40 of the 300 agents. `charles-river-classrooms.json` and `medical-classrooms.json` hold the catalog teaching buildings that `BUILDING_ALIASES` in `build_map_data.py` points at; they have no `bbox` (they sit inside the campus bbox) and each location carries a `source` object: its building codes, BU directory entry and URL, the OSM footprint URL, the position basis (the footprint's area centroid) and the capacity basis (the catalog's deduplicated classroom seats, 24 per unknown room, as `build_runtime_data.py` computes). `charles-river-destinations.json` adds branch libraries and cafés with their own published hours; a place inside an already-mapped building shares that building's OSM footprint and door, and `capacityNote` labels its configured size proxy, which `build_runtime_data.py` records as low-confidence `configured_model_capacity`. The demo day saves the walk between every ordered pair of one campus's locations, not only the pairs its placeholder trips use.
- `fetch_transit.py`: snapshots the MBTA routes and stops serving each campus into `map-client/public/data/transit.json`. The map polls live vehicles and predictions itself.
- `fetch_bikes.py`: real Bluebikes rides at BU's docks into `map-client/public/data/bikes.json`. It downloads the month's public trip file once (`--month`, default `202609`, ~130 MB, cached in `.cache/bluebikes/`). It keeps docks within 200 m of a location in `campuses/*.json`, profiles each dock's typical weekday (`--weekday`, default Wednesday), and routes every ride on the median day (or `--replay-date`) over OSM's bike network. Dock times are real; street paths are inferred (see the map client README). It reads `campuses/*.json` but doesn't change them. Tests: `tests/test_bikes.py`.
- `fetch_fire_response.py`: the Boston Fire Department network for the map's fire alarms, into `map-client/public/data/fire-response.json` (~180 KB). From OpenStreetMap (cached in `.cache/overpass/`): eight BFD firehouses near BU with their companies (from Boston.gov's fire department locations list), the driveable streets with one-way rules, truck restrictions (`hgv=no`, `maxheight` under 3.9 m) and traffic signals, and hydrants near BU buildings. The graph is pruned to streets near BU buildings plus every quickest firehouse-to-building path either way, so the client's dispatch-time routing gives the same answers as the full network. Run `python3 data-pipeline/fetch_fire_response.py`.
- `fetch_parking.py`: the garages and lots around BU and its event venues (Agganis, Fenway Park, MGM Music Hall, Nickerson Field) into `map-client/public/data/parking.json`, for the map's opt-in Parking layer. Geometry from OpenStreetMap (Overpass, cached in `.cache/overpass/`). Capacity comes from a published figure (BU, BMC master plan, the Red Sox game-day table, or a low-confidence Parkopedia listing), else the OSM `capacity` tag, else footprint × levels ÷ 30 m², and each lot records which. It also writes the events (Red Sox 2026 home games, BU hockey at Agganis, MGM shows, move-in, Commencement) with their sources; anything without a published schedule is marked `sample`. Standard library only: `python3 data-pipeline/fetch_parking.py`. Tests: `map-client/tests/parking.test.mjs`.

### Map integration (offline)

`python3 data-pipeline/build_map_data.py` transforms the six category snapshots, opening-hours audit, and dated residential availability into
`map-client/public/data/campus-data.json`. It reads local files only and records input
SHA-256 hashes. Rebuild this bundle after deliberately refreshing source datasets;
opening the map does not scrape BU again.

Mappings target existing map location IDs. Unknown building codes and ambiguous event
venues remain explicitly unmapped. The map displays source facts with dates and units,
while `map-client/src/sim/sourceDay.ts` generates fictional student attendance against
published class times. Historical library counts, registrations, residential baselines,
and dining volumes are not treated as live occupancy.

## FitRec visits and the Registrar calendar

`fitrec_usage.json` saves the public [FitRec peak/quiet-hours report](https://www.bu.edu/fitrec/peak-quiet-hours/): hourly entry counts for its last seven reported dates, preserving the published Power BI visual filters. Missing cells remain absent. The bundle replaces the older generic FitRec daily-visits evidence with this dated snapshot. The gym planner samples relative arrival timing from the latest same-weekday observation on or before the simulated date, at most 28 days old. Opening hours, travel feasibility, and capacity still apply. Attendance probability and dwell time remain assumptions; entries are neither unique visitors nor simultaneous occupancy. If no recent profile exists, the existing generic gym timing remains in use.

`academic_calendar.json` saves the [Registrar semester calendar](https://www.bu.edu/reg/calendars/semester/) for Fall 2026 and Spring 2027. Class plans and course-coverage weights honor term boundaries, suspended dates, recesses, and substitute weekdays. Section validity dates apply to the actual attendance date. Exam periods do not generate invented meetings. The general calendar applies only to the listed course prefixes: professional schools with separately published calendars and unknown prefixes retain their source schedules.

Both collectors support `--refresh` and cached `--offline` acquisition. Committed normalized snapshots are sufficient for offline builds; no raw cache, API credentials, or VPN is needed for these two sources.
