import json
import tempfile
import unittest
from pathlib import Path
from fetch_parking import soccer_events, OUT

class ParkingSourceTests(unittest.TestCase):
    def test_saved_calendar_replaces_invented_october_fixture(self):
        events = soccer_events()
        games = {e['date']: e for e in events}
        self.assertNotIn('2026-10-28', games)
        for day, hour in [('2026-10-30', 19), ('2026-10-31', 13)]:
            self.assertEqual(games[day]['start'], hour * 3600)
            self.assertFalse(games[day]['sample'])
            self.assertEqual(games[day]['demandBasis'], 'modeled')
            self.assertEqual(games[day]['endBasis'], 'modeled two-hour duration')
        shipped = json.loads(OUT.read_text())['events']
        self.assertFalse(any(e['sample'] for e in shipped))
        self.assertTrue(all(e in shipped for e in events))

    def test_empty_calendar_does_not_create_replacement_sample(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'calendar.json'
            path.write_text('{"events": []}')
            self.assertEqual(soccer_events(path), [])
