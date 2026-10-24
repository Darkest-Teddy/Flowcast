"""Collect public BU course meetings and their separately published room capacities."""

import re
from collections import defaultdict
from urllib.parse import urldefrag, urljoin, urlparse

from common import ScrapeError, run_cli, soup, stable_id

DEFAULT_COURSES = [
    "https://www.bu.edu/academics/cas/courses/cas-ma-123/",
    "https://www.bu.edu/academics/eng/courses/eng-ek-103/",
    "https://www.bu.edu/academics/cas/courses/cas-ch-101/",
]
BUILDINGS_URL = "https://www.bu.edu/reservations/25live/building-codes/"
COURSE_PATH = re.compile(r"^/academics/[^/]+/courses/[a-z]+-[a-z]+-\d+[a-z]?/$", re.I)
DAY_INDEX = {day: index for index, day in enumerate("MTWRFSU")}
SCHEDULE = re.compile(
    r"^([MTWRFSU]+)\s+(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)\s*[-–—]\s*"
    r"(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)$", re.I
)


def text(node):
    return " ".join(node.get_text(" ", strip=True).split())


def clock_seconds(value):
    match = re.fullmatch(r"(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?", value, re.I)
    if not match:
        raise ValueError(f"Unrecognized clock time: {value}")
    hour, minute = int(match[1]), int(match[2] or 0)
    if not 1 <= hour <= 12 or not 0 <= minute < 60:
        raise ValueError(f"Invalid clock time: {value}")
    return ((hour % 12) + (12 if match[3].lower() == "p" else 0)) * 3600 + minute * 60


def parse_schedule(value):
    match = SCHEDULE.fullmatch(value.strip())
    if not match:
        raise ValueError(f"Unrecognized schedule: {value}")
    start, end = clock_seconds(match[2]), clock_seconds(match[3])
    if end <= start:
        raise ValueError(f"Non-positive or overnight class interval: {value}")
    return [
        {"weekday": DAY_INDEX[day], "startSec": DAY_INDEX[day] * 86400 + start,
         "endSec": DAY_INDEX[day] * 86400 + end}
        for day in dict.fromkeys(match[1].upper())
    ]


def parse_course(source, term="FALL 2026"):
    doc = soup(source)
    content = doc.select_one("#col1") or doc
    heading = content.find("h2")
    course = text(heading) if heading else ""
    if not re.fullmatch(r"[A-Z]+\s+[A-Z]+\s+\d+[A-Z]?", course):
        raise ScrapeError(f"Course identity not found: {source.url}")
    title = content.find("h1")
    meetings, excluded, warnings = [], [], []
    matched_tables = 0
    for table in content.find_all("table"):
        term_heading = table.find_previous(["h3", "h4"])
        if not term_heading or text(term_heading).upper() != f"{term.upper()} SCHEDULE":
            continue
        rows = table.find_all("tr")
        if not rows:
            continue
        columns = [text(cell).lower() for cell in rows[0].find_all(["th", "td"])]
        if not {"section", "location", "schedule"}.issubset(columns):
            continue
        matched_tables += 1
        for row in rows[1:]:
            cells = row.find_all(["td", "th"])
            if len(cells) != len(columns):
                excluded.append({
                    "id": "meeting-" + stable_id(term.upper(), course, text(row)),
                    "courseCode": course, "term": term.upper(),
                    "reason": "malformed_columns", "rawCells": [text(cell) for cell in cells],
                    "expectedColumns": columns, "provenance": source.provenance,
                })
                warnings.append(f"Malformed meeting row preserved for review on {source.url}")
                continue
            fields = dict(zip(columns, map(text, cells)))
            room_raw, schedule = fields["location"], fields["schedule"]
            record = {
                "id": "meeting-" + stable_id(term.upper(), course, fields["section"], room_raw, schedule),
                "courseCode": course, "courseTitle": text(title) if title else None,
                "section": fields["section"], "term": term.upper(),
                "instructor": fields.get("instructor") or None,
                "locationRaw": room_raw, "scheduleRaw": schedule,
                "notes": fields.get("notes") or None,
                "enrollment": None, "locationId": None, "locationResolution": "unresolved",
                "provenance": source.provenance,
            }
            room_match = re.fullmatch(r"([A-Z]{2,6})\s+([A-Z0-9][A-Z0-9.-]*)", room_raw, re.I)
            no_location = not room_match or room_raw.upper() in {"NO ROOM", "ON LINE", "ONLINE", "TBA"}
            if no_location:
                record["reason"] = "exam_reservation" if re.search(r"exam", fields.get("notes", ""), re.I) else "no_physical_location"
                excluded.append(record)
                continue
            record["buildingCode"], record["roomCode"] = room_match[1].upper(), room_match[2].upper()
            try:
                record["intervals"] = parse_schedule(schedule)
            except ValueError as error:
                record["reason"] = "unparsed_schedule"
                record["parseError"] = str(error)
                excluded.append(record)
                continue
            meetings.append(record)
    if not matched_tables:
        warnings.append(f"No public meeting tables for {term.upper()} on {source.url}; no term fallback was used.")
    return {"meetings": meetings, "excludedMeetings": excluded, "warnings": warnings}


def parse_buildings(source):
    records = []
    for table in soup(source).find_all("table"):
        rows = table.find_all("tr")
        if not rows or "Street Address" not in text(rows[0]):
            continue
        for row in rows[1:]:
            cells = row.find_all(["th", "td"])
            if len(cells) != 3:
                continue
            code, name, address = map(text, cells)
            if not re.fullmatch(r"[A-Z0-9]{2,8}", code):
                continue
            records.append({"buildingCode": code, "name": name, "address": address,
                            "locationId": None, "locationResolution": "unresolved",
                            "provenance": source.provenance})
    if not records:
        raise ScrapeError(f"Building code table not found: {source.url}")
    return records


def parse_classroom(source, building_code, room_code):
    doc = soup(source)
    fields = {}
    for item in doc.select("li"):
        label, value = item.select_one(".meta-name"), item.select_one(".meta-value")
        if label and value:
            fields[text(label).lower()] = text(value)
    capacity = fields.get("capacity", "")
    if not capacity.isdigit():
        raise ScrapeError(f"Published room capacity not found: {source.url}")
    if fields.get("building code", "").upper() != building_code or fields.get("room number", "").upper() != room_code:
        raise ScrapeError(f"Room identity mismatch for {building_code} {room_code}: {source.url}")
    return {
        "id": f"room-{building_code}-{room_code}", "buildingCode": building_code,
        "roomCode": room_code, "address": fields.get("address"),
        "capacity": {"value": int(capacity), "unit": "seats", "measure": "capacity",
                     "estimated": False, "basis": "Published classroom directory; not enrollment or attendance"},
        "provenance": source.provenance,
    }


def discover_courses(fetcher, index_urls, max_index_pages):
    pending = list(dict.fromkeys(index_urls))
    visited, found, sources, warnings, errors = set(), [], [], [], []
    while pending and len(visited) < max_index_pages:
        url = pending.pop(0)
        if url in visited:
            continue
        visited.add(url)
        try:
            source = fetcher.get(url)
            sources.append(source.provenance)
        except ScrapeError as error:
            errors.append({"url": url, "error": str(error)})
            continue
        doc = soup(source)
        for link in doc.find_all("a", href=True):
            target = urldefrag(urljoin(source.url, link["href"]))[0]
            parsed = urlparse(target)
            if parsed.hostname != "www.bu.edu":
                continue
            if COURSE_PATH.fullmatch(parsed.path):
                found.append(target)
            elif ("next" in (link.get("rel") or []) or re.search(r"/page/\d+/?$", parsed.path)) and target not in visited:
                if parsed.path.startswith(urlparse(url).path.split('/page/')[0]):
                    pending.append(target)
    if pending:
        warnings.append(f"Course index crawl stopped at {max_index_pages} pages; more index links remain.")
    return list(dict.fromkeys(found)), sources, warnings, errors


def flag_shared_meetings(meetings):
    groups = defaultdict(list)
    for meeting in meetings:
        for interval in meeting["intervals"]:
            groups[(meeting["buildingCode"], meeting["roomCode"], interval["startSec"], interval["endSec"])].append(meeting)
    for records in groups.values():
        if len({r["id"] for r in records}) < 2:
            continue
        for record in records:
            record.setdefault("possibleCombinedMeetingIds", set()).update(r["id"] for r in records if r["id"] != record["id"])
    for record in meetings:
        if "possibleCombinedMeetingIds" in record:
            record["possibleCombinedMeetingIds"] = sorted(record["possibleCombinedMeetingIds"])
            record["countingStatus"] = "review_possible_combined_section_before_aggregation"


def collect(fetcher, term="FALL 2026", course_urls=None, index_urls=None, max_courses=200, max_index_pages=5):
    """Collect public meetings, excluded reservations, building addresses, and room seats."""
    if max_courses < 1 or max_index_pages < 1:
        raise ScrapeError("max_courses and max_index_pages must be positive")
    if not re.fullmatch(r"(?:FALL|SPRING|SUMMER) \d{4}", term.upper()):
        raise ScrapeError("term must be FALL, SPRING, or SUMMER followed by a four-digit year")
    sources, warnings, errors = [], [], []
    urls = list(course_urls or ([] if index_urls else DEFAULT_COURSES))
    if index_urls:
        discovered, index_sources, index_warnings, index_errors = discover_courses(fetcher, index_urls, max_index_pages)
        sources.extend(index_sources)
        warnings.extend(index_warnings)
        errors.extend(index_errors)
        urls.extend(discovered)
    urls = list(dict.fromkeys(urls))
    if len(urls) > max_courses:
        warnings.append(f"Course crawl limited to {max_courses} of {len(urls)} discovered URLs.")
    meetings, excluded = {}, {}
    for url in urls[:max_courses]:
        try:
            source = fetcher.get(url)
            sources.append(source.provenance)
            parsed = parse_course(source, term)
            warnings.extend(parsed["warnings"])
            meetings.update((r["id"], r) for r in parsed["meetings"])
            excluded.update((r["id"], r) for r in parsed["excludedMeetings"])
        except ScrapeError as error:
            errors.append({"url": url, "error": str(error)})
    buildings, rooms = [], []
    try:
        source = fetcher.get(BUILDINGS_URL)
        sources.append(source.provenance)
        buildings = parse_buildings(source)
    except ScrapeError as error:
        errors.append({"url": BUILDINGS_URL, "error": str(error)})
    by_code = {record["buildingCode"]: record for record in buildings}
    room_keys = sorted({(m["buildingCode"], m["roomCode"]) for m in meetings.values()})
    for building_code, room_code in room_keys:
        url = f"https://www.bu.edu/classrooms/classroom/{building_code.lower()}-{room_code.lower()}/"
        try:
            source = fetcher.get(url)
            sources.append(source.provenance)
            rooms.append(parse_classroom(source, building_code, room_code))
        except ScrapeError as error:
            errors.append({"url": url, "error": str(error)})
    by_room = {(r["buildingCode"], r["roomCode"]): r for r in rooms}
    for meeting in meetings.values():
        building = by_code.get(meeting["buildingCode"])
        classroom = by_room.get((meeting["buildingCode"], meeting["roomCode"]))
        meeting["buildingName"] = building["name"] if building else None
        meeting["address"] = classroom.get("address") if classroom else (building["address"] if building else None)
        meeting["roomCapacity"] = classroom["capacity"] if classroom else None
        meeting["roomProvenance"] = classroom["provenance"] if classroom else None
        meeting["buildingProvenance"] = building["provenance"] if building else None
    flag_shared_meetings(list(meetings.values()))
    if not meetings:
        errors.append({"error": f"No usable physical meetings collected for {term.upper()}"})
    warnings.append("Public room capacity is not enrollment or attendance. Possible combined sections require review; no shared-room counts are summed.")
    return {"term": term.upper(), "timezone": "America/New_York", "weekOrigin": "Monday 00:00",
            "meetings": list(meetings.values()), "excludedMeetings": list(excluded.values()),
            "buildings": buildings, "classrooms": rooms, "sources": sources, "warnings": warnings, "errors": errors}


def add_arguments(parser):
    parser.add_argument("--term", default="FALL 2026")
    parser.add_argument("--course-url", dest="course_urls", action="append", help="Repeat for explicitly selected courses")
    parser.add_argument("--index-url", dest="index_urls", action="append", help="Repeat for department course indexes; follows bounded pagination")
    parser.add_argument("--max-courses", type=int, default=200)
    parser.add_argument("--max-index-pages", type=int, default=5)


if __name__ == "__main__":
    run_cli("catalog", collect, add_arguments)
