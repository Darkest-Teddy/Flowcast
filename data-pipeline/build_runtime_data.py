"""Build compact runtime population and transit snapshots without network access."""

import argparse
import json
import math
import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def valid_capacity(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value >= 0


def build_population(population, campuses, sources):
    students = population["students"]
    if sum(c["headcount"] for c in students["cohorts"]) != students["total"]:
        raise ValueError("Population cohorts do not reconcile")
    capacities, bases, residential = {}, {}, {}
    for campus in campuses:
        for location in campus["locations"]:
            key = location["id"]
            records = sources["locations"].get(key, {}).get("evidence", [])
            units = {"bed-spaces", "residential-spaces"} if location["kind"] == "dorm" else {"seats"}
            records = [e for e in records if e.get("unit") in units and valid_capacity(e.get("value"))
                       and not (location["kind"] == "dorm" and e.get("basis") == "nominal_complex_total")]
            if records:
                record = min(records, key=lambda e: e["value"])
                capacities[key] = int(record["value"])
                bases[key] = {"basis": record["basis"], "unit": record["unit"], "sourceUrl": record["sourceUrl"]}
                if location["kind"] == "dorm":
                    residential[key] = capacities[key]
            elif location["kind"] == "dorm":
                capacities[key] = 0
                bases[key] = {"basis": "available_beds_unverified", "unit": "bed-spaces"}
            else:
                capacity = location["capacity"]
                if not valid_capacity(capacity):
                    raise ValueError(f"Invalid configured capacity: {key}")
                capacities[key] = capacity
                bases[key] = {"basis": "configured_model_capacity", "unit": "people"}
    return {**population, "locationCapacities": capacities, "locationCapacityBasis": bases,
            "residentialCapacities": residential}


def write_compact(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
        output.write(encoded)
    os.replace(output.name, path)
    return len(encoded.encode())


def build(input_dir, campus_dir, output_dir):
    read = lambda path: json.loads(path.read_text())
    population = build_population(read(input_dir / "population.json"),
        [read(path) for path in sorted(campus_dir.glob("*.json"))], read(output_dir / "campus-data.json"))
    transit = read(input_dir / "transit_schedule.json")
    if transit.get("schemaVersion") != 1 or len(transit.get("dates", [])) != 7 or not isinstance(transit.get("trips"), list):
        raise ValueError("Unsupported transit timetable")
    return {"populationBytes": write_compact(output_dir / "population.json", population),
            "transitBytes": write_compact(output_dir / "transit-schedule.json", transit)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=ROOT / "data-pipeline/output")
    parser.add_argument("--campus-dir", type=Path, default=ROOT / "data-pipeline/campuses")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "map-client/public/data")
    args = parser.parse_args()
    print(json.dumps(build(args.input_dir, args.campus_dir, args.output_dir)))
