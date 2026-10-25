"""Snapshot published MBTA service for the representative week, using cached GTFS."""
import csv
from datetime import date, timedelta
import io
import json
import math
from pathlib import Path
import zipfile
from common import Fetcher, ScrapeError, run_cli

ROOT = Path(__file__).resolve().parent.parent
FEED_URL = 'https://cdn.mbta.com/MBTA_GTFS.zip'
TRANSIT_FILE = ROOT / 'map-client/public/data/transit.json'
WEEK_START = '2026-10-26'
DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']


def seconds(value):
    parts = value.split(':')
    if len(parts) != 3:
        raise ScrapeError(f'Invalid GTFS time: {value}')
    hour, minute, second = map(int, parts)
    if hour < 0 or not 0 <= minute < 60 or not 0 <= second < 60:
        raise ScrapeError(f'Invalid GTFS time: {value}')
    return hour * 3600 + minute * 60 + second


def csv_rows(archive, name):
    with archive.open(name) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding='utf-8-sig', newline=''))


def active_days(calendars, exceptions, week_start):
    start = date.fromisoformat(week_start)
    dates = [(i, start + timedelta(days=i)) for i in range(-1, 7)]
    out = {}
    for row in calendars:
        for index, day in dates:
            stamp = day.strftime('%Y%m%d')
            if row['start_date'] <= stamp <= row['end_date'] and row[DAYS[day.weekday()]] == '1':
                out.setdefault(row['service_id'], set()).add(index)
    by_date = {day.strftime('%Y%m%d'): index for index, day in dates}
    for row in exceptions:
        if row['date'] not in by_date:
            continue
        days = out.setdefault(row['service_id'], set())
        if row['exception_type'] == '1':
            days.add(by_date[row['date']])
        elif row['exception_type'] == '2':
            days.discard(by_date[row['date']])
        else:
            raise ScrapeError('Unsupported GTFS calendar exception')
    return out


def trim_to_geometry(trips, stops, routes):
    """Keep nearby anchors and their outside neighbors so exits remain explicit."""
    by_route = {(route['id'], direction): [path['path'] for path in route.get('paths', [])
                                          if path['direction'] == direction]
                for route in routes for direction in (0, 1)}
    near_cache = {}
    def near(route, direction, stop):
        key = (route, direction, stop)
        if key not in near_cache:
            paths = by_route.get((route, direction), [])
            lon, lat = stops[stop]['position']
            kx = 111320 * math.cos(math.radians(lat))
            found = False
            for path in paths:
                for a, b in zip(path, path[1:]):
                    ax, ay = (a[0] - lon) * kx, (a[1] - lat) * 110540
                    bx, by = (b[0] - lon) * kx, (b[1] - lat) * 110540
                    dx, dy = bx - ax, by - ay
                    denominator = dx * dx + dy * dy
                    fraction = max(0, min(1, -(ax * dx + ay * dy) / denominator)) if denominator else 0
                    if math.hypot(ax + fraction * dx, ay + fraction * dy) <= 100:
                        found = True
                        break
                if found:
                    break
            near_cache[key] = found
        return near_cache[key]
    kept = []
    for trip in trips:
        # Fixtures and consumers without geometry retain their original timetable.
        if not by_route.get((trip['route'], trip['direction'])):
            kept.append(trip)
            continue
        rows = trip['stops']
        indices = {j for i, row in enumerate(rows) if near(trip['route'], trip['direction'], row['stop'])
                   for j in (i - 1, i, i + 1) if 0 <= j < len(rows)}
        if len(indices) >= 2:
            trip['stops'] = [rows[i] for i in sorted(indices)]
            kept.append(trip)
    needed = {row['stop'] for trip in kept for row in trip['stops']}
    return kept, {key: value for key, value in stops.items() if key in needed}


def parse_gtfs(body, transit, week_start=WEEK_START):
    archive = zipfile.ZipFile(io.BytesIO(body))
    feed = next(csv_rows(archive, 'feed_info.txt'))
    start = date.fromisoformat(week_start)
    # Never silently apply a future/current timetable to an uncovered reference week.
    if not (feed['feed_start_date'] <= (start - timedelta(days=1)).strftime('%Y%m%d')
            and feed['feed_end_date'] >= (start + timedelta(days=6)).strftime('%Y%m%d')):
        raise ScrapeError(f'GTFS does not cover reference week {week_start}')
    active = active_days(csv_rows(archive, 'calendar.txt'), csv_rows(archive, 'calendar_dates.txt'), week_start)
    route_ids = {r['id'] for r in transit['routes'] if r['kind'] != 'shuttle'}
    selected = {}
    for row in csv_rows(archive, 'trips.txt'):
        if row['route_id'] not in route_ids or not active.get(row['service_id']):
            continue
        direction = int(row['direction_id'])
        if direction not in (0, 1):
            continue
        selected[row['trip_id']] = {'id': row['trip_id'], 'route': row['route_id'], 'direction': direction,
                                   'weekdays': sorted(active[row['service_id']]), 'stops': []}
    for row in csv_rows(archive, 'stop_times.txt'):
        trip = selected.get(row['trip_id'])
        if trip is None:
            continue
        if not row['arrival_time'] or not row['departure_time']:
            raise ScrapeError(f'Missing published stop time in {row["trip_id"]}')
        trip['stops'].append({'stop': row['stop_id'], 'arrival': seconds(row['arrival_time']),
                              'departure': seconds(row['departure_time']), 'sequence': int(row['stop_sequence'])})
    valid = []
    rejected = 0
    for trip in selected.values():
        trip['stops'].sort(key=lambda row: row['sequence'])
        rows = trip['stops']
        if len(rows) < 2 or any(r['arrival'] > r['departure'] for r in rows) or any(
                rows[i]['departure'] > rows[i + 1]['arrival'] for i in range(len(rows) - 1)):
            rejected += 1
            continue
        for row in rows:
            del row['sequence']
        valid.append(trip)
    needed = {row['stop'] for trip in valid for row in trip['stops']}
    map_ids = {platform: stop['id'] for stop in transit['stops'] for platform in [stop['id'], *stop['platforms']]}
    stops = {}
    for row in csv_rows(archive, 'stops.txt'):
        if row['stop_id'] not in needed:
            continue
        stops[row['stop_id']] = {'position': [float(row['stop_lon']), float(row['stop_lat'])],
                                 'mapStopId': map_ids.get(row['stop_id']) or map_ids.get(row.get('parent_station'))}
    if needed - stops.keys():
        raise ScrapeError('GTFS stop times reference missing stop coordinates')
    source_trip_count = len(valid)
    valid, stops = trim_to_geometry(valid, stops, transit['routes'])
    return {'referenceWeekStart': week_start, 'dates': [(start + timedelta(days=i)).isoformat() for i in range(7)],
            'priorDate': (start - timedelta(days=1)).isoformat(),
            'feed': {'start': feed['feed_start_date'], 'end': feed['feed_end_date'], 'version': feed['feed_version']},
            'sourceUrl': FEED_URL, 'stops': stops, 'trips': sorted(valid, key=lambda t: t['id']),
            'coverage': {'routes': sorted({t['route'] for t in valid}), 'trips': len(valid), 'stops': len(stops),
                         'rejectedTrips': rejected, 'sourceTrips': source_trip_count, 'geometryBufferMetres': 100, 'excludedRoutes': sorted(route_ids - {t['route'] for t in valid}),
                         'previousDayIncluded': True, 'shuttleSchedulesIncluded': False}, 'errors': []}


def collect(fetcher, week_start=WEEK_START):
    """Extract the official MBTA timetable without polling or estimating headways."""
    source = fetcher.get(FEED_URL)
    result = parse_gtfs(source.body, json.loads(TRANSIT_FILE.read_text()), week_start)
    provenance = dict(source.provenance)
    provenance['rawPath'] = str(Path(provenance['rawPath']).relative_to(ROOT))
    result['sources'] = [provenance]
    return result


if __name__ == '__main__':
    run_cli('transit_schedule', collect, lambda parser: parser.add_argument('--week-start', default=WEEK_START))
