import json
from datetime import date, datetime
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_calibration_observations as observations
from common import ScrapeError, Source


def row(day, time, value):
    return {'service_date': int(datetime.fromisoformat(day).replace(tzinfo=observations.BOSTON).timestamp() * 1000),
            'time_period': f'({time}:00)', 'gated_entries': value,
            'stop_id': 'place-kencl', 'route_or_line': 'Green Line', 'station_name': 'Kenmore'}


class KenmoreGatedTests(unittest.TestCase):
    def test_partial_refresh_preserves_other_observations_and_rejects_failed_fetch(self):
        old = {'kind': 'gated-entries', 'stop': {'mapStopId': 'place-kencl'}, 'id': 'old'}
        other = {'kind': 'apc-boardings', 'stop': {'mapStopId': 'other'}, 'id': 'keep'}
        previous = {'schemaVersion': 1, 'transit': [old, other], 'pedestrian': [{'id': 'site'}],
                    'sources': [{'id': 'mbta-gse-fall-2025'}, {'id': 'other-source'}], 'notes': ['retained note']}
        new = {**old, 'id': 'new'}
        meta = {'id': 'mbta-gse-fall-2025', 'coverage': 'dated', 'records': 1}
        with patch.object(observations, 'map_stops', return_value={}), \
                patch.object(observations, 'kenmore_gated', return_value=([new], [meta], [])):
            refreshed = observations.refresh_kenmore(previous, None)
        self.assertEqual(refreshed['transit'], [other, new])
        self.assertEqual(refreshed['pedestrian'], previous['pedestrian'])
        self.assertEqual(refreshed['notes'], previous['notes'])
        self.assertEqual(previous['transit'], [old, other])
        self.assertEqual([s['id'] for s in refreshed['sources']], ['other-source', 'mbta-gse-fall-2025'])
        with patch.object(observations, 'map_stops', return_value={}), \
                patch.object(observations, 'kenmore_gated', return_value=([], [], ['missing data'])):
            with self.assertRaises(ScrapeError):
                observations.refresh_kenmore(previous, None)

    def collect(self, rows, start='2025-09-02', end='2025-09-03', holidays=()):
        pages = [Source('https://example.test/query?offset=0', b'first', '2026-10-25T01:00:00Z'),
                 Source('https://example.test/query?offset=2000', b'second', '2026-10-25T01:01:00Z')]
        period = {'start': date.fromisoformat(start), 'end': date.fromisoformat(end), 'holidays': set(holidays)}
        with patch.object(observations, 'GATED_PERIODS', {'fall-2025': period}), \
                patch.object(observations, 'fetch_gse', return_value=(rows, pages)):
            return observations.kenmore_gated(None, {'place-kencl': {'position': [-71.095, 42.349]}})

    def test_quiet_days_explicit_zero_and_per_bin_denominators(self):
        series, sources, notes = self.collect([
            row('2025-09-02', '08:00', '0'), row('2025-09-02', '08:30', '10'),
            row('2025-09-03', '08:00', '20'), row('2025-09-03', '09:00', '600')])
        self.assertEqual(notes, [])
        s = series[0]
        bins = {b['start']: b for b in s['bins']}
        self.assertEqual(set(bins), {'08:00', '08:30', '09:00'})
        self.assertEqual((bins['08:00']['value'], bins['08:00']['days']), (10, 2))
        self.assertEqual((bins['08:30']['value'], bins['08:30']['days']), (10, 1))
        self.assertEqual(bins['08:30']['dates'], ['2025-09-02'])
        self.assertEqual(s['days'], 2)
        self.assertEqual(s['dailyObservations'][0]['bins'][0]['value'], 0)
        self.assertEqual(s['source'], sources[0]['id'])
        self.assertEqual(sources[0]['dates'], ['2025-09-02', '2025-09-03'])
        self.assertEqual(len(sources[0]['pageProvenance']), 2)
        self.assertNotEqual(sources[0]['pageProvenance'][0]['sha256'], sources[0]['pageProvenance'][1]['sha256'])

    def test_all_zero_day_is_an_observation(self):
        series, _, _ = self.collect([row('2025-09-02', '08:00', '0')])
        self.assertEqual(series[0]['bins'][0]['value'], 0)
        self.assertEqual(series[0]['days'], 1)

    def test_invalid_values_do_not_create_observations_or_zero_bins(self):
        rows = [row('2025-09-02', f'{8 + i}:00', v) for i, v in enumerate([None, '', 'NaN', 'inf', '-1'])]
        series, sources, notes = self.collect(rows)
        self.assertEqual(series, [])
        self.assertEqual(sources[0]['invalidCountRecords'], 5)
        self.assertEqual(sources[0]['dates'], [])
        self.assertEqual(sources[0]['coverage'], 'none')
        self.assertTrue(notes)

    def test_calendar_boundary_holidays_and_exact_date_gaps(self):
        series, sources, _ = self.collect([
            row('2025-09-01', '01:00', '3'),  # prior service date, Sept 2 calendar
            row('2025-09-02', '03:00', '4'),
            row('2025-09-02', '01:00', '99'),  # excluded Sept 3 calendar
            row('2025-09-03', '08:00', '99'),
            row('2025-09-05', '08:00', '5'),
            row('2025-09-05', '01:00', '99')],  # outside calendar window
            end='2025-09-05', holidays=[date(2025, 9, 3)])
        self.assertEqual(series[0]['dates'], ['2025-09-02', '2025-09-05'])
        self.assertEqual([b['value'] for b in series[0]['dailyObservations'][0]['bins']], [3, 4])
        self.assertEqual(sources[0]['excludedDates'], ['2025-09-03'])
        self.assertEqual(sources[0]['requestedCalendarPeriod']['end'], '2025-09-05')

    def test_dst_service_date_preserves_local_calendar_day(self):
        series, _, _ = self.collect([row('2025-11-02', '00:30', '1'), row('2025-11-03', '03:00', '2')],
                                     start='2025-11-03', end='2025-11-03')
        self.assertEqual(series[0]['dates'], ['2025-11-03'])
        self.assertEqual(len(series[0]['bins']), 2)

    def test_ambiguous_duplicate_bins_are_excluded_not_summed(self):
        r = row('2025-09-02', '08:00', '41')
        series, sources, _ = self.collect([r, {**r, 'gated_entries': '40'}, r,
                                           row('2025-09-03', '08:00', '20')])
        self.assertEqual(series[0]['bins'][0]['value'], 20)
        self.assertEqual(series[0]['bins'][0]['days'], 1)
        self.assertEqual(sources[0]['ambiguousBins'], [{'date': '2025-09-02', 'start': '08:00'}])
        self.assertEqual(sources[0]['dates'], ['2025-09-03'])

    def test_unexpected_rows_fail_closed(self):
        r = row('2025-09-02', '08:00', '10')
        for rows in ([{**r, 'stop_id': 'other'}], [{**r, 'route_or_line': 'Blue Line'}],
                     [{**r, 'time_period': '(08:15:00)'}]):
            with self.subTest(rows=rows), self.assertRaises(ScrapeError):
                self.collect(rows)

    def test_collect_keeps_full_gated_metadata_and_source_reference(self):
        gated, metadata, notes = self.collect([row('2025-09-02', '08:00', '1')])
        unavailable = ScrapeError('not part of this test')
        with patch.object(observations, 'map_stops', return_value={}), \
                patch.object(observations, 'kenmore_gated', return_value=(gated, metadata, notes)), \
                patch.object(observations, 'rail_hourly', side_effect=unavailable), \
                patch.object(observations, 'bus_apc', side_effect=unavailable), \
                patch.object(observations, 'pedestrian_counts', side_effect=unavailable), \
                patch.object(observations, 'ctps_pedestrians', side_effect=unavailable):
            payload = observations.collect(None)
        self.assertEqual(payload['sources'][0]['pageProvenance'], metadata[0]['pageProvenance'])
        self.assertEqual(payload['transit'][0]['source'], payload['sources'][0]['id'])
        json.dumps(payload, allow_nan=False)


if __name__ == '__main__':
    unittest.main()
