"""Merge date-specific BU library hours for a complete requested Monday–Sunday week."""
import argparse
from datetime import date, timedelta
import json

from common import Fetcher, OUTPUT, ScrapeError, utc_now, write_json
from extend_opening_hours import merge_hours
from scrape_libraries import HOURS_URL, parse_hours
from scrape_opening_hours import LIBRARIES, entry, hour_windows, portable


def refresh(payload, fetcher, week_start):
    start = date.fromisoformat(week_start)
    if start.weekday() != 0:
        raise ScrapeError('week-start must be a Monday')
    dates = {(start + timedelta(days=i)).isoformat() for i in range(7)}
    # The publisher's calendar starts on Sunday, so a simulation week spans two pages.
    sunday = start - timedelta(days=1)
    sources = [fetcher.get(f'{HOURS_URL}?week={(sunday + timedelta(days=i)).isoformat()}') for i in (0, 7)]
    parsed = [(source, row) for source in sources for row in parse_hours(source)]
    updates = {}
    for location in payload['locations']:
        name = LIBRARIES.get(location['locationId'])
        if name is None:
            continue
        rows = []
        for source, row in parsed:
            if row['library'] != name or row['service'] != 'General Hours' or row['date'] not in dates:
                continue
            windows = hour_windows(row['hoursText'])
            if not windows and not row['closed']:
                raise ScrapeError(f"Unrecognized library hours: {name} {row['date']}")
            rows.append(entry(source, row['hoursText'], windows, date=row['date']))
        if {row['date'] for row in rows} != dates:
            raise ScrapeError(f'Incomplete dated library schedule: {name}')
        updates[location['locationId']] = rows
    # Validate every location before mutating the saved payload.
    for location in payload['locations']:
        if location['locationId'] in updates:
            rows = updates[location['locationId']]
            location.update(hours=merge_hours(location['hours'], rows), status='published', reason=None)
            location['sources'] = sorted(set(location['sources']) | {row['sourceUrl'] for row in rows})
    provenance = {(s['url'], s['sha256']): s for s in payload['sources']}
    provenance.update({(s.url, s.provenance['sha256']): portable(s) for s in sources})
    payload['sources'] = list(provenance.values())
    payload['collectedAt'] = utc_now()
    return payload


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--week-start', required=True)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--refresh', action='store_true')
    parser.add_argument('--output', default=str(OUTPUT / 'opening_hours.json'))
    args = parser.parse_args()
    with open(args.output) as stream:
        payload = json.load(stream)
    write_json(args.output, refresh(payload, Fetcher(offline=args.offline, refresh=args.refresh), args.week_start))
