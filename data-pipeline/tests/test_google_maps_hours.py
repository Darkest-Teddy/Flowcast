import json
import unittest
from apply_google_maps_hours import apply, INPUT
from common import ScrapeError


class GoogleMapsHoursTests(unittest.TestCase):
    def evidence(self):
        evidence = json.loads(INPUT.read_text())
        evidence['locations'] = [next(r for r in evidence['locations'] if r['locationId'] == 'west-dining')]
        return evidence

    def payload(self):
        return {'locations': [{'locationId': 'west-dining', 'status': 'published', 'hours': [
            {'date': '2026-10-31', 'windows': [[32400, 75600]], 'sourceUrl': 'official'}], 'sources': []}]}

    def test_fills_sunday_without_overwriting_conflicting_official_saturday(self):
        original = self.payload()
        result, added = apply(original, self.evidence())
        self.assertEqual(original, self.payload())
        self.assertEqual(result['locations'][0]['hours'][0], original['locations'][0]['hours'][0])
        self.assertEqual(added, [{'locationId': 'west-dining', 'date': '2026-11-01'}])
        self.assertEqual(result['locations'][0]['hours'][1]['windows'], [[36000, 75600]])
        self.assertIn('exceptions unverified', result['locations'][0]['hours'][1]['qualifier'])
        self.assertEqual(apply(result, self.evidence()), (result, []))

    def test_weekly_official_closure_takes_precedence(self):
        payload = self.payload()
        payload['locations'][0]['hours'].append({'date': None, 'weekday': 6, 'validFrom': '2026-10-26',
                                                'validTo': '2026-11-01', 'windows': []})
        result, added = apply(payload, self.evidence())
        self.assertEqual(added, [])
        self.assertEqual(result['locations'][0]['hours'], payload['locations'][0]['hours'])

    def test_explicit_closure_and_overnight_are_retained(self):
        evidence = self.evidence()
        evidence['locations'][0]['weekend'] = {'5': {'text': 'Closed', 'windows': []},
                                              '6': {'text': '10 PM to 1 AM', 'windows': [[79200,90000]]}}
        payload = self.payload(); payload['locations'][0]['hours'] = []
        result, _ = apply(payload, evidence)
        self.assertEqual([r['windows'] for r in result['locations'][0]['hours']], [[], [[79200,90000]]])

    def test_rejects_invalid_or_unverified_evidence(self):
        for mutate in [lambda r: r.update(sourceUrl='https://example.com/maps/place/test'),
                       lambda r: r['weekend'].update({'6': {'text': 'Unknown', 'windows': []}}),
                       lambda r: r['weekend'].update({'6': {'text': 'Bad', 'windows': [[10,1]]}})]:
            evidence = self.evidence(); mutate(evidence['locations'][0])
            with self.assertRaises(ScrapeError):
                apply(self.payload(), evidence)
