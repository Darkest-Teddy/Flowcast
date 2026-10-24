"""Build course-component constraints from saved official registration instructions."""

import argparse
from collections import defaultdict
import json
from pathlib import Path
import re

from common import ROOT, Fetcher, ScrapeError, envelope, soup, write_json

CS_PAGES = {'CAS CS 111': 'https://cs-web.bu.edu/courses/cs111/',
            'CAS CS 237': 'https://cs-people.bu.edu/sofya/cs237/'}
LINKED = re.compile(r'(?:must|need to|should)\s+(?:also\s+)?(?:register|be registered).{0,180}(?:lecture|\blec\b|discussion|\bdis\b|\blab\b|both|two sections|same section)|register.{0,80}(?:two|three|both) sections', re.I)


def expand_sections(value):
    value = value.upper().replace('–', '-').replace('—', '-')
    if '-' not in value:
        return [value]
    start, end = value.split('-')
    a, b = re.fullmatch(r'([A-Z]+)([0-9A-Z])', start), re.fullmatch(r'([A-Z]+)([0-9A-Z])', end)
    if not a or not b or a[1] != b[1]:
        raise ValueError(f'Unsupported section range: {value}')
    alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    first, last = alphabet.index(a[2]), alphabet.index(b[2])
    if first > last:
        raise ValueError(f'Reversed section range: {value}')
    return [a[1] + char for char in alphabet[first:last+1]]


def parse_rule(course, rows, verified_lectures=None):
    notes = list(dict.fromkeys(row['notes'] for row in rows if row.get('notes')))
    relevant = [note for note in notes if LINKED.search(note) and not re.search(r'can register for both.+or just one', note, re.I)]
    if not relevant:
        return None
    sections = sorted({row['section'] for row in rows})
    rule = {'status': 'unresolved', 'components': [], 'dependencies': [], 'sourceUrls': sorted({row['provenance']['url'] for row in rows}),
            'notes': relevant, 'reason': 'Linked registration is explicit, but component choices or compatibility are not fully resolved.'}
    dependencies, lectures, discussions = [], set(), set()
    for row in rows:
        match = re.search(r'must be registered for LEC ([A-Z0-9]+) in order to enroll in this discussion section', row.get('notes') or '', re.I)
        if match:
            lectures.add(match[1].upper()); discussions.add(row['section'])
            dependency = {'section': row['section'], 'requires': [{'component': 'lecture', 'sections': [match[1].upper()]}]}
            if dependency not in dependencies:
                dependencies.append(dependency)
    if dependencies and all(section in lectures or section in discussions for section in sections):
        rule.update(status='resolved', components=[{'id': 'lecture', 'sections': sorted(lectures)},
                    {'id': 'discussion', 'sections': sorted(discussions)}], dependencies=dependencies, reason=None)
        return rule
    if verified_lectures and course in CS_PAGES and any(re.search(r'must register for two sections', note, re.I) for note in relevant):
        primary = sorted(set(verified_lectures) & set(sections))
        secondary = sorted(set(sections) - set(primary))
        if primary and secondary:
            component = 'lab' if course == 'CAS CS 111' else 'discussion'
            rule.update(status='resolved', components=[{'id': 'lecture', 'sections': primary}, {'id': component, 'sections': secondary}], reason=None,
                        classificationBasis='Official current course page identifies lecture section roster; catalog requires exactly one lecture and one other component. Remaining scheduled sections form that other component.')
            rule['sourceUrls'].append(CS_PAGES[course])
        return rule
    if course == 'CAS MA 123' and all('Discussion section B1-BC' in note for note in relevant):
        discussion = expand_sections('B1-BC')
        primary = sorted(set(sections) - set(discussion))
        if primary:
            rule.update(status='resolved', components=[{'id': 'primary', 'sections': primary}, {'id': 'discussion', 'sections': discussion}], reason=None,
                        classificationBasis='Catalog primary-section rows explicitly require a B1-BC discussion; no universal section-letter convention is used.')
        return rule
    pairs = []
    for note in relevant:
        match = re.search(r'registering for (?:CAS\s+)?MA\s*\d{3}\s+([A-Z][0-9A-Z]+) must also register for (?:a )?discussion [Ss]ection\s*\(?([A-Z][0-9A-Z](?:[-–][A-Z][0-9A-Z])?)', note, re.I)
        if match:
            pairs.append((match[1].upper(), expand_sections(match[2])))
    if pairs and len(pairs) == len(relevant):
        primary = sorted({main for main, _ in pairs})
        secondary = sorted({section for _, options in pairs for section in options})
        if set(sections).issubset(set(primary + secondary)) and not set(primary).intersection(secondary):
            rule.update(status='resolved', components=[{'id': 'primary', 'sections': primary}, {'id': 'discussion', 'sections': secondary}],
                dependencies=[{'section': main, 'requires': [{'component': 'discussion', 'sections': options}]} for main, options in pairs], reason=None)
            return rule
    # Only the explicit three-component grammar is expanded generically.
    for note in relevant:
        matches = re.findall(r'\b(lecture|discussion|lab) section:\s*(?:[A-Z]{2,}\s*\d{3}\s+)?([A-Z][0-9A-Z](?:[–-][A-Z][0-9A-Z])?)\b', note, re.I)
        if {role.lower() for role, _ in matches} == {'lecture', 'discussion', 'lab'} and len(matches) == 3:
            components = [{'id': role.lower(), 'sections': expand_sections(value)} for role, value in matches]
            if set(sections).issubset({section for item in components for section in item['sections']}):
                rule.update(status='resolved', components=components, reason=None)
                return rule
    return rule


def build(catalog, campus, verified_lectures=None):
    by_course = defaultdict(list)
    for row in catalog['meetings']:
        by_course[row['courseCode']].append(row)
    mapped = defaultdict(set)
    for location in campus['locations'].values():
        for meeting in location['meetings']:
            if not meeting['calendarRestricted']:
                mapped[meeting['courseCode']].add(meeting['section'])
    rules = {}
    for course, rows in sorted(by_course.items()):
        rule = parse_rule(course, rows, (verified_lectures or {}).get(course))
        if rule:
            rule['mappedCoverage'] = {component['id']: sorted(set(component['sections']) & mapped[course]) for component in rule['components']}
            rule['mappedCourse'] = bool(mapped[course])
            rule['hasCompleteMappedOption'] = rule['status'] == 'resolved' and all(rule['mappedCoverage'].values())
            rules[course] = rule
    return {'term': catalog['term'], 'courseComponentRules': rules,
            'coverage': {'linkedCourses': len(rules), 'resolved': sum(r['status'] == 'resolved' for r in rules.values()),
                         'unresolved': sum(r['status'] == 'unresolved' for r in rules.values()),
                         'mappedLinkedCourses': sum(r['mappedCourse'] for r in rules.values()),
                         'completeMappedCandidates': sum(r['hasCompleteMappedOption'] for r in rules.values())}, 'errors': []}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'output/course_component_rules.json')
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    fetcher = Fetcher(offline=args.offline)
    verified, sources = {}, []
    for course, url in CS_PAGES.items():
        source = fetcher.get(url)
        text = soup(source).get_text(' ', strip=True)
        if 'Fall 2026' not in text:
            raise ScrapeError(f'Course lecture verification is not Fall 2026: {url}')
        verified[course] = sorted(set(re.findall(r'\bsection (A\d)\b', text, re.I)))
        provenance = source.provenance
        if provenance['rawPath']:
            provenance['rawPath'] = str(Path(provenance['rawPath']).relative_to(ROOT.parent))
        sources.append(provenance)
    result = build(json.loads((ROOT / 'output/catalog.json').read_text()),
                   json.loads((ROOT.parent / 'map-client/public/data/campus-data.json').read_text()), verified)
    result['sources'] = sources
    write_json(args.output, envelope('course_component_rules', result))
    print(json.dumps(result['coverage']))


if __name__ == '__main__':
    main()
