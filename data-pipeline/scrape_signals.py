"""Collect historical pedestrian counts, FitRec evidence, and reported sports attendance."""

from datetime import datetime
from io import BytesIO
import re
from urllib.parse import urljoin, urlsplit
from zoneinfo import ZoneInfo

from pypdf import PdfReader

from common import ScrapeError, main_content, run_cli, soup, stable_id

PEDESTRIAN_REPORT = "https://www.bu.edu/community/files/2024/02/Warren-Towers-EPNF.pdf"
FITREC_GUIDE = "https://www.bu.edu/articles/2025/fitrec-what-to-know/"
FITREC_USAGE = "https://www.bu.edu/fitrec/peak-quiet-hours/"
HOCKEY_SCHEDULE = "https://goterriers.com/sports/mens-ice-hockey/schedule/2026-27"
EXAMPLE_BOXSCORE = "https://goterriers.com/sports/mens-ice-hockey/stats/2026-27/brown/boxscore/33104"


def parse_pedestrian_table(text, provenance):
    if "Table 7-6:" not in text or "Peds" not in text or "8" not in text:
        raise ScrapeError("Warren report PDF page 136 no longer contains expected Table 7-6")
    dates = re.search(r"October\s+(\d+)\s+and\s+(\d+),\s+(\d{4})", text)
    if not dates:
        raise ScrapeError("Pedestrian collection dates missing from table context")
    collection_dates = [f"{dates[3]}-10-{int(dates[i]):02d}" for i in (1, 2)]
    table = text.split("Peds Bicycles Cars/ Trucks", 2)[-1].split("Source:", 1)[0]
    rows = re.findall(r"([^\d]+?)\s+(\d[\d,]*)\s+(\d[\d,]*)\s+(\d[\d,]*)\s+(\d[\d,]*)\s+(\d[\d,]*)\s+(\d[\d,]*)", table)
    records = []
    for location, *values in rows:
        location = " ".join(location.split())
        for start, end, count in (("08:00", "09:00", values[0]), ("17:00", "18:00", values[3])):
            records.append({
                "id": stable_id("pedestrian", location, start, *collection_dates),
                "intersection": location, "locationId": None,
                "measure": "pedestrian_flow", "value": int(count.replace(",", "")),
                "unit": "pedestrian_crossings_per_hour", "startLocal": start, "endLocal": end,
                "collectionDates": collection_dates, "exactIntersectionDate": None,
                "basis": "Table 7-6, printed page 7-17, PDF page 136",
                "limitations": "May include nonstudents and repeated people; do not sum intersections as unique people or occupancy.",
                "provenance": {**provenance, "pdfPage": 136, "table": "7-6"},
            })
    if not records:
        raise ScrapeError("No pedestrian rows parsed from Table 7-6")
    return records


def parse_fitrec(source):
    document = soup(source)
    text = main_content(source).get_text(" ", strip=True)
    published = document.select_one('meta[property="article:published_time"], time[datetime]')
    published_at = (published.get("content") or published.get("datetime")) if published else None
    if not published_at:
        date = re.search(r'"datePublished"\s*:\s*"([^\"]+)"', source.text)
        published_at = date[1] if date else None
    match = re.search(r"(?:more than|over)\s+([\d,]+)\s+members\s+stopping by every day", text, re.I)
    if not match:
        raise ScrapeError("Expected daily FitRec usage statement not found; inspect the saved source")
    context = text[max(0, match.start()-30):text.find("Cardio central", match.end()) if "Cardio central" in text[match.end():] else match.end()+600]
    return {
        "id": stable_id("fitrec", source.url, "daily-visits"), "location": "FitRec", "locationId": None,
        "measure": "daily_visits", "value": int(match[1].replace(",", "")), "qualifier": "more_than",
        "unit": "visits_per_day", "sourcePublishedAt": published_at,
        "observationPeriod": None, "evidence": context,
        "limitations": "Dated published volume and usage pattern, not current occupancy or verified unique visitors.",
        "provenance": source.provenance,
    }


def parse_boxscore(source):
    document = soup(source)
    fields = {}
    for label in document.find_all(["span", "dt"]):
        name = label.get_text(" ", strip=True).rstrip(":").lower()
        if name not in ("date", "attendance", "location", "start", "stadium"):
            continue
        value = label.find_next_sibling(["span", "dd"])
        if value:
            fields[name] = value.get_text(" ", strip=True)
    if not re.fullmatch(r"[\d,]+", fields.get("attendance", "")):
        raise ScrapeError(f"Reported attendance missing from box score: {source.url}")
    try:
        date = datetime.strptime(fields["date"], "%m/%d/%Y").date()
        start = datetime.strptime(fields["start"], "%I:%M %p").time() if fields.get("start") else None
    except (KeyError, ValueError) as exc:
        raise ScrapeError(f"Box-score date/start format changed: {fields}") from exc
    return {
        "id": stable_id("sports", source.url),
        "title": document.title.get_text(" ", strip=True) if document.title else None,
        "date": date.isoformat(),
        "startAt": datetime.combine(date, start, ZoneInfo("America/New_York")).isoformat() if start else None,
        "location": fields.get("location"), "venue": fields.get("stadium"), "locationId": None,
        "measure": "reported_event_attendance", "value": int(fields["attendance"].replace(",", "")),
        "unit": "reported_attendees_per_event",
        "limitations": "Event total, not an arrival curve or instantaneous building occupancy; exact counting method unspecified.",
        "provenance": source.provenance,
    }


def collect(fetcher, boxscore_urls=None, discover_sports=False, max_boxscores=10):
    """Download supplemental public flow/usage evidence; never infer live occupancy."""
    if max_boxscores < 1:
        raise ScrapeError("max_boxscores must be positive")
    result = {"pedestrianCounts": [], "fitrecMetrics": [], "sportsAttendance": [], "dashboardLinks": [],
              "sources": [], "warnings": [], "errors": []}
    try:
        source = fetcher.get(PEDESTRIAN_REPORT)
        result["sources"].append(source.provenance)
        reader = PdfReader(BytesIO(source.body))
        if len(reader.pages) < 136:
            raise ScrapeError("Warren report has fewer than 136 pages")
        result["pedestrianCounts"] = parse_pedestrian_table(reader.pages[135].extract_text(), source.provenance)
    except (ScrapeError, ValueError, OSError) as exc:
        result["errors"].append({"url": PEDESTRIAN_REPORT, "error": str(exc)})
    try:
        source = fetcher.get(FITREC_GUIDE)
        result["sources"].append(source.provenance)
        result["fitrecMetrics"].append(parse_fitrec(source))
    except (ScrapeError, ValueError, OSError) as exc:
        result["errors"].append({"url": FITREC_GUIDE, "error": str(exc)})
    try:
        source = fetcher.get(FITREC_USAGE)
        result["sources"].append(source.provenance)
        result["dashboardLinks"] = [{"url": urljoin(source.url, frame["src"]), "status": "link_only_export_not_collected",
                                     "provenance": source.provenance}
                                    for frame in soup(source).select("iframe[src]") if "powerbi.com" in frame["src"]]
        if not result["dashboardLinks"]:
            raise ScrapeError("FitRec Power BI link not found")
    except (ScrapeError, ValueError, OSError) as exc:
        result["errors"].append({"url": FITREC_USAGE, "error": str(exc)})
    urls = list(boxscore_urls or [EXAMPLE_BOXSCORE])
    if discover_sports:
        try:
            source = fetcher.get(HOCKEY_SCHEDULE)
            result["sources"].append(source.provenance)
            for link in soup(source).select('a[href*="/boxscore/"]'):
                url = urljoin(source.url, link["href"])
                if urlsplit(url).netloc in ("goterriers.com", "www.goterriers.com"):
                    urls.append(url)
        except (ScrapeError, ValueError, OSError) as exc:
            result["errors"].append({"url": HOCKEY_SCHEDULE, "error": str(exc)})
    urls = list(dict.fromkeys(urls))
    if len(urls) > max_boxscores:
        result["warnings"].append(f"Sports discovery bounded at {max_boxscores} of {len(urls)} box scores; not full-season coverage.")
    for url in urls[:max_boxscores]:
        try:
            source = fetcher.get(url)
            result["sources"].append(source.provenance)
            result["sportsAttendance"].append(parse_boxscore(source))
        except (ScrapeError, ValueError, OSError) as exc:
            result["errors"].append({"url": url, "error": str(exc)})
    result["warnings"].append("No Power BI chart values are exported; the public dashboard link is retained for follow-up.")
    return result


def add_arguments(parser):
    parser.add_argument("--boxscore-url", action="append", dest="boxscore_urls")
    parser.add_argument("--discover-sports", action="store_true")
    parser.add_argument("--max-boxscores", type=int, default=10)


if __name__ == "__main__":
    run_cli("signals", collect, add_arguments)
