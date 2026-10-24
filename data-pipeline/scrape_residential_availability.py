"""Extract dated residential capacity supported during construction phases."""

from datetime import date, timedelta
from pathlib import Path
import re

from common import ROOT, ScrapeError, main_content, run_cli
from scrape_dining import WARREN, publication_date

FAQ = 'https://www.bu.edu/cpo/warren-faq/'
PROJECT = 'https://www.bu.edu/cpo/project/warren-towers-renovation/'


def parse_warren(reopening, faq, project, week_start='2026-10-19'):
    start = date.fromisoformat(week_start)
    end = start + timedelta(days=6)
    # Fall-2026 reopening/relocation evidence was reviewed for these two weeks.
    # Later weeks need another phase review, not automatic indefinite recurrence.
    if start.weekday() != 0 or start < date(2026, 10, 19) or end > date(2026, 11, 1):
        raise ScrapeError('Residential phase evidence reviewed only for weeks of 2026-10-19 and 2026-10-26')
    article = main_content(reopening).get_text(' ', strip=True)
    relocation = main_content(faq).get_text(' ', strip=True)
    project_text = main_content(project).get_text(' ', strip=True)
    match = re.search(r'newly renovated Tower A houses (\d[\d,]*) students', article)
    displaced = re.search(r'For fall 2026, plans are to assign the (\d[\d,]*) students from Warren Towers \(B Tower\) to the Fenway Campus', relocation)
    if not match or not displaced or 'Tower A Reopens to Students' not in article:
        raise ScrapeError('Warren reopened tower or relocation evidence changed')
    if 'Tower C' not in project_text or 'fall semester of 2028' not in project_text:
        raise ScrapeError('Warren construction phase evidence changed')
    return {'locationId': 'warren', 'value': int(match[1].replace(',', '')), 'unit': 'bed-spaces',
            'basis': 'verified_reopened_component', 'coverage': 'partial', 'displayName': 'Warren Towers (Tower A)',
            'validFrom': start.isoformat(), 'validTo': end.isoformat(),
            'sourcePublishedDate': publication_date(reopening), 'sourceUrl': reopening.url,
            'sourceUrls': [reopening.url, faq.url, project.url],
            'components': [{'name': 'Tower A', 'capacity': int(match[1].replace(',', '')), 'status': 'reopened'},
                           {'name': 'Tower B', 'capacity': 0, 'status': 'students_relocated', 'relocatedStudents': int(displaced[1].replace(',', ''))},
                           {'name': 'Tower C', 'capacity': None, 'status': 'component_capacity_unverified'}],
            'note': 'Supported minimum for the reference week: reopened Tower A only. Tower B students are assigned to Fenway; Tower C is not counted without a verified component bed total. Capacity is not observed occupancy.'}


def collect(fetcher, week_start=None):
    sources = [fetcher.get(url) for url in (WARREN, FAQ, PROJECT)]
    if week_start is None:
        import json
        week_start = json.loads((ROOT.parent / 'map-client/public/data/campus-data.json').read_text())['referenceWeekStart']
    record = parse_warren(*sources, week_start=week_start)
    provenance = []
    for source in sources:
        item = source.provenance
        if item['rawPath']:
            item['rawPath'] = str(Path(item['rawPath']).relative_to(ROOT.parent))
        provenance.append(item)
    return {'records': [record], 'campusResidentMinimums': [{
        'campus': 'fenway', 'students': record['components'][1]['relocatedStudents'],
        'validFrom': record['validFrom'], 'validTo': record['validTo'],
        'basis': 'published_planned_relocation', 'sourceUrl': FAQ,
        'note': 'Model minimum based on the published Fall 2026 Tower B relocation plan; not observed attendance or assignment to a specific Fenway residence.'}],
        'sources': provenance, 'errors': []}


if __name__ == '__main__':
    run_cli('residential_availability', collect, lambda parser: parser.add_argument('--week-start', help='Monday of reviewed reference week; defaults to campus-data.json'))
