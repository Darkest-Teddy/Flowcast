"""Acquire a complete Bluebikes month and aggregate trips between BU-area stations."""

from collections import Counter, defaultdict
import csv
from datetime import date, datetime, timedelta
from io import BytesIO, StringIO, TextIOWrapper
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile
from zoneinfo import ZoneInfo

from common import ROOT, ScrapeError, run_cli

SOURCE_URL = "https://bluebikes.com/system-data"
BUCKET = "https://s3.amazonaws.com/hubway-data"
BOSTON = ZoneInfo("America/New_York")
FILE_PATTERN = re.compile(r"^(\d{6})-bluebikes-tripdata\.(csv|zip)$")


def campus_boxes():
    return [(data["campus"], data["bbox"]) for data in (
        json.loads((ROOT / "campuses" / f"{name}.json").read_text())
        for name in ("charles-river", "medical", "fenway"))]


def campus_at(position, boxes):
    lon, lat = position
    for campus, (south, west, north, east) in boxes:
        if west <= lon <= east and south <= lat <= north:
            return campus
    return None


def month_bounds(month):
    try:
        start = date(int(month[:4]), int(month[4:]), 1)
    except (ValueError, TypeError) as exc:
        raise ScrapeError(f"Invalid archive month: {month}") from exc
    following = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    return start, following - timedelta(days=1)


def choose_archive(xml, as_of):
    candidates = []
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise ScrapeError("Invalid Bluebikes archive listing") from exc
    if root.findtext("{*}IsTruncated") == "true":
        raise ScrapeError("Bluebikes year listing is truncated; refusing an incomplete discovery")
    for item in root.findall("{*}Contents"):
        key = item.findtext("{*}Key", "")
        match = FILE_PATTERN.fullmatch(key)
        if not match:
            continue
        start, end = month_bounds(match[1])
        if end < as_of:
            candidates.append((start, match[2] == "zip", key))
    return max(candidates)[2] if candidates else None


def relative_provenance(source):
    provenance = dict(source.provenance)
    raw = provenance.get("rawPath")
    if raw:
        try:
            provenance["rawPath"] = Path(raw).resolve().relative_to(ROOT.parent).as_posix()
        except ValueError:
            provenance["rawPath"] = None
    return provenance


def archive_rows(body, key):
    if key.endswith(".zip"):
        with ZipFile(BytesIO(body)) as archive:
            members = [name for name in archive.namelist()
                       if name.lower().endswith(".csv") and not name.startswith("__MACOSX/")]
            if not members:
                raise ScrapeError("No CSV in Bluebikes archive")
            for name in sorted(members):
                with archive.open(name) as stream:
                    yield from csv.DictReader(TextIOWrapper(stream, encoding="utf-8-sig", newline=""))
    else:
        yield from csv.DictReader(StringIO(body.decode("utf-8-sig"), newline=""))


def local_timestamp(value):
    parsed = datetime.fromisoformat(value.strip())
    return parsed.replace(tzinfo=BOSTON) if parsed.tzinfo is None else parsed.astimezone(BOSTON)


def point(row, prefix):
    position = [float(row[f"{prefix}_lng"]), float(row[f"{prefix}_lat"])]
    if not all(math.isfinite(value) for value in position) or not (-180 <= position[0] <= 180 and -90 <= position[1] <= 90):
        raise ValueError("Invalid coordinates")
    return tuple(round(value, 6) for value in position)


def metres(a, b):
    return math.hypot((a[0] - b[0]) * 111320 * math.cos(math.radians(a[1])), (a[1] - b[1]) * 111320)


def aggregate(rows, month, boxes=None):
    boxes = boxes or campus_boxes()
    start, end = month_bounds(month)
    weekday_days = Counter((start + timedelta(days=offset)).weekday() for offset in range((end - start).days + 1))
    coverage = Counter()
    candidates = []
    station_points, station_names = defaultdict(Counter), defaultdict(Counter)
    seen = set()
    required = {"ride_id", "started_at", "ended_at", "start_station_id", "end_station_id", "start_station_name", "end_station_name", "start_lat", "start_lng", "end_lat", "end_lng"}
    for row in rows:
        if not required.issubset(row):
            raise ScrapeError("Unsupported Bluebikes CSV schema")
        coverage["sourceTrips"] += 1
        trip_id = row["ride_id"].strip()
        if not trip_id:
            coverage["invalidRows"] += 1
            continue
        if trip_id in seen:
            coverage["duplicateTrips"] += 1
            continue
        seen.add(trip_id)
        try:
            begun, finished = local_timestamp(row["started_at"]), local_timestamp(row["ended_at"])
            duration = (finished.astimezone(ZoneInfo("UTC")) - begun.astimezone(ZoneInfo("UTC"))).total_seconds()
            origin, destination = row["start_station_id"].strip(), row["end_station_id"].strip()
            origin_name, destination_name = row["start_station_name"].strip(), row["end_station_name"].strip()
            origin_point, destination_point = point(row, "start"), point(row, "end")
        except (ValueError, TypeError, KeyError):
            coverage["invalidRows"] += 1
            continue
        if not start <= begun.date() <= end:
            coverage["outsidePeriod"] += 1
            continue
        if not origin or not destination or not origin_name or not destination_name:
            coverage["missingStations"] += 1
            continue
        if duration < 60 or duration > 86400:
            coverage["outsideDurationRange"] += 1
            continue
        if origin == destination:
            coverage["sameStationTrips"] += 1
            continue
        origin_campus, destination_campus = campus_at(origin_point, boxes), campus_at(destination_point, boxes)
        if not origin_campus or not destination_campus:
            coverage["outsideCampusTrips"] += 1
            continue
        for station, name, position in ((origin, origin_name, origin_point), (destination, destination_name, destination_point)):
            station_points[station][position] += 1
            station_names[station][name] += 1
        candidates.append((origin, destination, begun.weekday(), begun.hour, duration, origin_point, destination_point))
    canonical = {station: min(points, key=lambda position: (-points[position], position)) for station, points in station_points.items()}
    flows = defaultdict(lambda: [0, 0.0])
    used = set()
    for origin, destination, weekday, hour, duration, op, dp in candidates:
        # A moved station ID must not connect observations from two distinct places.
        if metres(op, canonical[origin]) > 250 or metres(dp, canonical[destination]) > 250:
            coverage["stationPositionConflicts"] += 1
            continue
        key = (origin, destination, weekday, hour)
        flows[key][0] += 1
        flows[key][1] += duration
        coverage["retainedTrips"] += 1
        if campus_at(canonical[origin], boxes) != campus_at(canonical[destination], boxes):
            coverage["interCampusTrips"] += 1
        used.update((origin, destination))
    stations = [{"id": station, "name": min(station_names[station], key=lambda name: (-station_names[station][name], name)),
                 "position": list(canonical[station]), "campus": campus_at(canonical[station], boxes)} for station in sorted(used)]
    result = [{"from": origin, "to": destination, "weekday": weekday, "hour": hour,
               "trips": int(values[0]), "days": weekday_days[weekday], "meanDurationSec": round(values[1] / values[0], 2)}
              for (origin, destination, weekday, hour), values in sorted(flows.items())]
    return {"period": {"start": start.isoformat(), "end": end.isoformat()}, "stations": stations, "flows": result,
            "coverage": {**dict(coverage), "stations": len(stations), "flowBins": len(result),
                         "durationRangeSec": [60, 86400], "stationPositionToleranceMetres": 250,
                         "normalization": "Trips divided by every matching weekday in the complete archive month, including zero-trip days.",
                         "scope": "Both endpoints inside the three configured campus bounds; station pairs, not measured street routes."}}


def collect(fetcher, as_of=None):
    """Download one complete public month, cache it, and retain aggregate BU station flows."""
    cutoff = date.fromisoformat(as_of) if as_of else datetime.now(BOSTON).date()
    sources, key = [], None
    for year in (cutoff.year, cutoff.year - 1):
        listing = fetcher.get(f"{BUCKET}?list-type=2&prefix={year}")
        sources.append(relative_provenance(listing))
        key = choose_archive(listing.body, cutoff)
        if key:
            break
    if not key:
        raise ScrapeError("No complete Bluebikes month found in this or the previous year")
    archive = fetcher.get(f"{BUCKET}/{key}")
    sources.append(relative_provenance(archive))
    result = aggregate(archive_rows(archive.body, key), key[:6])
    if not result["stations"] or not result["flows"]:
        raise ScrapeError("The archive contains no valid trips between BU-area stations")
    return {"sourceUrl": SOURCE_URL, "sources": sources, "archive": key, **result, "errors": []}


if __name__ == "__main__":
    run_cli("bluebikes", collect, lambda parser: parser.add_argument("--as-of", help="YYYY-MM-DD; excludes incomplete archive months"))
