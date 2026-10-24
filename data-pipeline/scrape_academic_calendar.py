"""Collect the Registrar's term bounds, class suspensions, and substitute weekdays."""

from datetime import datetime, timedelta
from pathlib import Path
import re

from common import ROOT, ScrapeError, run_cli, soup
from academic_calendar import effective_intervals

SEMESTER_URL = "https://www.bu.edu/reg/calendars/semester/"
SCOPE_URL = "https://www.bu.edu/reg/calendars/"
TERMS = ("FALL 2026", "SPRING 2027")
PREFIXES = ("CAS", "CFA", "CGS", "COM", "ENG", "GRS", "CDS", "KHC", "QST", "GSM", "SAR", "SHA", "SED", "WED", "MET", "HUB", "PDP", "STH")
EXCLUDED = ("LAW", "MED", "GMS", "SDM", "SPH", "SSW")
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def date_range(value):
    value = re.sub(r"\s+", " ", value).strip()
    match = re.fullmatch(r"([A-Za-z]+) (\d{1,2})(?:\s*[–—-]\s*(?:([A-Za-z]+) )?(\d{1,2}))?, (\d{4})", value)
    if not match:
        raise ScrapeError(f"Unrecognized academic-calendar date: {value}")
    month, first, end_month, last, year = match.groups()
    try:
        start = datetime.strptime(f"{month} {first} {year}", "%B %d %Y").date()
        end = datetime.strptime(f"{end_month or month} {last or first} {year}", "%B %d %Y").date()
    except ValueError as error:
        raise ScrapeError(f"Invalid academic-calendar date: {value}") from error
    if end < start or (end - start).days > 31:
        raise ScrapeError(f"Invalid academic-calendar range: {value}")
    return [start + timedelta(days=offset) for offset in range((end - start).days + 1)]


def parse_calendar(source, terms=TERMS):
    document = soup(source)
    parsed = []
    for term in terms:
        headings = [h for h in document.find_all(["h2", "h3", "h4"]) if h.get_text(" ", strip=True).upper() == term]
        if len(headings) != 1:
            raise ScrapeError(f"Expected one academic-calendar heading for {term}")
        table = headings[0].find_next("table")
        if table is None or table.find_previous(["h2", "h3", "h4"]) != headings[0]:
            raise ScrapeError(f"Missing academic-calendar table for {term}")
        entry = {"term": term, "suspendedDates": [], "substitutions": [], "sourceUrl": source.url, "events": []}
        for row in table.find_all("tr"):
            cells = row.find_all(["td", "th"], recursive=False)
            if len(cells) != 2:
                raise ScrapeError(f"Unexpected academic-calendar row for {term}")
            raw_date, label = (cell.get_text(" ", strip=True) for cell in cells)
            if label == "Classes Begin":
                kind = "classesStart"
            elif label == "Last Day of Classes":
                kind = "classesEnd"
            elif re.search(r"Classes Suspended|Recess", label, re.I):
                kind = "suspended"
            elif re.search(r"Substitute .*Schedule of Classes", label, re.I):
                kind = "substitute"
            elif label in {"Study Period", "Final Exams Begin", "Final Exams End"}:
                kind = "exams" if "Exam" in label else "study"
            else:
                continue
            dates = date_range(raw_date)
            entry["events"].append({"kind": kind, "label": label, "start": dates[0].isoformat(), "end": dates[-1].isoformat()})
            if kind in {"classesStart", "classesEnd"}:
                if len(dates) != 1 or kind in entry:
                    raise ScrapeError(f"Ambiguous term boundary for {term}")
                entry[kind] = dates[0].isoformat()
            elif kind == "suspended":
                entry["suspendedDates"].extend(day.isoformat() for day in dates)
            elif kind == "substitute":
                match = re.fullmatch(r"Substitute (?:a )?(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) Schedule of Classes", label, re.I)
                if not match or len(dates) != 1:
                    raise ScrapeError(f"Unrecognized substitute weekday for {term}")
                entry["substitutions"].append({"date": dates[0].isoformat(), "scheduleWeekday": WEEKDAYS.index(match[1].title())})
        if not all(entry.get(key) for key in ("classesStart", "classesEnd", "suspendedDates", "substitutions")):
            raise ScrapeError(f"Incomplete academic-calendar events for {term}")
        if entry["classesEnd"] < entry["classesStart"]:
            raise ScrapeError(f"Reversed term bounds for {term}")
        entry["suspendedDates"] = sorted(set(entry["suspendedDates"]))
        if any(row["date"] in entry["suspendedDates"] for row in entry["substitutions"]):
            raise ScrapeError(f"Conflicting suspension and substitute date for {term}")
        parsed.append(entry)
    return {"sourceUrl": source.url, "scopeSourceUrl": SCOPE_URL,
            "applicableCoursePrefixes": list(PREFIXES), "excludedCoursePrefixes": list(EXCLUDED),
            "terms": parsed,
            "limitations": "General Registrar calendar only. Dental Medicine, Law, Medicine (including GMS), Public Health, Social Work, and unknown course prefixes retain their source schedules until school-specific calendars are imported. Exam dates do not create exam meetings."}


def collect(fetcher):
    source = fetcher.get(SEMESTER_URL)
    scope = fetcher.get(SCOPE_URL)
    scope_text = soup(scope).get_text(" ", strip=True)
    if not all(name in scope_text for name in ("Dental Medicine", "Law", "Medicine", "Public Health", "Social Work")) or "published separately" not in scope_text:
        raise ScrapeError("Registrar's separate-school calendar scope changed")
    sources = []
    for item in (source, scope):
        provenance = item.provenance
        path = Path(provenance["rawPath"])
        if path.is_relative_to(ROOT.parent):
            provenance["rawPath"] = path.relative_to(ROOT.parent).as_posix()
        sources.append(provenance)
    return {"calendar": parse_calendar(source), "sources": sources, "errors": [], "warnings": []}


if __name__ == "__main__":
    run_cli("academic_calendar", collect)
