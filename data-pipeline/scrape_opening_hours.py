"""Audit mapped optional venues against official BU service-hour publications."""

from datetime import date, datetime, timedelta
import json
from pathlib import Path
import re
from urllib.parse import urlsplit, urljoin, parse_qs

from bs4 import BeautifulSoup
from common import ROOT, ScrapeError, run_cli, soup, utc_now
from build_map_data import hour_windows
from scrape_libraries import parse_hours, HOURS_URL

FITREC = 'https://www.bu.edu/fitrec/visit-us/hours/'
MEDICAL = 'https://www.bumc.bu.edu/medlib/about/hours/'
CHEQUERS = 'https://www.bumc.bu.edu/chequers/'
SPORTS = 'https://www.bu.edu/admissions/why-bu/student-life/sports-fitness/'
DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
LAW_LIBRARY = 'https://www.bu.edu/law/libraries/'
DINING = {'warren-dining': ['warren'], 'west-dining': ['west'], 'marciano': ['marciano'],
          'fenway-dining': ['fenway'], 'gsu': ['urban-table-at-the-gsu', 'panda-express', 'basho-sushi-at-the-gsu', 'the-halal-shack'],
          'breadwinners': ['breadwinners'], 'saxbys': ['saxbys'], 'einstein-bagels': ['einsteins-brothers-bagels'],
          'buick-street-market': ['buick-street-market'], 'fullers-pub': ['fullersbupub'], 'after-hours-west': ['afterhourswest']}
# Library names on the BU Libraries hours page, by map location.
LIBRARIES = {'mugar': 'Mugar Library', 'pardee': 'Pardee Management Library', 'sel': 'Science & Engineering Library',
             'stone-library': 'Stone Science Library', 'theology-library': 'Theology Library',
             'african-studies-library': 'African Studies Library', 'music-library': 'Music Library',
             'pickering-library': 'Pickering Educational Resources Library', 'astronomy-library': 'Astronomy Library'}


def entry(source, text, windows, **scope):
    return {'date': None, 'windows': windows, 'text': text, 'sourceUrl': source.url, 'qualifier': None, **scope}


def dated_label(label, anchor):
    label = re.sub(r'(\d+)(?:st|nd|rd|th)', r'\1', label)
    weekday, monthday = label.split(', ', 1)
    options = [datetime.strptime(f'{monthday}, {year}', '%B %d, %Y').date() for year in (anchor.year-1, anchor.year, anchor.year+1)]
    chosen = min(options, key=lambda d: abs((d-anchor).days))
    if DAYS[chosen.weekday()] != weekday or abs((chosen-anchor).days) > 185:
        raise ScrapeError(f'Ambiguous service date {label}')
    return chosen.isoformat()


def parse_dining(source):
    # Menus contain megabytes of nutrition markup; hours precede that content.
    page = BeautifulSoup(source.text.split('js-menu-bydate', 1)[0], 'html.parser')
    container = page.select_one('.location-single-hours')
    if not container:
        return []
    anchor = date.fromisoformat(source.fetched_at[:10])
    records = []
    for heading in container.select('.location-single-hours-day'):
        block = heading.find_next_sibling('ol')
        if block is None:
            raise ScrapeError('Dining service date missing its hours list')
        text = block.get_text(' ', strip=True)
        windows = [w for node in block.select('.daygroup-times') for w in hour_windows(node.get_text(' ', strip=True))]
        if not windows and not re.search(r'\bclosed\b', text, re.I):
            raise ScrapeError(f'Unrecognized dining hours: {text}')
        records.append(entry(source, text, windows, date=dated_label(heading.get_text(' ', strip=True), anchor)))
    return records


def format_windows(windows):
    clock = lambda value: f'{value // 3600:02d}:{value % 3600 // 60:02d}'
    return ', '.join(f'{clock(a)}–{clock(b)}' for a, b in windows) or 'Closed'


def parse_fenway_provider(source, week_start='2026-10-19'):
    script = next((node.string for node in soup(source).select('script')
                   if 'window.__PRELOADED_STATE__ =' in (node.string or '')), None)
    if script is None:
        raise ScrapeError('Fenway provider state missing')
    state = json.JSONDecoder().raw_decode(script.split('window.__PRELOADED_STATE__ =', 1)[1].strip())[0]
    matches = []
    def visit(value):
        if isinstance(value, dict):
            if value.get('slug') == 'the-fenway-dining-hall':
                matches.append(value)
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(state)
    if len(matches) != 1:
        raise ScrapeError('Fenway dining hall identity is ambiguous')
    schedule = matches[0]['openingHours']
    def seconds(value):
        hour, minute = int(value['hour']), int(value['minute'])
        if not 1 <= hour <= 12 or not 0 <= minute < 60 or value['period'] not in ('AM', 'PM'):
            raise ScrapeError('Invalid provider clock')
        return ((hour % 12) + (12 if value['period'] == 'PM' else 0)) * 3600 + minute * 60
    hours = []
    for offset in range(7):
        day = date.fromisoformat(week_start) + timedelta(days=offset)
        exceptions = [period for period in schedule.get('seasonalHours', [])
                      if period['from'][:10] <= day.isoformat() <= period['to'][:10]]
        if len(exceptions) > 1:
            raise ScrapeError('Overlapping Fenway seasonal hours')
        rows = exceptions[0]['openingHours'] if exceptions else schedule['standardHours']
        windows, labels, found = [], [], False
        for row in rows:
            if row['days'] and not any(d['value'] == DAYS[day.weekday()] for d in row['days']):
                continue
            found = True
            for span in row['hours']:
                if span.get('allDay'):
                    windows.append([0, 86400])
                elif span.get('startTime') and span.get('finishTime'):
                    a, b = seconds(span['startTime']), seconds(span['finishTime'])
                    windows.append([a, b + (86400 if b <= a else 0)])
                elif span.get('startTime') or span.get('finishTime'):
                    raise ScrapeError('Incomplete Fenway time range')
                if span.get('label'):
                    labels.append(span['label'])
        if not found:
            raise ScrapeError(f'Fenway schedule omits {day}')
        hours.append(entry(source, format_windows(windows), windows, date=day.isoformat(),
            qualifier='Official BU-linked dining provider; regular hours with seasonal overrides. Meal stations vary by service period.',
            servicePeriods=labels))
    return hours


def law_library_hours(source, valid_from, valid_to, qualifier):
    """The law libraries' 'Fall Hours' (weekdays, weekend) as weekly rows for one stated week only."""
    text = soup(source).get_text(' ', strip=True)
    match = re.search(r'Fall Hours\s+Monday\s*-\s*Friday\s+(.+?)\s+Saturday\s*-\s*Sunday\s+(.+?)(?=\s+We|$)', text)
    if not match:
        raise ScrapeError('Law library fall hours missing')
    rows = []
    for label, times, days in [('Monday - Friday', match[1], range(5)), ('Saturday - Sunday', match[2], (5, 6))]:
        windows = hour_windows(times)
        if not windows:
            raise ScrapeError(f'Law library hours unrecognized: {times}')
        rows += [entry(source, f'{label} {times}', windows, weekday=day, validFrom=valid_from, validTo=valid_to, qualifier=qualifier) for day in days]
    return rows


def fitrec_section(source, section):
    span = section.select_one('.effective-range-title').get_text(' ', strip=True)
    start, end = [datetime.strptime(t.strip(), '%B %d, %Y').date().isoformat() for t in span.split(' - ')]
    records = []
    def windows(row):
        values = [n['datetime'] for n in row.select('time[datetime]')]
        if len(values) % 2:
            raise ScrapeError('Unpaired facility opening and closing times')
        seconds = [sum(int(x) * factor for x, factor in zip(v.split(':'), [3600, 60])) for v in values]
        if not values and 'Closed' not in row.get_text():
            raise ScrapeError('Unrecognized facility exception')
        return [[a, b + (86400 if b <= a else 0)] for a, b in zip(seconds[::2], seconds[1::2])]
    for row in section.select('.hoo-item'):
        day = row.select_one('.facility-event-label').get_text(' ', strip=True)
        records.append(entry(source, row.get_text(' ', strip=True), windows(row), weekday=DAYS.index(day), validFrom=start, validTo=end))
    for row in section.select('.calendar-item'):
        label = row.select_one('.facility-event-label').get_text(' ', strip=True)
        records.append(entry(source, row.get_text(' ', strip=True), windows(row), date=dated_label(label, date.fromisoformat(start)), validFrom=start, validTo=end))
    return records


def parse_fitrec(source):
    page = soup(source)
    main = page.select_one('.fitrec-hours-post .facility-hours')
    fenway = next((h.find_parent(class_='bu_collapsible_container').select_one('.facility-hours') for h in page.select('h3.bu_collapsible') if h.get_text(strip=True) == 'Fitness at Fenway'), None)
    if not main or not fenway:
        raise ScrapeError('FitRec facility sections changed')
    return {'fitrec': fitrec_section(source, main), 'fenway-fitness': fitrec_section(source, fenway)}


def portable(source):
    value = source.provenance
    if value['rawPath']:
        value['rawPath'] = str(Path(value['rawPath']).relative_to(ROOT.parent))
    return value


def collect(fetcher):
    """Collect actual dated or explicitly weekly hours for every mapped optional venue."""
    mapped = json.loads((ROOT.parent / 'map-client/public/data/demo-day.json').read_text())
    locations = {l['id']: {'locationId': l['id'], 'status': 'unknown', 'hours': [], 'reason': 'No verified service schedule', 'sources': []}
                 for l in mapped['locations'] if l['kind'] in ('dining', 'library', 'gym')}
    sources, errors = [], []
    def fetch(url):
        source = fetcher.get(url)
        sources.append(portable(source))
        return source
    def publish(key, hours, urls, reason=None):
        locations[key].update(status='published' if hours else 'unknown', hours=hours, sources=urls, reason=reason)
    for key, slugs in DINING.items():
        records, urls = [], []
        for slug in slugs:
            url = f'https://www.bu.edu/dining/location/{slug}/'
            try:
                source = fetch(url)
                urls.append(url)
                provider = key == 'fenway-dining' and urlsplit(source.url).hostname == 'bufenway.sodexomyway.com'
                if not provider and not urlsplit(source.url).hostname.endswith('bu.edu'):
                    continue
                for hour in (parse_fenway_provider(source) if provider else parse_dining(source)):
                    if not provider:
                        hour['qualifier'] = f'Meal service: {slug}; hours are dated, not a recurring weekly schedule.'
                    records.append(hour)
            except ScrapeError as exc:
                errors.append(str(exc))
        # GSU records describe specific meal vendors; union overlapping service windows per date.
        combined = {}
        for record in records:
            day = record['date']
            current = combined.setdefault(day, {**record, 'windows': [], 'serviceSourceUrls': []})
            current['windows'].extend(record['windows'])
            current['serviceSourceUrls'].append(record['sourceUrl'])
        for record in combined.values():
            merged = []
            for start, end in sorted(record['windows']):
                if merged and start <= merged[-1][1]:
                    merged[-1][1] = max(merged[-1][1], end)
                else:
                    merged.append([start, end])
            record['windows'] = merged
            if key == 'gsu':
                record['qualifier'] = 'Union of four meal vendors; partial service coverage, not the entire food hall or full capacity.'
                record['text'] = format_windows(merged)
        publish(key, list(combined.values()), urls, 'Meal-vendor coverage only; no whole-hall capacity inference' if key == 'gsu' else ('Official BU link redirects to an external dining provider without usable server-rendered hours' if not records else None))
    try:
        source = fetch(FITREC)
        for key, hours in parse_fitrec(source).items():
            publish(key, hours, [FITREC])
    except ScrapeError as exc:
        errors.append(str(exc))
    try:
        source = fetch(HOURS_URL)
        rows = parse_hours(source)
        library_urls = [HOURS_URL]
        for link in soup(source).select('a[href]'):
            target = urljoin(source.url, link['href'])
            if urlsplit(target).hostname == 'www.bu.edu' and parse_qs(urlsplit(target).query).get('week') == ['2026-10-25']:
                extra = fetch(target)
                rows.extend(parse_hours(extra))
                library_urls.append(target)
                break
        for key, name in LIBRARIES.items():
            if key not in locations:
                continue
            hours = [{**entry(source, r['hoursText'], hour_windows(r['hoursText']), date=r['date']), 'sourceUrl': r['provenance']['url']}
                     for r in rows if r['library'] == name and r['service'] == 'General Hours']
            publish(key, hours, library_urls)
    except ScrapeError as exc:
        errors.append(str(exc))
    try:
        source = fetch(CHEQUERS)
        text = soup(source).get_text(' ', strip=True)
        match = re.search(r'open weekdays from (.+?) and offers', text)
        if not match:
            raise ScrapeError('Chequers weekday schedule missing')
        windows = hour_windows(match[1].replace('.', ''))
        if not windows:
            raise ScrapeError('Chequers time range not parsed')
        publish('bumc-chequers', [entry(source, match[0], windows, weekday=d, validFrom='2026-10-19', validTo='2026-10-25', qualifier='Published weekday schedule applied only to reference week; holiday exceptions not supplied') for d in range(5)], [CHEQUERS])
    except ScrapeError as exc:
        errors.append(str(exc))
    try:
        if 'law-library' in locations:
            source = fetch(LAW_LIBRARY)
            publish('law-library', law_library_hours(source, '2026-10-19', '2026-10-25',
                'Published fall schedule applied only to reference week; holiday exceptions not supplied'), [LAW_LIBRARY])
    except ScrapeError as exc:
        errors.append(str(exc))
    try:
        source = fetch(MEDICAL)
        text = soup(source).get_text(' ', strip=True).split('Library Hours', 1)[1].split('L1101', 1)[0]
        matches = re.findall(r'(Monday\s*[–-]\s*Friday|Saturday\s*[–-]\s*Sunday)\s*[–-]\s*(.+?)(?=Saturday|$)', text)
        hours = []
        for label, times in matches:
            windows = hour_windows(times.replace('.', ''))
            if not windows:
                raise ScrapeError('Medical library time range not parsed')
            for day in (range(5) if label.startswith('Monday') else (5, 6)):
                hours.append(entry(source, f'{label} {times}', windows, weekday=day,
                    validFrom='2026-10-19', validTo='2026-10-25', qualifier='Regular schedule applied only to reference week; published holiday closures must be resolved before extending'))
        if len(hours) != 7:
            raise ScrapeError('Medical library weekday schedule incomplete')
        publish('bumc-library', hours, [MEDICAL])
    except ScrapeError as exc:
        errors.append(str(exc))
    try:
        source = fetch(SPORTS)
        text = soup(source).get_text(' ', strip=True)
        for key, token, reason in [('agganis', 'multipurpose sports and entertainment center', 'Event arena; no published general recreation access'),
                                   ('dewolfe', 'home of the BU men’s and women’s crew teams', 'Crew-team boathouse; no published general recreation access')]:
            if token not in text:
                raise ScrapeError(f'Facility use evidence changed: {key}')
            locations[key].update(status='restricted', reason=reason, sources=[SPORTS])
    except ScrapeError as exc:
        errors.append(str(exc))
    return {'collectedAt': utc_now(), 'locations': list(locations.values()), 'sources': sources,
            'coverage': {status: sum(l['status'] == status for l in locations.values()) for status in ['published', 'unknown', 'restricted']}, 'errors': errors}


if __name__ == '__main__':
    run_cli('opening_hours', collect)
