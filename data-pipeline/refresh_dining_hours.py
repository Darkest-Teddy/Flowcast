"""Merge current published dining dates without extrapolating missing dates."""

import argparse
from copy import deepcopy
from datetime import date, timedelta
import json

from common import Fetcher, OUTPUT, ScrapeError, soup, utc_now, write_json
from extend_opening_hours import merge_hours
from scrape_opening_hours import DINING, entry, format_windows, parse_dining, portable

AFTER_HOURS = 'https://www.bu.edu/articles/2026/dining-services-expands-offerings/'


def refresh(payload, fetcher, week_start, reviewed_regular_hours=False):
    start = date.fromisoformat(week_start)
    if start.weekday() != 0:
        raise ScrapeError('week-start must be a Monday')
    days = [(start + timedelta(days=n)).isoformat() for n in range(7)]
    result = deepcopy(payload)
    locations = {row['locationId']: row for row in result['locations']}
    sources = {(s['url'], s['sha256']): s for s in result['sources']}
    errors = []
    for key, slugs in DINING.items():
        if key == 'fenway-dining' or key not in locations:
            continue
        by_day = {}
        for slug in slugs:
            url = f'https://www.bu.edu/dining/location/{slug}/'
            try:
                source = fetcher.get(url)
                provenance = portable(source)
                sources[(provenance['url'], provenance['sha256'])] = provenance
                for row in parse_dining(source):
                    if row['date'] in days:
                        by_day.setdefault(row['date'], []).append(row)
            except ScrapeError as exc:
                errors.append(str(exc))
        incoming = []
        for day, rows in sorted(by_day.items()):
            # A missing vendor cannot establish closure of the entire GSU group.
            if len(rows) != len(slugs):
                errors.append(f'{key} {day}: incomplete vendor coverage')
                continue
            windows = []
            for a, b in sorted(w for row in rows for w in row['windows']):
                if windows and a <= windows[-1][1]:
                    windows[-1][1] = max(windows[-1][1], b)
                else:
                    windows.append([a, b])
            incoming.append({**rows[0], 'windows': windows, 'text': format_windows(windows),
                'serviceSourceUrls': sorted({r['sourceUrl'] for r in rows}),
                'qualifier': ('Union of four meal vendors; partial service coverage, not the entire food hall or full capacity.'
                              if key == 'gsu' else 'Published dated meal service hours.')})
        location = locations[key]
        location['hours'] = merge_hours(location['hours'], incoming)
        location['sources'] = sorted(set(location.get('sources', [])) |
                                     {u for r in incoming for u in r['serviceSourceUrls']})
    if reviewed_regular_hours and 'after-hours-west' in locations:
        source = fetcher.get(AFTER_HOURS)
        text = soup(source).get_text(' ', strip=True)
        if '10 pm to 1 am daily' not in text or 'October 21, 2026' not in text:
            raise ScrapeError('After Hours published daily schedule changed')
        if not '2026-10-21' <= days[0] <= days[-1] <= '2026-11-01':
            raise ScrapeError('After Hours regular schedule only reviewed through November 1, 2026')
        provenance = portable(source)
        sources[(provenance['url'], provenance['sha256'])] = provenance
        location = locations['after-hours-west']
        existing = {row.get('date') for row in location['hours']}
        incoming = [entry(source, '10 pm to 1 am daily', [[79200, 90000]], date=day,
            qualifier='BU Today October 21, 2026 published daily schedule; reviewed for requested week. Dated location hours take precedence.')
            for day in days if day not in existing]
        location['hours'] = merge_hours(location['hours'], incoming)
        location['sources'] = sorted(set(location.get('sources', [])) | {source.url})
    result['sources'] = list(sources.values())
    result['collectedAt'] = utc_now()
    result['diningRefresh'] = {'weekStart': week_start, 'weekEnd': days[-1], 'errors': errors,
        'missingDates': {key: [day for day in days if not any(r.get('date') == day for r in locations[key]['hours'])]
                         for key in DINING if key != 'fenway-dining' and key in locations}}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--week-start', required=True)
    parser.add_argument('--input', default=str(OUTPUT / 'opening_hours.json'))
    parser.add_argument('--output', default=str(OUTPUT / 'opening_hours.json'))
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--refresh', action='store_true')
    parser.add_argument('--reviewed-regular-hours', action='store_true')
    args = parser.parse_args()
    with open(args.input) as stream:
        payload = json.load(stream)
    result = refresh(payload, Fetcher(offline=args.offline, refresh=args.refresh), args.week_start,
                     args.reviewed_regular_hours)
    write_json(args.output, result)
    print(json.dumps(result['diningRefresh']))


if __name__ == '__main__':
    main()
