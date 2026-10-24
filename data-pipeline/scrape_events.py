"""Collect public Terrier Central events without treating registrations as attendance."""

import json
import re
from datetime import datetime
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

from common import ScrapeError, run_cli, soup

LISTING_URL = "https://terriercentral.bu.edu/events"
EXAMPLE_URL = "https://terriercentral.bu.edu/web/rsvp_boot?id=375534"
TIMEZONE = ZoneInfo("America/New_York")


def _text(value):
    return BeautifulSoup(str(value or ""), "html.parser").get_text(" ", strip=True)


def _datetime(value):
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Event date has no timezone")
    return parsed.astimezone(TIMEZONE).isoformat()


def parse_event(source):
    page = soup(source)
    event = None
    for tag in page.select('script[type="application/ld+json"]'):
        text = tag.string or tag.get_text()
        try:
            # Organizer descriptions can contain raw newlines inside JSON strings.
            data = json.loads(text, strict=False)
        except json.JSONDecodeError:
            try:
                # ...and stray backslashes before HTML entities ("\&quot;"), which JSON rejects.
                data = json.loads(re.sub(r'\\(?!["\\/bfnrtu])', r"\\\\", text), strict=False)
            except json.JSONDecodeError:
                continue
        except TypeError:
            continue
        candidates = data if isinstance(data, list) else [data]
        for candidate in candidates:
            if isinstance(candidate, dict):
                graph = candidate.get("@graph", [])
                if isinstance(graph, list):
                    candidates.extend(graph)
                kinds = candidate.get("@type", [])
                kinds = [kinds] if isinstance(kinds, str) else kinds
                if isinstance(kinds, list) and "Event" in kinds:
                    event = candidate
        if event:
            break
    if not event or not event.get("name"):
        raise ScrapeError(f"No public Event JSON-LD found at {source.url}; login or layout change possible")
    event_id = parse_qs(urlsplit(source.url).query).get("id", [None])[0]
    if not event_id:
        raise ScrapeError(f"No event ID in {source.url}")
    location = event.get("location") or {}
    if isinstance(location, list):
        location = location[0] if location else {}
    if isinstance(location, str):
        location = {"name": location}
    if not isinstance(location, dict):
        raise ScrapeError(f"Unexpected event location schema at {source.url}")
    location_name = _text(location.get("name"))
    hidden = bool(re.search(r"private location|sign in|log.?in|hidden", location_name, re.I))
    address = location.get("address")
    if isinstance(address, dict):
        address = ", ".join(str(address.get(key)) for key in (
            "streetAddress", "addressLocality", "addressRegion", "postalCode") if address.get(key))
    organizer = page.select_one(".rsvp__event-org button, #event_host strong")
    organizer_name = organizer.get_text(" ", strip=True) if organizer else None
    if not organizer_name and isinstance(event.get("organizer"), dict):
        organizer_name = event["organizer"].get("name")
    visible = page.select_one(".rsvp__event-name")
    # Limit count matching to visible card text, excluding scripts and accessibility templates.
    root = visible.find_parent(class_="card") if visible else None
    root = root or page
    for tag in root.select("script, style"):
        tag.decompose()
    text = root.get_text(" ", strip=True)
    registered = re.search(r"\b([\d,]+)\s+Registered\b", text, re.I)
    spots = re.search(r"\b([\d,]+)\s+spots?\s+left\b", text, re.I)
    try:
        start, end = _datetime(event.get("startDate")), _datetime(event.get("endDate"))
    except (ValueError, TypeError) as error:
        raise ScrapeError(f"Invalid public event date at {source.url}: {error}") from error
    if not start:
        raise ScrapeError(f"Public event has no usable start time at {source.url}")
    if start and end and datetime.fromisoformat(end) <= datetime.fromisoformat(start):
        raise ScrapeError(f"Event end is not after start at {source.url}")
    return {
        "id": f"terriercentral:{event_id}", "eventId": event_id,
        "name": _text(event["name"]), "organizer": organizer_name,
        "start": start, "end": end, "timezone": "America/New_York",
        "locationName": None if hidden else (location_name or None),
        "locationAddress": None if hidden else address,
        "locationId": None, "locationResolution": "unresolved", "locationStatus": "hidden" if hidden else "unresolved",
        "registrationCount": int(registered[1].replace(",", "")) if registered else None,
        "remainingRegistrationSpots": int(spots[1].replace(",", "")) if spots else None,
        "registrationOptional": True if re.search(r"no registration (?:is )?required", _text(event.get("description")), re.I) else None,
        "observedAttendance": None, "roomCapacity": None,
        "measure": "registrations", "provenance": source.provenance,
        "limitations": ["Registration is neither attendance nor room capacity.",
                        "Multi-day/recurring event spans are not expanded into assumed occurrences."],
    }


def parse_listing(source):
    try:
        payload = json.loads(source.text)
    except json.JSONDecodeError as error:
        raise ScrapeError(f"Event listing did not return JSON: {source.url}") from error
    if not isinstance(payload, list):
        raise ScrapeError(f"Unexpected event listing schema: {source.url}")
    urls = []
    for item in payload:
        if not isinstance(item, dict) or not isinstance(item.get("fields"), str):
            raise ScrapeError(f"Unexpected event listing record at {source.url}")
        fields = item["fields"].split(",")
        if "eventId" not in fields:
            continue
        event_id = item.get(f"p{fields.index('eventId')}")
        if event_id and str(event_id).isdigit():
            urls.append(f"https://terriercentral.bu.edu/web/rsvp_boot?id={event_id}")
    return list(dict.fromkeys(urls))


def collect(fetcher, event_urls=None, max_events=500, max_pages=25):
    """Discover bounded public Terrier Central events or fetch explicit event URLs."""
    if max_events < 1 or max_pages < 1:
        raise ScrapeError("max_events and max_pages must be positive")
    warnings, sources, urls, failures = [], [], list(event_urls or []), []
    if not event_urls:
        source = fetcher.get(LISTING_URL)
        sources.append(source.provenance)
        page = soup(source)
        for link in page.select('a[href*="rsvp_boot?id="]'):
            event_id = parse_qs(urlsplit(link["href"]).query).get("id", [""])[0]
            if event_id.isdigit():
                urls.append(f"https://terriercentral.bu.edu/web/rsvp_boot?id={event_id}")
        # This public GET endpoint is embedded in the listing's getWebServiceUrl function.
        if not urls and "/mobile_ws/v17/" in source.text and "mobile_events_list" in source.text:
            seen = set()
            for index in range(max_pages):
                query = urlencode({"range": index * 40, "limit": 40,
                                   "filter4_contains": "any", "filter4_notcontains": "any",
                                   "order": "", "search_word": ""})
                try:
                    listing = fetcher.get("https://terriercentral.bu.edu/mobile_ws/v17/mobile_events_list?" + query)
                    sources.append(listing.provenance)
                    found = parse_listing(listing)
                except ScrapeError as error:
                    failures.append(f"Event listing page {index + 1}: {error}")
                    break
                fresh = [url for url in found if url not in seen]
                urls.extend(fresh)
                seen.update(fresh)
                if not fresh or len(urls) >= max_events:
                    break
        if not urls:
            raise ScrapeError("No public event links discovered; pass --event-url for known public details. " + "; ".join(failures))
        warnings.append("Public listing discovery is bounded; output is not a complete campus event inventory.")
    if len(set(urls)) > max_events:
        warnings.append(f"Event details truncated to the configured maximum of {max_events}.")
    records, private = [], 0
    for url in list(dict.fromkeys(urls))[:max_events]:
        try:
            parts = urlsplit(url)
            if parts.hostname != "terriercentral.bu.edu" or parts.scheme != "https":
                raise ScrapeError(f"Expected a public HTTPS Terrier Central event URL, got {url}")
            source = fetcher.get(url)
            sources.append(source.provenance)
            # Private events redirect to a sign-in page; they are expected, not a parser failure.
            if parse_qs(urlsplit(source.url).query).get("private_event") == ["1"]:
                private += 1
                continue
            records.append(parse_event(source))
        except ScrapeError as error:
            failures.append(str(error))
    if private:
        warnings.append(f"{private} listed events are private (sign-in required) and were not collected.")
    if not records:
        raise ScrapeError("No public events collected: " + "; ".join(failures))
    return {"events": records, "sources": sources, "warnings": warnings, "errors": failures}


def add_arguments(parser):
    parser.add_argument("--event-url", dest="event_urls", action="append", help="Known public event URL; repeatable")
    parser.add_argument("--max-events", type=int, default=500)
    parser.add_argument("--max-pages", type=int, default=25, help="Maximum 40-entry listing requests")


if __name__ == "__main__":
    run_cli("events", collect, add_arguments)
