"""Download STH's historical counts/workbooks and date-specific BU library hours."""

import csv
import hashlib
import io
import math
from pathlib import Path
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime

from common import ScrapeError, run_cli, soup

CSV_URL = "https://public.tableau.com/views/GateCountsbyTimeofDay/STHLibraryCountsandQuestionsbyTimeofDay.csv?:showVizHome=no"
WORKBOOK_URLS = ["https://public.tableau.com/workbooks/GateCountsbyTimeofDay.twb",
                 "https://public.tableau.com/workbooks/STHLibraryUsagebySection.twb"]
HOURS_URL = "https://www.bu.edu/library/visit-study/hours/"
DAYS = {name: index for index, name in enumerate(
    ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])}


def parse_counts(source):
    reader = csv.DictReader(io.StringIO(source.text.lstrip("\ufeff")))
    required = {"Day of Week", "Time (group) 1", "Patron Count"}
    if not required.issubset(reader.fieldnames or []):
        raise ScrapeError(f"Missing expected Tableau CSV headers: {source.url}")
    records, subtotals = [], 0
    for index, row in enumerate(reader, start=2):
        day = row["Day of Week"].strip()
        clock = row["Time (group) 1"].strip()
        if day.casefold() == "all" or clock.casefold() == "all":
            subtotals += 1
            continue
        try:
            if day not in DAYS:
                raise ValueError(f"unknown weekday {day}")
            parsed_time = datetime.strptime(clock.replace(" ", "").lower(), "%I:%M%p")
            value = int(row["Patron Count"].replace(",", ""))
            if value < 0:
                raise ValueError("negative count")
        except ValueError as error:
            raise ScrapeError(f"Invalid Tableau CSV row {index}: {error}") from error
        minute = parsed_time.hour * 60 + parsed_time.minute
        records.append({
            "id": f"sth-patrons:{DAYS[day]}:{minute}",
            "library": "School of Theology Library", "locationId": None, "locationResolution": "unresolved",
            "weekday": DAYS[day],
            "weekdayName": day, "timeLocal": parsed_time.strftime("%H:%M"),
            "weekSecond": DAYS[day] * 86400 + minute * 60,
            "value": value, "unit": "historical_patron_count", "measure": "patron_count",
            "observationDate": None, "observationPeriod": "See workbook metadata; CSV does not expose observation dates",
            "countingMethod": "unknown", "occupancy": None,
            "provenance": source.provenance,
        })
    if not records:
        raise ScrapeError("Tableau CSV contains no non-subtotal patron counts")
    return records, subtotals


def parse_workbook(source):
    body = source.body
    members, workbooks = [], []
    if zipfile.is_zipfile(io.BytesIO(body)):
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            members = archive.namelist()
            xml_members = [name for name in members if name.lower().endswith(".twb")]
            for name in xml_members:
                info = archive.getinfo(name)
                if info.file_size > 20_000_000:
                    raise ScrapeError("Workbook XML exceeds the 20 MB inspection limit")
                workbooks.append((name, archive.read(name)))
    else:
        workbooks.append((source.url.rsplit("/", 1)[-1], body))
    if not workbooks:
        raise ScrapeError(f"Downloaded workbook has no TWB XML: {source.url}")
    metadata = []
    for name, xml in workbooks:
        try:
            root = ET.fromstring(xml)
        except ET.ParseError as error:
            raise ScrapeError(f"Invalid Tableau workbook XML at {source.url}") from error
        if root.tag != "workbook":
            raise ScrapeError(f"Expected Tableau workbook XML at {source.url}")
        fields = sorted({column.get("caption") or column.get("name", "").strip("[]")
                         for column in root.iter("column") if column.get("name")})
        extract_updates = sorted({connection.get("update-time")
                                  for connection in root.iter("connection") if connection.get("update-time")})
        refresh_times = sorted({event.get("timestamp-start")
                                for event in root.iter("refresh-event") if event.get("timestamp-start")})
        semester_members = sorted({node.get("member", "").strip('"') for node in root.iter("groupfilter")
                                   if "Semester" in node.get("level", "") and node.get("member")})
        metadata.append({"name": name, "fields": fields, "extractUpdateTimes": extract_updates,
                         "refreshTimestamps": refresh_times, "semesterMembers": semester_members})
    return {"id": "tableau:" + source.url.rsplit("/", 1)[-1],
            "members": members, "workbooks": metadata,
            "hyperExtracts": [name for name in members if name.lower().endswith(".hyper")],
            "hyperRowsExtracted": False,
            "limitations": ["Raw workbook is retained in the HTTP cache; Hyper rows are not decoded.",
                            "Extract refresh/publication dates do not establish the observation period."],
            "provenance": source.provenance}


def extract_section_rows(source, max_rows=20000):
    """Read dated section measures from a downloaded workbook, using a readonly Hyper copy."""
    try:
        from tableauhyperapi import Connection, HyperException, HyperProcess, Telemetry
    except ImportError as error:
        raise ScrapeError("--extract-hyper requires pip install -r data-pipeline/requirements-hyper.txt") from error
    if not 1 <= max_rows <= 100000:
        raise ScrapeError("--max-hyper-rows must be between 1 and 100000")
    if not zipfile.is_zipfile(io.BytesIO(source.body)):
        raise ScrapeError(f"No packaged Hyper extract at {source.url}")
    units = {
        "Day of Week": "weekday_label", "Date (Patron Counts)": "observation_date",
        "Time": "local_time_label", "F4": "library_section_label",
        "Gross Zone Count": "historical_zone_count", "Patron Count": "historical_patron_count",
        "Total Seat Availability in Library": "seats",
        "Overall Seat Availability For That Section": "seats",
        "Zone Capacity Percentage": "source_percentage_value",
        "Zone Percentage of overall library count": "source_percentage_value",
        "Library Capacity Percentage (Patron Count/Total Seat Availability in library)": "source_percentage_value",
    }
    tables = []
    try:
        with zipfile.ZipFile(io.BytesIO(source.body)) as archive, tempfile.TemporaryDirectory(prefix="flowcast-hyper-") as temp:
            members = [entry for entry in archive.infolist() if entry.filename.lower().endswith(".hyper")]
            if not members:
                raise ScrapeError(f"No Hyper member in workbook at {source.url}")
            with HyperProcess(Telemetry.DO_NOT_SEND_USAGE_DATA_TO_TABLEAU, parameters={"log_dir": temp}) as process:
                remaining = max_rows
                for index, member in enumerate(members):
                    if member.file_size > 100_000_000:
                        raise ScrapeError("Hyper extract exceeds the 100 MB inspection limit")
                    path = Path(temp) / f"extract-{index}.hyper"
                    path.write_bytes(archive.read(member))
                    with Connection(process.endpoint, path, parameters={"access_mode": "readonly"}) as connection:
                        for schema in connection.catalog.get_schema_names():
                            for table in connection.catalog.get_table_names(schema):
                                columns = connection.catalog.get_table_definition(table).columns
                                selected = [column for column in columns if column.name.unescaped in units]
                                names = [column.name.unescaped for column in selected]
                                if not {"Patron Count", "Date (Patron Counts)", "F4"}.issubset(names):
                                    continue
                                projection = ", ".join(str(column.name) for column in selected)
                                query = f'SELECT DISTINCT {projection} FROM {table} WHERE "Patron Count" IS NOT NULL AND "Date (Patron Counts)" IS NOT NULL'
                                total = connection.execute_scalar_query(f"SELECT COUNT(*) FROM ({query}) AS measures")
                                raw = connection.execute_list_query(
                                    query + ' ORDER BY "Date (Patron Counts)", "Time", "F4" LIMIT ' + str(remaining)) if remaining else []
                                def json_value(value):
                                    if value is None or isinstance(value, (str, bool, int)):
                                        return value
                                    if isinstance(value, float):
                                        return value if math.isfinite(value) else None
                                    return str(value)
                                rows = [dict(zip(names, map(json_value, row))) for row in raw]
                                dates = [row["Date (Patron Counts)"] for row in rows]
                                tables.append({"member": member.filename, "table": str(table),
                                               "columns": [{"name": column.name.unescaped,
                                                            "sourceType": str(column.type),
                                                            "unit": units[column.name.unescaped]} for column in selected],
                                               "rows": rows, "availableRows": total,
                                               "truncated": total > len(rows),
                                               "returnedObservationRange": {"start": min(dates), "end": max(dates)} if dates else None})
                                remaining -= len(rows)
    except (HyperException, OSError, zipfile.BadZipFile) as error:
        raise ScrapeError(f"Cannot read section Hyper extract at {source.url}: {error}") from error
    if not tables:
        raise ScrapeError(f"No dated section-count table found in {source.url}")
    return {"tables": tables, "rowLimit": max_rows, "provenance": source.provenance,
            "countingMethod": "unknown", "occupancy": None,
            "limitations": ["Column names and units retain source meaning; percentage values are not rescaled.",
                            "Patron Count repeats library totals across section rows; never sum it across sections.",
                            "Historical patron and zone counts are not verified concurrent occupancy."]}


def parse_hours(source):
    page = soup(source)
    records = []
    for table in page.select("table"):
        dates = [node.get("datetime") for node in table.select("thead time[datetime]")]
        if not dates:
            continue
        caption = table.find("caption")
        name = caption.get_text(" ", strip=True) if caption else "Library hours"
        for row in table.select("tbody tr"):
            cells = row.find_all("td", recursive=False)
            label = row.find("th")
            if len(cells) != len(dates):
                raise ScrapeError(f"Library hour table dates/cells do not align at {source.url}")
            for date, cell in zip(dates, cells):
                raw = cell.get_text(" ", strip=True)
                service = label.get_text(" ", strip=True) if label else "General Hours"
                records.append({"id": "library-hours:" + hashlib.sha256(
                    f"{name}:{service}:{date}".encode()).hexdigest()[:16],
                    "library": name.removesuffix(" hours"), "locationId": None, "locationResolution": "unresolved", "service": service,
                    "date": date, "timezone": "America/New_York", "hoursText": raw,
                    "closed": raw.casefold() == "closed", "provenance": source.provenance})
    if not records:
        raise ScrapeError(f"No date-specific library hours tables found at {source.url}")
    return records


def collect(fetcher, counts_url=CSV_URL, hours_url=HOURS_URL, extract_hyper=False, max_hyper_rows=20000):
    """Download historical patron counts, section workbooks, and dated library hours."""
    sources, errors, counts, workbooks, hours = [], [], [], [], []
    subtotal_count = 0
    section_rows = None
    warnings = ["Historical patron counts have an unknown counting method; they are not verified concurrent occupancy.",
                "Workbook Hyper extracts are downloaded and cached but are not decoded into section-level observations."]
    if extract_hyper:
        warnings.pop()
    try:
        source = fetcher.get(counts_url)
        sources.append(source.provenance)
        counts, subtotal_count = parse_counts(source)
    except ScrapeError as error:
        errors.append(str(error))
    for url in WORKBOOK_URLS:
        try:
            source = fetcher.get(url)
            sources.append(source.provenance)
            workbook = parse_workbook(source)
            workbooks.append(workbook)
            if extract_hyper and "STHLibraryUsagebySection" in url:
                section_rows = extract_section_rows(source, max_hyper_rows)
                workbook["hyperRowsExtracted"] = True
                workbook["limitations"][0] = "Raw workbook is retained in the HTTP cache; dated section measures are decoded."
                if any(table["truncated"] for table in section_rows["tables"]):
                    warnings.append(f"Section-use rows truncated to configured maximum of {max_hyper_rows}.")
        except ScrapeError as error:
            errors.append(str(error))
    try:
        source = fetcher.get(hours_url)
        sources.append(source.provenance)
        hours = parse_hours(source)
    except ScrapeError as error:
        errors.append(str(error))
    return {"patronCounts": counts, "excludedSubtotalRows": subtotal_count,
            "workbooks": workbooks, "sectionUse": section_rows, "hours": hours,
            "sources": sources, "warnings": warnings, "errors": errors}


def add_arguments(parser):
    parser.add_argument("--extract-hyper", action="store_true", help="Decode historical section-use rows; requires requirements-hyper.txt")
    parser.add_argument("--max-hyper-rows", type=int, default=20000, help="Maximum decoded section rows, at most 100000")
    parser.add_argument("--counts-url", default=CSV_URL)
    parser.add_argument("--hours-url", default=HOURS_URL)


if __name__ == "__main__":
    run_cli("libraries", collect, add_arguments)
