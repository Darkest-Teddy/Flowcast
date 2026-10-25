import copy
from datetime import date, timedelta
import unittest
from unittest.mock import patch

from common import Source, ScrapeError
from refresh_library_hours import refresh


class LibraryRefreshTests(unittest.TestCase):
    def payload(self):
        return {'locations': [{'locationId': 'mugar', 'hours': [
            {'date': '2026-10-18', 'windows': [[1, 2]]}], 'sources': []}], 'sources': []}

    def rows(self):
        return [{'library': 'Mugar Library', 'service': 'General Hours',
                 'date': (date(2026, 10, 26) + timedelta(days=i)).isoformat(),
                 'hoursText': 'Closed' if i == 5 else '10:00am – 2:00am',
                 'closed': i == 5} for i in range(7)]

    def fetcher(self):
        class Fetcher:
            def get(self, url):
                return Source(url, b'', '2026-10-25T12:00:00Z')
        return Fetcher()

    def test_cross_month_week_closure_overnight_and_idempotence(self):
        with patch('refresh_library_hours.parse_hours', side_effect=[self.rows()[:6], self.rows()[6:]]):
            result = refresh(self.payload(), self.fetcher(), '2026-10-26')
        rows = result['locations'][0]['hours']
        self.assertEqual(len(rows), 8)
        self.assertEqual(rows[0]['date'], '2026-10-18')
        self.assertEqual(rows[-2]['windows'], [])
        self.assertEqual(rows[-1]['windows'], [[36000, 93600]])
        self.assertTrue(rows[-1]['sourceUrl'].endswith('week=2026-11-01'))
        with patch('refresh_library_hours.parse_hours', side_effect=[self.rows()[:6], self.rows()[6:]]):
            again = refresh(result, self.fetcher(), '2026-10-26')
        self.assertEqual(rows, again['locations'][0]['hours'])

    def test_missing_date_or_unrecognized_hours_does_not_mutate(self):
        for rows in [self.rows()[:6], [{**r, 'hoursText': 'By appointment'} for r in self.rows()]]:
            payload = self.payload()
            before = copy.deepcopy(payload)
            with patch('refresh_library_hours.parse_hours', side_effect=[rows, []]):
                with self.assertRaises(ScrapeError):
                    refresh(payload, self.fetcher(), '2026-10-26')
            self.assertEqual(payload, before)

    def test_requires_monday(self):
        with self.assertRaises(ScrapeError):
            refresh({}, None, '2026-11-01')
