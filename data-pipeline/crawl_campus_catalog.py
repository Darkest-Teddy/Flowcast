"""Crawl every published BU Academics course index and report Fall-term coverage."""

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urldefrag, urljoin, urlsplit

from common import CACHE, OUTPUT, Fetcher, ScrapeError, envelope, soup, stable_id, utc_now, write_json
from scrape_catalog import (BUILDINGS_URL, COURSE_PATH, flag_shared_meetings,
                            parse_buildings, parse_classroom, parse_course)

ACADEMICS = "https://www.bu.edu/academics/"
INDEX_PATH = re.compile(r"^/academics/[^/]+/courses/$")


def checked_page(fetcher, url):
    source = fetcher.get(url)
    actual, expected = urlsplit(source.url), urlsplit(url)
    if actual.netloc != expected.netloc or actual.path.rstrip("/") != expected.path.rstrip("/"):
        raise ScrapeError(f"Unexpected redirect from {url} to {source.url}; not counted as coverage")
    return source


def discover_areas(fetcher):
    source = checked_page(fetcher, ACADEMICS)
    areas = []
    for link in soup(source).select("h3 a[href]"):
        url = urljoin(source.url, link["href"])
        areas.append({"name": link.get_text(" ", strip=True), "url": url,
                      "status": "pending", "indexUrls": []})
    if not areas:
        raise ScrapeError("No academic areas found on BU Academics; inspect cached markup")
    return areas, [source.provenance]


def discover_indexes(fetcher, areas):
    sources, errors, indexes = [], [], []
    for area in areas:
        url = area["url"]
        if urlsplit(url).netloc != "www.bu.edu" or not urlsplit(url).path.startswith("/academics/"):
            area["status"] = "external_academic_area_not_in_bulletin_crawl"
            continue
        try:
            source = checked_page(fetcher, url)
            sources.append(source.provenance)
            for link in soup(source).select("a[href]"):
                target = urldefrag(urljoin(source.url, link["href"]))[0]
                parts = urlsplit(target)
                if parts.netloc == "www.bu.edu" and INDEX_PATH.fullmatch(parts.path) and parts.path.startswith(urlsplit(url).path):
                    area["indexUrls"].append(target)
            area["indexUrls"] = sorted(set(area["indexUrls"]))
            area["status"] = "index_discovered" if area["indexUrls"] else "no_own_public_course_index_link"
            indexes.extend(area["indexUrls"])
        except ScrapeError as error:
            area["status"] = "source_failed"
            errors.append({"url": url, "stage": "academic_area", "error": str(error)})
    return sorted(set(indexes)), sources, errors


def index_links(source, root):
    courses, pages, subindexes = set(), set(), set()
    base = urlsplit(root).path
    for link in soup(source).select("a[href]"):
        target = urldefrag(urljoin(source.url, link["href"]))[0]
        parts = urlsplit(target)
        if parts.netloc != "www.bu.edu":
            continue
        if COURSE_PATH.fullmatch(parts.path):
            courses.add(target)
        elif parts.path.startswith(base):
            suffix = parts.path[len(base):]
            if re.fullmatch(r"(?:page/)?\d+/", suffix):
                pages.add(int(suffix.strip("/").split("/")[-1]))
            elif suffix and re.fullmatch(r"[a-z-]+/", suffix):
                subindexes.add(target)
    return courses, pages, subindexes


def index_inventory(source):
    records = {}
    for link in soup(source).select("a[href]"):
        target = urldefrag(urljoin(source.url, link["href"]))[0]
        if urlsplit(target).netloc != "www.bu.edu" or not COURSE_PATH.fullmatch(urlsplit(target).path):
            continue
        label = " ".join(link.get_text(" ", strip=True).split())
        match = re.fullmatch(r"([A-Z]+\s+[A-Z]+\s+\d+[A-Z]?):\s*(.+)", label)
        records[target] = {"courseCode": match[1] if match else None,
                           "title": match[2] if match else label,
                           "listingLabel": label, "provenance": source.provenance}
    return records


def load_resume(output_dir, term):
    def rows(name):
        path = Path(output_dir)/name
        if path.exists():
            for line in path.read_text().splitlines():
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    by_meeting, by_exclusion = defaultdict(list), defaultdict(list)
    for row in rows("meetings.jsonl"):
        by_meeting[row["provenance"]["url"]].append(row)
    for row in rows("excluded-meetings.jsonl"):
        by_exclusion[row["provenance"]["url"]].append(row)
    reusable = {}
    for course in rows("courses.jsonl"):
        url = course["url"]
        if course.get("term") != term or course.get("scheduleStatus") == "detail_source_failed":
            continue
        if course["meetingCount"] != len(by_meeting[url]) or course["excludedMeetingCount"] != len(by_exclusion[url]):
            continue
        reusable[url] = {"course": course, "meetings": by_meeting[url],
                         "excludedMeetings": by_exclusion[url], "warnings": []}
    return reusable


def discover_classrooms(fetcher):
    url = "https://www.bu.edu/classrooms/find-a-classroom/?cts_filter_submit=Search"
    found, sources, seen = {}, [], set()
    while url and url not in seen:
        if len(seen) >= 500:
            raise ScrapeError("Public classroom directory exceeds 500 pages")
        seen.add(url)
        source = checked_page(fetcher, url)
        sources.append(source.provenance)
        page = soup(source)
        for card in page.select(".cts-results-list-details"):
            label, link = card.select_one("h4"), card.select_one('a[href*="/classrooms/classroom/"]')
            if not label or not link:
                continue
            match = re.match(r"^([A-Z0-9]{2,8})-([^\s(]+)", label.get_text(" ", strip=True))
            if not match:
                raise ScrapeError("Unrecognized classroom directory label: "+label.get_text(" ", strip=True))
            found[(match[1], match[2].upper())] = urljoin(source.url, link["href"])
        next_links = [urljoin(source.url, a["href"]) for a in page.select("a[href]")
                      if "more results" in a.get_text(" ", strip=True).lower()]
        url = next_links[0] if next_links else None
    if not found:
        raise ScrapeError("No entries in the public classroom search")
    return found, sources


def run(fetcher, output_dir, term="FALL 2026", workers=6, resume=False):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    sources, errors, warnings = [], [], []
    coverage = {"term": term, "startedAt": utc_now(), "status": "running", "stage": "discovery",
                "academicAreas": [], "indexes": [], "progress": {}, "errors": errors}

    def progress(stage, completed, total):
        coverage.update(rateLimitResponses=getattr(fetcher, "rate_limit_count", 0), stage=stage, updatedAt=utc_now(), progress={"completed": completed, "total": total})
        write_json(output_dir / "coverage.json", coverage)
        print(f"{stage}: {completed}/{total}", flush=True)

    areas, first_sources = discover_areas(fetcher)
    sources.extend(first_sources)
    roots, area_sources, area_errors = discover_indexes(fetcher, areas)
    coverage["academicAreas"] = areas
    sources.extend(area_sources)
    errors.extend(area_errors)
    if not roots:
        raise ScrapeError("No validated course indexes discovered")
    discovered = set()
    inventory = {}
    listings = []
    for root in roots:
        report = {"url": root, "slug": urlsplit(root).path.split("/")[2], "pagesExpected": 0,
                  "pagesFetched": 0, "coursesDiscovered": 0, "errors": []}
        coverage["indexes"].append(report)
        try:
            source = checked_page(fetcher, root)
            sources.append(source.provenance)
            courses, page_numbers, subindexes = index_links(source, root)
            discovered.update(courses)
            inventory.update(index_inventory(source))
            report["pagesExpected"] = max(page_numbers, default=1)
            if report["pagesExpected"] > 2000:
                raise ScrapeError("Unexpected pagination above 2000 pages; inspect source before continuing")
            report["pagesFetched"] = 1
            report["courseUrls"] = set(courses)
            # BU exposes first/last numeric links; fill the verified contiguous pagination.
            listings.extend((f"{root}{number}/", report) for number in range(2, report["pagesExpected"]+1))
            if not courses:
                listings.extend((url, report) for url in sorted(subindexes))
                report["pagesExpected"] += len(subindexes)
        except ScrapeError as error:
            report["errors"].append(str(error))
            errors.append({"url": root, "stage": "index", "error": str(error)})
    # Sets are only an in-process deduplication aid; checkpoints must remain JSON.
    by_report = {r["url"]: r.pop("courseUrls", set()) for r in coverage["indexes"]}
    progress("indexes", len(roots), len(roots)+len(listings))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(checked_page, fetcher, url): (url, report) for url, report in listings}
        for number, future in enumerate(as_completed(futures), 1):
            url, report = futures.pop(future)
            try:
                source = future.result()
                sources.append(source.provenance)
                courses, _, _ = index_links(source, report["url"])
                discovered.update(courses)
                inventory.update(index_inventory(source))
                by_report[report["url"]].update(courses)
                report["pagesFetched"] += 1
            except ScrapeError as error:
                report["errors"].append(str(error))
                errors.append({"url": url, "stage": "index", "error": str(error)})
            if number % 25 == 0 or number == len(listings):
                progress("indexes", len(roots)+number, len(roots)+len(listings))
    for report in coverage["indexes"]:
        report["coursesDiscovered"] = len(by_report[report["url"]])
    urls = sorted(discovered)
    write_json(output_dir / "course-urls.json", urls)
    if not urls:
        raise ScrapeError("No course links found in validated public indexes")
    reusable = load_resume(output_dir, term) if resume else {}
    meetings, excluded, courses = {}, {}, []
    progress("courses", 0, len(urls))
    with (output_dir / "courses.jsonl").open("w") as course_log, (output_dir / "meetings.jsonl").open("w") as meeting_log, (output_dir / "excluded-meetings.jsonl").open("w") as excluded_log:
        def accept(parsed):
            summary = parsed["course"]
            courses.append(summary)
            course_log.write(json.dumps(summary, ensure_ascii=False)+"\n")
            sources.append(summary["provenance"])
            for row in parsed["meetings"]:
                row["calendarStatus"] = "review_source_notes_and_dates_before_weekly_expansion"
                meetings[row["id"]] = row
                meeting_log.write(json.dumps(row, ensure_ascii=False)+"\n")
            for row in parsed["excludedMeetings"]:
                excluded[row["id"]] = row
                excluded_log.write(json.dumps(row, ensure_ascii=False)+"\n")
            warnings.extend(w for w in parsed["warnings"] if "No public meeting tables" not in w)
        for url in urls:
            if url in reusable:
                accept(reusable[url])
        reused = len(courses)
        pending_urls = [u for u in urls if u not in reusable]
        coverage["reusedParsedCourses"] = reused
        progress("courses", reused, len(urls))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(checked_page, fetcher, url): url for url in pending_urls}
            for number, future in enumerate(as_completed(futures), reused+1):
                url = futures.pop(future)
                try:
                    source = future.result()
                    accept(parse_course(source, term))
                except ScrapeError as error:
                    errors.append({"url": url, "stage": "course", "error": str(error)})
                    summary = {"id": "course-" + stable_id(url), **inventory.get(url, {}),
                               "url": url, "term": term, "termTableCount": None,
                               "meetingCount": None, "excludedMeetingCount": None,
                               "scheduleStatus": "detail_source_failed", "detailError": str(error)}
                    courses.append(summary)
                    course_log.write(json.dumps(summary, ensure_ascii=False)+"\n")
                if number % 50 == 0 or number == len(urls):
                    course_log.flush()
                    meeting_log.flush()
                    excluded_log.flush()
                    coverage["counts"] = {"coursePagesParsed": sum(c["scheduleStatus"] != "detail_source_failed" for c in courses), "physicalMeetingRows": len(meetings),
                                          "excludedRows": len(excluded), "errors": len(errors)}
                    progress("courses", number, len(urls))
    buildings, classrooms = [], []
    try:
        source = checked_page(fetcher, BUILDINGS_URL)
        sources.append(source.provenance)
        buildings = parse_buildings(source)
    except ScrapeError as error:
        errors.append({"url": BUILDINGS_URL, "stage": "building_directory", "error": str(error)})
    room_keys = sorted({(m["buildingCode"], m["roomCode"]) for m in meetings.values()})
    directory, unavailable = None, []
    try:
        directory, directory_sources = discover_classrooms(fetcher)
        sources.extend(directory_sources)
    except ScrapeError as error:
        warnings.append("Classroom directory lookup unavailable; falling back to per-room lookup: "+str(error))
    requests = []
    for building, room in room_keys:
        if directory is not None and (building, room) not in directory:
            unavailable.append({"buildingCode": building, "roomCode": room,
                                "reason": "no_matching_entry_in_public_classroom_directory"})
        else:
            url = directory[(building, room)] if directory is not None else f"https://www.bu.edu/classrooms/classroom/{building.lower()}-{room.lower()}/"
            requests.append((url, building, room))
    coverage["classroomsWithoutDirectoryEntry"] = len(unavailable)
    progress("classrooms", 0, len(requests))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(checked_page, fetcher, url): (url, b, r) for url, b, r in requests}
        for number, future in enumerate(as_completed(futures), 1):
            url, building, room = futures.pop(future)
            try:
                source = future.result()
                sources.append(source.provenance)
                classrooms.append(parse_classroom(source, building, room))
            except ScrapeError as error:
                errors.append({"url": url, "stage": "classroom", "error": str(error)})
            if number % 50 == 0 or number == len(requests):
                progress("classrooms", number, len(requests))
    by_building = {b["buildingCode"]: b for b in buildings}
    by_room = {(r["buildingCode"], r["roomCode"]): r for r in classrooms}
    for meeting in meetings.values():
        building = by_building.get(meeting["buildingCode"])
        room = by_room.get((meeting["buildingCode"], meeting["roomCode"]))
        meeting["buildingName"] = building["name"] if building else None
        meeting["address"] = room.get("address") if room else (building["address"] if building else None)
        meeting["roomCapacity"] = room["capacity"] if room else None
        meeting["roomProvenance"] = room["provenance"] if room else None
        meeting["buildingProvenance"] = building["provenance"] if building else None
    flag_shared_meetings(list(meetings.values()))
    schedule_counts = Counter(c["scheduleStatus"] for c in courses)
    per_school = []
    for report in coverage["indexes"]:
        prefix = urlsplit(report["url"]).path
        parsed_courses = [c for c in courses if urlsplit(c["url"]).path.startswith(prefix)]
        per_school.append({**report, "coursesListed": len(parsed_courses),
                           "coursePagesParsed": sum(c["scheduleStatus"] != "detail_source_failed" for c in parsed_courses),
                           "coursesWithTargetTermTables": sum(bool(c["termTableCount"]) for c in parsed_courses)})
    coverage.update(status="partial" if errors else "ok", stage="complete", completedAt=utc_now(), indexes=per_school,
                    counts={"courseUrlsDiscovered": len(urls), "coursePagesParsed": sum(c["scheduleStatus"] != "detail_source_failed" for c in courses),
                            "coursesListed": len(courses),
                            "uniqueCourseCodes": len({c["courseCode"] for c in courses if c.get("courseCode")}),
                            "coursesWithTargetTermTables": schedule_counts["published"],
                            "coursesWithoutTargetTermTables": schedule_counts["no_target_term_schedule_published"],
                            "coursesWithUnavailableDetails": schedule_counts["detail_source_failed"],
                            "physicalMeetingRows": len(meetings), "excludedRows": len(excluded),
                            "classroomsVerified": len(classrooms), "classroomsAttempted": len(requests), "classroomsReferenced": len(room_keys), "classroomsWithoutDirectoryEntry": len(unavailable), "errors": len(errors)})
    warnings.extend(["Campus-wide public catalogue coverage does not prove complete Fall-term offerings; MyBU is not scraped.",
                     "Term tables can have date-limited sessions; review source notes before representative-week expansion.",
                     "Room capacities are not enrollment; combined-section candidates require review before aggregation."])
    result = envelope("catalog", {"term": term, "courses": sorted(courses, key=lambda c: c["url"]),
                      "meetings": sorted(meetings.values(), key=lambda m: m["id"]),
                      "excludedMeetings": sorted(excluded.values(), key=lambda m: m["id"]),
                      "buildings": buildings, "classrooms": classrooms, "unavailableClassrooms": unavailable, "coverage": coverage,
                      "sources": sorted({s["requestedUrl"]: s for s in sources}.values(), key=lambda s: s["requestedUrl"]),
                      "warnings": sorted(set(warnings)), "errors": errors})
    write_json(output_dir / "catalog.json", result)
    write_json(output_dir / "coverage.json", coverage)
    write_json(output_dir / "manifest.json", {"schemaVersion": 1, "generatedAt": utc_now(), "status": coverage["status"],
               "dataset": "campus-wide-public-catalog", "term": term, "counts": coverage["counts"],
               "files": [{"path": name, "sha256": hashlib.sha256((output_dir/name).read_bytes()).hexdigest()}
                         for name in ("catalog.json", "coverage.json", "course-urls.json", "courses.jsonl", "meetings.jsonl", "excluded-meetings.jsonl")]})
    print(json.dumps(coverage["counts"], indent=2), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--term", default="FALL 2026")
    parser.add_argument("--output-dir", type=Path, default=OUTPUT / "campus-wide")
    parser.add_argument("--cache-dir", type=Path, default=CACHE)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--delay", type=float, default=0.5, help="Global minimum request interval per host, shared by workers")
    parser.add_argument("--resume", action="store_true", help="Reuse complete parsed JSONL results; retry missing/error details")
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    if not 1 <= args.workers <= 8 or not re.fullmatch(r"(?:FALL|SPRING|SUMMER) \d{4}", args.term.upper()):
        parser.error("Use 1-8 workers and a term such as FALL 2026")
    fetcher = Fetcher(args.cache_dir, offline=args.offline, delay=args.delay)
    try:
        result = run(fetcher, args.output_dir, args.term.upper(), args.workers, args.resume)
    except (ScrapeError, OSError) as error:
        parser.exit(1, str(error)+"\n")
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
