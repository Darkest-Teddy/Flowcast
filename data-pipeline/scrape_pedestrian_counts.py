"""Map pedestrian count observations to verified street intersections, using cached sources."""

import csv
from collections import defaultdict
from datetime import date
import io
import hashlib
import json
import math
from pathlib import Path

from common import OUTPUT, ROOT, ScrapeError, run_cli, stable_id

MPO_ROOT = 'https://www.ctps.org/geoserver/www/apps/bp-counts-app-01262024/'
MPO_COUNTS = MPO_ROOT + 'data/csv/bp_counts.csv'
MPO_GEOMETRY = MPO_ROOT + 'data/json/ctps_bp_count_locations_pt.geo.json'
REPORT = 'https://www.bu.edu/community/files/2024/02/Warren-Towers-EPNF.pdf'
STREET_FILE = ROOT.parent / 'map-client/public/data/street.json'
INTERSECTIONS = {
    "Commonwealth Avenue at St Mary's Street": ('Commonwealth Avenue', "Saint Mary's Street"),
    'Commonwealth Avenue at Cummington Mall': ('Commonwealth Avenue', 'Cummington Mall'),
    'Commonwealth Avenue at Granby Street': ('Commonwealth Avenue', 'Granby Street'),
    'Commonwealth Avenue at Hinsdale Mall': ('Commonwealth Avenue', 'Hinsdale Mall'),
    'Commonwealth Avenue at Silber Way/Blandford Mall': ('Commonwealth Avenue', 'Silber Way'),
    'Bay State Road at Granby Street/Back Street': ('Bay State Road', 'Granby Street'),
    'Silber Way at Bay State Road': ('Silber Way', 'Bay State Road'),
}


def provenance(source):
    result = dict(source.provenance)
    if result.get('rawPath'):
        try:
            result['rawPath'] = str(Path(result['rawPath']).resolve().relative_to(ROOT.parent))
        except ValueError:
            result['rawPath'] = None
    return result


def campus_for(position, campuses):
    lon, lat = position
    for campus, bounds in campuses.items():
        south, west, north, east = bounds
        if south <= lat <= north and west <= lon <= east:
            return campus
    return None


def street_intersection(signals, first, second):
    """Match both named approaches in one existing OSM-derived signal group."""
    groups = defaultdict(list)
    for signal in signals:
        groups[signal['group']].append(signal)
    matches = []
    for key, group in groups.items():
        names = {x['road'].replace("St. Mary's Street", "Saint Mary's Street") for x in group}
        if first in names and second in names:
            points = [x['position'] for x in group]
            matches.append(([sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points)], key))
    return matches[0] if len(matches) == 1 else None


def map_warren(rows, signals):
    locations = {}
    errors = []
    for row in rows:
        name = row['intersection']
        if name not in INTERSECTIONS:
            errors.append({'source': REPORT, 'message': f'Unknown intersection: {name}'})
            continue
        match = street_intersection(signals, *INTERSECTIONS[name])
        if match is None:
            errors.append({'source': REPORT, 'message': f'No uniquely matched signal group for {name}'})
            continue
        start = row['startLocal'].split(':')
        end = row['endLocal'].split(':')
        if start[1] != '00' or end[1] != '00' or int(end[0]) != int(start[0]) + 1:
            raise ScrapeError(f'Expected complete hourly count for {name}')
        value = row['value']
        if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ScrapeError(f'Invalid pedestrian count for {name}')
        dates = sorted(row['collectionDates'])
        if dates != ['2023-10-18', '2023-10-19'] or row.get('exactIntersectionDate') is not None:
            raise ScrapeError(f'Review changed observation dates for {name}')
        position, nodes = match
        location = locations.setdefault(name, {
            'id': 'ped-' + stable_id(name), 'name': name, 'position': position,
            'campus': 'charles-river', 'sourceUrl': REPORT,
            'observedFrom': dates[0], 'observedTo': dates[-1],
            'geometrySourceFile': 'map-client/public/data/street.json', 'signalGroup': nodes,
            'geometryMethod': 'Centroid of the mapped intersection signal poles',
            'profiles': [],
            'note': 'Midweek count; the report gives October 18–19, 2023 but does not identify each intersection’s collection day.',
        })
        profile = {'weekday': None, 'weekdays': [2, 3], 'hour': int(start[0]), 'pedestrians': value, 'samples': 1}
        if any(p['hour'] == profile['hour'] for p in location['profiles']):
            raise ScrapeError(f'Duplicate hourly count for {name}')
        location['profiles'].append(profile)
    return sorted(locations.values(), key=lambda x: x['name']), errors


def mpo_locations(rows, geometry, campuses, minimum_year=2015):
    positions = {str(feature['properties']['loc_id']): feature for feature in geometry['features']}
    groups = defaultdict(list)
    relevant_rows = 0
    for row in rows:
        feature = positions.get(row['bp_loc_id'])
        if row['count_type'] != 'P' or not feature:
            continue
        point = feature['geometry']['coordinates']
        campus = campus_for(point, campuses)
        if not campus:
            continue
        relevant_rows += 1
        if int(row['count_date'][:4]) >= minimum_year:
            groups[row['bp_loc_id']].append(row)
    result = []
    for location_id, observations in sorted(groups.items()):
        # Each row is a movement; sum complete hours within each date, then average dates.
        by_date_hour = {}
        by_date = defaultdict(list)
        seen = set()
        for row in observations:
            key = row['count_id'], row['from_st_name'], row['from_st_dir'], row['to_st_name'], row['to_st_dir'], row['count_date']
            if key in seen:
                raise ScrapeError(f'Duplicate pedestrian movement: {key}')
            seen.add(key)
            by_date[row['count_date']].append(row)
        for day, movements in by_date.items():
            for hour in range(7, 21):
                values = [row.get(f'cnt_{hour:02d}{minute:02d}', '')
                          for row in movements for minute in (0, 15, 30, 45)]
                if not all(v.strip() for v in values):
                    continue
                counts = [float(value) for value in values]
                if any(not math.isfinite(value) or value < 0 for value in counts):
                    raise ScrapeError('Invalid pedestrian count')
                by_date_hour[day, hour] = sum(counts)
        profiles = defaultdict(list)
        for (day, hour), count in by_date_hour.items():
            profiles[date.fromisoformat(day).weekday(), hour].append(count)
        if not profiles:
            continue
        feature = positions[location_id]
        point = feature['geometry']['coordinates']
        result.append({'id': 'mpo-' + location_id, 'name': feature['properties']['description'], 'position': point,
                       'campus': campus_for(point, campuses), 'sourceUrl': MPO_ROOT + 'index.html',
                       'observedFrom': min(row['count_date'] for row in observations),
                       'observedTo': max(row['count_date'] for row in observations),
                       'profiles': [{'weekday': weekday, 'hour': hour, 'pedestrians': sum(values) / len(values), 'samples': len(values)}
                                    for (weekday, hour), values in sorted(profiles.items())]})
    return result, relevant_rows


def collect(fetcher):
    """Build mapped pedestrian observations without re-downloading the saved Warren report."""
    signals = json.loads((OUTPUT / 'signals.json').read_text())
    street_bytes = STREET_FILE.read_bytes()
    streets = json.loads(street_bytes)
    locations, unmapped = map_warren(signals['pedestrianCounts'], streets['signals'])
    counts, geometry = fetcher.get(MPO_COUNTS), fetcher.get(MPO_GEOMETRY)
    campuses = {name: json.loads((ROOT / 'campuses' / f'{name}.json').read_text())['bbox']
                for name in ('charles-river', 'medical', 'fenway')}
    mpo, relevant = mpo_locations(list(csv.DictReader(io.StringIO(counts.text))), json.loads(geometry.text), campuses)
    locations += mpo
    return {'sourceUrl': REPORT, 'sources': [provenance(s) for s in (counts, geometry)] +
            [signals['pedestrianCounts'][0]['provenance']], 'locations': locations,
            'coverage': {'locations': len(locations), 'hourlyProfiles': sum(len(x['profiles']) for x in locations),
                         'mpoCampusPedestrianRows': relevant, 'mpoLocationsSince2015': len(mpo),
                         'minimumMpoYear': 2015, 'mpoCompletenessRule': 'All recorded directional movements must have four measured quarters for the reported hour', 'warrenSignalFile': 'data-pipeline/output/signals.json'},
            'unmapped': sorted({entry['message'] for entry in unmapped}),
            'inputFiles': [{'path': 'map-client/public/data/street.json', 'sha256': hashlib.sha256(street_bytes).hexdigest()},
                           {'path': 'data-pipeline/output/signals.json', 'sha256': hashlib.sha256((OUTPUT / 'signals.json').read_bytes()).hexdigest()}],
            'errors': []}


if __name__ == '__main__':
    run_cli('pedestrian_counts', collect)
