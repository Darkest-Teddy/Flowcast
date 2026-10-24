"""Collect the published FitRec last-seven-days hourly visit table, not occupancy."""

import base64
from datetime import datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from common import ROOT, Source, ScrapeError, USER_AGENT, run_cli, soup, utc_now, write_json

SOURCE_URL = 'https://www.bu.edu/fitrec/peak-quiet-hours/'
VISUAL_NAME = '10be441cdb53888497cb'


def public_request(fetcher, url, resource_key, payload=None):
    """Cache public PowerBI GET/POST responses by the complete request identity."""
    body = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode() if payload is not None else None
    identity = json.dumps([url, resource_key, body.decode() if body else None])
    digest = hashlib.sha256(identity.encode()).hexdigest()
    raw = fetcher.cache_dir / f'{digest}.body'
    meta = fetcher.cache_dir / f'{digest}.json'
    if raw.exists() and meta.exists() and not fetcher.refresh:
        record = json.loads(meta.read_text())
        content = raw.read_bytes()
        if hashlib.sha256(content).hexdigest() != record['sha256']:
            raise ScrapeError('FitRec cache checksum mismatch')
        return Source(url, content, record['retrievedAt'], 'application/json', str(raw.resolve()), True)
    if fetcher.offline:
        raise ScrapeError(f'No cached FitRec response for {url}; run online first')
    for attempt in range(3):
        time.sleep(fetcher.delay if attempt == 0 else 2 ** attempt)
        try:
            request = urllib.request.Request(url, data=body, headers={
                'X-PowerBI-ResourceKey': resource_key, 'User-Agent': USER_AGENT,
                'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=fetcher.timeout) as response:
                content = response.read()
            if content[:2] == b'\x1f\x8b':
                content = gzip.decompress(content)
            json.loads(content)
            break
        except (urllib.error.URLError, OSError, ValueError) as error:
            if attempt == 2:
                raise ScrapeError(f'Cannot fetch published FitRec report: {error}') from error
    source = Source(url, content, utc_now(), 'application/json', str(raw.resolve()))
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_bytes(content)
    write_json(meta, source.provenance)
    return source


def published_query(metadata):
    matches = [visual for section in metadata['exploration']['sections']
               for visual in section.get('visualContainers', [])
               if json.loads(visual['config']).get('name') == VISUAL_NAME]
    if len(matches) != 1:
        raise ScrapeError('FitRec published hourly table changed')
    query = json.loads(matches[0]['query'])
    semantic = query['Commands'][0]['SemanticQueryDataShapeCommand']['Query']
    names = [item['Name'] for item in semantic['Select']]
    if names != ['Fact FitRec Visits.HourBlock', 'Fact FitRec Visits.Formatted short Visit Date', 'Fact FitRec Visits.Total Visits']:
        raise ScrapeError('FitRec hourly table columns changed')
    if "'Last Seven'" not in json.dumps(semantic.get('Where')):
        raise ScrapeError('FitRec last-seven-days filter missing')
    return query


def parse_observations(payload):
    try:
        results = payload['results']
        if len(results) != 1:
            raise ValueError('Expected one visual result')
        data = results[0]['result']['data']
        ds = data['dsr']['DS']
        if len(ds) != 1:
            raise ValueError('Expected one data shape')
        ds = ds[0]
        dates = ds['ValueDicts']['D0']
        hours = ds['ValueDicts']['D1']
        dates = [datetime.strptime(value, '%a, %m/%d/%y').date().isoformat() for value in dates]
        hours = [datetime.strptime(value, '%I:%M %p').hour for value in hours]
        if len(dates) != 7 or len(set(dates)) != 7 or len(set(hours)) != len(hours):
            raise ValueError('Expected seven distinct dates and distinct hours')
        if len(ds['PH']) != 1 or len(ds['SH']) != 1:
            raise ValueError('Unexpected pivot hierarchy')
        secondary = ds['SH'][0]['DM1']
        if [row['G1'] for row in secondary] != list(range(len(dates))):
            raise ValueError('Unexpected date dictionary ordering')
        observations = []
        seen = set()
        for row in ds['PH'][0]['DM0']:
            if set(row) - {'S', 'G0', 'X'}:
                raise ValueError('Unsupported compressed hour row')
            hour = hours[row['G0']]
            index = -1
            for cell in row['X']:
                if set(cell) - {'S', 'I', 'M0'}:
                    raise ValueError('Unsupported compressed measure cell')
                index = cell.get('I', index + 1)
                if not isinstance(index, int) or not 0 <= index < len(dates):
                    raise ValueError('Invalid pivot date index')
                if 'M0' not in cell or cell['M0'] is None:
                    continue
                value = cell['M0']
                if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                    raise ValueError('Invalid visit count')
                key = dates[index], hour
                if key in seen:
                    raise ValueError('Duplicate observation')
                seen.add(key)
                observations.append({'date': dates[index], 'hour': hour, 'visits': value})
        if not observations or {row['date'] for row in observations} != set(dates):
            raise ValueError('Missing daily observations')
        return sorted(observations, key=lambda row: (row['date'], row['hour']))
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise ScrapeError(f'Unsupported FitRec public table response: {error}') from error


def collect(fetcher):
    page = fetcher.get(SOURCE_URL)
    frames = [node['src'] for node in soup(page).select('iframe[src]')
              if urllib.parse.urlsplit(node['src']).hostname == 'app.powerbi.com']
    if len(frames) != 1:
        raise ScrapeError('Expected one public FitRec PowerBI report')
    embed = fetcher.get(frames[0])
    try:
        token = urllib.parse.parse_qs(urllib.parse.urlsplit(frames[0]).query)['r'][0]
        resource = json.loads(base64.b64decode(token + '=' * (-len(token) % 4)))['k']
        cluster = re.search(r"var resolvedClusterUri\s*=\s*'([^']+)'", embed.text)[1]
        host = urllib.parse.urlsplit(cluster).hostname
        if not host.endswith('.analysis.windows.net'):
            raise ValueError('Unexpected public PowerBI host')
        first, rest = host.split('.', 1)
        api = 'https://' + first.replace('-redirect', '').removeprefix('global-') + '-api.' + rest
        metadata_source = public_request(fetcher, f'{api}/public/reports/{resource}/modelsAndExploration?preferReadOnlySession=true', resource)
        metadata = json.loads(metadata_source.body)
        if len(metadata['models']) != 1:
            raise ValueError('Expected one public report model')
        model = metadata['models'][0]
        query = published_query(metadata)
        result_source = public_request(fetcher, f'{api}/public/reports/querydata', resource,
            {'version': '1.0.0', 'queries': [{'Query': query}], 'cancelQueries': [], 'modelId': model['id']})
        observations = parse_observations(json.loads(result_source.body))
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise ScrapeError(f'Cannot read published FitRec report: {error}') from error
    sources = []
    for source in (page, embed, metadata_source, result_source):
        provenance = source.provenance
        path = Path(provenance['rawPath'])
        if path.is_relative_to(ROOT.parent):
            provenance['rawPath'] = path.relative_to(ROOT.parent).as_posix()
        sources.append(provenance)
    return {'usage': {
        'sourceUrl': SOURCE_URL, 'reportUrl': frames[0], 'modelRefreshedAt': model['LastRefreshTime'],
        'metric': 'visits', 'periodStart': observations[0]['date'], 'periodEnd': observations[-1]['date'],
        'observations': observations,
        'limitations': 'Published hourly entry counts, not occupancy or unique visitors. Preserves the public report filters, including excluded gear and staff pass codes. Missing cells are unreported, not zero. A recent week is a timing profile, not a forecast of attendance.'},
        'sources': sources, 'errors': [], 'warnings': []}


if __name__ == '__main__':
    run_cli('fitrec_usage', collect)
