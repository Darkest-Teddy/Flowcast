import unittest

from common import ScrapeError, Source
from scrape_signals import parse_boxscore, parse_fitrec, parse_pedestrian_table


class SignalTests(unittest.TestCase):
    def test_table_selects_pedestrians_not_bicycles_and_keeps_collection_dates(self):
        text = '''October 18 and 19, 2023. Table 7-6: volume
Peds Bicycles Cars/ Trucks Peds Bicycles Cars/ Trucks
Commonwealth Avenue at St Mary's Street 836 180 971 1,632 236 1,378
Bay State Road at Granby Street/Back Street 235 31 164 403 48 198
Source: Accurate Counts'''
        records = parse_pedestrian_table(text, {'url': 'https://example.com/report.pdf'})
        self.assertEqual([r['value'] for r in records], [836, 1632, 235, 403])
        self.assertEqual(records[0]['collectionDates'], ['2023-10-18', '2023-10-19'])
        self.assertIsNone(records[0]['exactIntersectionDate'])
        with self.assertRaises(ScrapeError):
            parse_pedestrian_table('some unrelated PDF page', {})

    def test_boxscore_uses_reported_total_and_boston_offset(self):
        html = '<title>BU vs Brown</title>' + ''.join(
            f'<div><span>{key}: </span><span>{value}</span></div>' for key, value in
            [('Date','10/10/2026'), ('Start','07:00 PM'), ('Attendance','4,951'), ('Location','Boston')])
        result = parse_boxscore(Source('https://example.com/boxscore', html.encode(), 'now'))
        self.assertEqual(result['value'], 4951)
        self.assertEqual(result['startAt'], '2026-10-10T19:00:00-04:00')
        self.assertEqual(result['measure'], 'reported_event_attendance')
        self.assertIsNone(result['locationId'])

    def test_fitrec_publication_is_not_a_current_observation(self):
        html = '''<meta property="article:published_time" content="2025-11-03T12:00:00Z">
<main>With more than 4,000 members stopping by every day, FitRec is busy.</main>'''
        result = parse_fitrec(Source('https://example.com/fitrec', html.encode(), '2026-10-24'))
        self.assertEqual(result['value'], 4000)
        self.assertEqual(result['qualifier'], 'more_than')
        self.assertEqual(result['sourcePublishedAt'], '2025-11-03T12:00:00Z')
        self.assertIsNone(result['observationPeriod'])


if __name__ == '__main__':
    unittest.main()
