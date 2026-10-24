import json
from pathlib import Path
import unittest

from build_component_rules import build, parse_rule, expand_sections

ROOT = Path(__file__).resolve().parents[1]


def row(section, note=None):
    return {'section': section, 'notes': note, 'provenance': {'url': 'https://www.bu.edu/example/'}}


class ComponentRuleTests(unittest.TestCase):
    def test_explicit_discussion_requires_its_own_lecture(self):
        rule = parse_rule('CAS EC 101', [row('AA'), row('BB'),
            row('A0', 'You must be registered for LEC AA in order to enroll in this discussion section.'),
            row('B0', 'You must be registered for LEC BB in order to enroll in this discussion section.')])
        self.assertEqual(rule['status'], 'resolved')
        self.assertEqual(rule['dependencies'][1]['requires'][0]['sections'], ['BB'])

    def test_ambiguous_letters_are_not_treated_as_universal_components(self):
        note = 'Students registering must register for two sections: a Lecture section and a Lab section.'
        rule = parse_rule('CAS XX 200', [row('A1', note), row('B1')])
        self.assertEqual(rule['status'], 'unresolved')
        self.assertEqual(rule['components'], [])
        self.assertIsNone(parse_rule('QST ES 090', [row('A1', 'Students can register for both sections or just one.')]))
        self.assertIsNone(parse_rule('COM CM 501', [row('A1', 'Undergraduate students must have sophomore standing to register.')]))

    def test_explicit_primary_discussion_choices_keep_dependencies(self):
        rule = parse_rule('CAS MA 115', [row('C1', 'Students registering for MA115 C1 must also register for a discussion section C2-C3.'), row('C2'), row('C3'),
            row('E1', 'Students registering for MA115 E1 must also register for a discussion section E2-E3.'), row('E2'), row('E3')])
        self.assertEqual(rule['status'], 'resolved')
        self.assertEqual(rule['dependencies'][0]['requires'][0]['sections'], ['C2', 'C3'])
        self.assertEqual(expand_sections('B1-BC'), ['B1','B2','B3','B4','B5','B6','B7','B8','B9','BA','BB','BC'])

    def test_real_six_course_requirements_keep_unmapped_essential_components(self):
        catalog = json.loads((ROOT / 'output/catalog.json').read_text())
        campus = json.loads((ROOT.parent / 'map-client/public/data/campus-data.json').read_text())
        result = build(catalog, campus, {'CAS CS 111': ['A1','A2','A4'], 'CAS CS 237': ['A1','A2']})
        rules = result['courseComponentRules']
        for course in ['CAS CS 111','CAS CS 237','CAS MA 213','CAS MA 123','CAS EC 101','CAS EC 102']:
            self.assertEqual(rules[course]['status'], 'resolved', course)
        self.assertEqual(len(rules['CAS MA 213']['components']), 3)
        self.assertTrue(rules['CAS CS 111']['hasCompleteMappedOption'])
        # Their lectures meet in STO and MOR, which are now mapped teaching buildings.
        for course in ['CAS MA 123','CAS EC 101','CAS EC 102']:
            self.assertTrue(rules[course]['hasCompleteMappedOption'], course)
            primary = rules[course]['components'][0]
            self.assertEqual(rules[course]['mappedCoverage'][primary['id']], primary['sections'])
