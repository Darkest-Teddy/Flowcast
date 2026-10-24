import hashlib
from concurrent.futures import ThreadPoolExecutor
import time
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

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

    def test_concurrent_workers_share_the_host_request_interval(self):
        starts = []
        class Response:
            headers = {'Content-Type': 'text/plain'}
            def __init__(self, url): self.url = url
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self): return b'public source'
        def respond(request, timeout):
            starts.append(time.monotonic())
            return Response(request.full_url)
        with tempfile.TemporaryDirectory() as directory, patch('urllib.request.urlopen', side_effect=respond):
            fetcher = Fetcher(directory, delay=0.02)
            with ThreadPoolExecutor(max_workers=4) as pool:
                responses = list(pool.map(fetcher.get, ['https://www.bu.edu/test-'+str(i) for i in range(6)]))
            self.assertEqual(len(responses), 6)
        starts.sort()
        self.assertTrue(all(b-a >= 0.018 for a,b in zip(starts, starts[1:])))

    def test_refresh_reuses_disk_after_response_is_evicted_from_memory(self):
        class Response:
            headers = {'Content-Type': 'text/plain'}
            def __init__(self, url): self.url = url
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self): return b'public source'
        with tempfile.TemporaryDirectory() as directory, patch('urllib.request.urlopen', side_effect=lambda request, timeout: Response(request.full_url)) as request:
            fetcher = Fetcher(directory, refresh=True, delay=0)
            for i in range(129):
                fetcher.get('https://www.bu.edu/test-'+str(i))
            cached = fetcher.get('https://www.bu.edu/test-0')
            self.assertTrue(cached.cached)
            self.assertEqual(request.call_count, 129)
            self.assertLessEqual(len(fetcher.responses), 128)

    def test_rate_limit_honors_retry_after_and_slows_all_workers(self):
        class Response:
            headers = {'Content-Type': 'text/plain'}
            url = 'https://www.bu.edu/limited'
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self): return b'public source'
        error = HTTPError(Response.url,429,'limited',{'Retry-After':'120'},None)
        with tempfile.TemporaryDirectory() as directory, patch('urllib.request.urlopen',side_effect=[error,Response()]), patch('common.time.sleep') as sleep:
            fetcher = Fetcher(directory,delay=0.25)
            fetcher.get(Response.url)
            self.assertEqual(fetcher.rate_limit_count,1)
            self.assertGreaterEqual(fetcher.delay,1)
            self.assertTrue(any(call.args[0] >= 120 for call in sleep.call_args_list))
            self.assertIn('www.bu.edu',fetcher.host_backoff)

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
