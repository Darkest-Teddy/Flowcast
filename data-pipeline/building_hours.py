"""BU's published academic building hours (inputs/academic_building_hours.json) as weekly opening
hours on the map's locations, under `buildingHours`.

Kept apart from the venue `hours`: those decide the reference week and admit optional visits;
these only let the map show a building closed outside its published hours. Buildings with no
published hours get none and are never shown closed.

    python3 data-pipeline/building_hours.py   # writes them into map-client/public/data/campus-data.json
"""

import json
import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parent.parent
INPUT = ROOT / "data-pipeline" / "inputs" / "academic_building_hours.json"
BUNDLE = ROOT / "map-client" / "public" / "data" / "campus-data.json"
DAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def clock(seconds):
    hour, minute = divmod(seconds // 60, 60)
    suffix = "AM" if hour % 24 < 12 else "PM"
    hour = hour % 12 or 12
    return f"{hour}:{minute:02d} {suffix}" if minute else f"{hour} {suffix}"


def weekly_hours(path=INPUT):
    """{locationId: [weekly OpeningHours]} from the input, validated."""
    data = json.loads(Path(path).read_text())
    out = {}
    for building in data["buildings"]:
        entries = []
        for day, windows in sorted(building["week"].items(), key=lambda item: int(item[0])):
            weekday = int(day)
            if not 0 <= weekday <= 6:
                raise ValueError(f"Building hours weekday out of range: {building['locationId']}")
            for start, end in windows:
                if not 0 <= start < end <= 86400:
                    raise ValueError(f"Invalid building hours window: {building['locationId']}")
            text = ", ".join(f"{clock(a)} – {clock(b)}" for a, b in windows) or "Closed"
            entries.append({"date": None, "weekday": weekday, "validFrom": data["validFrom"], "validTo": data["validTo"],
                            "windows": windows, "text": f"{DAYS[weekday]} {text}", "sourceUrl": building["sourceUrl"],
                            "qualifier": f"Building hours: {building['basis']} Outside them: {building['access']}."})
        out[building["locationId"]] = entries
    return out


def attach(locations, path=INPUT):
    """Adds `buildingHours` to the bundle's locations; an unknown location is an error."""
    for location_id, entries in weekly_hours(path).items():
        if location_id not in locations:
            raise ValueError(f"Building hours reference unknown map location: {location_id}")
        locations[location_id]["buildingHours"] = entries
    return locations


def main():
    bundle = json.loads(BUNDLE.read_text())
    attach(bundle["locations"])
    encoded = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=BUNDLE.parent, delete=False) as temporary:
        temporary.write(encoded)
    os.replace(temporary.name, BUNDLE)
    print(f"Building hours for {sum(1 for l in bundle['locations'].values() if 'buildingHours' in l)} locations -> {BUNDLE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
