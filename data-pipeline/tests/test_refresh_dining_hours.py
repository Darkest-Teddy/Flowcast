import unittest
from unittest.mock import patch

from common import Source, ScrapeError
from refresh_dining_hours import refresh, AFTER_HOURS


class DiningRefreshTests(unittest.TestCase):
    def source(self, text=''):
        return Source('https://www.bu.edu/dining/location/test/', text.encode(), '2026-10-25T12:00:00Z')

    def payload(self, key, hours=None):
        return {'locations': [{'locationId': key, 'hours': hours or [], 'sources': []}], 'sources': []}

    def test_non_monday_rejected_before_fetch(self):
        with self.assertRaises(ScrapeError):
            refresh({}, None, '2026-10-25')

    def test_union_preserves_overnight_and_history(self):
        old = {'date': '2026-10-19', 'windows': [[1, 2]]}
        source = self.source()
        class Fetch:
            def get(self, url):
                return source
        rows = [{'date': '2026-10-31', 'windows': [[79200, 90000]], 'sourceUrl': source.url}]
        with patch('refresh_dining_hours.DINING', {'gsu': ['one', 'two']}), patch('refresh_dining_hours.parse_dining', return_value=rows):
            result = refresh(self.payload('gsu', [old]), Fetch(), '2026-10-26')
        self.assertEqual(result['locations'][0]['hours'], [old, {
            **rows[0], 'text': '22:00–25:00', 'serviceSourceUrls': [source.url],
            'qualifier': 'Union of four meal vendors; partial service coverage, not the entire food hall or full capacity.'}])
        self.assertIn('2026-11-01', result['diningRefresh']['missingDates']['gsu'])

    def test_incomplete_vendor_closure_is_not_published(self):
        source = self.source()
        class Fetch:
            def get(self, url):
                return source
        with patch('refresh_dining_hours.DINING', {'gsu': ['one', 'two']}), patch('refresh_dining_hours.parse_dining', side_effect=[[
                {'date': '2026-10-31', 'windows': [], 'sourceUrl': source.url}], []]):
            result = refresh(self.payload('gsu'), Fetch(), '2026-10-26')
        self.assertEqual(result['locations'][0]['hours'], [])
        self.assertEqual(len(result['diningRefresh']['errors']), 1)

    def test_regular_article_fills_only_missing_dates(self):
        source = self.source('October 21, 2026 serves food from 10 pm to 1 am daily')
        class Fetch:
            def get(self, url):
                return source
        closed = {'date': '2026-10-31', 'windows': []}
        with patch('refresh_dining_hours.DINING', {}):
            result = refresh(self.payload('after-hours-west', [closed]), Fetch(), '2026-10-26', True)
        rows = result['locations'][0]['hours']
        self.assertEqual(len(rows), 7)
        self.assertEqual(next(r for r in rows if r['date'] == '2026-10-31'), closed)
        self.assertEqual(rows[-1]['windows'], [[79200, 90000]])

    def test_article_cannot_extend_beyond_review(self):
        source = self.source('October 21, 2026 serves food from 10 pm to 1 am daily')
        class Fetch:
            def get(self, url):
                return source
        with patch('refresh_dining_hours.DINING', {}), self.assertRaises(ScrapeError):
            refresh(self.payload('after-hours-west'), Fetch(), '2026-11-02', True)
