"""Extract BU's published Fall 2025 headcounts and housing baseline."""

from io import BytesIO
from pathlib import Path
import re

from pypdf import PdfReader

from common import ROOT, ScrapeError, run_cli

CDS_ENROLLMENT = "https://www.bu.edu/asir/files/2026/05/CDS-2025-2026-B.pdf"
CDS_HOUSING = "https://www.bu.edu/asir/files/2026/05/CDS-2025-2026-F.pdf"
FACT_SHEET = "https://www.bu.edu/asir/files/2026/06/G3b-Fact-Sheet-FY2026.pdf"
NUMBER = r"([\d,]+)"


def numbers_after(text, label, count=1):
    match = re.search(re.escape(label) + r"\s+" + r"\s+".join([NUMBER] * count), text)
    if not match:
        raise ScrapeError(f"Population source missing expected row: {label}")
    return [int(value.replace(",", "")) for value in match.groups()]


def parse_enrollment(text):
    if "2025-2026" not in text:
        raise ScrapeError("Expected 2025-2026 CDS enrollment")
    cohorts = []
    for level in ("Undergraduate", "Graduate"):
        for attendance in ("Full-Time", "Part-Time"):
            headcount = sum(numbers_after(text, f"Total {level} {attendance} Students", 2))
            cohorts.append({"level": level.lower(), "attendance": attendance.lower(), "headcount": headcount})
    undergraduate = numbers_after(text, "Total all undergraduates")[0]
    graduate = numbers_after(text, "Total all graduate")[0]
    total = numbers_after(text, "GRAND TOTAL ALL STUDENTS")[0]
    degree_rows = re.findall(r"Total degree-seeking\s+([\d,]+)\s+([\d,]+)", text.split("Graduate Students: Full-Time")[0])
    if len(degree_rows) != 2:
        raise ScrapeError("Expected full-time and part-time degree-seeking undergraduate rows")
    degree_seeking = sum(int(n.replace(",", "")) for row in degree_rows for n in row)
    if (sum(c["headcount"] for c in cohorts[:2]) != undergraduate
            or sum(c["headcount"] for c in cohorts[2:]) != graduate
            or undergraduate + graduate != total or not 0 < degree_seeking <= undergraduate):
        raise ScrapeError("Published enrollment totals do not reconcile")
    return {"reportingPeriod": "Fall 2025 CDS census", "unit": "people", "total": total,
            "undergraduate": undergraduate, "graduate": graduate,
            "degreeSeekingUndergraduate": degree_seeking, "cohorts": cohorts,
            "exclusivelyDistanceEducation": None, "charlesRiverHeadcount": None,
            "medicalHeadcount": None}


def parse_housing(text, denominator):
    if "degree-seeking undergraduates enrolled in Fall 2025" not in text:
        raise ScrapeError("Housing denominator or reporting period changed")
    # This PDF places the housing label after the table in reading order.
    match = re.search(r"(\d+)%\s+(\d+)%\s+Percent who live off campus or commute\s+(\d+)%\s+(\d+)%", text)
    if not match or "-affiliated housing" not in text:
        raise ScrapeError("Expected housing and commuting percentage rows")
    first_year, residents, first_year_off, off_campus = map(int, match.groups())
    if first_year + first_year_off != 100 or residents + off_campus != 100:
        raise ScrapeError("Housing percentages do not reconcile")
    return {"degreeSeekingUndergraduateResidentPercent": residents,
            "denominatorHeadcount": denominator, "denominator": "degree-seeking undergraduates",
            "estimatedUndergraduateResidents": round(denominator * residents / 100),
            "estimateBasis": "CDS F1 rounded percentage multiplied by CDS B1 degree-seeking undergraduate headcount; not an exact resident count"}


def parse_fact_sheet(text):
    if "FACT SHEET 2025/2026" not in text:
        raise ScrapeError("Expected FY2026 fact sheet")
    capacity = numbers_after(text, "Residences - Total Capacity")[0]
    employee_section = text.split("A. TOTAL UNIVERSITY EMPLOYEES", 1)[-1]
    crc, medical, overseas, total = numbers_after(employee_section, "TOTAL", 4)
    if crc + medical + overseas != total:
        raise ScrapeError("Employee headcounts do not reconcile")
    campus_fte = {}
    for campus, label in (("charlesRiver", "B. CHARLES RIVER CAMPUS, FTE ENROLLMENTS"),
                          ("medical", "B. MEDICAL CAMPUS, FTE ENROLLMENTS")):
        if label not in text:
            raise ScrapeError(f"Missing campus FTE section: {label}")
        section = text.split(label, 1)[1]
        row = re.search(r"^TOTAL\s+[\d,]+\s+([\d,]+)\s+-?\d+\.\d+(?:\s|$)", section, re.M)
        if not row:
            raise ScrapeError(f"Missing campus FTE total and change: {label}")
        campus_fte[campus] = int(row[1].replace(",", ""))
    return {"residenceCapacity": capacity,
            "employees": {"unit": "people", "reportingPeriod": "End of November 2025 payroll",
                          "total": total, "charlesRiver": crc, "medical": medical, "overseas": overseas,
                          "scope": "University employees; excludes extramural medical faculty"},
            "campusStudentFte": {"unit": "full-time equivalents", "reportingPeriod": "End of Semester I Fall 2025",
                                 **campus_fte}}


def collect(fetcher):
    """Read cached official population reports; refresh only when requested."""
    sources = [fetcher.get(url) for url in (CDS_ENROLLMENT, CDS_HOUSING, FACT_SHEET)]
    texts = ["\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(source.body)).pages) for source in sources]
    students = parse_enrollment(texts[0])
    housing = parse_housing(texts[1], students["degreeSeekingUndergraduate"])
    fact = parse_fact_sheet(texts[2])
    housing["residenceCapacity"] = fact.pop("residenceCapacity")
    provenance = []
    for source in sources:
        entry = source.provenance
        if entry["rawPath"]:
            try:
                entry["rawPath"] = str(Path(entry["rawPath"]).relative_to(ROOT.parent))
            except ValueError:
                entry["rawPath"] = None
        provenance.append(entry)
    return {"students": students, "housing": housing, **fact, "sources": provenance,
            "limitations": [
                "Institutional enrollment is not simultaneous campus occupancy. Online-only and campus-specific student headcounts are not established by these reports.",
                "Campus student FTE measures enrollment intensity, not people; never use it as a headcount or a campus allocation ratio.",
                "Residence capacity is beds, not occupied beds. Undergraduate resident headcount is estimated from a rounded published percentage.",
                "CDS uses the fall census; the fact sheet uses end-of-semester enrollment. Their student totals must not be combined.",
                "Employee headcounts are not daily attendance and may overlap enrolled students."
            ], "errors": []}


if __name__ == "__main__":
    run_cli("population", collect)
