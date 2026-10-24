import unittest
from scrape_opening_hours import parse_fenway_provider
from extend_opening_hours import merge_hours, extend
from common import ScrapeError, Source
import json


class ExtensionTests(unittest.TestCase):
    def test_merge_preserves_history_and_replaces_same_date(self):
        old = [{'date': '2026-10-19', 'windows': [[1,2]]}, {'date': '2026-10-26', 'windows': [[3,4]]}]
        rows = merge_hours(old, [{'date': '2026-10-26', 'windows': []}])
        self.assertEqual(rows, [old[0], {'date':'2026-10-26', 'windows':[]}])
        self.assertEqual(merge_hours(rows, rows), rows)

    def test_reject_non_monday_before_fetch(self):
        with self.assertRaises(ScrapeError):
            extend({}, None, '2026-10-25')

    def test_requested_week_crosses_month_and_honors_provider_closure(self):
        state = {'slug':'the-fenway-dining-hall', 'openingHours': {
            'standardHours':[{'days':[], 'hours':[{'allDay':True}]}],
            'seasonalHours':[{'from':'2026-11-01', 'to':'2026-11-01',
                'openingHours':[{'days':[], 'hours':[{'label':'Closed'}]}]}]}}
        source = Source('https://bufenway.sodexomyway.com/en-us/locations/',
            ('<script>window.__PRELOADED_STATE__ = '+json.dumps(state)+'</script>').encode(), '2026-10-24T12:00:00Z')
        rows = parse_fenway_provider(source, '2026-10-26')
        self.assertEqual(rows[0]['date'], '2026-10-26')
        self.assertEqual(rows[-1]['date'], '2026-11-01')
        self.assertEqual(rows[-1]['windows'], [])
        self.assertEqual(rows[0]['windows'], [[0,86400]])
