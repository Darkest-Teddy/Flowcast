"""Run the public BU source collectors and write a versioned acquisition manifest."""

import argparse
import hashlib
import importlib
from pathlib import Path
import sys

from common import CACHE, OUTPUT, Fetcher, ScrapeError, envelope, utc_now, write_json

COLLECTORS = ("catalog", "events", "dining", "libraries", "housing", "signals")
ACCESS_LIMITS = [
    {"source": "Campus Density Mapping", "status": "institutional_access_required",
     "url": "https://www.bu.edu/tech/services/admin/campus-operations-systems/campus-density-mapping/",
     "requestedData": "Approved historical aggregate building population with timestamps and method definitions"},
    {"source": "Registrar BU_R0012G_SR_SOC_EXTR", "status": "staff_export_not_obtained",
     "url": "https://sites.bu.edu/sis-training/scheduling-queries/",
     "requestedData": "Section schedule and enrollment, combined-section identifiers; no student roster"},
    {"source": "25Live reservations", "status": "authorized_export_not_obtained",
     "url": "https://www.bu.edu/reservations/25live/",
     "requestedData": "Confirmed event locations and organizer attendance estimates"},
    {"source": "Dining entries and transactions", "status": "institutional_export_not_obtained",
     "url": "https://www.bu.edu/dining/project-and-media-requests/",
     "requestedData": "Aggregate counts by hall/date/interval with transaction definitions"},
    {"source": "Housing occupied beds", "status": "institutional_export_not_obtained",
     "url": "https://www.bu.edu/housing/",
     "requestedData": "Aggregate occupied beds by residence and applicable date range"},
]


def run(fetcher, output_dir, selected, options=None):
    options = options or {}
    output_dir = Path(output_dir)
    manifest = {
        "schemaVersion": 1,
        "datasetVersion": "bu-public-" + utc_now(),
        "generatedAt": utc_now(), "timezone": "America/New_York",
        "status": "ok", "datasets": [], "uncollectedInstitutionalSources": ACCESS_LIMITS,
        "handoff": "Acquisition inputs, not the final campus bundle. Resolve locations to graph-connected entrances before planning.",
        "limitations": "Capacity, registrations, throughput, historical counts, and occupancy are distinct. No measured live occupancy is inferred.",
    }
    for name in selected:
        print(f"Collecting {name}...", flush=True)
        try:
            module = importlib.import_module(f"scrape_{name}")
            result = module.collect(fetcher, **options.get(name, {}))
            payload = envelope(name, result)
        except (ScrapeError, OSError, ValueError) as exc:
            payload = envelope(name, {"errors": [str(exc)], "sources": [], "warnings": []})
            payload["status"] = "failed"
        output = output_dir / f"{name}.json"
        write_json(output, payload)
        manifest["datasets"].append({
            "dataset": name, "path": output.name, "status": payload["status"],
            "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            "sourceCount": len(payload.get("sources", [])),
            "recordCounts": {**({"sectionObservations": sum(len(table["rows"]) for table in payload["sectionUse"]["tables"])} if payload.get("sectionUse") else {}), **{key: len(value) for key, value in payload.items()
                             if isinstance(value, list) and key not in ("sources", "warnings", "errors")}},
            "errors": payload.get("errors", []),
        })
        print(f"  {payload['status']}: {output}", flush=True)
        if payload["status"] != "ok":
            manifest["status"] = "partial"
    write_json(output_dir / "manifest.json", manifest)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", choices=COLLECTORS, nargs="+", default=list(COLLECTORS))
    parser.add_argument("--output-dir", type=Path, default=OUTPUT)
    parser.add_argument("--cache-dir", type=Path, default=CACHE)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--delay", type=float, default=0.5)
    parser.add_argument("--term", default="FALL 2026")
    parser.add_argument("--course-url", action="append", dest="course_urls")
    parser.add_argument("--index-url", action="append", dest="index_urls")
    parser.add_argument("--max-courses", type=int, default=200)
    parser.add_argument("--max-index-pages", type=int, default=5)
    parser.add_argument("--event-url", action="append", dest="event_urls")
    parser.add_argument("--max-events", type=int, default=20)
    parser.add_argument("--max-event-pages", type=int, default=3)
    parser.add_argument("--max-housing-pages", type=int, default=45)
    parser.add_argument("--discover-sports", action="store_true")
    parser.add_argument("--max-boxscores", type=int, default=10)
    parser.add_argument("--max-hyper-rows", type=int, default=20000)
    parser.add_argument("--extract-hyper", action="store_true", help="Decode library section extract; requires optional Hyper dependency")
    args = parser.parse_args()
    options = {
        "catalog": {key: getattr(args, key) for key in ("term", "course_urls", "index_urls", "max_courses", "max_index_pages")},
        "events": {"event_urls": args.event_urls, "max_events": args.max_events, "max_pages": args.max_event_pages},
        "housing": {"max_pages": args.max_housing_pages},
        "signals": {"discover_sports": args.discover_sports, "max_boxscores": args.max_boxscores},
    }
    if args.extract_hyper:
        options["libraries"] = {"extract_hyper": True, "max_hyper_rows": args.max_hyper_rows}
    try:
        fetcher = Fetcher(args.cache_dir, offline=args.offline, refresh=args.refresh, delay=args.delay)
        manifest = run(fetcher, args.output_dir, list(dict.fromkeys(args.only)), options)
    except (ScrapeError, OSError) as exc:
        parser.exit(1, f"Acquisition failed: {exc}\n")
    print(f"Manifest: {args.output_dir / 'manifest.json'} ({manifest['status']})")
    return 0 if manifest["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
