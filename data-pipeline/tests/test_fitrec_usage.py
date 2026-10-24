import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import Fetcher, ScrapeError
from scrape_fitrec_usage import parse_observations, public_request


def response():
    return {'results': [{'result': {'data': {'dsr': {'DS': [{
        'ValueDicts': {'D0': [f'{day}, 10/{17+i}/26' for i, day in enumerate(['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'])],
                       'D1': ['5:00 AM', '12:00 PM', '10:00 PM']},
        'SH': [{'DM1': [{'G1': i} for i in range(7)]}],
        'PH': [{'DM0': [
            {'G0': 0, 'X': [{'S': []}, {'I': 2, 'M0': 16}, {'M0': 5}]},
            {'G0': 1, 'X': [{'M0': 100+i} for i in range(7)]},
            {'G0': 2, 'X': [{'I': 5, 'M0': 0}]}]}]
    }]}}}}]}


class FitRecTests(unittest.TestCase):
    def test_sparse_indices_missing_cells_and_zero(self):
        rows = parse_observations(response())
        self.assertEqual(len(rows), 10)
        self.assertIn({'date': '2026-10-19', 'hour': 5, 'visits': 16}, rows)
        self.assertIn({'date': '2026-10-20', 'hour': 5, 'visits': 5}, rows)
        self.assertIn({'date': '2026-10-22', 'hour': 22, 'visits': 0}, rows)
        self.assertNotIn({'date': '2026-10-17', 'hour': 5, 'visits': 0}, rows)

    def test_unknown_compression_fails_closed(self):
        payload = response()
        payload['results'][0]['result']['data']['dsr']['DS'][0]['PH'][0]['DM0'][0]['X'][0]['R'] = 1
        with self.assertRaises(ScrapeError):
            parse_observations(payload)

    def test_negative_counts_rejected(self):
        payload = response()
        payload['results'][0]['result']['data']['dsr']['DS'][0]['PH'][0]['DM0'][1]['X'][0]['M0'] = -1
        with self.assertRaises(ScrapeError):
            parse_observations(payload)

    def test_cache_replay_and_request_identity(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'{"results":[]}'
        with tempfile.TemporaryDirectory() as directory:
            with patch('urllib.request.urlopen', return_value=Response()) as fetch:
                first = public_request(Fetcher(cache_dir=directory, delay=0), 'https://example.com/query', 'public-key', {'a': 1})
                self.assertEqual(fetch.call_count, 1)
            with patch('urllib.request.urlopen', side_effect=AssertionError('Network used offline')):
                replay = public_request(Fetcher(cache_dir=directory, offline=True), 'https://example.com/query', 'public-key', {'a': 1})
                self.assertEqual(first.body, replay.body)
                self.assertEqual(first.fetched_at, replay.fetched_at)
                self.assertTrue(replay.cached)
                with self.assertRaises(ScrapeError):
                    public_request(Fetcher(cache_dir=directory, offline=True), 'https://example.com/query', 'public-key', {'a': 2})
            Path(first.cache_path).write_bytes(b'corrupted')
            with self.assertRaises(ScrapeError):
                public_request(Fetcher(cache_dir=directory, offline=True), 'https://example.com/query', 'public-key', {'a': 1})


if __name__ == '__main__':
    unittest.main()
