"""Build the class finder's sidecar: building names/addresses and published instructors.

campus-data.json keeps class meetings lean (it is a simulation input, hashed by the event-impact
build), so the details only the class finder shows live in class-directory.json:

* buildings: the 25Live building-code directory's name and street address for every building
  code that has a mapped class meeting.
* instructors: the instructor text published on each mapped meeting's course page, keyed by the
  meeting id used in campus-data.json. Meetings without a published instructor are left out.

Reads data-pipeline/output/catalog.json and the built campus-data.json; writes
map-client/public/data/class-directory.json.
"""

import argparse
import json
import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CATALOG = ROOT / "data-pipeline" / "output" / "catalog.json"
DEFAULT_CAMPUS = ROOT / "map-client" / "public" / "data" / "campus-data.json"
DEFAULT_OUTPUT = ROOT / "map-client" / "public" / "data" / "class-directory.json"


def build_directory(catalog, campus):
    mapped = {meeting["id"]: meeting for location in campus["locations"].values() for meeting in location.get("meetings", [])}
    codes = {meeting.get("buildingCode") for meeting in mapped.values() if meeting.get("buildingCode")}
    buildings, source_url = {}, None
    for record in catalog.get("buildings", []):
        code = record.get("buildingCode")
        if code not in codes or not record.get("name"):
            continue
        buildings[code] = {"name": record["name"], "address": record.get("address") or None}
        source_url = source_url or (record.get("provenance") or {}).get("url")
    instructors = {}
    for row in catalog.get("meetings", []):
        name = (row.get("instructor") or "").strip()
        if row.get("id") in mapped and name:
            instructors[row["id"]] = name
    return {
        "schemaVersion": 1,
        "term": campus.get("term"),
        "buildingsSourceUrl": source_url,
        "basis": "Building names and addresses from BU's published building-code directory; instructors as printed on each course's published schedule. Instructors may change; check the course page.",
        "buildings": dict(sorted(buildings.items())),
        "instructors": dict(sorted(instructors.items())),
    }


def build(catalog_path=DEFAULT_CATALOG, campus_path=DEFAULT_CAMPUS, output=DEFAULT_OUTPUT):
    directory = build_directory(json.loads(Path(catalog_path).read_text()), json.loads(Path(campus_path).read_text()))
    encoded = json.dumps(directory, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent, delete=False) as temporary:
        temporary.write(encoded)
    os.replace(temporary.name, output)
    os.chmod(output, 0o644)
    return directory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--campus-data", type=Path, default=DEFAULT_CAMPUS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    directory = build(args.catalog, args.campus_data, args.output)
    print(json.dumps({"output": str(args.output), "buildings": len(directory["buildings"]), "instructors": len(directory["instructors"])}, indent=2))


if __name__ == "__main__":
    main()
