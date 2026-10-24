"""Snapshot Boston's observed hourly bicycle and motor-vehicle counts near BU."""

from collections import Counter, defaultdict
from datetime import date, datetime, timezone
import json
import math
from pathlib import Path
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from common import Fetcher, ScrapeError, run_cli, stable_id

ROOT = Path(__file__).resolve().parent.parent
SERVICE = 'https://services.arcgis.com/sFnw0xNflSi8J0uh/arcgis/rest/services/Streets_Hourly_Bike_Counts/FeatureServer/0'
SOURCE_URL = 'https://www.boston.gov/departments/boston-bikes/bike-data'
BOSTON = ZoneInfo('America/New_York')
AS_OF = '2026-10-24'
PAGE_SIZE = 2000
MAX_PAGES = 20
APPROACH_BUFFER_METRES = 500


def campus_bounds():
    bounds = {}
    for name in ('charles-river', 'medical', 'fenway'):
        south, west, north, east = json.loads((ROOT / 'data-pipeline' / 'campuses' / f'{name}.json').read_text())['bbox']
        dy = APPROACH_BUFFER_METRES / 111320
        dx = dy / math.cos(math.radians((south + north) / 2))
        bounds[name] = [round(south-dy, 6), round(west-dx, 6), round(north+dy, 6), round(east+dx, 6)]
    return bounds


def query_url(bounds, offset=0):
    clauses = [f'(lat >= {south} AND lat <= {north} AND long >= {west} AND long <= {east})'
               for south, west, north, east in bounds.values()]
    return SERVICE + '/query?' + urlencode({
        'f': 'json', 'where': 'year >= 2024 AND (' + ' OR '.join(clauses) + ')',
        'outFields': 'ObjectId,count_id,location_name,date,time,year,season,direction,bike,mv_total,lat,long',
        'returnGeometry': 'false', 'orderByFields': 'ObjectId',
        'resultRecordCount': PAGE_SIZE, 'resultOffset': offset,
    })


def numeric(value):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise ValueError('missing or invalid number')
    return value


def normalize(row, bounds, as_of):
    lat, lon = numeric(row.get('lat')), numeric(row.get('long'))
    candidates = [(name, math.hypot(lat-(s+n)/2, (lon-(w+e)/2)*math.cos(math.radians(lat))))
                  for name, (s, w, n, e) in bounds.items() if s <= lat <= n and w <= lon <= e]
    campus = min(candidates, key=lambda item: item[1])[0] if candidates else None
    if campus is None:
        raise ValueError('outside campus bounds')
    observed = datetime.fromtimestamp(numeric(row.get('date')) / 1000, timezone.utc).astimezone(BOSTON).date()
    stamp = datetime.fromtimestamp(numeric(row.get('time')) / 1000, timezone.utc).astimezone(BOSTON)
    if observed > as_of or observed.year < 2024:
        raise ValueError('outside collection window')
    if stamp.date() != observed or stamp.minute or stamp.second or stamp.microsecond:
        raise ValueError('timestamp does not match hourly observation date')
    if row.get('year') != observed.year:
        raise ValueError('year and date disagree')
    bikes, motor = numeric(row.get('bike')), numeric(row.get('mv_total'))
    if bikes < 0 or motor < 0 or not float(bikes).is_integer() or not float(motor).is_integer():
        raise ValueError('invalid count')
    name, direction = row.get('location_name'), row.get('direction')
    if not isinstance(name, str) or not name.strip() or not isinstance(direction, str) or not direction.strip():
        raise ValueError('missing location or direction')
    site_id = f'boston-count-{stable_id(name.strip(), round(lon, 6), round(lat, 6))}'
    return {'id': site_id, 'name': name.strip(), 'position': [lon, lat], 'campus': campus,
            'date': observed.isoformat(), 'weekday': observed.weekday(), 'hour': stamp.hour,
            'direction': direction.strip(), 'bikes': int(bikes), 'motorVehicles': int(motor),
            'season': row.get('season')}


def summarize(rows, bounds, as_of=AS_OF):
    end = date.fromisoformat(as_of)
    rejected = Counter()
    observations = {}
    conflicts = set()
    duplicates = 0
    for row in rows:
        try:
            item = normalize(row, bounds, end)
        except (ValueError, OverflowError, OSError) as exc:
            rejected[str(exc)] += 1
            continue
        key = (item['id'], item['date'], item['hour'], item['direction'])
        if key in conflicts:
            rejected['conflicting duplicate observation'] += 1
        elif key in observations:
            if observations[key] == item:
                duplicates += 1
            else:
                del observations[key]
                conflicts.add(key)
                rejected['conflicting duplicate observation'] += 2
        else:
            observations[key] = item
    latest = {}
    for item in observations.values():
        latest[item['id']] = max(latest.get(item['id'], 0), int(item['date'][:4]))
    selected = sorted((item for item in observations.values() if int(item['date'][:4]) == latest[item['id']]),
                      key=lambda item: (item['id'], item['date'], item['hour'], item['direction']))
    sites = defaultdict(list)
    for item in selected:
        sites[item['id']].append(item)
    locations = []
    for site_id, items in sorted(sites.items()):
        profiles = defaultdict(list)
        for item in items:
            profiles[item['weekday'], item['hour'], item['direction']].append(item)
        first = items[0]
        locations.append({
            'id': site_id, 'name': first['name'], 'position': first['position'], 'campus': first['campus'],
            'sourceUrl': SOURCE_URL, 'observedFrom': min(x['date'] for x in items),
            'observedTo': max(x['date'] for x in items),
            'profiles': [{'weekday': weekday, 'hour': hour, 'direction': direction,
                          'bikes': round(sum(x['bikes'] for x in values) / len(values), 3),
                          'motorVehicles': round(sum(x['motorVehicles'] for x in values) / len(values), 3),
                          'samples': len(values)}
                         for (weekday, hour, direction), values in sorted(profiles.items())],
        })
    return {'sourceUrl': SOURCE_URL, 'apiUrl': SERVICE, 'asOf': as_of, 'locations': locations,
            'observations': selected,
            'coverage': {'queriedRows': len(rows), 'locations': len(locations), 'observations': len(selected),
                         'profiles': sum(len(x['profiles']) for x in locations),
                         'duplicateRowsRemoved': duplicates, 'rejectedRows': dict(sorted(rejected.items())),
                         'olderObservationsOmitted': len(observations) - len(selected),
                         'campusApproachBounds': bounds, 'approachBufferMetres': APPROACH_BUFFER_METRES},
            'method': 'Mean hourly directional counts by weekday, using the latest observed year at each location. Samples count distinct survey dates. Missing observations are not zero.',
            'errors': []}


def collect(fetcher, as_of=AS_OF):
    """Read a bounded, cached ArcGIS query and retain the latest count year for each BU-area site."""
    bounds = campus_bounds()
    rows, sources, seen = [], [], set()
    offset = 0
    for page in range(MAX_PAGES):
        source = fetcher.get(query_url(bounds, offset))
        payload = json.loads(source.text)
        if 'error' in payload or not isinstance(payload.get('features'), list):
            raise ScrapeError(f'Boston count service returned invalid data: {payload.get("error", "missing features")}')
        provenance = source.provenance
        if provenance.get('rawPath'):
            try:
                provenance['rawPath'] = Path(provenance['rawPath']).relative_to(ROOT).as_posix()
            except ValueError:
                provenance['rawPath'] = None
        sources.append(provenance)
        batch = [feature['attributes'] for feature in payload['features']]
        ids = [row.get('ObjectId') for row in batch]
        if any(value is None for value in ids) or len(set(ids)) != len(ids) or seen.intersection(ids):
            raise ScrapeError('ArcGIS pagination repeated or omitted an object identifier')
        seen.update(ids)
        rows.extend(batch)
        offset += len(batch)
        if not payload.get('exceededTransferLimit'):
            break
        if not batch:
            raise ScrapeError('ArcGIS claims additional results but returned an empty page')
    else:
        raise ScrapeError(f'Boston query exceeded the {MAX_PAGES * PAGE_SIZE}-row safety bound')
    result = summarize(rows, bounds, as_of)
    if not result['locations']:
        raise ScrapeError('No usable observed counts in BU campus bounds')
    result['sources'] = sources
    return result


if __name__ == '__main__':
    run_cli('road_counts', collect, lambda parser: parser.add_argument('--as-of', default=AS_OF))
