"""Apply reviewed Google Maps regular hours only where scenario dates lack evidence."""
import argparse
from copy import deepcopy
from datetime import date, datetime, timedelta
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit

from common import OUTPUT, ROOT, ScrapeError, utc_now, write_json
from extend_opening_hours import merge_hours

INPUT = ROOT / 'inputs/google_maps_hours.json'


def apply(payload, evidence):
    start, end = date.fromisoformat(evidence['weekStart']), date.fromisoformat(evidence['weekEnd'])
    if start.weekday() != 0 or end != start + timedelta(days=6):
        raise ScrapeError('Maps fallback must cover exactly one Monday–Sunday week')
    result = deepcopy(payload)
    locations = {r['locationId']: r for r in result['locations']}
    added, seen = [], set()
    for record in evidence['locations']:
        key = record['locationId']
        if key in seen or key not in locations:
            raise ScrapeError(f'Duplicate or unknown Maps location: {key}')
        seen.add(key)
        url = urlsplit(record['sourceUrl'])
        if url.scheme != 'https' or url.hostname != 'www.google.com' or not url.path.startswith('/maps/place/'):
            raise ScrapeError('Expected an observed Google Maps place URL')
        datetime.fromisoformat(record['observedAt'].replace('Z', '+00:00'))
        location = locations[key]
        incoming = []
        for weekday, value in record['weekend'].items():
            if weekday not in ('5', '6'):
                raise ScrapeError('Only reviewed weekend hours are supported')
            windows = value['windows']
            if not windows and value['text'].strip().lower() != 'closed':
                raise ScrapeError('Empty Maps hours must explicitly say Closed')
            for window in windows:
                if len(window) != 2 or any(type(n) is not int for n in window) or not 0 <= window[0] < window[1] <= 172800:
                    raise ScrapeError('Invalid Maps time window')
            day = (start + timedelta(days=int(weekday))).isoformat()
            if any(r.get('date') == day or (r.get('date') is None and r.get('weekday') == int(weekday)
                    and r.get('validFrom', day) <= day <= r.get('validTo', day)) for r in location['hours']):
                continue
            incoming.append({'date': day, 'windows': windows, 'text': value['text'],
                'sourceUrl': record['sourceUrl'], 'sourceKind': 'google_maps_regular_hours',
                'observedAt': record['observedAt'], 'placeName': record['placeName'],
                'qualifier': 'Google Maps regular weekly listing used as a fallback for this scenario date; date-specific exceptions unverified. '
                             + record.get('scope', '')})
            added.append({'locationId': key, 'date': day})
        if incoming:
            location['hours'] = merge_hours(location['hours'], incoming)
            location['sources'] = sorted(set(location.get('sources', [])) | {record['sourceUrl']})
            location['status'] = 'published'
    missing = {}
    for key, location in locations.items():
        if location['status'] == 'restricted':
            continue
        gaps = []
        for offset in range(7):
            day = (start + timedelta(days=offset)).isoformat()
            if not any(r.get('date') == day or (r.get('date') is None and r.get('weekday') == offset
                    and r.get('validFrom', day) <= day <= r.get('validTo', day)) for r in location['hours']):
                gaps.append(day)
        if gaps:
            missing[key] = gaps
    result['googleMapsFallback'] = {'weekStart': start.isoformat(), 'weekEnd': end.isoformat(),
        'basis': evidence['basis'], 'missingDates': missing}
    if 'diningRefresh' in result:
        result['diningRefresh']['missingDates'] = {key: missing.get(key, []) for key in result['diningRefresh']['missingDates']}
    return result, added


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUTPUT / 'opening_hours.json')
    args = parser.parse_args()
    evidence = json.loads(INPUT.read_text())
    result, added = apply(json.loads(args.output.read_text()), evidence)
    digest = hashlib.sha256(INPUT.read_bytes()).hexdigest()
    sources = {(s['url'], s['sha256']): s for s in result['sources']}
    for row in evidence['locations']:
        sources[(row['sourceUrl'], digest)] = {'url': row['sourceUrl'], 'requestedUrl': row['sourceUrl'],
            'retrievedAt': row['observedAt'], 'sha256': digest, 'contentType': 'application/json',
            'rawPath': str(INPUT.relative_to(ROOT.parent)), 'cacheUsed': True,
            'captureMethod': 'Manually reviewed Google Maps listing; hash identifies saved observation records.'}
    result['sources'] = list(sources.values())
    if added:
        result['collectedAt'] = utc_now()
    write_json(args.output, result)
    print(json.dumps({'added': added, 'missingDates': result['googleMapsFallback']['missingDates']}))
