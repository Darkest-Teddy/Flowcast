"""Extract dated residential capacity supported during construction phases."""

from pathlib import Path
import re

from common import ROOT, ScrapeError, main_content, run_cli
from scrape_dining import WARREN, publication_date

FAQ = 'https://www.bu.edu/cpo/warren-faq/'
PROJECT = 'https://www.bu.edu/cpo/project/warren-towers-renovation/'


def parse_warren(reopening, faq, project):
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
            'validFrom': '2026-10-19', 'validTo': '2026-10-25',
            'sourcePublishedDate': publication_date(reopening), 'sourceUrl': reopening.url,
            'sourceUrls': [reopening.url, faq.url, project.url],
            'components': [{'name': 'Tower A', 'capacity': int(match[1].replace(',', '')), 'status': 'reopened'},
                           {'name': 'Tower B', 'capacity': 0, 'status': 'students_relocated', 'relocatedStudents': int(displaced[1].replace(',', ''))},
                           {'name': 'Tower C', 'capacity': None, 'status': 'component_capacity_unverified'}],
            'note': 'Supported minimum for the reference week: reopened Tower A only. Tower B students are assigned to Fenway; Tower C is not counted without a verified component bed total. Capacity is not observed occupancy.'}


def collect(fetcher):
    sources = [fetcher.get(url) for url in (WARREN, FAQ, PROJECT)]
    record = parse_warren(*sources)
    provenance = []
    for source in sources:
        item = source.provenance
        if item['rawPath']:
            item['rawPath'] = str(Path(item['rawPath']).relative_to(ROOT.parent))
        provenance.append(item)
    return {'records': [record], 'sources': provenance, 'errors': []}


if __name__ == '__main__':
    run_cli('residential_availability', collect)
