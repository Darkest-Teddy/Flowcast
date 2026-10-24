"""Extend one requested week from cached official schedules without replacing history.

--reviewed-regular-hours means the operator checked the medical library's holiday
list, Chequers' and the law libraries' notices for this week. It is deliberately not inferred from a
weekday pattern. Fenway's provider publishes machine-readable seasonal overrides.
"""
import argparse
from datetime import date, timedelta
import json
import re

from common import Fetcher, OUTPUT, ScrapeError, soup, utc_now, write_json
from scrape_opening_hours import (CHEQUERS, LAW_LIBRARY, MEDICAL, entry, hour_windows,
                                  law_library_hours, parse_fenway_provider, portable)


def merge_hours(existing, incoming):
    def key(row):
        return (row.get('date'), row.get('weekday'), row.get('validFrom'), row.get('validTo'))
    merged = {key(row): row for row in existing}
    merged.update({key(row): row for row in incoming})
    return sorted(merged.values(), key=lambda row: (row.get('date') or '', row.get('validFrom') or '', row.get('weekday', -1)))


def extend(payload, fetcher, week_start, reviewed_regular_hours=False):
    start = date.fromisoformat(week_start)
    if start.weekday() != 0:
        raise ScrapeError('week-start must be a Monday')
    end = start + timedelta(days=6)
    locations = {row['locationId']: row for row in payload['locations']}
    fetched = []
    def get(url):
        source = fetcher.get(url)
        fetched.append(portable(source))
        return source
    updates = {'fenway-dining': parse_fenway_provider(get('https://www.bu.edu/dining/location/fenway/'), week_start)}
    if reviewed_regular_hours:
        source = get(CHEQUERS)
        match = re.search(r'open weekdays from (.+?) and offers', soup(source).get_text(' ', strip=True))
        if not match:
            raise ScrapeError('Chequers weekday schedule missing')
        windows = hour_windows(match[1].replace('.', ''))
        if not windows:
            raise ScrapeError('Chequers hours unrecognized')
        updates['bumc-chequers'] = [entry(source, match[0], windows, weekday=day,
            validFrom=week_start, validTo=end.isoformat(),
            qualifier='Published regular schedule; source reviewed for this week. No holiday exceptions supplied by cafe.') for day in range(5)]
        source = get(MEDICAL)
        text = soup(source).get_text(' ', strip=True)
        if 'Holiday Closures' not in text:
            raise ScrapeError('Medical library holiday list missing; review source before extending')
        hours_text = text.split('Library Hours', 1)[1].split('L1101', 1)[0]
        matches = re.findall(r'(Monday\s*[–-]\s*Friday|Saturday\s*[–-]\s*Sunday)\s*[–-]\s*(.+?)(?=Saturday|$)', hours_text)
        rows = []
        for label, times in matches:
            windows = hour_windows(times.replace('.', ''))
            if not windows:
                raise ScrapeError('Medical library hours unrecognized')
            for day in (range(5) if label.startswith('Monday') else (5, 6)):
                rows.append(entry(source, f'{label} {times}', windows, weekday=day,
                    validFrom=week_start, validTo=end.isoformat(),
                    qualifier='Published regular schedule; listed holiday closures reviewed for this week.'))
        if len(rows) != 7:
            raise ScrapeError('Medical library schedule incomplete')
        updates['bumc-library'] = rows
        if 'law-library' in locations:
            updates['law-library'] = law_library_hours(get(LAW_LIBRARY), week_start, end.isoformat(),
                'Published fall schedule; source reviewed for this week. No holiday exceptions supplied.')
    for key, rows in updates.items():
        for row in rows:
            merged = []
            for a, b in sorted(row['windows']):
                if merged and a <= merged[-1][1]:
                    merged[-1][1] = max(merged[-1][1], b)
                else:
                    merged.append([a, b])
            row['windows'] = merged
        locations[key]['hours'] = merge_hours(locations[key]['hours'], rows)
        locations[key]['status'] = 'published'
    sources = {(s['url'], s['sha256']): s for s in payload['sources']}
    sources.update({(s['url'], s['sha256']): s for s in fetched})
    payload['sources'] = list(sources.values())
    payload['collectedAt'] = utc_now()
    payload['weekExtension'] = {'weekStart': week_start, 'weekEnd': end.isoformat(),
        'regularHoursReviewed': reviewed_regular_hours, 'locations': list(updates)}
    return payload


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--week-start', required=True)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--reviewed-regular-hours', action='store_true')
    parser.add_argument('--output', default=str(OUTPUT / 'opening_hours.json'))
    args = parser.parse_args()
    with open(args.output) as stream:
        payload = json.load(stream)
    result = extend(payload, Fetcher(offline=args.offline, delay=1), args.week_start, args.reviewed_regular_hours)
    write_json(args.output, result)
    print(json.dumps(result['weekExtension']))
