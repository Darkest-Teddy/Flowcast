import json
from pathlib import Path
import shutil
import tempfile
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

import build_shuttle_schedule as shuttle

BOSTON = ZoneInfo('America/New_York')


def epoch(text):
    return round(datetime.fromisoformat(text).replace(tzinfo=BOSTON).timestamp())


class ShuttleScheduleTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp())
        shutil.copy(shuttle.GTFS, self.temp / shuttle.GTFS.name)
        shutil.copy(shuttle.ROUTES, self.temp / 'routes.json')
        self.saved = (shuttle.SNAPSHOTS, shuttle.GTFS, shuttle.ROUTES, shuttle.ROOT)
        shuttle.SNAPSHOTS, shuttle.GTFS, shuttle.ROUTES, shuttle.ROOT = (
            self.temp, self.temp / shuttle.GTFS.name, self.temp / 'routes.json', self.temp)

    def tearDown(self):
        shuttle.SNAPSHOTS, shuttle.GTFS, shuttle.ROUTES, shuttle.ROOT = self.saved
        shutil.rmtree(self.temp)

    def departures(self, result, route, weekday, stop='BU:addr:1'):
        times = []
        for trip in result['trips']:
            if trip['route'] == route and weekday in trip['weekdays'] and trip['stops'][0]['stop'] in (stop, 'BU:2160536'):
                times.append(trip['stops'][0]['departure'])
        return sorted(times)

    def test_gtfs_baseline_expands_exact_frequencies_and_keeps_published_running_times(self):
        result = shuttle.build()
        saturday = self.departures(result, 'BU-1', 5)
        # Two Saturday 1BU blocks, each hourly, combine into 30-minute service in the afternoon.
        self.assertIn(17 * 3600, saturday)
        self.assertIn(17 * 3600 + 1800, saturday)
        trip = next(t for t in result['trips'] if t['route'] == 'BU-1' and t['stops'][0]['departure'] == 17 * 3600 and 5 in t['weekdays'])
        self.assertEqual([c['arrival'] - trip['stops'][0]['arrival'] for c in trip['stops'][:4]], [0, 120, 240, 360])
        self.assertTrue(all(row['baseline'] == 'gtfs-2024-25' and 'recordedDate' not in row for row in result['provenance']))
        self.assertTrue(all(stop['mapStopId'] is None or stop['mapStopId'].startswith('BU-stop-') for stop in result['stops'].values()))

    def test_recorded_windows_replace_the_baseline_including_missing_service(self):
        # Saturday 24 October 2026: Fenway runs every 40 minutes; Comm Ave does not run at all.
        polled = epoch('2026-10-24T17:00:00')
        calls = []
        for start in ('17:20', '18:00', '18:40'):
            base = epoch(f'2026-10-24T{start}:00')
            for offset, (route_stop, stop) in enumerate([(25, 1), (26, 2), (27, 3)]):
                calls.append({'route': 4, 'routeStop': route_stop, 'stop': stop, 'arrival': base + offset * 120, 'departure': base + offset * 120})
        horizon = epoch('2026-10-24T19:00:00')
        (self.temp / '2026-10-24.json').write_text(json.dumps({'polls': [
            {'polledAt': polled, 'horizons': {'4': horizon, '1': horizon}, 'calls': calls}]}))
        result = shuttle.build()
        window = (17 * 3600, 19 * 3600)
        fenway = [t for t in self.departures(result, 'BU-4', 5) if window[0] <= t < window[1]]
        self.assertEqual(fenway, [17 * 3600 + 1200, 18 * 3600, 18 * 3600 + 2400])
        self.assertEqual([t for t in self.departures(result, 'BU-3', 5) if window[0] <= t < window[1]], [])
        # Outside the window, and on other weekdays, the baseline stays.
        self.assertTrue(any(t < window[0] for t in self.departures(result, 'BU-4', 5)))
        self.assertEqual(self.departures(result, 'BU-4', 4), self.departures(shuttle_without(self), 'BU-4', 4))
        row = next(r for r in result['validation'] if r['route'] == 'BU-4')
        self.assertEqual(row['recordedDepartures'], 3)
        self.assertFalse(row['matches'])

    def test_after_midnight_times_belong_to_the_previous_service_day(self):
        day, seconds = shuttle.service_time(epoch('2026-10-25T01:30:00'))
        self.assertEqual((day.isoformat(), seconds), ('2026-10-24', 25 * 3600 + 1800))


def shuttle_without(test):
    for path in test.temp.glob('20*.json'):
        path.rename(path.with_suffix('.off'))
    try:
        return shuttle.build()
    finally:
        for path in test.temp.glob('20*.off'):
            path.rename(path.with_suffix('.json'))


if __name__ == '__main__':
    unittest.main()
