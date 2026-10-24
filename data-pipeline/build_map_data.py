"""Build the map's compact, offline source bundle from committed acquisition snapshots."""

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timedelta
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = ROOT / "data-pipeline" / "output"
DEFAULT_MAP = ROOT / "map-client" / "public" / "data" / "demo-day.json"
DEFAULT_OUTPUT = ROOT / "map-client" / "public" / "data" / "campus-data.json"
DATASETS = ("catalog", "events", "dining", "housing", "libraries", "signals", "opening_hours", "residential_availability")

# These aliases refer to existing mapped buildings, never inferred nearby coordinates.
BUILDING_ALIASES = {
    "CAS": "cas", "CDS": "cds", "HAR": "questrom", "PHO": "photonics", "EPC": "epic",
    "COM": "com", "CFA": "cfa", "CGS": "cgs", "SAR": "sargent", "ENG": "eng",
    "LAW": "law-tower", "MUG": "mugar", "KHC": "kilachand", "FRC": "fitrec",
    "FCB": "fenway-classroom", "FAB": "fenway-activities", "HAW": "hawes", "INS": "bumc-instructional",
}
HOUSING_ALIASES = {
    "housing:warren-towers": "warren", "housing:10-buick-street": "stuvi",
    "housing:33-harry-agganis-way": "stuvi2", "housing:the-towers": "towers",
    "housing:610-beacon-street": "myles",
}
DINING_ALIASES = {
    "dining:warren": "warren-dining", "dining:west": "west-dining", "dining:marciano": "marciano",
    "dining:gsu": "gsu", "dining:fenway": "fenway-dining",
}
LIBRARY_ALIASES = {"Mugar Library": "mugar", "Pardee Management Library": "pardee"}
EVENT_ALIASES = {**BUILDING_ALIASES, "GSU": "gsu", "Sargent": "sargent"}
MONTH_DATE = r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}\b"
DATE = rf"(?:\b\d{{1,2}}/\d{{1,2}}(?:/\d{{2,4}})?\b|\b\d{{4}}-\d{{2}}-\d{{2}}\b|\b{MONTH_DATE})"


def source_url(record):
    return record.get("provenance", {}).get("url", "")


def calendar_restricted(notes):
    if not notes:
        return False
    normalized = re.sub(r"\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.(?=\s+\d)", r"\1", notes, flags=re.I)
    for sentence in re.split(r"(?<=[.!?;])\s+|\n", normalized):
        administrative = re.search(r"\b(?:deadline|last day to add|add/drop|registration|register|waitlist|seats? (?:are )?reserved|reserved .*until|prerequisite)\b", sentence, re.I)
        if administrative:
            continue
        if re.search(r"\b(?:intensive|condensed|alternate weeks|(?:first|second) half|(?:first|second) session)\b", sentence, re.I):
            return True
        if re.search(DATE, sentence, re.I):
            return True
    return False


def seconds(clock):
    match = re.fullmatch(r"(\d{1,2}):(\d{2})", clock)
    if not match or not 0 <= int(match[1]) < 24 or not 0 <= int(match[2]) < 60:
        raise ValueError(f"Invalid local clock value {clock!r}")
    return int(match[1]) * 3600 + int(match[2]) * 60


def hour_windows(text):
    if re.search(r"\bclosed\b", text, re.I):
        return []
    if re.search(r"24\s*(?:hours?|hrs?)", text, re.I):
        return [[0, 86400]]
    match = re.search(r"(\d{1,2}(?::\d{2})?\s*[ap]m)\s*[-–—]\s*(\d{1,2}(?::\d{2})?\s*[ap]m)", text, re.I)
    if not match:
        return []
    def parse(value):
        value = re.sub(r"\s", "", value).lower()
        pattern = "%I:%M%p" if ":" in value else "%I%p"
        time = datetime.strptime(value, pattern)
        return time.hour * 3600 + time.minute * 60
    start, end = parse(match[1]), parse(match[2])
    return [[start, end + (86400 if end <= start else 0)]]


def evidence(record, label, *, note=None):
    value = record.get("value")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"Invalid evidence value for {record.get('id')}")
    return {
        "id": record["id"], "label": label, "value": value, "unit": record["unit"],
        "basis": record.get("basis", record.get("measure", "published")),
        "publishedAt": record.get("sourcePublishedDate", record.get("sourcePublishedAt")),
        "sourceUrl": source_url(record), "note": note or record.get("warning") or record.get("limitations"),
    }


def normalized_address(value):
    value = value.casefold().replace("commonweatlh", "commonwealth")
    value = re.sub(r"\bavenue\b", "ave", value)
    value = re.sub(r"\bstreet\b", "st", value)
    value = re.sub(r"\broad\b", "rd", value)
    return re.sub(r"[^\w-]", "", value)


def event_location(record, locations, address_aliases):
    if record.get("locationStatus") == "hidden" or not record.get("locationName"):
        return None
    name = record["locationName"]
    candidates = {target for alias, target in EVENT_ALIASES.items()
                  if target in locations and re.match(r"^"+re.escape(alias)+r"\b", name, re.I)}
    address = normalized_address(record.get("locationAddress") or "")
    address_candidates = {target for prefix, target in address_aliases if address and address.startswith(prefix)}
    if candidates and address_candidates and not candidates.intersection(address_candidates):
        return None
    candidates = candidates or address_candidates
    return next(iter(candidates)) if len(candidates) == 1 else None


def routable_ids(day):
    locations = {location["id"]: location for location in day["locations"]}
    result = set()
    for key, route in day.get("walkRoutes", {}).items():
        origin, destination = key.split(">", 1)
        if origin not in locations or destination not in locations:
            raise ValueError(f"Walk route references an unknown location: {key}")
        if locations[origin].get("campus") != locations[destination].get("campus"):
            raise ValueError(f"Walk route crosses campuses: {key}")
        if len(route.get("path", [])) < 2 or len(route["path"]) != len(route.get("cumulative", [])):
            raise ValueError(f"Invalid precomputed route: {key}")
        if any(b < a for a, b in zip(route["cumulative"], route["cumulative"][1:])):
            raise ValueError(f"Non-monotonic route distance: {key}")
        result.update((origin, destination))
    return result


def build_bundle(datasets, day, input_files=None):
    map_locations = {location["id"]: location for location in day["locations"]}
    if len(map_locations) != len(day["locations"]):
        raise ValueError("Map location IDs must be unique")
    reachable = routable_ids(day)
    aliases = {code: target for code, target in BUILDING_ALIASES.items() if target in map_locations and target in reachable}
    locations = {key: {"id": key, "buildingCodes": [], "meetings": [], "evidence": [], "hours": []} for key in sorted(map_locations)}
    catalog = datasets["catalog"]
    grouped, unmapped = defaultdict(list), Counter()
    for row in catalog["meetings"]:
        code = row["buildingCode"]
        target = aliases.get(code)
        if not target:
            unmapped[code] += 1
            continue
        intervals = row["intervals"]
        for interval in intervals:
            if not 0 <= interval["weekday"] <= 6 or not 0 <= interval["startSec"] < interval["endSec"] <= 604800:
                raise ValueError(f"Invalid weekly interval for {row['id']}")
        capacity = row.get("roomCapacity") or {}
        capacity = capacity.get("value") if capacity.get("unit") == "seats" and not capacity.get("estimated", False) else None
        if capacity is not None and (isinstance(capacity, bool) or not isinstance(capacity, (int, float)) or not math.isfinite(capacity) or capacity < 0):
            raise ValueError(f"Invalid published room capacity for {row['id']}")
        meeting = {
            "id": row["id"], "courseCode": row["courseCode"], "title": row.get("courseTitle") or row["courseCode"],
            "section": row["section"], "buildingCode": code, "roomCode": row["roomCode"],
            "intervals": sorted(intervals, key=lambda i: i["startSec"]), "roomCapacity": capacity,
            "notes": row.get("notes"), "calendarRestricted": calendar_restricted(row.get("notes")),
            "sharedKey": None, "sourceUrl": source_url(row),
        }
        locations[target]["meetings"].append(meeting)
        locations[target]["buildingCodes"].append(code)
        signature = (code, row["roomCode"], tuple((i["weekday"], i["startSec"], i["endSec"]) for i in meeting["intervals"]))
        grouped[signature].append(meeting)
    for signature, meetings in grouped.items():
        if len(meetings) > 1:
            key = hashlib.sha256(json.dumps(signature).encode()).hexdigest()[:16]
            for meeting in meetings:
                meeting["sharedKey"] = key
    global_evidence = []
    for record in datasets["housing"]["measurements"]:
        key = record["entityKey"]
        target = HOUSING_ALIASES.get(key)
        if target in locations:
            note = record.get("warning") or "Residential baseline, not occupied beds or current occupancy."
            locations[target]["evidence"].append(evidence(record, "Published residential baseline", note=note))
        elif key == "housing:west-campus":
            global_evidence.append(evidence(record, "West Campus residential baseline (three halls combined)",
                note="Claflin, Sleeper and Rich combined; no supported per-building split. Not current occupancy."))
        # Tower A is a subset of Warren; it is not added to the complex total.
    for record in datasets["dining"]["measurements"]:
        target = DINING_ALIASES.get(record["entityKey"])
        item = evidence(record, "Published seating capacity" if record["metric"] == "capacity" else "Published dining throughput",
                        note="Dated seats or meal/customer volume; not concurrent occupancy.")
        if target in locations:
            locations[target]["evidence"].append(item)
        elif record.get("aggregate"):
            item["label"] = f"Three main dining halls: {record.get('period', 'meal volume')}"
            item["note"] = "Combined historical meal-period total; not a per-hall count or occupancy."
            global_evidence.append(item)
    for record in datasets["dining"]["locations"]:
        target = DINING_ALIASES.get(record["id"])
        if target not in locations:
            continue
        windows = []
        for window in record.get("windows", []):
            if window.get("status") == "parsed" and window.get("opensLocal") and window.get("closesLocal"):
                start, end = seconds(window["opensLocal"]), seconds(window["closesLocal"])
                windows.append([start, end + (86400 if end <= start else 0)])
        locations[target]["hours"].append({
            "date": record.get("scheduleDate"), "windows": windows,
            "text": "; ".join(w["rawText"] for w in record.get("windows", [])),
            "sourceUrl": source_url(record),
            "qualifier": "Retrieved dining-hours snapshot; service date unverified. Not a permanent weekly schedule.",
        })
    for record in datasets["libraries"]["hours"]:
        target = LIBRARY_ALIASES.get(record["library"])
        if target in locations:
            locations[target]["hours"].append({"date": record["date"], "windows": hour_windows(record["hoursText"]),
                "text": record["hoursText"], "sourceUrl": source_url(record), "qualifier": None})
    for record in datasets.get("opening_hours", {}).get("locations", []):
        target = record["locationId"]
        if target not in locations:
            raise ValueError(f"Opening hours reference unknown map location: {target}")
        audited = []
        for hours in record.get("hours", []):
            date, weekday = hours.get("date"), hours.get("weekday")
            if date is None and (type(weekday) is not int or not 0 <= weekday <= 6):
                raise ValueError(f"Opening hours have neither a date nor a weekday: {target}")
            for key in ("date", "validFrom", "validTo"):
                if hours.get(key):
                    datetime.strptime(hours[key], "%Y-%m-%d")
            if hours.get("validFrom") and hours.get("validTo") and hours["validFrom"] > hours["validTo"]:
                raise ValueError(f"Reversed opening-hour validity: {target}")
            for window in hours["windows"]:
                if len(window) != 2 or any(not isinstance(n, (int, float)) or not math.isfinite(n) for n in window) or not 0 <= window[0] < window[1] <= 172800:
                    raise ValueError(f"Invalid opening-hour window: {target}")
            audited.append(hours)
        # The audit separates general public service from desks, teams and event-only access.
        locations[target]["hours"] = audited
        locations[target]["hoursStatus"] = record["status"]
        locations[target]["hoursReason"] = record.get("reason", "")
    for record in datasets.get("residential_availability", {}).get("records", []):
        if record["locationId"] not in locations:
            raise ValueError("Residential availability references an unknown location")
        locations[record["locationId"]]["evidence"].append({
            "id": f"available:{record['locationId']}:{record['validFrom']}",
            "label": f"Verified beds: {record.get('displayName', record['locationId'])}",
            "value": record["value"], "unit": "bed-spaces", "basis": "dated_availability",
            "publishedAt": record.get("sourcePublishedDate"), "sourceUrl": record["sourceUrl"],
            "note": f"{record['validFrom']} to {record['validTo']}. {record['note']}",
        })
    address_aliases = [(normalized_address(record["address"]), aliases[record["buildingCode"]])
                       for record in catalog.get("buildings", []) if record["buildingCode"] in aliases and record.get("address")]
    if "gsu" in locations:
        address_aliases.append((normalized_address("775 Commonwealth Avenue"), "gsu"))
    events = [{"id": record["id"], "name": record["name"], "start": record["start"], "end": record.get("end"),
               "locationId": event_location(record, locations, address_aliases), "locationName": record.get("locationName"),
               "registrationCount": record.get("registrationCount"), "sourceUrl": source_url(record)}
              for record in datasets["events"]["events"]]
    for record in datasets["signals"]["pedestrianCounts"]:
        item = evidence(record, f"{record['intersection']}, {record['startLocal']}-{record['endLocal']}")
        item["note"] = "Collection dates: "+", ".join(record["collectionDates"])+". "+record["limitations"]
        global_evidence.append(item)
    for record in datasets["signals"]["fitrecMetrics"]:
        item = evidence(record, "FitRec daily visits (more than)")
        global_evidence.append(item)
        if "fitrec" in locations:
            locations["fitrec"]["evidence"].append(item)
    for record in datasets["signals"]["sportsAttendance"]:
        global_evidence.append(evidence(record, "Reported hockey event attendance", note=f"Event date: {record['date']}. {record['limitations']}"))
    history = datasets["libraries"]
    section = history.get("sectionUse") or {}
    ranges = [table.get("returnedObservationRange") for table in section.get("tables", []) if table.get("returnedObservationRange")]
    period = f"{min(r['start'] for r in ranges)} to {max(r['end'] for r in ranges)}" if ranges else "Historical extract; observation period not verified"
    retrieved = [item["retrievedAt"] for dataset in datasets.values() for item in dataset.get("sources", []) if item.get("retrievedAt")]
    if not retrieved:
        retrieved = [d["generatedAt"] for d in datasets.values() if d.get("generatedAt")]
    if not retrieved:
        raise ValueError("Snapshot retrieval or generation date is required")
    collected_at = max(retrieved, key=lambda value: datetime.fromisoformat(value.replace("Z", "+00:00")))
    date = datetime.fromisoformat(collected_at.replace("Z", "+00:00")).astimezone(ZoneInfo("America/New_York")).date()
    week_start = date - timedelta(days=date.weekday())
    for location in locations.values():
        location["buildingCodes"] = sorted(set(location["buildingCodes"]))
        location["meetings"].sort(key=lambda m: m["id"])
        location["evidence"].sort(key=lambda e: e["id"])
        location["hours"].sort(key=lambda h: (h["date"] or "", h["text"]))
    mapped = [meeting for location in locations.values() for meeting in location["meetings"]]
    counts = catalog.get("coverage", {}).get("counts", {})
    return {
        "schemaVersion": 1, "term": catalog.get("term", "FALL 2026"), "collectedAt": collected_at,
        "referenceWeekStart": week_start.isoformat(),
        "coverage": {"coursePages": counts.get("coursePagesParsed", len(catalog.get("courses", []))),
                     "uniqueCourses": counts.get("uniqueCourseCodes", len({m['courseCode'] for m in catalog['meetings']})),
                     "sourceMeetings": len(catalog["meetings"]), "mappedMeetings": len(mapped),
                     "calendarRestrictedMeetings": sum(m["calendarRestricted"] for m in mapped),
                     "mappedLocations": sum(bool(l["meetings"] or l["evidence"] or l["hours"]) for l in locations.values()),
                     "unmappedBuildings": [{"code": code, "meetingCount": count} for code, count in sorted(unmapped.items())],
                     "eventCount": len(events), "mappedEvents": sum(e["locationId"] is not None for e in events)},
        "locations": locations, "events": sorted(events, key=lambda e: (e["start"], e["id"])),
        "libraryHistory": {"name": "School of Theology Library", "observationPeriod": period,
                           "countingMethod": "Historical patron/zone counts; counting method unknown, not verified occupancy.",
                           "patronCounts": [{"weekday": r["weekday"], "timeLocal": r["timeLocal"], "value": r["value"]} for r in history["patronCounts"]],
                           "sectionObservations": sum(len(t["rows"]) for t in section.get("tables", [])),
                           "sourceUrl": source_url(history["patronCounts"][0]) if history["patronCounts"] else ""},
        "signals": sorted(global_evidence, key=lambda e: e["id"]),
        "assumptions": [
            "Published class times drive fictional student plans; enrollment and attendance are unknown.",
            "Published room seats only cap assigned synthetic attendance; they are not observed enrollment or headcounts.",
            "Only explicit building aliases with existing mapped routes are joined; no nearby-building guessing.",
            "Date/session-restricted rows are retained for inspection, not expanded as ordinary weekly classes.",
            "Identical room/time candidates share a key; possible combined sections must not be counted as independent attendance.",
            "Optional visits require audited dated or weekday service hours. Unknown hours and restricted-access venues do not generate optional visits.",
            "Registrations, residential baselines, seats, throughput and historical counts are distinct from live occupancy.",
            "Multi-day event listings are not expanded into recurring occurrences or continuous attendance.",
        ],
        "inputFiles": input_files or [],
    }


def build(input_dir=DEFAULT_INPUT, map_file=DEFAULT_MAP, output=DEFAULT_OUTPUT):
    input_dir, map_file, output = Path(input_dir), Path(map_file), Path(output)
    snapshots, inputs = {}, []
    manifest_path = input_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    expected = {item["path"]: item["sha256"] for item in manifest.get("datasets", [])}
    for name in DATASETS:
        path = input_dir / f"{name}.json"
        body = path.read_bytes()
        checksum = hashlib.sha256(body).hexdigest()
        if path.name in expected and checksum != expected[path.name]:
            raise ValueError(f"Snapshot checksum does not match manifest: {path}")
        snapshots[name] = json.loads(body)
        relative = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.name
        inputs.append({"path": relative, "sha256": checksum})
    body = map_file.read_bytes()
    inputs.append({"path": map_file.relative_to(ROOT).as_posix() if map_file.is_relative_to(ROOT) else map_file.name,
                   "sha256": hashlib.sha256(body).hexdigest()})
    bundle = build_bundle(snapshots, json.loads(body), inputs)
    encoded = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)+"\n"
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent, delete=False) as temporary:
        temporary.write(encoded)
    os.replace(temporary.name, output)
    return bundle, len(encoded.encode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--map-data", type=Path, default=DEFAULT_MAP)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    try:
        bundle, size = build(args.input_dir, args.map_data, args.output)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"Cannot build map data: {error}\n")
    summary = {**bundle["coverage"]}
    summary["unmappedBuildingCount"] = len(summary.pop("unmappedBuildings"))
    print(json.dumps({"output": str(args.output), "bytes": size, **summary}, indent=2))


if __name__ == "__main__":
    main()
