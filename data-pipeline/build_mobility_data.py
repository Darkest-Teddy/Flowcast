"""Build a compact map bundle from the committed road, walking, and bike-trip snapshots."""

from datetime import date, datetime, timedelta
import hashlib
import json
import math
from pathlib import Path
import argparse
import os
import tempfile

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = ROOT / 'data-pipeline' / 'output'
DEFAULT_OUTPUT = ROOT / 'map-client' / 'public' / 'data' / 'mobility.json'
DATASETS = ('road_counts', 'pedestrian_counts', 'bluebikes')


def number(value, name, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value < minimum:
        raise ValueError(f'Invalid {name}: {value!r}')
    return value


def integer(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f'Invalid {name}: {value!r}')
    return value


def position(value):
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError('Location requires longitude and latitude')
    lon, lat = value
    if not (-72 <= number(lon, 'longitude', -180) <= -70 and 41 <= number(lat, 'latitude', -90) <= 43):
        raise ValueError('Location outside Greater Boston')
    return value


def site_base(site):
    if not site.get('id') or not site.get('name') or site.get('campus') not in ('charles-river', 'medical', 'fenway'):
        raise ValueError('Invalid count location identity')
    start, end = date.fromisoformat(site['observedFrom']), date.fromisoformat(site['observedTo'])
    if start > end:
        raise ValueError('Observation period is reversed')
    return {key: site[key] for key in ('id', 'name', 'campus', 'observedFrom', 'observedTo')} | {'position': position(site['position'])}


def count_locations(dataset, mode):
    locations, identities = [], set()
    for site in dataset['locations']:
        compact = site_base(site)
        if compact['id'] in identities:
            raise ValueError('Duplicate count location')
        identities.add(compact['id'])
        profiles, keys = [], set()
        for row in site['profiles']:
            hour = integer(row['hour'], 'hour', 0, 23)
            samples = integer(row['samples'], 'samples', 1, 10000)
            weekday = row['weekday']
            if weekday is not None:
                integer(weekday, 'weekday', 0, 6)
            if mode == 'roads':
                if weekday is None or not row.get('direction'):
                    raise ValueError('Road counts need a weekday and direction')
                profile = {'weekday': weekday, 'hour': hour, 'direction': row['direction'],
                           'bikes': number(row['bikes'], 'bikes'), 'motorVehicles': number(row['motorVehicles'], 'vehicles'), 'samples': samples}
                key = weekday, hour, row['direction']
            else:
                profile = {'weekday': weekday, 'hour': hour, 'pedestrians': number(row['pedestrians'], 'pedestrians'), 'samples': samples}
                if weekday is None:
                    days = row.get('weekdays')
                    if not isinstance(days, list) or not days:
                        raise ValueError('Unknown collection day requires its possible weekdays')
                    profile['weekdays'] = sorted(set(integer(day, 'possible weekday', 0, 6) for day in days))
                key = weekday, hour
            if key in keys:
                raise ValueError('Duplicate count profile would double-count a survey')
            keys.add(key)
            profiles.append(profile)
        compact['profiles'] = profiles
        compact['sourceUrl'] = site.get('sourceUrl', dataset['sourceUrl'])
        locations.append(compact)
    return locations


def build_bundle(inputs):
    for name in DATASETS:
        data = inputs[name]
        if data.get('schemaVersion') != 1 or data.get('dataset') != name or data.get('errors'):
            raise ValueError(f'Incomplete or unsupported snapshot: {name}')
    bike = inputs['bluebikes']
    start, end = date.fromisoformat(bike['period']['start']), date.fromisoformat(bike['period']['end'])
    if start > end or (end-start).days > 366:
        raise ValueError('Invalid Bluebikes observation period')
    weekday_days = {day: 0 for day in range(7)}
    cursor = start
    while cursor <= end:
        weekday_days[cursor.weekday()] += 1
        cursor += timedelta(days=1)
    stations = []
    for site in bike['stations']:
        if site.get('campus') not in ('charles-river', 'medical', 'fenway'):
            raise ValueError('Unknown bike-station campus')
        stations.append({key: site[key] for key in ('id', 'name', 'campus')} | {'position': position(site['position'])})
    ids = {site['id'] for site in stations}
    if len(ids) != len(stations):
        raise ValueError('Duplicate Bluebikes station')
    flows, seen = [], set()
    for flow in bike['flows']:
        weekday = integer(flow['weekday'], 'weekday', 0, 6)
        hour = integer(flow['hour'], 'hour', 0, 23)
        if flow['from'] not in ids or flow['to'] not in ids:
            raise ValueError('Bluebikes flow references a missing station')
        if flow['days'] != weekday_days[weekday]:
            raise ValueError('Bluebikes denominator must include every calendar occurrence of its weekday')
        integer(flow['trips'], 'trips', 1, 10000000)
        number(flow['meanDurationSec'], 'trip duration')
        key = flow['from'], flow['to'], weekday, hour
        if key in seen:
            raise ValueError('Duplicate Bluebikes flow')
        seen.add(key)
        flows.append({key: flow[key] for key in ('from', 'to', 'weekday', 'hour', 'trips', 'days', 'meanDurationSec')})
    return {
        'schemaVersion': 1, 'generatedAt': max(inputs[name]['generatedAt'] for name in DATASETS),
        'roads': {'sourceUrl': inputs['road_counts']['sourceUrl'], 'locations': count_locations(inputs['road_counts'], 'roads')},
        'pedestrians': {'sourceUrl': inputs['pedestrian_counts']['sourceUrl'], 'locations': count_locations(inputs['pedestrian_counts'], 'pedestrians')},
        'bluebikes': {'sourceUrl': bike['sourceUrl'], 'period': bike['period'], 'stations': stations, 'flows': flows},
    }


def build(input_dir=DEFAULT_INPUT, output=DEFAULT_OUTPUT):
    inputs, files = {}, []
    for name in DATASETS:
        path = Path(input_dir) / f'{name}.json'
        raw = path.read_bytes()
        inputs[name] = json.loads(raw)
        try:
            relative = path.resolve().relative_to(ROOT).as_posix()
        except ValueError:
            relative = path.name
        files.append({'path': relative, 'sha256': hashlib.sha256(raw).hexdigest()})
    bundle = build_bundle(inputs)
    bundle['inputFiles'] = files
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=output.parent, delete=False) as file:
        json.dump(bundle, file, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
        file.write('\n')
    os.replace(file.name, output)
    return bundle


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir', type=Path, default=DEFAULT_INPUT)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    bundle = build(args.input_dir, args.output)
    print(f"mobility: {len(bundle['roads']['locations'])} road sites, {len(bundle['pedestrians']['locations'])} pedestrian sites, {len(bundle['bluebikes']['flows'])} bike station-pair/hour bins -> {args.output}")
