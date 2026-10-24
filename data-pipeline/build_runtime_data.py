"""Build compact runtime population and transit snapshots without network access."""

import argparse
from datetime import date, timedelta
import json
import math
import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def valid_capacity(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value >= 0


def build_population(population, campuses, sources, availability=None, estimates=None):
    students = population["students"]
    if sum(c["headcount"] for c in students["cohorts"]) != students["total"]:
        raise ValueError("Population cohorts do not reconcile")
    capacities, bases, residential, names = {}, {}, {}, {}
    dated, campus_minimums, academic = {}, [], {}
    if availability:
        week_start = date.fromisoformat(sources['referenceWeekStart'])
        week_end = week_start + timedelta(days=6)
        for record in availability['records']:
            if record['unit'] != 'bed-spaces' or not valid_capacity(record['value']):
                raise ValueError('Invalid dated residential capacity')
            if date.fromisoformat(record['validFrom']) <= week_start and week_end <= date.fromisoformat(record['validTo']):
                if record['locationId'] in dated:
                    raise ValueError('Overlapping residential capacity records')
                dated[record['locationId']] = record
        for record in availability.get('campusResidentMinimums', []):
            if not valid_capacity(record['students']) or not isinstance(record['students'], int):
                raise ValueError('Invalid campus resident minimum')
            if date.fromisoformat(record['validFrom']) <= week_start and week_end <= date.fromisoformat(record['validTo']):
                campus_minimums.append(record)
    for campus in campuses:
        for location in campus["locations"]:
            key = location["id"]
            records = sources["locations"].get(key, {}).get("evidence", [])
            units = {"bed-spaces", "residential-spaces"} if location["kind"] == "dorm" else {"seats"}
            records = [e for e in records if e.get("unit") in units and valid_capacity(e.get("value"))
                       and not (location["kind"] == "dorm" and e.get("basis") in ("nominal_complex_total", "dated_availability"))]
            override = dated.get(key) if location['kind'] == 'dorm' else None
            if records or override:
                record = override or min(records, key=lambda e: e["value"])
                capacities[key] = int(record["value"])
                bases[key] = {"basis": record["basis"], "unit": record["unit"], "sourceUrl": record["sourceUrl"]}
                if override:
                    if override.get('displayName'):
                        names[key] = override['displayName']
                    bases[key].update({field: override[field] for field in ('coverage', 'validFrom', 'validTo', 'note', 'sourceUrls')})
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
            rooms = {}
            for meeting in sources['locations'].get(key, {}).get('meetings', []):
                if meeting.get('calendarRestricted') or not meeting.get('roomCode'):
                    continue
                building_codes = sources['locations'].get(key, {}).get('buildingCodes', [])
                building_code = meeting.get('buildingCode') or (building_codes[0] if len(building_codes) == 1 else None)
                if not building_code and len(building_codes) > 1:
                    raise ValueError(f'Ambiguous building code for room: {key}/{meeting["roomCode"]}')
                values = rooms.setdefault((building_code or key, meeting['roomCode']), set())
                value = meeting.get('roomCapacity')
                if value is not None:
                    if not valid_capacity(value):
                        raise ValueError(f'Invalid room capacity: {key}/{meeting["roomCode"]}')
                    values.add(value)
            if rooms:
                # Repeated/cross-listed meetings do not create additional physical seats.
                total = sum(min(values) if values else 24 for values in rooms.values())
                academic[key] = {'value': total, 'unit': 'seats', 'roomCount': len(rooms),
                    'publishedRooms': sum(bool(values) for values in rooms.values()),
                    'modeledRooms': sum(not values for values in rooms.values()),
                    'conflictingRooms': sum(len(values) > 1 for values in rooms.values()),
                    'sourceUrls': sorted({m['sourceUrl'] for m in sources['locations'][key]['meetings'] if m.get('sourceUrl')}),
                    'basis': 'deduplicated_classroom_seats',
                    'confidence': 'mixed_published_and_modeled' if any(not v or len(v) > 1 for v in rooms.values()) else 'published',
                    'note': 'Mapped room-seat reference, not whole-building occupancy capacity. Unknown rooms use 24 seats; conflicting published counts use the smaller value.'}
                if location['kind'] in ('classroom', 'dorm'):
                    capacities[key] = total + residential.get(key, 0)
                    bases[key] = {**academic[key], 'basis': 'residential_beds_plus_classroom_seats' if residential.get(key, 0) else 'deduplicated_classroom_seats',
                                  'residentialBeds': residential.get(key, 0)}
                else:
                    # Library/gym activity areas may overlap teaching spaces; never add both.
                    capacities[key] = max(capacities[key], total)
                    bases[key]['academicSeatReference'] = total
    housing_estimates, activity_estimates = {}, {}
    if estimates:
        if estimates['referenceWeekStart'] != sources['referenceWeekStart']:
            raise ValueError('Estimated profiles require review for this reference week')
        locations = {l['id']: l for campus in campuses for l in campus['locations']}
        for kind, target in [('housing', housing_estimates), ('activities', activity_estimates)]:
            for profile in estimates[kind]:
                key = profile['locationId']
                if key not in locations or key in housing_estimates or key in activity_estimates:
                    raise ValueError(f'Unknown or duplicated estimated profile: {key}')
                if profile['confidence'] != 'low' or not valid_capacity(profile['capacity']) or not profile['note'] or not profile['proxy']:
                    raise ValueError(f'Invalid estimated profile metadata: {key}')
                if kind == 'housing':
                    if locations[key]['kind'] != 'dorm' or key in residential or not 0 <= profile['occupancyRate'] <= 1:
                        raise ValueError(f'Estimated housing conflicts with published housing: {key}')
                    basis = 'estimated_residential_beds'
                else:
                    if locations[key]['kind'] == 'dorm' or sources['locations'].get(key, {}).get('meetings'):
                        raise ValueError(f'Estimated activity conflicts with sourced classes: {key}')
                    basis = 'estimated_student_capacity'
                target[key] = profile
                if kind == 'housing':
                    capacities[key] = profile['capacity']
                bases[key] = {'referenceCapacity': capacities[key], 'referenceBasis': 'configured_size_proxy' if kind == 'activities' else 'estimated_beds', 'basis': basis, 'unit': 'people', 'confidence': 'low', 'note': profile['note'], 'proxy': profile['proxy']}
    return {**population, "locationEstimatedProfiles": activity_estimates, "estimatedHousingProfiles": housing_estimates,
            "academicCapacities": academic, "campusResidentMinimums": campus_minimums,
            "locationCapacities": capacities, "locationCapacityBasis": bases,
            "residentialCapacities": residential, "locationNames": names, "residentialAvailability": list(dated.values())}


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
        [read(path) for path in sorted(campus_dir.glob("*.json"))], read(output_dir / "campus-data.json"), read(input_dir / "residential_availability.json"), read(ROOT / "data-pipeline/estimated_profiles.json"))
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
