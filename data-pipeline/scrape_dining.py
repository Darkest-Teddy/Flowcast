"""Collect public dining windows and separately typed, dated capacity/volume evidence."""

import hashlib
import re
from datetime import datetime
from urllib.parse import urljoin, urlsplit

from common import ScrapeError, main_content, run_cli, soup

OPEN_NOW = "https://www.bu.edu/dining/open-now/"
DIRECTORY = "https://www.bu.edu/dining/where-to-eat/"
WARREN = "https://www.bu.edu/articles/2026/warren-towers-tower-a-reopens-to-students/"
WEST = "https://www.bu.edu/articles/2022/video-tour-of-west-campus/"
MARCIANO = "https://www.bu.edu/parentmagazine/2012/07/26/center-brings-student-services-together/"
VOLUMES = "https://www.bu.edu/articles/2017/bu-dining/"
AFTER_HOURS = "https://www.bu.edu/articles/2026/dining-services-expands-offerings/"
ARTICLE_URLS = [WARREN, WEST, MARCIANO, VOLUMES, AFTER_HOURS]


def publication_date(source):
    """A page update is not its publication or observation date."""
    document = soup(source)
    node = document.select_one('meta[property="article:published_time"], meta[name="date"]')
    if node and node.get("content"):
        return node["content"][:10]
    node = document.select_one(".wp-prepress-component-metabar-date")
    if node:
        try:
            return datetime.strptime(node.get_text(" ", strip=True), "%B %d, %Y").date().isoformat()
        except ValueError:
            pass
    match = re.search(r"/(\d{4})/(\d{2})/(\d{2})/", source.url)
    if match:
        return "-".join(match.groups())
    match = re.search(r"/(\d{4})/", source.url)
    return match.group(1) if match else None


def article_paragraphs(source):
    document = main_content(source)
    article = document.select_one("article.bu-article") or document
    for unwanted in article.select(".comments-area, #comments, .comment-body, script, style, nav, footer"):
        unwanted.decompose()
    return [re.sub(r"\s+", " ", p.get_text(" ", strip=True)) for p in article.select("p")]


def measurement(source, entity, metric, value, unit, evidence, *, basis="published", **extra):
    identity = "|".join([source.url, entity, metric, extra.get("period", "")])
    return {
        "id": hashlib.sha256(identity.encode()).hexdigest()[:20],
        "entityKey": entity,
        "locationId": None,
        "locationResolution": "unresolved",
        "metric": metric,
        "value": value,
        "unit": unit,
        "basis": basis,
        "sourcePublishedDate": publication_date(source),
        "observationDate": None,
        "evidence": evidence,
        "provenance": source.provenance,
        **extra,
    }


def parse_dining_hours(source):
    records = []
    for item in soup(source).select(".dining-opennow-item"):
        title = item.select_one("h3")
        link = item.select_one('a[href*="/dining/location/"]')
        if not title or not link:
            continue
        url = urljoin(source.url, link["href"]).split("#")[0]
        entity = "dining:" + urlsplit(url).path.rstrip("/").split("/")[-1]
        windows = []
        for block in item.select(".dining-opennow-schedule"):
            opening, closing = block.get("data-open", ""), block.get("data-close", "")
            valid = all(re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", t) for t in (opening, closing))
            label = block.select_one("strong")
            windows.append({
                "label": label.get_text(" ", strip=True).rstrip(":") if label else None,
                "opensLocal": opening if valid else None,
                "closesLocal": closing if valid else None,
                "crossesMidnight": closing <= opening if valid else None,
                "rawText": block.get_text(" ", strip=True),
                "status": "parsed" if valid else "unavailable",
            })
        campus = item.select_one(".dining-opennow-campus")
        records.append({
            "id": entity,
            "name": title.get_text(" ", strip=True),
            "url": url,
            "campus": campus.get_text(" ", strip=True) if campus else None,
            "timezone": "America/New_York",
            "scheduleDate": None,
            "scheduleScope": "retrieved_page_snapshot",
            "dateStatus": "page_does_not_explicitly_identify_service_date",
            "windows": windows,
            "locationId": None,
            "locationResolution": "unresolved",
            "provenance": source.provenance,
        })
    if not records:
        raise ScrapeError(f"No dining location cards found at {source.url}; page structure may have changed")
    return records


def parse_dining_metrics(source):
    records = []
    for p in article_paragraphs(source):
        if source.url.rstrip("/") == WARREN.rstrip("/"):
            m = re.search(r"dining hall serves (?:about |around )?([\d,]+) meals a day", p, re.I)
            if m:
                records.append(measurement(source, "dining:warren", "throughput", int(m[1].replace(",", "")), "meals/day", p, approximate=True))
        elif source.url.rstrip("/") == WEST.rstrip("/"):
            m = re.search(r"(?:dining hall|Fresh Food Co\.).*?seats ([\d,]+)", p, re.I)
            if m:
                records.append(measurement(source, "dining:west", "capacity", int(m[1].replace(",", "")), "seats", p))
        elif source.url.rstrip("/") == MARCIANO.rstrip("/"):
            if "Marciano" not in p:
                continue
            for pattern, metric, unit in [
                (r"dining hall seats ([\d,]+)", "capacity", "seats"),
                (r"serves (?:around |about )?([\d,]+) meals every day", "throughput", "meals/day"),
            ]:
                m = re.search(pattern, p, re.I)
                if m:
                    records.append(measurement(source, "dining:marciano", metric, int(m[1].replace(",", "")), unit, p, approximate=metric == "throughput"))
        elif source.url.rstrip("/") == VOLUMES.rstrip("/"):
            if "three main dining halls" not in p:
                continue
            for number, period in re.findall(r"([\d,]+) (breakfasts|lunches|dinners)", p):
                records.append(measurement(source, "dining:three-main-halls", "throughput", int(number.replace(",", "")), "meals/day", p, period=period, aggregate=True, members=["dining:warren", "dining:west", "dining:marciano"]))
            m = re.search(r"([\d,]+) customers served in the George Sherman Union Food Court every week", p, re.I)
            if m:
                records.append(measurement(source, "dining:gsu", "throughput", int(m[1].replace(",", "")), "customer-visits/week", p))
    return list({r["id"]: r for r in records}.values())


def collect(fetcher, **_):
    """Collect dining location snapshots and dated capacity/throughput evidence."""
    sources, warnings, records, metrics, notices, errors = [], [], [], [], [], []
    for url in [OPEN_NOW, DIRECTORY, *ARTICLE_URLS]:
        try:
            source = fetcher.get(url)
            sources.append(source.provenance)
            if url == OPEN_NOW:
                records.extend(parse_dining_hours(source))
            elif url in ARTICLE_URLS:
                found = parse_dining_metrics(source)
                metrics.extend(found)
                if url != AFTER_HOURS and not found:
                    errors.append(f"No expected capacity/volume evidence parsed from {url}")
                if url == AFTER_HOURS:
                    for paragraph in article_paragraphs(source):
                        if "After Hours" in paragraph:
                            notices.append({"kind": "operating_hours_article", "rawText": paragraph, "sourcePublishedDate": publication_date(source), "provenance": source.provenance})
            else:
                links = {urljoin(url, a["href"]).split("#")[0] for a in main_content(source).select('a[href*="/dining/location/"]')}
                known = {r["url"] for r in records}
                for link in sorted(links - known):
                    records.append({"id": "dining:" + urlsplit(link).path.rstrip("/").split("/")[-1], "url": link, "name": None, "windows": [], "scheduleDate": None, "timezone": "America/New_York", "locationId": None, "locationResolution": "unresolved", "provenance": source.provenance})
        except ScrapeError as exc:
            errors.append(str(exc))
    warnings.append("Dining windows are page snapshots with an unverified service date, not a reusable weekly schedule. Meals/visits are throughput, not unique people or concurrent occupancy.")
    if not records and not metrics:
        raise ScrapeError("No public dining locations or evidence collected")
    return {"locations": records, "measurements": metrics, "notices": notices, "sources": sources, "warnings": warnings, "errors": errors}


if __name__ == "__main__":
    run_cli("dining", collect)
