import io
from pathlib import Path
import tempfile
from unittest import mock
import unittest
import zipfile

from common import ScrapeError, Source
from scrape_libraries import extract_section_rows, parse_counts, parse_hours, parse_workbook


def source(value):
    return Source("https://public.tableau.com/test", value if isinstance(value, bytes) else value.encode(),
                  "2026-10-24T12:00:00+00:00")


class LibraryTests(unittest.TestCase):
    def test_excludes_all_subtotals_and_preserves_measure(self):
        data = "Day of Week,Time (group) 1,Patron Count\nMonday,8:30am,106\nAll,8:30am,873\nMonday,All,3000\n"
        rows, skipped = parse_counts(source(data))
        self.assertEqual(skipped, 2)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["weekSecond"], 30600)
        self.assertEqual(rows[0]["value"], 106)
        self.assertIsNone(rows[0]["occupancy"])
        self.assertIsNone(rows[0]["observationDate"])

    def test_invalid_csv_does_not_silently_succeed(self):
        with self.assertRaises(ScrapeError):
            parse_counts(source("<html>Login</html>"))
        with self.assertRaises(ScrapeError):
            parse_counts(source("Day of Week,Time (group) 1,Patron Count\nMonday,8:30am,-1\n"))

    def test_twb_extension_can_be_zip_with_hyper(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as archive:
            archive.writestr("Counts.twb", """<workbook><column name="[Patron Count]"/>
                <connection update-time="03/02/2020 04:35:07 PM"/>
                <groupfilter level="[Semester]" member='&quot;Spr 2020&quot;'/></workbook>""")
            archive.writestr("Data/counts.hyper", b"not decoded")
        row = parse_workbook(source(data.getvalue()))
        self.assertEqual(row["hyperExtracts"], ["Data/counts.hyper"])
        self.assertFalse(row["hyperRowsExtracted"])
        self.assertEqual(row["workbooks"][0]["semesterMembers"], ["Spr 2020"])
        self.assertEqual(row["workbooks"][0]["fields"], ["Patron Count"])

    def test_hours_are_attached_to_dates(self):
        data = """<table><caption>Mugar hours</caption><thead><tr><th></th>
            <th><time datetime="2026-10-24">Oct 24</time></th></tr></thead><tbody>
            <tr><th>General Hours</th><td>8:00am - 11:00pm</td></tr></tbody></table>"""
        rows = parse_hours(source(data))
        self.assertEqual(rows[0]["date"], "2026-10-24")
        self.assertEqual(rows[0]["library"], "Mugar")
        self.assertEqual(rows[0]["hoursText"], "8:00am - 11:00pm")

    def test_no_hours_is_error(self):
        with self.assertRaises(ScrapeError):
            parse_hours(source("<p>Loading...</p>"))


class HyperTests(unittest.TestCase):
    def test_optional_dependency_has_clear_error(self):
        with mock.patch.dict("sys.modules", {"tableauhyperapi": None}):
            with self.assertRaisesRegex(ScrapeError, "requirements-hyper.txt"):
                extract_section_rows(source(b""))

    def test_extracts_distinct_section_measures_with_row_limit(self):
        try:
            from tableauhyperapi import (Connection, CreateMode, Date, HyperProcess,
                                         Inserter, SqlType, TableDefinition, TableName, Telemetry)
        except ImportError:
            self.skipTest("Optional tableauhyperapi is not installed")
        with tempfile.TemporaryDirectory(prefix="flowcast-test-hyper-") as temp:
            path = Path(temp) / "sections.hyper"
            with HyperProcess(Telemetry.DO_NOT_SEND_USAGE_DATA_TO_TABLEAU, parameters={"log_dir": temp}) as process:
                with Connection(process.endpoint, path, CreateMode.CREATE_AND_REPLACE) as connection:
                    connection.catalog.create_schema("Extract")
                    table = TableDefinition(TableName("Extract", "Extract"), [
                        TableDefinition.Column("Date (Patron Counts)", SqlType.date()),
                        TableDefinition.Column("Time", SqlType.text()),
                        TableDefinition.Column("F4", SqlType.text()),
                        TableDefinition.Column("Patron Count", SqlType.big_int()),
                        TableDefinition.Column("Gross Zone Count", SqlType.big_int()),
                    ])
                    connection.catalog.create_table(table)
                    with Inserter(connection, table) as inserter:
                        inserter.add_rows([[Date(2019, 6, 18), "9:30am", "Desk", 2, 1],
                                           [Date(2019, 6, 18), "9:30am", "Desk", 2, 1],
                                           [Date(2019, 6, 19), "10:30am", "Stacks", 4, 2]])
                        inserter.execute()
            archive_bytes = io.BytesIO()
            with zipfile.ZipFile(archive_bytes, "w") as archive:
                archive.writestr("Data/sections.hyper", path.read_bytes())
            result = extract_section_rows(source(archive_bytes.getvalue()), max_rows=1)
        table = result["tables"][0]
        self.assertEqual(table["availableRows"], 2)
        self.assertEqual(len(table["rows"]), 1)
        self.assertTrue(table["truncated"])
        self.assertEqual(table["rows"][0]["Date (Patron Counts)"], "2019-06-18")
        self.assertEqual(table["rows"][0]["Gross Zone Count"], 1)
        self.assertIsNone(result["occupancy"])


if __name__ == "__main__":
    unittest.main()
