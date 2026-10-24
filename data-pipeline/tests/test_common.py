import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from common import Fetcher, ScrapeError, Source, envelope, write_json


class CommonTests(unittest.TestCase):
    def test_cached_body_is_verified_and_keeps_original_collection_date(self):
        with tempfile.TemporaryDirectory() as directory:
            url = 'https://www.bu.edu/example'
            key = hashlib.sha256(url.encode()).hexdigest()
            body = Path(directory) / f'{key}.body'
            body.write_bytes(b'original')
            source = Source(url, body.read_bytes(), '2020-01-01T00:00:00+00:00', cache_path=str(body))
            write_json(Path(directory) / f'{key}.json', source.provenance)
            with patch('urllib.request.urlopen', side_effect=AssertionError('network requested')):
                cached = Fetcher(directory, offline=True).get(url)
            self.assertEqual(cached.fetched_at, source.fetched_at)
            self.assertTrue(cached.cached)
            body.write_bytes(b'changed')
            with self.assertRaisesRegex(ScrapeError, 'checksum'):
                Fetcher(directory, offline=True).get(url)

    def test_missing_offline_source_does_not_attempt_network(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ScrapeError, 'No cached'):
                Fetcher(directory, offline=True).get('https://www.bu.edu/not-cached')

    def test_invalid_fetch_options_and_urls(self):
        with self.assertRaises(ScrapeError):
            Fetcher(offline=True, refresh=True)
        for url in ['file:///etc/passwd', 'https://user:password@www.bu.edu/']:
            with self.subTest(url=url), self.assertRaises(ScrapeError):
                Fetcher().get(url)

    def test_partial_output_is_labeled_and_json_is_atomic_on_serialization_error(self):
        self.assertEqual(envelope('example', {'errors': ['failed']})['status'], 'partial')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'data.json'
            write_json(path, {'value': 1})
            with self.assertRaises(ValueError):
                write_json(path, {'value': float('nan')})
            self.assertEqual(json.loads(path.read_text()), {'value': 1})


if __name__ == '__main__':
    unittest.main()
