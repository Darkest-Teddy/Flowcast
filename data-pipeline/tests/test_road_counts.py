import json
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from common import ScrapeError
from scrape_road_counts import normalize, summarize, collect

BOUNDS = {'campus': [42, -72, 43, -71]}


def row(day='2026-06-10', hour=8, **changes):
    stamp = datetime.fromisoformat(day).replace(tzinfo=ZoneInfo('America/New_York'))
    value = {'ObjectId': 1, 'location_name': 'Street at Campus', 'date': stamp.timestamp()*1000,
             'time': stamp.replace(hour=hour).timestamp()*1000, 'year': stamp.year,
             'direction': 'Eastbound', 'bike': 10, 'mv_total': 100, 'lat': 42.5, 'long': -71.5,
             'season': 'Summer'}
    value.update(changes)
    return value


class RoadCountTests(unittest.TestCase):
    def test_hour_and_weekday_are_boston_local(self):
        result = summarize([row(hour=23)], BOUNDS)
        profile = result['locations'][0]['profiles'][0]
        self.assertEqual((profile['weekday'], profile['hour']), (2, 23))
        self.assertEqual(result['observations'][0]['date'], '2026-06-10')

    def test_latest_year_distinct_dates_mean_and_direction_separation(self):
        first = row()
        result = summarize([first, dict(first), row('2026-06-17', bike=30, mv_total=200),
                            row('2026-06-17', direction='Westbound', bike=4, mv_total=50),
                            row('2025-06-11', bike=999)], BOUNDS)
        self.assertEqual(result['coverage']['duplicateRowsRemoved'], 1)
        self.assertEqual(result['coverage']['olderObservationsOmitted'], 1)
        profiles = result['locations'][0]['profiles']
        self.assertEqual(profiles[0], {'weekday':2,'hour':8,'direction':'Eastbound','bikes':20,'motorVehicles':150,'samples':2})
        self.assertEqual(profiles[1]['direction'], 'Westbound')
        self.assertEqual(profiles[1]['samples'], 1)

    def test_missing_values_are_not_zero_and_invalid_dates_rejected(self):
        invalid = [row(bike=None), row(mv_total=-1), row(bike=float('nan')),
                   row('2027-01-06'), row(year=2025), row(long=-80)]
        result = summarize(invalid + [row(bike=0, mv_total=0)], BOUNDS)
        self.assertEqual(result['coverage']['observations'], 1)
        self.assertEqual(sum(result['coverage']['rejectedRows'].values()), 6)
        self.assertEqual(result['locations'][0]['profiles'][0]['bikes'], 0)

    def test_conflicting_duplicate_removed_instead_of_arbitrarily_averaged(self):
        result = summarize([row(), row(bike=25), row('2026-06-17')], BOUNDS)
        self.assertEqual(result['coverage']['observations'], 1)
        self.assertEqual(result['locations'][0]['profiles'][0]['samples'], 1)
        self.assertEqual(result['coverage']['rejectedRows']['conflicting duplicate observation'], 2)

    def test_server_page_cap_advances_by_actual_records_not_requested_size(self):
        class Capped:
            offsets = []
            def get(self, url):
                offset = int(parse_qs(urlsplit(url).query)['resultOffset'][0])
                self.offsets.append(offset)
                payload = {'features': [{'attributes': row('2026-06-10' if offset == 0 else '2026-06-17', ObjectId=offset+1)}],
                           'exceededTransferLimit': offset == 0}
                return SimpleNamespace(text=json.dumps(payload), provenance={})
        fetcher = Capped()
        with patch('scrape_road_counts.campus_bounds', return_value=BOUNDS):
            result = collect(fetcher)
        self.assertEqual(fetcher.offsets, [0, 1])
        self.assertEqual(result['coverage']['queriedRows'], 2)

    def test_api_errors_and_repeating_pagination_fail(self):
        class Fake:
            def __init__(self, payload): self.payload=payload
            def get(self, url): return SimpleNamespace(text=json.dumps(self.payload), provenance={})
        with self.assertRaises(ScrapeError):
            collect(Fake({'error': {'message':'Bad query'}}))
        with self.assertRaisesRegex(ScrapeError, 'pagination'):
            collect(Fake({'features':[{'attributes':row()}], 'exceededTransferLimit':True}))


if __name__ == '__main__':
    unittest.main()
