---
name: refresh-events
description: Re-scrape BU's public campus events and rebuild the map and dashboard bundles. Use when events look stale.
---

# Refresh campus events

Refresh Flowcast's campus events. Extra instructions: $ARGUMENTS

1. From `data-pipeline/`, run the collector against the live site (polite delay, results cached):
   `.venv/bin/python scrape_events.py --refresh --delay 0.4`
   If the network is unavailable, replay with `--offline` instead.
2. Read the result's `status`, `warnings` and `errors`. Private events are expected warnings; parser errors are not — fix and add a test in `tests/test_events.py`.
3. Update the `events.json` entry in `output/manifest.json` (sha256, sourceCount, recordCounts, status, errors).
4. From the repo root: `python3 data-pipeline/build_map_data.py && python3 data-pipeline/build_runtime_data.py`.
5. Report how many events were collected and how many resolve to mapped buildings (`coverage.mappedEvents`), and list the most common unmapped venues.
6. Run `bash .kiro/hooks/verify.sh`.
