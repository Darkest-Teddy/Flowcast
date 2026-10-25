"""Build the BU Shuttle timetable for playback and the student planner (stdlib only, offline).

Two published sources, in order of preference for each route and weekday:

1. TransLoc's current scheduled stop times, recorded by capture_shuttle_times.py. Only the
   windows those polls could see are used; inside a window the recorded times replace the
   baseline, including the absence of service.
2. BU's TransLoc GTFS feed (snapshots/transloc/bu-gtfs-2024-25.zip), the most recent complete
   machine-readable BU Shuttle timetable. Its calendars cover the 2024-25 academic year, so it is
   applied to Fall 2026 by weekday from the equivalent fall-term week (Monday 21 October 2024)
   and labelled as a baseline, not a Fall 2026 timetable.

Each route/weekday records which source it came from, and every recorded window is compared with
the baseline so stale headways are visible rather than hidden.

    python3 build_shuttle_schedule.py
"""
import csv
from datetime import date, datetime, timedelta
import hashlib
import io
import json
import math
from pathlib import Path
import zipfile
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SNAPSHOTS = HERE / 'snapshots' / 'transloc'
GTFS = SNAPSHOTS / 'bu-gtfs-2024-25.zip'
GTFS_URL = 'https://api.transloc.com/gtfs/bu.zip'
ROUTES = SNAPSHOTS / 'routes.json'
OUTPUT = ROOT / 'map-client' / 'public' / 'data' / 'shuttle-schedule.json'
BOSTON = ZoneInfo('America/New_York')
SCENARIO_WEEK = '2026-10-26'  # aligned with the saved MBTA timetable week, by weekday
BASELINE_WEEK = date(2024, 10, 21)  # same fall-term week in the GTFS feed's academic year
SERVICE_DAY_START = 4 * 3600  # times before 04:00 belong to the previous evening's service
MAX_SEGMENT = 30 * 60  # a recorded stop time more than this after the previous stop is another run
# GTFS route_short_name -> TransLoc RouteID (the map's "BU-<RouteID>"). Hyatt and the
# Thanksgiving service have no current TransLoc route on the map and are left out.
ROUTE_FOR_GTFS = {'1BU': 1, 'BUMC': 2, 'COMM': 3, 'FEN': 4, 'NITE': 6}
DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']


def seconds(value):
    hour, minute, second = map(int, value.split(':'))
    return hour * 3600 + minute * 60 + second


def rows(archive, name):
    with archive.open(name) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding='utf-8-sig', newline=''))


def address_ids(routes):
    """(lat, lng) rounded to 6 places -> TransLoc AddressID: GTFS and TransLoc share stop coordinates."""
    out = {}
    for route in routes:
        for stop in route['Stops']:
            out[(round(stop['Latitude'], 6), round(stop['Longitude'], 6))] = stop['AddressID']
    return out


def baseline(routes):
    """Every BU GTFS trip in the baseline week, frequencies expanded (exact_times=1)."""
    archive = zipfile.ZipFile(GTFS)
    feed = next(rows(archive, 'feed_info.txt'))
    week = [BASELINE_WEEK + timedelta(days=i) for i in range(7)]
    active = {}
    for row in rows(archive, 'calendar.txt'):
        for index, day in enumerate(week):
            stamp = day.strftime('%Y%m%d')
            if row['start_date'] <= stamp <= row['end_date'] and row[DAYS[day.weekday()]] == '1':
                active.setdefault(row['service_id'], set()).add(index)
    stamps = {day.strftime('%Y%m%d'): index for index, day in enumerate(week)}
    for row in rows(archive, 'calendar_dates.txt'):
        if row['date'] in stamps:
            days = active.setdefault(row['service_id'], set())
            (days.add if row['exception_type'] == '1' else days.discard)(stamps[row['date']])
    route_names = {row['route_id']: row['route_short_name'] for row in rows(archive, 'routes.txt')}
    trips = {row['trip_id']: row for row in rows(archive, 'trips.txt')
             if route_names.get(row['route_id']) in ROUTE_FOR_GTFS and active.get(row['service_id'])}
    pattern = {}
    for row in rows(archive, 'stop_times.txt'):
        if row['trip_id'] in trips:
            pattern.setdefault(row['trip_id'], []).append(
                # A missing departure (trip 6030977) means no published dwell: depart at arrival.
                (int(row['stop_sequence']), row['stop_id'], seconds(row['arrival_time']),
                 seconds(row['departure_time'] or row['arrival_time'])))
    frequencies = {}
    for row in rows(archive, 'frequencies.txt'):
        frequencies.setdefault(row['trip_id'], []).append(row)
    lookup = address_ids(routes)
    stops = {}
    for row in rows(archive, 'stops.txt'):
        address = lookup.get((round(float(row['stop_lat']), 6), round(float(row['stop_lon']), 6)))
        stops[f"BU:{row['stop_id']}"] = {'position': [float(row['stop_lon']), float(row['stop_lat'])],
                                        'mapStopId': f'BU-stop-{address}' if address else None, 'name': row['stop_name']}
    out = []
    for trip_id, trip in sorted(trips.items()):
        calls = sorted(pattern.get(trip_id, []))
        if len(calls) < 2:
            continue
        first = calls[0][2]
        starts = [first]
        if trip_id in frequencies:
            starts = []
            for row in frequencies[trip_id]:
                if row.get('exact_times', '1') != '1':
                    raise SystemExit(f'Unsupported inexact frequency for GTFS trip {trip_id}')
                start, end, step = seconds(row['start_time']), seconds(row['end_time']), int(row['headway_secs'])
                starts += list(range(start, end, step))
        route = f"BU-{ROUTE_FOR_GTFS[route_names[trip['route_id']]]}"
        for start in sorted(set(starts)):
            shift = start - first
            out.append({'id': f'BU:gtfs:{trip_id}:{start}', 'route': route, 'direction': 0,
                        'weekdays': sorted(active[trip['service_id']]),
                        'stops': [{'stop': f'BU:{stop}', 'arrival': arrival + shift, 'departure': departure + shift}
                                  for _, stop, arrival, departure in calls]})
    return out, stops, {'url': GTFS_URL, 'sha256': hashlib.sha256(GTFS.read_bytes()).hexdigest(),
                        'feedStart': feed['feed_start_date'], 'feedEnd': feed['feed_end_date'],
                        'feedVersion': feed['feed_version'], 'baselineWeekStart': BASELINE_WEEK.isoformat()}


def service_time(epoch):
    """Epoch seconds -> (service date, seconds since that date's midnight, possibly > 24 h)."""
    local = datetime.fromtimestamp(epoch, BOSTON)
    day = local.date()
    seconds_of_day = local.hour * 3600 + local.minute * 60 + local.second
    if seconds_of_day < SERVICE_DAY_START:
        day -= timedelta(days=1)
        seconds_of_day += 86400
    return day, seconds_of_day


def recorded(routes):
    """Recorded TransLoc schedules as trips, plus the windows each route's polls covered."""
    calls, windows = {}, {}
    route_ids = {route['RouteID'] for route in routes}
    sources = []
    for path in sorted(SNAPSHOTS.glob('20*.json')):
        snapshot = json.loads(path.read_text())
        sources.append({'path': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                        'polls': len(snapshot['polls'])})
        for poll in snapshot['polls']:
            system = min(poll['horizons'].values()) if poll['horizons'] else poll['polledAt']
            for route in route_ids:
                end = poll['horizons'].get(str(route), system)
                if end > poll['polledAt']:
                    windows.setdefault(route, []).append((poll['polledAt'], end))
            for call in poll['calls']:
                calls.setdefault(call['route'], set()).add((call['routeStop'], call['stop'], call['arrival'], call['departure']))
    trips, covered = [], {}
    for route in routes:
        rid = route['RouteID']
        order = [stop['RouteStopID'] for stop in route['Stops']]
        at = {}
        for route_stop, stop, arrival, departure in calls.get(rid, ()):
            at.setdefault(route_stop, []).append((arrival, departure, stop))
        for times in at.values():
            times.sort()
        used = set()
        # Start runs at the first stop, then from any recorded call no earlier run reached.
        starts = [(0, entry) for entry in at.get(order[0], [])] + [
            (index, entry) for index, rs in enumerate(order) for entry in at.get(rs, [])]
        for index, entry in sorted(starts, key=lambda item: (item[1][0], item[0])):
            if (order[index], entry[0]) in used:
                continue
            run = [(order[index], entry)]
            used.add((order[index], entry[0]))
            previous = entry[1]
            position = index + 1
            while position < len(order):
                # TransLoc omits some stops' times (720 Albany St on the Albany line): allow one gap.
                found = None
                for skip in (0, 1):
                    rs = order[position + skip] if position + skip < len(order) else None
                    nxt = rs is not None and next((e for e in at.get(rs, []) if previous <= e[0] <= previous + MAX_SEGMENT
                                                   and (rs, e[0]) not in used), None)
                    if nxt:
                        found = (position + skip, rs, nxt); break
                if not found:
                    break
                position, rs, nxt = found
                run.append((rs, nxt)); used.add((rs, nxt[0])); previous = nxt[1]; position += 1
            if len(run) < 2:
                continue
            day, start = service_time(run[0][1][0])
            stops = [{'stop': f'BU:addr:{e[2]}', 'arrival': start + e[0] - run[0][1][0],
                      'departure': start + e[1] - run[0][1][0]} for _, e in run]
            trips.append({'id': f'BU:rec:{rid}:{run[0][1][0]}', 'route': f'BU-{rid}', 'direction': 0,
                          'date': day.isoformat(), 'stops': stops})
        # Merge overlapping windows, then express them per service date.
        merged = []
        for start, end in sorted(windows.get(rid, [])):
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        for start, end in merged:
            cursor = start
            while cursor < end:
                day, offset = service_time(cursor)
                day_end = datetime.combine(day + timedelta(days=1), datetime.min.time(), BOSTON).timestamp() + SERVICE_DAY_START
                stop = min(end, day_end)
                covered.setdefault((rid, day.isoformat()), []).append([offset, offset + stop - cursor])
                cursor = stop
    return trips, covered, sources


def build():
    routes = json.loads(ROUTES.read_text())['routes']
    base_trips, stops, gtfs = baseline(routes)
    rec_trips, covered, sources = recorded(routes)
    for route in routes:
        for stop in route['Stops']:
            stops[f"BU:addr:{stop['AddressID']}"] = {'position': [stop['Longitude'], stop['Latitude']],
                                                     'mapStopId': f"BU-stop-{stop['AddressID']}", 'name': stop['Description']}
    # The latest recorded date wins for each route and weekday.
    latest = {}
    for (rid, day), spans in covered.items():
        weekday = date.fromisoformat(day).weekday()
        if day > latest.get((rid, weekday), ('',))[0]:
            latest[(rid, weekday)] = (day, spans)
    overlaps = lambda trip, spans: any(trip['stops'][0]['arrival'] < end and trip['stops'][-1]['departure'] > start for start, end in spans)
    trips, provenance, validation = [], [], []
    for trip in base_trips:
        rid = int(trip['route'][3:])
        keep = [w for w in trip['weekdays'] if not (latest.get((rid, w)) and overlaps(trip, latest[(rid, w)][1]))]
        if keep:
            trips.append({**trip, 'weekdays': keep})
    for trip in rec_trips:
        rid, weekday = int(trip['route'][3:]), date.fromisoformat(trip['date']).weekday()
        chosen = latest.get((rid, weekday))
        if chosen and chosen[0] == trip['date']:
            trips.append({key: trip[key] for key in ('id', 'route', 'direction', 'stops')} | {'weekdays': [weekday]})
    for route in routes:
        rid = route['RouteID']
        for weekday in range(7):
            chosen = latest.get((rid, weekday))
            entry = {'route': f'BU-{rid}', 'weekday': weekday, 'baseline': 'gtfs-2024-25'}
            if chosen:
                entry |= {'recordedDate': chosen[0], 'recordedWindows': chosen[1]}
                validation.append(compare(route, weekday, chosen, base_trips, rec_trips))
            provenance.append(entry)
    used_stops = {call['stop'] for trip in trips for call in trip['stops']}
    start = date.fromisoformat(SCENARIO_WEEK)
    return {
        'schemaVersion': 1, 'dataset': 'shuttle_schedule', 'timezone': 'America/New_York',
        'referenceWeekStart': SCENARIO_WEEK, 'dates': [(start + timedelta(days=i)).isoformat() for i in range(7)],
        'priorDate': (start - timedelta(days=1)).isoformat(),
        'feed': {'start': gtfs['feedStart'], 'end': gtfs['feedEnd'], 'version': f"BU TransLoc GTFS {gtfs['feedVersion']} + recorded TransLoc schedules"},
        'sourceUrl': GTFS_URL,
        'stops': {key: value for key, value in sorted(stops.items()) if key in used_stops},
        'trips': sorted(trips, key=lambda trip: (trip['route'], trip['stops'][0]['arrival'], trip['id'])),
        'provenance': provenance, 'validation': validation,
        'sources': [{'kind': 'gtfs-baseline', **gtfs}, *({'kind': 'transloc-recorded', **s} for s in sources)],
        'assumptions': [
            'The baseline is BU\'s 2024-25 TransLoc GTFS feed, the most recent complete machine-readable BU Shuttle timetable, applied by weekday from Monday 21 October 2024. It is not a Fall 2026 timetable.',
            'Inside each recorded window, TransLoc\'s current published scheduled stop times replace the baseline for that route and weekday, including the absence of service.',
            'Hyatt and Thanksgiving services are excluded: they have no current TransLoc route on the map.',
        ],
    }


def compare(route, weekday, chosen, base_trips, rec_trips):
    """Departures from the route's first stop inside the recorded windows: recorded vs baseline."""
    first = f"BU:addr:{route['Stops'][0]['AddressID']}"
    rid = f"BU-{route['RouteID']}"
    inside = lambda t: any(a <= t < b for a, b in chosen[1])
    recorded_times = sorted(c['departure'] for trip in rec_trips if trip['route'] == rid and trip['date'] == chosen[0]
                            for c in trip['stops'][:1] if c['stop'] == first and inside(c['departure']))
    first_position = (round(route['Stops'][0]['Latitude'], 6), round(route['Stops'][0]['Longitude'], 6))
    baseline_times = sorted(trip['stops'][0]['departure'] for trip in base_trips
                            if trip['route'] == rid and weekday in trip['weekdays'] and inside(trip['stops'][0]['departure']))
    offsets = [min(abs(t - b) for b in baseline_times) for t in recorded_times] if baseline_times else []
    return {'route': rid, 'weekday': weekday, 'date': chosen[0], 'recordedDepartures': len(recorded_times),
            'baselineDepartures': len(baseline_times),
            'medianOffsetMinutes': round(sorted(offsets)[len(offsets) // 2] / 60, 1) if offsets else None,
            'matches': bool(recorded_times) == bool(baseline_times) and len(recorded_times) == len(baseline_times)
                       and all(o <= 120 for o in offsets)}


if __name__ == '__main__':
    result = build()
    OUTPUT.write_text(json.dumps(result, separators=(',', ':')) + '\n')
    print(f"shuttle_schedule: {len(result['trips'])} trips, {sum(1 for p in result['provenance'] if 'recordedDate' in p)} recorded route-days -> {OUTPUT}")
    for row in result['validation']:
        print('  ', row)
