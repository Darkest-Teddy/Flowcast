#!/usr/bin/env python3
"""Builds web/src/data/courseCatalog.json from the scraped public course catalog
(output/catalog.json's `meetings` array) for the web app's Courses feature.

This is BU's published course catalog (crawl_campus_catalog.py / scrape_catalog.py), not
Student Link/MyBU registration data -- see output/catalog.json's own warnings. Exam-only
reservations are already excluded upstream (exclusion reason "exam_reservation"); this script
also drops any meeting whose title or section still reads as an exam, defensively.

Building codes are resolved to a map-client location id via the same BUILDING_ALIASES used by
build_map_data.py where the target already exists in the web app's small fixtures location list.
Every other building code gets its own location, named from the meeting's own real buildingName
-- not guessed -- so the catalog never fabricates a building.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG_IN = ROOT / "data-pipeline" / "output" / "catalog.json"
OUT = ROOT / "web" / "src" / "data" / "courseCatalog.json"
OUT_LOCATIONS = ROOT / "web" / "src" / "data" / "courseLocations.json"

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# Buildings the web app's fixtures.ts already models as a CampusLocation with its own id.
KNOWN_WEB_LOCATIONS = {"cas", "cds", "questrom", "epic", "mugar", "gsu", "warren", "myles", "stuvi", "warren-dining"}
BUILDING_ALIASES = {
    "CAS": "cas", "CDS": "cds", "HAR": "questrom", "EPC": "epic", "MUG": "mugar",
}

EXAM_RE = re.compile(r"\bexam\b", re.I)


def hhmm(total_seconds: int) -> str:
    """`total_seconds` is seconds since the start of the WEEK (weekday*86400 + time-of-day) in
    this dataset, not since midnight -- confirmed by cross-checking against `scheduleRaw` on
    several real meetings. Reduce to time-of-day before formatting."""
    time_of_day = total_seconds % 86400
    h, rem = divmod(time_of_day, 3600)
    m = rem // 60
    return f"{h:02d}:{m:02d}"


def main() -> None:
    with CATALOG_IN.open(encoding="utf-8") as f:
        data = json.load(f)

    minted_locations = {}  # building code -> CampusLocation
    offerings = []
    skipped_exam = 0

    for m in data["meetings"]:
        title = m.get("courseTitle") or ""
        section = m.get("section") or ""
        if EXAM_RE.search(title) or EXAM_RE.search(section):
            skipped_exam += 1
            continue
        intervals = m.get("intervals") or []
        if not intervals:
            continue

        days = sorted({iv["weekday"] for iv in intervals if 0 <= iv.get("weekday", -1) <= 6})
        if not days:
            continue
        start_sec = intervals[0]["startSec"]
        end_sec = intervals[0]["endSec"]

        code = (m.get("buildingCode") or "").strip()
        location_id = BUILDING_ALIASES.get(code)
        if location_id and location_id not in KNOWN_WEB_LOCATIONS:
            location_id = None  # alias target isn't modeled on the web side; mint our own below
        if not location_id:
            if not code:
                continue
            location_id = f"bldg-{code.lower()}"
            if location_id not in minted_locations:
                name = m.get("buildingName") or code
                minted_locations[location_id] = {
                    "id": location_id,
                    "name": name,
                    "short": code,
                    "kind": "classroom",
                    "capacity": 250,
                }

        offerings.append({
            "id": m["id"],
            "code": m.get("courseCode") or "",
            "title": title,
            "section": section,
            "instructor": m.get("instructor") or None,
            "days": [WEEKDAYS[d] for d in days],
            "startTime": hhmm(start_sec),
            "endTime": hhmm(end_sec),
            "locationId": location_id,
        })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(offerings, indent=None, separators=(",", ":")), encoding="utf-8")
    OUT_LOCATIONS.write_text(json.dumps(list(minted_locations.values()), indent=None, separators=(",", ":")), encoding="utf-8")

    print(f"meetings in: {len(data['meetings'])}")
    print(f"skipped (exam title/section): {skipped_exam}")
    print(f"offerings written: {len(offerings)} -> {OUT.relative_to(ROOT)}")
    print(f"minted locations: {len(minted_locations)} -> {OUT_LOCATIONS.relative_to(ROOT)}")
    print(f"catalog file size: {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
