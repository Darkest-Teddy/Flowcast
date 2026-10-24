"""Import the read-only BU hackathon catalog into a private local snapshot."""

import argparse
import copy
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

PRIVATE = Path(__file__).resolve().parent / ".cache" / "hackathon"
SOURCE = "https://library.bu.edu/dsxhackathon/college"


def unique(rows, key):
    result = {row[key]: row for row in rows}
    if len(result) != len(rows):
        raise ValueError(f"Duplicate catalog {key}")
    return result


def course_code(row):
    subject, number = row["subject"], row["catalog_number"]
    if not re.fullmatch(r"[A-Z]{5}", subject) or not re.fullmatch(r"\d+[A-Z]*", number):
        raise ValueError("Unrecognized catalog course identity")
    display = row["display_code"]
    if not display.startswith(subject + number) or not re.fullmatch(r"\d+[A-Z]*", display[len(subject):]):
        raise ValueError("Conflicting catalog display code")
    # Display suffixes distinguish offerings such as study-abroad variants.
    return f"{subject[:3]} {subject[3:]} {display[len(subject):]}"


def intervals(row):
    days = row["day"]
    if not days or any(day not in "MTWRFSU" for day in days):
        raise ValueError("unavailable_schedule")
    def clock(value):
        match = re.fullmatch(r"(\d{2})\.(\d{2})\.(\d{2})\.\d{6}", value)
        if not match:
            raise ValueError("unavailable_schedule")
        hour, minute, second = map(int, match.groups())
        if hour > 23 or minute > 59 or second > 59:
            raise ValueError("invalid_schedule")
        return hour * 3600 + minute * 60 + second
    start, end = clock(row["start_time"]), clock(row["end_time"])
    if start >= end:
        raise ValueError("invalid_schedule")
    return [{"weekday": day, "startSec": day * 86400 + start, "endSec": day * 86400 + end}
            for day in sorted({"MTWRFSU".index(day) for day in days})]


def merge(public, payload):
    """Prefer complete database offerings for covered course codes, retain other evidence."""
    if public["term"] != "FALL 2026" or payload["termCode"] != "2268":
        raise ValueError("This importer maps Fall 2026 (2268) only")
    courses = unique(payload["courses"], "course_key")
    sections = unique(payload["sections"], "section_key")
    if not courses or not sections or not payload["meetings"]:
        raise ValueError("Incomplete catalog snapshot")
    if any(row["term_code"] != payload["termCode"] for row in courses.values()):
        raise ValueError("Mixed catalog terms")
    if any(row["course_key"] not in courses for row in sections.values()):
        raise ValueError("Orphan catalog section")
    codes = {key: course_code(row) for key, row in courses.items()}
    covered = set(codes.values())
    rooms = {(r["buildingCode"], r["roomCode"]): r for r in public["classrooms"]}
    buildings = {r["buildingCode"]: r for r in public["buildings"]}
    result = copy.deepcopy(public)
    provenance = {"url": SOURCE, "retrievedAt": payload["retrievedAt"],
                  "source": "BU read-only catalog database", "termCode": payload["termCode"]}
    result["meetings"] = [r for r in result["meetings"] if r["courseCode"] not in covered]
    result["excludedMeetings"] = [r for r in result["excludedMeetings"] if r["courseCode"] not in covered]
    fallback_count = len(result["meetings"])
    counts, excluded_counts = Counter(), Counter()
    seen = set()
    for raw in payload["meetings"]:
        section = sections[raw["section_key"]]
        course = courses[section["course_key"]]
        identity = (raw["section_key"], raw["meeting_index"])
        if identity in seen:
            raise ValueError("Duplicate catalog meeting")
        seen.add(identity)
        start = datetime.strptime(section["start_date"], "%Y%m%d").date().isoformat()
        end = datetime.strptime(section["end_date"], "%Y%m%d").date().isoformat()
        if start > end:
            raise ValueError("Reversed catalog section dates")
        record = {"id": "bu-db-" + hashlib.sha256(json.dumps(identity).encode()).hexdigest()[:20],
                  "courseCode": codes[section["course_key"]], "courseTitle": course["title"],
                  "section": section["section"], "term": public["term"],
                  "academicCareer": course["academic_career"], "sectionType": section["section_type"],
                  "instructionType": section["instruction_type"], "validFrom": start, "validTo": end,
                  "sourceCourseKey": section["course_key"], "sourceSectionKey": raw["section_key"],
                  "buildingCode": raw["building_code"], "roomCode": raw["room"],
                  "buildingName": raw["building"], "locationRaw": raw["facility_code"],
                  "notes": None, "enrollment": None, "provenance": provenance}
        try:
            if not raw["building_code"] or not raw["room"] or raw["building_code"] in {"ON", "NO"}:
                raise ValueError("no_physical_location")
            record["intervals"] = intervals(raw)
        except ValueError as error:
            record["reason"] = str(error)
            result["excludedMeetings"].append(record)
            excluded_counts[section["course_key"]] += 1
            continue
        room = rooms.get((raw["building_code"], raw["room"]))
        if room:
            record["roomCapacity"] = room["capacity"]
            record["roomProvenance"] = room["provenance"]
        building = buildings.get(raw["building_code"])
        if building:
            record["address"] = building["address"]
            record["buildingProvenance"] = building["provenance"]
        result["meetings"].append(record)
        counts[section["course_key"]] += 1
    result["courses"] = [r for r in result["courses"] if r["courseCode"] not in covered]
    for key, row in courses.items():
        result["courses"].append({"id": "bu-db-" + hashlib.sha256(key.encode()).hexdigest()[:20],
            "courseCode": codes[key], "title": row["title"], "description": row["description"],
            "term": public["term"], "url": SOURCE, "provenance": provenance,
            "meetingCount": counts[key], "excludedMeetingCount": excluded_counts[key],
            "scheduleStatus": "published" if counts[key] else "no_physical_meetings",
            "academicCareer": row["academic_career"], "sessionCode": row["session_code"]})
    result["sources"].append(provenance)
    result["coverage"] = {"counts": {"coursePagesParsed": len(result["courses"]),
        "uniqueCourseCodes": len({r["courseCode"] for r in result["courses"]})}}
    result["hackathonCoverage"] = {"databaseCourses": len(courses), "databaseCourseCodes": len(covered),
        "databaseSections": len(sections), "databaseMeetings": sum(counts.values()),
        "excludedDatabaseMeetings": sum(excluded_counts.values()), "retainedPublicMeetings": fallback_count,
        "datasetInfo": payload["datasetInfo"]}
    return result


def acquire(term_code):
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(
        host=os.environ["CATALOG_DB_HOST"], port=5432,
        dbname=os.environ.get("CATALOG_DB_NAME", "hackathon"),
        user=os.environ["CATALOG_DB_USER"], password=os.environ["CATALOG_DB_PASSWORD"],
        sslmode="require", connect_timeout=10, row_factory=dict_row,
        options="-c default_transaction_read_only=on -c statement_timeout=60000",
    ) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        info = connection.execute("SELECT * FROM catalog.dataset_info").fetchall()
        if len(info) != 1 or info[0]["contract_version"] != 1:
            raise ValueError("Unsupported catalog contract")
        terms = connection.execute("SELECT * FROM catalog.terms WHERE term_code = %s", (term_code,)).fetchall()
        if not terms:
            raise ValueError(f"Unknown catalog term: {term_code}")
        courses = connection.execute("SELECT * FROM catalog.courses WHERE term_code = %s", (term_code,)).fetchall()
        sections = connection.execute("SELECT s.* FROM catalog.sections s JOIN catalog.courses c USING (course_key) WHERE c.term_code = %s", (term_code,)).fetchall()
        meetings = connection.execute("SELECT m.* FROM catalog.meetings m JOIN catalog.sections s USING (section_key) JOIN catalog.courses c USING (course_key) WHERE c.term_code = %s", (term_code,)).fetchall()
    if not courses or not sections or not meetings:
        raise ValueError("Incomplete catalog snapshot")
    return {"schemaVersion": 1, "termCode": term_code, "retrievedAt": datetime.now(timezone.utc).isoformat(),
            "datasetInfo": info, "terms": terms, "courses": courses, "sections": sections, "meetings": meetings}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--term-code", default="2268")
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    path = PRIVATE / "catalog.json"
    if path.exists() and not args.refresh:
        if json.loads(path.read_text())["termCode"] != args.term_code:
            parser.error("Cached term differs; use --refresh")
        print(f"Using cached catalog: {path}")
        return
    payload = acquire(args.term_code)
    PRIVATE.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=PRIVATE, delete=False) as handle:
        json.dump(payload, handle, default=str, allow_nan=False)
    os.replace(handle.name, path)
    print(f"Saved {len(payload['courses'])} courses, {len(payload['sections'])} sections, {len(payload['meetings'])} meetings to {path}")


if __name__ == "__main__":
    main()
