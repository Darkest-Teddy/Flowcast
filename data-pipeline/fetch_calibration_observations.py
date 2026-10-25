"""Package real observed transit and pedestrian counts near BU for behaviour calibration.

Writes map-client/public/data/calibration-observations.json from public, keyless sources:

* MBTA Gated Station Entries (ArcGIS feature service): Kenmore entries per 30-minute bin,
  averaged over fall-term days by day type (Fall 2025 term and Fall 2026 to date).
* MBTA Fall 2025 Rail Ridership by Hour, Route/Line, and Stop: Green Line B/C/D ons and offs
  per hour at every map stop, per direction and day type.
* MBTA Bus Ridership by Trip, Season, Route/Line, and Stop (Fall 2025 APC): boardings and
  alightings at every map bus stop, binned by the hour the bus reaches the stop (trip start
  time plus the stop's scheduled offset in the Fall 2025 GTFS archive).
* Pedestrian counts: BU Warren Towers EPNF (2024) Table 7-6 peak-hour intersection crossings
  (already transcribed into data-pipeline/output/signals.json), located with OpenStreetMap, and
  CTPS Boston Region MPO bicycle/pedestrian counts at map sites (15-minute pedestrian counts),
  plus any hand-transcribed counts listed in inputs/pedestrian_counts_extra.json.

Raw downloads are cached under data-pipeline/.cache/observations/ (gitignored); run again with
--offline to rebuild from the cache only.
"""

import argparse
import csv
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
import io
import json
import math
from pathlib import Path
import statistics
import sys
from urllib.parse import urlencode
import zipfile
from zoneinfo import ZoneInfo

from common import Fetcher, ScrapeError, utc_now, write_json

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
CACHE = ROOT / '.cache' / 'observations'
OUT = REPO / 'map-client' / 'public' / 'data' / 'calibration-observations.json'
TRANSIT_FILE = REPO / 'map-client' / 'public' / 'data' / 'transit.json'
SIGNALS_FILE = ROOT / 'output' / 'signals.json'
EXTRA_PED_FILE = ROOT / 'inputs' / 'pedestrian_counts_extra.json'
BOSTON = ZoneInfo('America/New_York')

GSE_SERVICE = 'https://services1.arcgis.com/ceiitspzDAHrdGO1/arcgis/rest/services/GSE/FeatureServer/0/query'
GSE_ITEM = 'https://mbta-massdot.opendata.arcgis.com/datasets/001c177f07594e7c99f193dde32284c9'
RAIL_HOURLY_ITEM = 'https://mbta-massdot.opendata.arcgis.com/datasets/6494749a29c648018820d0e49636205c'
RAIL_HOURLY_CSV = 'https://www.arcgis.com/sharing/rest/content/items/6494749a29c648018820d0e49636205c/data'
BUS_ITEM = 'https://mbta-massdot.opendata.arcgis.com/datasets/8daf4a33925a4df59183f860826d29ee'
BUS_ZIP = 'https://www.arcgis.com/sharing/rest/content/items/8daf4a33925a4df59183f860826d29ee/data'
GTFS_ARCHIVE_INDEX = 'https://cdn.mbta.com/archive/archived_feeds.txt'
GTFS_FALL_2025 = 'https://cdn.mbtace.com/archive/20251021.zip'
CTPS_ROOT = 'https://www.ctps.org/geoserver/www/apps/bp-counts-app-01262024/'
CTPS_COUNTS = CTPS_ROOT + 'data/csv/bp_counts.csv'
CTPS_GEOMETRY = CTPS_ROOT + 'data/json/ctps_bp_count_locations_pt.geo.json'
WARREN_REPORT = 'https://www.bu.edu/community/files/2024/02/Warren-Towers-EPNF.pdf'
OVERPASS = 'https://overpass-api.de/api/interpreter'

# Fall-term windows: first day of BU classes to the Tuesday before Thanksgiving, holidays removed.
GATED_PERIODS = {
    'fall-2025': {'start': date(2025, 9, 2), 'end': date(2025, 11, 25),
                  'holidays': {date(2025, 10, 13), date(2025, 11, 11)}},
    'fall-2026': {'start': date(2026, 9, 2), 'end': date(2026, 11, 24),
                  'holidays': {date(2026, 9, 7), date(2026, 10, 12), date(2026, 11, 11)}},
}
LICENSE_MBTA = 'CC0 (MassDOT/MBTA open data portal)'

# Share of the people counted who are BU students. Documented assumptions, not measurements:
# see docs/calibration-observations.md for the reasoning behind each band.
STUDENT_SHARE = {
    'Green-B:bu': (0.55, 0.85),       # Blandford St to Babcock St: BU frontage on both sides
    'Green-B:kenmore': (0.2, 0.45),
    'Green-C': (0.2, 0.5),            # St Mary's/Hawes/Kent: Brookline residents, some BU housing
    'Green-D': (0.1, 0.3),            # Fenway/Longwood: hospital and LMA workers
    'kenmore-gated': (0.2, 0.45),     # Kenmore: BU, Fenway Park area, hotels, offices
    'bus-charles-river': (0.25, 0.6),
    'bus-fenway': (0.05, 0.25),
    'bus-medical': (0.03, 0.15),      # BMC patients/staff dominate the Albany St/Mass Ave stops
    'ped-comm-ave': (0.6, 0.9),       # Comm Ave crossings inside the Charles River Campus
    'ped-bay-state': (0.7, 0.95),
    'ped-bu-bridge': (0.2, 0.5),
    'ped-medical': (0.05, 0.25),      # Albany St/Harrison Ave: BMC staff, patients and visitors
    'ped-default': (0.2, 0.6),
}


def ny_date(epoch_ms):
    return datetime.fromtimestamp(epoch_ms / 1000, timezone.utc).astimezone(BOSTON).date()


def day_type(day):
    wd = day.weekday()
    return 'saturday' if wd == 5 else 'sunday' if wd == 6 else 'weekday'


def hhmm(minutes):
    return f'{minutes // 60:02d}:{minutes % 60:02d}'


def round1(value):
    return round(value + 0.0, 2)


def source_meta(fetched):
    return {'retrievedAt': fetched.fetched_at, 'sha256': fetched.provenance['sha256']}


# ---------------------------------------------------------------- map stops

def map_stops():
    transit = json.loads(TRANSIT_FILE.read_text())
    stops = {}
    for stop in transit['stops']:
        stops[stop['id']] = stop
    return stops


# ---------------------------------------------------------------- Kenmore gated entries

def gse_url(where, offset):
    return GSE_SERVICE + '?' + urlencode({
        'where': where, 'outFields': 'service_date,time_period,stop_id,station_name,route_or_line,gated_entries',
        'orderByFields': 'ObjectId', 'resultOffset': offset, 'resultRecordCount': 2000, 'f': 'json'})


def fetch_gse(fetcher, stop_id, start, end):
    where = f"stop_id='{stop_id}' AND service_date >= DATE '{start.isoformat()}' AND service_date < DATE '{end.isoformat()}'"
    rows, offset, fetched = [], 0, []
    while True:
        page = fetcher.get(gse_url(where, offset))
        fetched.append(page)
        body = json.loads(page.text)
        if 'error' in body:
            raise ScrapeError(f'GSE query failed: {body["error"]}')
        rows += [f['attributes'] for f in body['features']]
        if not body.get('exceededTransferLimit') and len(body['features']) < 2000:
            break
        offset += 2000
        if offset > 200000:
            raise ScrapeError('GSE paging did not terminate')
    return rows, fetched


def kenmore_gated(fetcher, stops):
    series, sources, notes = [], [], []
    for period_id, period in GATED_PERIODS.items():
        # Service dates run 03:00-02:59; fetch a day either side and re-file post-midnight bins.
        rows, pages = fetch_gse(fetcher, 'place-kencl', period['start'] - timedelta(days=1), period['end'] + timedelta(days=2))
        per_day = defaultdict(dict)
        seen = set()
        ambiguous = set()
        invalid_rows = 0
        for row in rows:
            if row['stop_id'] != 'place-kencl' or row['route_or_line'] != 'Green Line':
                raise ScrapeError('Unexpected station or line in Kenmore GSE response')
            service = ny_date(row['service_date'])
            h, m, sec = map(int, row['time_period'].strip('()').split(':'))
            if not (0 <= h < 24 and m in (0, 30) and sec == 0):
                raise ScrapeError(f'Invalid GSE half-hour: {row["time_period"]}')
            minute = h * 60 + m
            calendar = service + timedelta(days=1) if minute < 180 else service
            try:
                value = float(row['gated_entries'])
            except (TypeError, ValueError):
                value = None
            if value is None or not math.isfinite(value) or value < 0:
                invalid_rows += 1
                value = None
            key = calendar, minute
            if key in seen:
                ambiguous.add(key)
                per_day[calendar].pop(minute, None)
                continue
            seen.add(key)
            if value is None:
                continue
            per_day[calendar][minute] = value
        valid_days = sorted(d for d in per_day if per_day[d] and period['start'] <= d <= period['end']
                            and d not in period['holidays'])
        source_id = f'mbta-gse-{period_id}'
        sources.append({
            'id': source_id, 'pages': len(pages), 'records': len(rows),
            'coverage': f'{valid_days[0]} to {valid_days[-1]}' if valid_days else 'none',
            'dates': [d.isoformat() for d in valid_days],
            'requestedCalendarPeriod': {'start': period['start'].isoformat(), 'end': period['end'].isoformat()},
            'excludedDates': sorted(d.isoformat() for d in period['holidays']),
            'invalidCountRecords': invalid_rows,
            'ambiguousBins': [{'date': d.isoformat(), 'start': hhmm(m)} for d, m in sorted(ambiguous)],
            'retrievedAt': max(p.fetched_at for p in pages),
            'pageProvenance': [p.provenance for p in pages],
        })
        if not valid_days:
            notes.append(f'No Kenmore gated entries for {period_id}')
            continue
        for dt in ('weekday', 'saturday', 'sunday'):
            days = [d for d in valid_days if day_type(d) == dt]
            if not days:
                continue
            bins = []
            for minute in range(0, 1440, 30):
                observed_days = [d for d in days if minute in per_day[d]]
                if not observed_days:
                    continue
                values = [per_day[d][minute] for d in observed_days]
                bins.append({'start': hhmm(minute), 'end': hhmm(minute + 30),
                             'value': round1(sum(values) / len(values)), 'days': len(values),
                             'dates': [d.isoformat() for d in observed_days]})
            series.append({
                'id': f'kenmore-gated-entries-{period_id}-{dt}', 'kind': 'gated-entries', 'mode': 'subway',
                'stop': {'name': 'Kenmore', 'mapStopId': 'place-kencl', 'mbtaStopIds': ['place-kencl'],
                         'position': stops['place-kencl']['position']},
                'route': 'Green', 'direction': None, 'dayType': dt, 'bins': bins,
                'unit': 'avg observed gated entries per reporting day per 30-min bin', 'source': source_id,
                'period': f'{days[0].isoformat()} to {days[-1].isoformat()} ({len(days)} {dt} days with observations)',
                'days': len(days), 'dates': [d.isoformat() for d in days],
                'dailyObservations': [
                    {'date': d.isoformat(), 'bins': [
                        {'start': hhmm(m), 'end': hhmm(m + 30), 'value': v}
                        for m, v in sorted(per_day[d].items())]}
                    for d in days],
                'expectedStudentShare': list(STUDENT_SHARE['kenmore-gated']),
                'role': 'primary' if period_id == 'fall-2025' else 'comparison',
                'notes': ('Unscaled faregate entries (all Green Line branches; no exits). '
                          'Post-midnight bins are re-filed to the calendar day they fall on. '
                          'Missing bins are omitted, not zero; each mean uses only its reporting dates. '
                          'Series days counts dates with any valid bin, not complete days. '
                          'Duplicate date/time bins are excluded as ambiguous. '
                          'MBTA publishes only station-open periods and does not guarantee complete counts. '
                          'Low and explicit zero counts are retained; held-open gates can undercount. '
                          'These are not pedestrian counts or weather-effect estimates.'),
            })
    return series, sources, notes


# ---------------------------------------------------------------- Green Line hourly APC

RAIL_STOPS = {
    'Green-B': ['place-kencl', 'place-bland', 'place-buest', 'place-bucen', 'place-amory', 'place-babck'],
    'Green-C': ['place-kencl', 'place-smary', 'place-hwsst', 'place-kntst'],
    'Green-D': ['place-kencl', 'place-fenwy', 'place-longw'],
}
RAIL_DAYTYPE = {'Weekday': 'weekday', 'Saturday': 'saturday', 'Sunday': 'sunday'}
RAIL_DIRECTION = {'WB': 0, 'EB': 1}  # GTFS Green Line: 0 = westbound/outbound, 1 = eastbound/inbound


def rail_share(route, stop):
    if route == 'Green-B':
        return STUDENT_SHARE['Green-B:kenmore' if stop == 'place-kencl' else 'Green-B:bu']
    return STUDENT_SHARE[route]


def rail_hourly(fetcher, stops):
    fetched = fetcher.get(RAIL_HOURLY_CSV)
    groups = defaultdict(dict)
    days = defaultdict(set)
    for row in csv.DictReader(io.StringIO(fetched.text.lstrip('﻿'))):
        route, stop = row['route_id'], row['parent_station']
        if stop not in RAIL_STOPS.get(route, ()):
            continue
        dt = RAIL_DAYTYPE.get(row['day_type_name'])
        direction = RAIL_DIRECTION.get(row['dir_id'])
        if dt is None or direction is None:
            continue
        n = int(row['number_service_days'])
        if n <= 0:
            continue
        hour = int(row['hour_of_service'][:2])
        days[route, dt].add(n)
        key = route, stop, direction, dt
        groups[key][hour] = (int(row['total_ons']) / n, int(row['total_offs']) / n, n)
    series = []
    for (route, stop, direction, dt), hours in sorted(groups.items()):
        for kind, index in (('apc-boardings', 0), ('apc-alightings', 1)):
            bins = [{'start': hhmm(h * 60), 'end': hhmm(h * 60 + 60), 'value': round1(hours[h][index]) if h in hours else 0.0}
                    for h in range(24)]
            name = stops[stop]['name']
            series.append({
                'id': f'{route.lower()}-{stop.removeprefix("place-")}-{direction}-{dt}-{"ons" if index == 0 else "offs"}',
                'kind': kind, 'mode': 'light-rail',
                'stop': {'name': name, 'mapStopId': stop, 'mbtaStopIds': [stop], 'position': stops[stop]['position']},
                'route': route, 'direction': direction, 'dayType': dt, 'bins': bins,
                'unit': 'avg per day per hour', 'source': 'mbta-rail-hourly-fall-2025',
                'period': 'Fall 2025 rating (MBTA), holidays and diversion days excluded',
                'days': max(h[2] for h in hours.values()), 'expectedStudentShare': list(rail_share(route, stop)),
                # Kenmore boardings are measured at the gates (kenmore-gated-entries-*); these are context.
                'role': 'comparison' if stop == 'place-kencl' and index == 0 else 'primary',
                'notes': ('Kenmore is underground: these are modelled train ons/offs for this branch, not gate counts.'
                          if stop == 'place-kencl' else 'Surface stop; automatic passenger counters (APC), expanded by the MBTA.'),
            })
    meta = {'id': 'mbta-rail-hourly-fall-2025', **source_meta(fetched),
            'serviceDays': {f'{r}:{d}': sorted(v) for (r, d), v in sorted(days.items())}}
    return series, meta


# ---------------------------------------------------------------- Bus APC

BUS_DAYTYPE = {'Wkdy': 'weekday', 'Fri': 'friday', 'Sat': 'saturday', 'Sun': 'sunday',
               'weekday': 'weekday', 'saturday': 'saturday', 'sunday': 'sunday'}


def seconds(text):
    text = text.strip()
    if ':' not in text:  # some Fall 2025 rows store the time as an Excel fraction of a day
        return int(round(float(text) * 86400 / 60)) * 60
    h, m, s = text.split(':')
    return int(h) * 3600 + int(m) * 60 + int(s)


def gtfs_offsets(body, wanted_routes, wanted_stops):
    """Scheduled seconds from trip start to each wanted stop, by route/direction/stop and by start time."""
    archive = zipfile.ZipFile(io.BytesIO(body))

    def rows(name):
        with archive.open(name) as handle:
            yield from csv.DictReader(io.TextIOWrapper(handle, encoding='utf-8-sig'))

    trips = {r['trip_id']: (r['route_id'], int(r['direction_id'])) for r in rows('trips.txt') if r['route_id'] in wanted_routes}
    first, at_stop = {}, defaultdict(list)
    for r in rows('stop_times.txt'):
        trip = trips.get(r['trip_id'])
        if trip is None:
            continue
        seq, t = int(r['stop_sequence']), seconds(r['departure_time'] or r['arrival_time'])
        if r['trip_id'] not in first or seq < first[r['trip_id']][0]:
            first[r['trip_id']] = (seq, t)
        if r['stop_id'] in wanted_stops:
            at_stop[r['trip_id']].append((r['stop_id'], t))
    exact, typical = {}, defaultdict(list)
    for trip_id, calls in at_stop.items():
        route, direction = trips[trip_id]
        start = first[trip_id][1]
        for stop, t in calls:
            exact[route, direction, start, stop] = t - start
            typical[route, direction, stop].append(t - start)
    return exact, {key: statistics.median(values) for key, values in typical.items()}


def bus_share(area):
    return STUDENT_SHARE.get(f'bus-{area}', STUDENT_SHARE['bus-charles-river'])


def bus_apc(fetcher, stops):
    bus_stops = {sid: s for sid, s in stops.items() if s['kind'] == 'bus'}
    routes = sorted({r for s in bus_stops.values() for r in s['routes']})
    zipped = fetcher.get(BUS_ZIP)
    gtfs = fetcher.get(GTFS_FALL_2025)
    exact, typical = gtfs_offsets(gtfs.body, set(routes), set(bus_stops))
    archive = zipfile.ZipFile(io.BytesIO(zipped.body))
    member = next(n for n in archive.namelist() if n.endswith('Fall_2025.csv'))
    totals = defaultdict(lambda: [0.0] * 24)  # (stop, route, direction, dayType, kind) -> hourly
    samples = defaultdict(list)
    matched = unmatched = skipped = 0
    with archive.open(member) as handle:
        for row in csv.DictReader(io.TextIOWrapper(handle, encoding='utf-8-sig')):
            route = row.get('GTFS route_id') or row.get('route_id')
            stop = row.get('GTFS stop_id') or row.get('stop_id')
            if stop not in bus_stops or route not in bus_stops[stop]['routes']:
                continue
            direction = int(row.get('GTFS direction_id') or row.get('direction_id'))
            dt = BUS_DAYTYPE.get(row.get('Day Type') or row.get('day_type_name'))
            if dt is None:
                continue
            start = seconds(row.get('trip start time') or row.get('trip_start_time'))
            offset = exact.get((route, direction, start, stop))
            if offset is None:
                offset = typical.get((route, direction, stop))
                if offset is None:
                    skipped += 1
                    continue
                unmatched += 1
            else:
                matched += 1
            hour = int(((start + offset) // 3600) % 24)
            for kind, column in (('apc-boardings', 'Boardings'), ('apc-alightings', 'Alightings')):
                value = float(row.get(column) or row.get(column.lower()) or 0)
                totals[stop, route, direction, dt, kind][hour] += value
            samples[stop, route, direction, dt].append(int(row.get('# of Trip Samples ') or row.get('sample_count') or 0))
    series = []
    for (stop, route, direction, dt, kind), hours in sorted(totals.items()):
        if sum(hours) <= 0:
            continue
        s = bus_stops[stop]
        n = samples[stop, route, direction, dt]
        series.append({
            'id': f'bus-{route}-{stop}-{dt}-{"ons" if kind == "apc-boardings" else "offs"}', 'kind': kind, 'mode': 'bus',
            'stop': {'name': s['name'], 'mapStopId': stop, 'mbtaStopIds': [stop], 'position': s['position']},
            'route': route, 'direction': direction, 'dayType': dt,
            'bins': [{'start': hhmm(h * 60), 'end': hhmm(h * 60 + 60), 'value': round1(v)} for h, v in enumerate(hours)],
            'unit': 'avg per day per hour', 'source': 'mbta-bus-apc-fall-2025',
            'period': 'Fall 2025 (MBTA bus APC rating); Wkdy = Monday-Thursday, Friday separate',
            'tripsSampled': {'median': statistics.median(n) if n else 0, 'trips': len(n)},
            'expectedStudentShare': list(bus_share(s.get('area'))), 'role': 'primary',
            'notes': 'Sum over scheduled trips of average boardings/alightings per trip; binned by the hour the bus reaches the stop (trip start + Fall 2025 GTFS offset).',
        })
    meta = {'id': 'mbta-bus-apc-fall-2025', **source_meta(zipped), 'member': member.split('/')[-1],
            'gtfs': {'url': GTFS_FALL_2025, **source_meta(gtfs)},
            'stopTimeMatch': {'exactTrip': matched, 'medianOffset': unmatched, 'noSchedule': skipped}}
    return series, meta


# ---------------------------------------------------------------- Pedestrian counts

AREA_BOXES = {  # south, west, north, east: where the count sites' streets are looked up in OSM
    'charles-river': (42.3460, -71.1260, 42.3560, -71.0940),
    'medical': (42.3300, -71.0800, 42.3410, -71.0660),
}
CROSSWALK_SEARCH_METRES = 45
SCREEN_HALF_WIDTH_METRES = 5
NAME_FIXES = {'St. ': 'Saint ', "St Mary's": "Saint Mary's"}


def osm_name(name):
    for a, b in NAME_FIXES.items():
        name = name.replace(a, b)
    return name


def local_xy(origin, point):
    kx = 111_320 * math.cos(math.radians(origin[1]))
    return ((point[0] - origin[0]) * kx, (point[1] - origin[1]) * 110_540)


def from_xy(origin, xy):
    kx = 111_320 * math.cos(math.radians(origin[1]))
    return [round(origin[0] + xy[0] / kx, 7), round(origin[1] + xy[1] / 110_540, 7)]


def compass(dx, dy):
    angle = (math.degrees(math.atan2(dx, dy)) + 360) % 360
    return ['N', 'E', 'S', 'W'][int(((angle + 45) % 360) // 90)]


def locate_sites(fetcher, sites):
    """Each site at the OSM node(s) shared by its two named streets, else its transcribed position."""
    positions = {}
    for area, (s_, w, n, e) in AREA_BOXES.items():
        names = sorted({osm_name(x) for site in sites.values() if site['area'] == area and site.get('streets') for x in site['streets']})
        if not names:
            continue
        regex = '^(' + '|'.join(x.replace("'", '.') for x in names) + ')$'
        page = fetcher.get(OVERPASS + '?' + urlencode({'data': f'[out:json][timeout:90];way["highway"]["name"~"{regex}"]({s_},{w},{n},{e});out body;>;out skel qt;'}))
        body = json.loads(page.text)
        nodes = {x['id']: (x['lon'], x['lat']) for x in body['elements'] if x['type'] == 'node'}
        by_name = defaultdict(set)
        for x in body['elements']:
            if x['type'] == 'way':
                by_name[osm_name(x['tags']['name'])].update(x['nodes'])
        for key, site in sites.items():
            if site['area'] != area or not site.get('streets'):
                continue
            a, b = (osm_name(x) for x in site['streets'])
            shared = [nodes[i] for i in by_name.get(a, set()) & by_name.get(b, set()) if i in nodes]
            if site.get('fallback'):  # a divided road meets a side street at several nodes; keep this junction's
                shared = [p for p in shared if math.hypot(*local_xy(site['fallback'], p)) < site.get('fallbackRadius', 80)]
                if shared:  # the junction's own nodes: those near the closest shared node
                    first = min(shared, key=lambda p: math.hypot(*local_xy(site['fallback'], p)))
                    shared = [p for p in shared if math.hypot(*local_xy(first, p)) < 60]
            if shared:
                positions[key] = ([round(sum(p[0] for p in shared) / len(shared), 7), round(sum(p[1] for p in shared) / len(shared), 7)], 'osm')
    for key, site in sites.items():
        if key not in positions and site.get('fallback'):
            positions[key] = (site['fallback'], 'transcribed')
    return positions


def crosswalk_segments(ways, origin):
    """OSM crossing segments around an intersection, grouped into legs (Comm Ave's crosswalks are
    split at each carriageway and the trackbed) and labelled by compass leg."""
    segs = []
    for way in ways:
        a, b = local_xy(origin, way[0]), local_xy(origin, way[-1])
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        if length >= 1:
            segs.append({'a': a, 'b': b, 'u': ((b[0] - a[0]) / length, (b[1] - a[1]) / length)})
    parent = list(range(len(segs)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i, si in enumerate(segs):
        for j in range(i + 1, len(segs)):
            sj = segs[j]
            if abs(si['u'][0] * sj['u'][0] + si['u'][1] * sj['u'][1]) < math.cos(math.radians(25)):
                continue
            mid = ((sj['a'][0] + sj['b'][0]) / 2 - si['a'][0], (sj['a'][1] + sj['b'][1]) / 2 - si['a'][1])
            lateral = abs(mid[0] * si['u'][1] - mid[1] * si['u'][0])
            gap = min(math.hypot(p[0] - q[0], p[1] - q[1]) for p in (si['a'], si['b']) for q in (sj['a'], sj['b']))
            if lateral < 5 and gap < 12:
                parent[find(i)] = find(j)
    legs = defaultdict(list)
    for i, seg in enumerate(segs):
        seg['mid'] = ((seg['a'][0] + seg['b'][0]) / 2, (seg['a'][1] + seg['b'][1]) / 2)
        legs[find(i)].append(seg)
    out = []
    for members in legs.values():
        cx = sum(m['mid'][0] for m in members) / len(members)
        cy = sum(m['mid'][1] for m in members) / len(members)
        leg = compass(cx, cy)
        u = members[0]['u']
        members.sort(key=lambda m: m['mid'][0] * u[0] + m['mid'][1] * u[1])
        for k, m in enumerate(members):
            # A divided road's crossing is counted per half: the two outer segments are the halves.
            half = None
            if len(members) > 1 and k in (0, len(members) - 1):
                side = compass(m['mid'][0] - cx, m['mid'][1] - cy)
                half = side + leg if leg in 'EW' else leg + side
            out.append({**m, 'leg': leg, 'half': half, 'outer': len(members) == 1 or k in (0, len(members) - 1)})
    return out


def screen_for(segments, origin, method):
    """Short lines across the crosswalks. `leg`: one count per pass over a leg; `half-leg`: Comm Ave's
    two halves counted separately (the trackbed segment between them is not a screen)."""
    lines = []
    for seg in segments:
        if method == 'half-leg' and not seg['outer']:
            continue
        n = (-seg['u'][1] * SCREEN_HALF_WIDTH_METRES, seg['u'][0] * SCREEN_HALF_WIDTH_METRES)
        group = seg['leg'] if method == 'leg' or not seg['half'] else seg['half']
        lines.append({'from': from_xy(origin, (seg['mid'][0] - n[0], seg['mid'][1] - n[1])),
                      'to': from_xy(origin, (seg['mid'][0] + n[0], seg['mid'][1] + n[1])), 'group': group})
    return {'type': 'lines', 'lines': lines, 'mergeMetres': 40} if lines else {'type': 'cordon', 'radiusMetres': 25}


def osm_crosswalks(fetcher, positions):
    """Mapped crosswalks (footway=crossing) around each located count site."""
    parts = ''.join(f'way["footway"="crossing"](around:{CROSSWALK_SEARCH_METRES},{lat},{lon});' for (lon, lat), _ in sorted(positions.values()))
    fetched = fetcher.get(OVERPASS + '?' + urlencode({'data': f'[out:json][timeout:90];({parts});out geom;'}))
    ways = [[(g['lon'], g['lat']) for g in e['geometry']] for e in json.loads(fetched.text)['elements'] if e['type'] == 'way']
    result = {}
    for key, (origin, _) in positions.items():
        near = [w for w in ways if min(math.hypot(*local_xy(origin, p)) for p in w) <= CROSSWALK_SEARCH_METRES]
        result[key] = crosswalk_segments(near, origin)
    return result, fetched


def ped_share(key, site):
    if site['area'] == 'medical':
        return STUDENT_SHARE['ped-medical']
    if key.startswith('baystate'):
        return STUDENT_SHARE['ped-bay-state']
    if key == 'comm-bubridge':
        return STUDENT_SHARE['ped-bu-bridge']
    return STUDENT_SHARE['ped-comm-ave']


def pedestrian_counts(fetcher):
    """Warren Towers 2023 peak hours (signals.json) plus the transcribed counts in inputs/."""
    extra = json.loads(EXTRA_PED_FILE.read_text()) if EXTRA_PED_FILE.exists() else {'sources': [], 'sites': {}, 'counts': []}
    sites = dict(extra['sites'])
    by_name = {site['name']: key for key, site in sites.items()}
    signals = json.loads(SIGNALS_FILE.read_text())
    counts = list(extra['counts'])
    warren = defaultdict(list)
    for row in signals['pedestrianCounts']:
        warren[row['intersection']].append(row)
    for name, rows in sorted(warren.items()):
        key = by_name.get(name)
        if key is None:
            raise ScrapeError(f'Warren Towers site has no site entry: {name}')
        counts.append({'site': key, 'source': 'bu-warren-epnf-2024', 'date': '2023-10-18/2023-10-19', 'weekdays': [2, 3], 'method': 'half-leg',
                       'page': 'Table 7-6, PDF p.136',
                       'bins': [{'start': r['startLocal'], 'end': r['endLocal'], 'total': float(r['value'])} for r in sorted(rows, key=lambda r: r['startLocal'])],
                       'notes': "Wed/Thu during the fall term; the report does not give each intersection's day."})
    # One series per site, source and date: a count sheet's AM and PM pages become one day.
    merged = {}
    for count in counts:
        key = (count['site'], count['source'], count['date'])
        if key in merged:
            merged[key]['bins'] = sorted(merged[key]['bins'] + count['bins'], key=lambda b: b['start'])
            merged[key]['page'] += ', ' + count['page']
        else:
            merged[key] = dict(count)
    counts = list(merged.values())
    positions = locate_sites(fetcher, sites)
    crosswalks, crossing_page = osm_crosswalks(fetcher, positions)
    out, missing = [], []
    for count in counts:
        key = count['site']
        if key not in positions:
            missing.append(key)
            continue
        site = sites[key]
        position, how = positions[key]
        # Crosswalks are only matched around a junction OSM located; a transcribed position may be ~100 m off.
        segments = crosswalks.get(key, []) if how == 'osm' else []
        bins, legs = [], defaultdict(list)
        for b in count['bins']:
            value = b['total'] if 'total' in b else float(sum(b['legs'].values()))
            bins.append({'start': b['start'], 'end': b['end'], 'value': value})
            for leg, v in b.get('legs', {}).items():
                legs[leg].append(v)
        weekdays = count.get('weekdays') or [count['weekday']]
        source_tag = {'bu-warren-epnf-2024': 'warren-2023', 'bu-cds-pnf-2018': 'cds-2018', 'bu-tmp-2013': 'tmp-2012', 'bmc-imp-2021': 'bmc-2019'}[count['source']]
        out.append({
            'id': f'ped-{source_tag}-{key}', 'site': site['name'], 'siteKey': key, 'position': position, 'positionFrom': how,
            'measure': 'intersection-crossings', 'screen': screen_for(segments, position, count['method']),
            'countMethod': count['method'], 'legsMapped': sorted({seg['half'] or seg['leg'] for seg in segments}),
            'date': count['date'], 'dayType': 'weekday', 'weekdays': weekdays,
            'bins': bins, **({'legCounts': {leg: v for leg, v in sorted(legs.items())}} if legs else {}),
            'unit': 'pedestrian crosswalk crossings per bin (all legs)', 'direction': None,
            'source': count['source'], 'page': count['page'], 'quality': 'primary',
            'expectedStudentShare': list(ped_share(key, site)),
            'notes': ' '.join(x for x in (count.get('notes', ''),
                     'Counted per crosswalk leg, Comm Ave halves separately.' if count['method'] == 'half-leg' else 'Counted once per crosswalk leg.',
                     '' if segments else 'No mapped OSM crosswalks here: the screen is a 25 m cordon.',
                     '' if how == 'osm' else 'Position transcribed (about 100 m accuracy), not an OSM junction.') if x),
        })
    sources = extra['sources'] + [{
        'id': 'bu-warren-epnf-2024', 'title': 'Boston University Warren Towers Expanded Project Notification Form (Feb 2024), Table 7-6',
        'url': WARREN_REPORT, 'license': 'Public filing (BPDA Article 80); facts reused with citation',
        'period': '2023-10-18 to 2023-10-19 (Wed/Thu), AM 8-9 and PM 5-6 peak hours',
        'notes': 'Values transcribed from PDF page 136 into data-pipeline/output/signals.json (scrape_signals.py).',
        'retrievedAt': signals['pedestrianCounts'][0]['provenance']['retrievedAt']}, {
        'id': 'osm-overpass', 'title': 'OpenStreetMap via Overpass API (intersections and crosswalks)', 'url': OVERPASS,
        'license': 'ODbL 1.0, (c) OpenStreetMap contributors', 'period': crossing_page.fetched_at[:10],
        'notes': 'Count sites at the nodes shared by their two named streets; screens across the mapped crosswalks (footway=crossing).',
        'retrievedAt': crossing_page.fetched_at}]
    return out, sources, missing


def ctps_pedestrians(fetcher, bounds):
    counts, geometry = fetcher.get(CTPS_COUNTS), fetcher.get(CTPS_GEOMETRY)
    features = {str(f['properties']['loc_id']): f for f in json.loads(geometry.text)['features']}
    by_site_date = defaultdict(list)
    for row in csv.DictReader(io.StringIO(counts.text)):
        feature = features.get(row['bp_loc_id'])
        if row['count_type'] != 'P' or feature is None:
            continue
        lon, lat = feature['geometry']['coordinates'][:2]
        if not any(w <= lon <= e and s <= lat <= n for s, w, n, e in bounds):
            continue
        by_site_date[row['bp_loc_id'], row['count_date']].append(row)
    columns = [c for c in next(iter(by_site_date.values()))[0].keys() if c.startswith('cnt_') and c != 'cnt_total'] if by_site_date else []
    out = []
    for (loc, day), rows in sorted(by_site_date.items()):
        year = int(day[:4])
        if year < 2000:
            continue
        feature = features[loc]
        bins = []
        for col in columns:
            values = [r[col].strip() for r in rows]
            if not all(values):
                continue
            minute = int(col[4:6]) * 60 + int(col[6:8])
            bins.append({'start': hhmm(minute), 'end': hhmm(minute + 15), 'value': float(sum(float(v) for v in values))})
        if not bins:
            continue
        d = date.fromisoformat(day)
        movements = sorted({f"{r['from_st_name']} {r['from_st_dir']} -> {r['to_st_name']} {r['to_st_dir']}".strip() for r in rows})
        name = feature['properties']['description']
        out.append({
            'id': f'ped-ctps-{loc}-{day}', 'site': name, 'position': [round(c, 7) for c in feature['geometry']['coordinates'][:2]],
            'measure': 'screenline', 'screen': {'type': 'cordon', 'radiusMetres': 20},
            'date': day, 'dayType': day_type(d), 'weekdays': [d.weekday()],
            'bins': bins, 'unit': 'people per 15-min bin (all movements summed)', 'direction': None,
            'movements': movements, 'source': 'ctps-bp-counts',
            'quality': 'context' if year < 2015 or d.month in (6, 7, 8) or year in (2020, 2021) else 'primary',
            'expectedStudentShare': list(STUDENT_SHARE['ped-bu-bridge' if 'Bridge' in name else 'ped-default']),
            'notes': 'Boston Region MPO manual count; movements summed per 15 minutes. Older or out-of-term dates are context only.',
        })
    return out, counts, geometry


# ---------------------------------------------------------------- main

def gated_source_metadata(meta):
    return {**meta, 'title': 'MBTA Gated Station Entries (station, service date, 30-minute period)',
            'url': GSE_ITEM, 'apiUrl': GSE_SERVICE, 'license': LICENSE_MBTA,
            'period': meta['coverage'],
            'notes': f'{meta["records"]} Kenmore records queried including boundary service dates; '
                     'configured fall calendar windows and excluded dates applied. '
                     'Per-page provenance records every query URL, retrieval time and response hash.'}


def refresh_kenmore(previous, fetcher):
    """Refresh one measured source without dropping unrelated saved observations."""
    if previous.get('schemaVersion') != 1 or not all(isinstance(previous.get(k), list) for k in ('transit', 'pedestrian', 'sources')):
        raise ScrapeError('Kenmore refresh requires an existing observations bundle')
    gated, metadata, notes = kenmore_gated(fetcher, map_stops())
    if not gated or notes:
        raise ScrapeError('Incomplete Kenmore refresh; keeping saved bundle: ' + '; '.join(notes))
    sources = [gated_source_metadata(meta) for meta in metadata]
    ids = {source['id'] for source in sources}
    return {**previous, 'generatedAt': utc_now(),
            'transit': [s for s in previous['transit'] if not (s['kind'] == 'gated-entries' and s['stop']['mapStopId'] == 'place-kencl')] + gated,
            'sources': [source for source in previous['sources'] if source['id'] not in ids] + sources}


def collect(fetcher):
    stops = map_stops()
    transit, pedestrian, notes = [], [], []
    sources = []
    try:
        gated, gse_meta, gse_notes = kenmore_gated(fetcher, stops)
        transit += gated
        notes += gse_notes
        sources.extend(gated_source_metadata(meta) for meta in gse_meta)
    except ScrapeError as exc:
        notes.append(f'Kenmore gated entries unavailable: {exc}')
    try:
        rail, meta = rail_hourly(fetcher, stops)
        transit += rail
        sources.append({'id': meta['id'], 'title': 'Fall 2025 MBTA Rail Ridership by Hour, Route/Line, and Stop',
                        'url': RAIL_HOURLY_ITEM, 'downloadUrl': RAIL_HOURLY_CSV, 'license': LICENSE_MBTA,
                        'period': 'Fall 2025 service rating; averages over non-holiday days, diversion days excluded per line',
                        'notes': 'Hour-of-service bins (hour starting at hour_of_service). Values recomputed as total/number_service_days for precision.',
                        'retrievedAt': meta['retrievedAt'], 'serviceDays': meta['serviceDays']})
    except ScrapeError as exc:
        notes.append(f'Rail hourly ridership unavailable: {exc}')
    try:
        bus, meta = bus_apc(fetcher, stops)
        transit += bus
        sources.append({'id': meta['id'], 'title': 'MBTA Bus Ridership by Trip, Season, Route/Line, and Stop (Fall 2025)',
                        'url': BUS_ITEM, 'downloadUrl': BUS_ZIP, 'license': LICENSE_MBTA,
                        'period': 'Fall 2025 APC rating; day types Wkdy (Mon-Thu), Fri, Sat, Sun; holidays excluded',
                        'notes': f'Stop arrival hour from the Fall 2025 GTFS archive {GTFS_FALL_2025} ({meta["stopTimeMatch"]}).',
                        'retrievedAt': meta['retrievedAt'], 'member': meta['member']})
        sources.append({'id': 'mbta-gtfs-fall-2025', 'title': 'MBTA GTFS archive, Fall 2025 (feed 2025-10-21)',
                        'url': GTFS_FALL_2025, 'indexUrl': GTFS_ARCHIVE_INDEX, 'license': 'MBTA developer license (public GTFS)',
                        'period': '2025-10-21 to 2025-10-27 feed', 'notes': 'Used only to place APC trip rows in the hour they reach each stop.',
                        'retrievedAt': meta['gtfs']['retrievedAt']})
    except ScrapeError as exc:
        notes.append(f'Bus APC ridership unavailable: {exc}')
    try:
        counted, ped_sources, missing = pedestrian_counts(fetcher)
        pedestrian += counted
        sources += ped_sources
        if missing:
            notes.append('Pedestrian count sites not located: ' + ', '.join(sorted(set(missing))))
    except (ScrapeError, OSError, KeyError) as exc:
        notes.append(f'Pedestrian counts unavailable: {exc}')
    try:
        bounds = [json.loads((ROOT / 'campuses' / f'{c}.json').read_text())['bbox'] for c in ('charles-river', 'medical', 'fenway')]
        ctps, counts, _ = ctps_pedestrians(fetcher, bounds)
        pedestrian += ctps
        sources.append({'id': 'ctps-bp-counts', 'title': 'Boston Region MPO (CTPS) Bicycle/Pedestrian Counts', 'url': CTPS_ROOT + 'index.html',
                        'downloadUrl': CTPS_COUNTS, 'license': 'Public (Boston Region MPO data browser)',
                        'period': ', '.join(sorted({p['date'] for p in ctps})) or 'none in map area since 2000',
                        'notes': 'Pedestrian (count_type P) rows only, 15-minute bins, movements summed.', 'retrievedAt': counts.fetched_at})
    except ScrapeError as exc:
        notes.append(f'CTPS counts unavailable: {exc}')
    return {
        'schemaVersion': 1, 'generatedAt': utc_now(), 'timezone': 'America/New_York',
        'notes': notes,
        'dayTypes': {'weekday': 'Monday-Friday for rail/gated; Monday-Thursday for bus (Friday separate)',
                     'friday': 'bus only', 'saturday': 'Saturday', 'sunday': 'Sunday'},
        'sources': sources, 'transit': transit, 'pedestrian': pedestrian,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--output', type=Path, default=OUT)
    parser.add_argument('--cache-dir', type=Path, default=CACHE)
    parser.add_argument('--offline', action='store_true', help='Use only cached downloads')
    parser.add_argument('--refresh', action='store_true', help='Download again')
    parser.add_argument('--only-kenmore', action='store_true', help='Refresh Kenmore observations in the existing output bundle, preserving other sources')
    args = parser.parse_args()
    fetcher = Fetcher(cache_dir=args.cache_dir, offline=args.offline, refresh=args.refresh, delay=0.5, timeout=180)
    try:
        payload = refresh_kenmore(json.loads(args.output.read_text()), fetcher) if args.only_kenmore else collect(fetcher)
        if not payload['transit'] and not payload['pedestrian']:
            raise ScrapeError('No observations collected; output was not replaced')
    except (ScrapeError, OSError, json.JSONDecodeError) as exc:
        sys.exit(f'calibration observations: {exc}')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')
    print(f'calibration observations: {len(payload["transit"])} transit series, {len(payload["pedestrian"])} pedestrian series '
          f'-> {args.output} ({args.output.stat().st_size // 1024} KB)')
    for note in payload['notes']:
        print('  note:', note)


if __name__ == '__main__':
    main()
