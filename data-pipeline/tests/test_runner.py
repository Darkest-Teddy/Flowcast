import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from common import ScrapeError
from scrape_population_data import run


class RunnerTests(unittest.TestCase):
    def test_failed_category_is_visible_without_losing_successful_categories(self):
        def load(name):
            if name == 'scrape_events':
                def fail(fetcher, **kwargs):
                    raise ScrapeError('source unavailable')
                return SimpleNamespace(collect=fail)
            return SimpleNamespace(collect=lambda fetcher, **kwargs: {'meetings': [{'id': 'one'}], 'sources': [], 'errors': []})
        with tempfile.TemporaryDirectory() as directory, patch('scrape_population_data.importlib.import_module', side_effect=load):
            manifest = run(object(), directory, ['catalog', 'events'])
            self.assertEqual(manifest['status'], 'partial')
            self.assertEqual([d['status'] for d in manifest['datasets']], ['ok','failed'])
            for item in manifest['datasets']:
                path = Path(directory) / item['path']
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item['sha256'])
            self.assertEqual(json.loads((Path(directory)/'events.json').read_text())['errors'], ['source unavailable'])


if __name__ == '__main__':
    unittest.main()
