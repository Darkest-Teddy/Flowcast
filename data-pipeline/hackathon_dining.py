"""Acquire restricted BU dining snapshots and overlay only matching dated hours."""

import argparse
import copy
from datetime import date, datetime, timezone
import json
import os
from pathlib import Path
import tempfile
import time
from urllib.request import Request, urlopen

BASE = "https://public.api-nonprod.bu.edu/api/v1/dining"
PRIVATE = Path(__file__).resolve().parent / ".cache" / "hackathon"
LOCATIONS = {"warren": "warren-dining", "west": "west-dining", "marciano": "marciano"}


def clock(value):
    parsed = datetime.strptime(value, "%H:%M")
    return parsed.hour * 3600 + parsed.minute * 60


def overlay(snapshots, payload):
    """Retain non-overlapping sources, dates, and capacity/throughput measurements."""
    result = copy.deepcopy(snapshots)
    locations = result["opening_hours"]["locations"]
    by_id = {row["locationId"]: row for row in locations}
    seen = set()
    for menu in payload["menus"]:
        source_id = menu["location"]["id"]
        target = LOCATIONS[source_id]
        day = date.fromisoformat(menu["date"]).isoformat()
        if (target, day) in seen:
            raise ValueError(f"Duplicate dining schedule: {target}, {day}")
        seen.add((target, day))
        if menu.get("stale", False):
            raise ValueError(f"Stale dining API schedule: {target}, {day}")
        datetime.fromisoformat(menu["fetched_at"].replace("Z", "+00:00"))
        schedules = menu["schedules"]
        # An empty upstream response does not establish a closure.
        if not schedules:
            continue
        windows = []
        for schedule in schedules:
            start, end = clock(schedule["opens_at"]), clock(schedule["closes_at"])
            if start == end:
                raise ValueError(f"Ambiguous equal dining clock times: {target}")
            windows.append([start, end + (86400 if end < start else 0)])
        merged = []
        for start, end in sorted(windows):
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(end, merged[-1][1])
            else:
                merged.append([start, end])
        record = by_id.get(target)
        if record is None:
            record = {"locationId": target, "hours": []}
            locations.append(record)
            by_id[target] = record
        record["hours"] = [h for h in record["hours"] if h.get("date") != day]
        record["hours"].append({
            "date": day, "windows": merged,
            "text": "; ".join(f"{s['meal']}: {s['opens_at']}–{s['closes_at']}" for s in schedules),
            "sourceUrl": f"{BASE}/locations/{source_id}/menu?day={day}",
            "qualifier": f"BU hackathon API; retrieved {menu['fetched_at']}. Dated meal service hours.",
        })
        record["status"] = "published"
        record["reason"] = "BU hackathon API preferred for matching dates; other dates retain public evidence."
    return result


def acquire(days, key):
    def get(path):
        request = Request(BASE + path, headers={"X-API-Key": key, "Accept": "application/json"})
        with urlopen(request, timeout=30) as response:
            return json.load(response)

    directory = get("/locations")
    menus = []
    for location in directory["locations"]:
        if location["id"] not in LOCATIONS:
            continue
        for day in days:
            time.sleep(0.65)
            menu = get(f"/locations/{location['id']}/menu?day={day}")
            if menu["location"]["id"] != location["id"] or menu["date"] != day:
                raise ValueError("Dining API returned a different location/date")
            menus.append(menu)
    if not menus:
        raise ValueError("Dining API returned no supported locations")
    payload = {"schemaVersion": 1, "source": BASE, "retrievedAt": datetime.now(timezone.utc).isoformat(),
               "locations": directory["locations"], "menus": menus}
    overlay({"opening_hours": {"locations": []}}, payload)
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", action="append", required=True, dest="days")
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    days = sorted({date.fromisoformat(day).isoformat() for day in args.days})
    path = PRIVATE / "dining.json"
    if path.exists() and not args.refresh:
        cached = json.loads(path.read_text())
        if {menu["date"] for menu in cached["menus"]} != set(days):
            parser.error("Cached dates differ; pass --refresh to acquire a new snapshot")
        print(f"Using cached dining snapshot: {path}")
        return
    key = os.environ.get("CATALOG_API_KEY")
    if not key:
        parser.error("Set CATALOG_API_KEY in the process environment (never a VITE_ variable)")
    payload = acquire(days, key)
    PRIVATE.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=PRIVATE, delete=False) as handle:
        json.dump(payload, handle, allow_nan=False)
    os.replace(handle.name, path)
    print(f"Saved {len(payload['menus'])} dated dining menus to {path}")


if __name__ == "__main__":
    main()
