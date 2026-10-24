"""Collect housing directories and dated residential baselines without summing overlaps."""

import re
from collections import deque
from io import BytesIO
from urllib.parse import urljoin, urlsplit

from pypdf import PdfReader

from common import ScrapeError, main_content, run_cli, soup
from scrape_dining import WARREN, WEST, article_paragraphs, measurement, publication_date

DIRECTORY = "https://www.bu.edu/housing/undergrad-housing/residences/"
STUVI1 = "https://www.bu.edu/housing/residence/student-village/10-buick-street/"
STUVI2 = "https://www.bu.edu/housing/residence/student-village/33-harry-agganis-way/"
TOWERS = "https://www.bu.edu/articles/2023/video-a-tour-of-the-towers/"
BEACON_PDF = "https://www.bu.edu/community/files/2024/02/BU-IMPNF-for-Renewal-7th-Amendment.pdf"


def parse_housing_page(source):
    document = soup(source)
    content = main_content(source)
    heading = document.select_one("h1")
    name = heading.get_text(" ", strip=True) if heading else urlsplit(source.url).path.rstrip("/").split("/")[-1]
    paragraphs = article_paragraphs(source)
    entity = "housing:" + urlsplit(source.url).path.rstrip("/").split("/")[-1]
    record = {"id": entity, "name": name, "url": source.url, "pageKind": "residence" if document.select_one("article.type-residence") else "directory", "sourcePublishedDate": publication_date(source), "locationId": None, "locationResolution": "unresolved", "provenance": source.provenance}
    address = next((p for p in paragraphs if p.startswith("Residence Life Office:")), None)
    record["residenceLifeOfficeAddress"] = address.partition(":")[2].strip() if address else None
    metrics = []
    for p in paragraphs:
        for m in re.finditer(r"\b(?:accommodates|houses|home to)\s+(?:approximately\s+|about\s+)?([\d,]+)\s+(?:residents|students)\b", p, re.I):
            metrics.append(measurement(source, entity, "residential_baseline", int(m[1].replace(",", "")), "residential-spaces", p, basis="published_residential_description", currentOccupancy=False))
    inventory = []
    words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}
    for p in paragraphs:
        for count, size in re.findall(r"\b([\d,]+)\s+(one|two|three|four|five|six|\d+)[-\s]person apartments\b", p, re.I):
            number, places = int(count.replace(",", "")), words.get(size.lower())
            places = places if places is not None else int(size)
            inventory.append({"apartments": number, "spacesPerApartment": places, "evidence": p})
    if inventory:
        inventory = list({(r["apartments"], r["spacesPerApartment"]): r for r in inventory}.values())
        metrics.append(measurement(source, entity, "capacity", sum(r["apartments"] * r["spacesPerApartment"] for r in inventory), "bed-spaces", " ".join(dict.fromkeys(r["evidence"] for r in inventory)), basis="inventory_derived", components=inventory, currentOccupancy=False))
    links = sorted({urljoin(source.url, a["href"]).split("#")[0] for a in content.select('a[href*="/housing/residence/"]') if urlsplit(urljoin(source.url, a["href"])).netloc == "www.bu.edu"})
    return record, list({m["id"]: m for m in metrics}.values()), links


def parse_article_baselines(source):
    records = []
    for p in article_paragraphs(source):
        if source.url.rstrip("/") == WARREN.rstrip("/"):
            m = re.search(r"complex, which houses ([\d,]+) students per year", p, re.I)
            if m:
                records.append(measurement(source, "housing:warren-towers", "residential_baseline", int(m[1].replace(",", "")), "residential-spaces", p, basis="nominal_complex_total", aggregate=True, includes=["housing:warren-tower-a", "housing:warren-tower-b", "housing:warren-tower-c"], currentOccupancy=False, warning="Staggered renovation closures and relocations require target-date confirmation."))
            m = re.search(r"Tower A houses ([\d,]+) students", p, re.I)
            if m:
                records.append(measurement(source, "housing:warren-tower-a", "residential_baseline", int(m[1].replace(",", "")), "residential-spaces", p, basis="published_tower_subset", partOf="housing:warren-towers", currentOccupancy=False))
        elif source.url.rstrip("/") == WEST.rstrip("/"):
            m = re.search(r"three.*?residential towers.*?home to approximately ([\d,]+) students", p, re.I)
            if m:
                records.append(measurement(source, "housing:west-campus", "residential_baseline", int(m[1].replace(",", "")), "residential-spaces", p, basis="published_group_total", aggregate=True, includes=["housing:claflin-hall", "housing:sleeper-hall", "housing:rich-hall"], perBuildingSplit=None, currentOccupancy=False))
        elif source.url.rstrip("/") == TOWERS.rstrip("/"):
            m = re.search(r"Home to ([\d,]+) students", p, re.I)
            if m:
                records.append(measurement(source, "housing:the-towers", "residential_baseline", int(m[1].replace(",", "")), "residential-spaces", p, basis="dated_population_description", currentOccupancy=False))
    return records


def parse_beacon_pdf(source):
    try:
        reader = PdfReader(BytesIO(source.body))
        page = reader.pages[33].extract_text()
    except Exception as exc:
        raise ScrapeError(f"Cannot read housing planning PDF page 34: {exc}") from exc
    # Restrict the match to the residence paragraph rather than arbitrary report tables.
    normalized = re.sub(r"\s+", " ", page)
    match = re.search(r"(?:610 Beacon|Myles Standish).{0,1600}?renovation.{0,700}?provide space for (\d[\d,]*)\s+(?:beds|students|residents)\b", normalized, re.I)
    if not match:
        raise ScrapeError("610 Beacon/Myles residential figure not found on planning PDF page 34")
    return measurement(source, "housing:610-beacon-street", "residential_baseline", int(match[1].replace(",", "")), "residential-spaces", match[0], basis="planning_document_post_renovation", sourcePublishedDate="2024-02", pdfPage=34, printedPage="2-21", currentOccupancy=False)


def add_arguments(parser):
    parser.add_argument("--max-pages", type=int, default=45, help="Maximum housing-directory and detail pages to fetch")


def collect(fetcher, max_pages=45):
    """Collect residence metadata, sourced baselines, and overlap relationships."""
    if max_pages < 1:
        raise ScrapeError("max-pages must be positive")
    sources, records, metrics, warnings, errors, directories = [], [], [], [], [], []
    queue, visited = deque([STUVI1, STUVI2, DIRECTORY]), set()
    while queue and len(visited) < max_pages:
        url = queue.popleft()
        if url in visited:
            continue
        visited.add(url)
        try:
            source = fetcher.get(url)
            sources.append(source.provenance)
            record, evidence, links = parse_housing_page(source)
            (records if record["pageKind"] == "residence" else directories).append(record)
            metrics.extend(evidence)
            queue.extend(link for link in links if link not in visited)
        except ScrapeError as exc:
            errors.append(str(exc))
    if queue:
        warnings.append(f"Housing discovery capped at {max_pages} pages; {len(set(queue) - visited)} discovered URLs remain unvisited")
    for url in [WARREN, WEST, TOWERS, BEACON_PDF]:
        try:
            source = fetcher.get(url)
            sources.append(source.provenance)
            evidence = [parse_beacon_pdf(source)] if url == BEACON_PDF else parse_article_baselines(source)
            if not evidence:
                errors.append(f"No expected residential evidence found at {url}")
            metrics.extend(evidence)
        except ScrapeError as exc:
            errors.append(str(exc))
    if not records and not metrics:
        raise ScrapeError("No public housing data collected")
    warnings.append("Residential baselines are dated capacities or population descriptions, never current occupancy. Do not sum a complex and its subsets or split an aggregate evenly without evidence. Map entity aliases and validate reachable entrances before simulation use.")
    return {"residences": records, "directoryPages": directories, "measurements": list({r["id"]: r for r in metrics}.values()), "sources": sources, "warnings": warnings, "errors": errors}


if __name__ == "__main__":
    run_cli("housing", collect, add_arguments)
