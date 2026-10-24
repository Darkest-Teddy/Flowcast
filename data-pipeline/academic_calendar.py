"""Apply saved academic calendar facts without acquisition dependencies."""

from datetime import date, timedelta


def effective_intervals(meeting, week_start, calendar, term=None):
    """Map published schedule weekdays onto actual dates in one Monday-first week."""
    if isinstance(week_start, str):
        week_start = date.fromisoformat(week_start)
    prefix = meeting.get("courseCode", "").split(" ", 1)[0]
    applies = calendar and prefix in calendar["applicableCoursePrefixes"]
    term_name = (term or meeting.get("term", "")).upper()
    selected = next((row for row in calendar["terms"] if row["term"] == term_name), None) if applies else None
    substitutions = {row["date"]: row["scheduleWeekday"] for row in selected["substitutions"]} if selected else {}
    result = []
    for weekday in range(7):
        stamp = (week_start + timedelta(days=weekday)).isoformat()
        if meeting.get("validFrom", stamp) > stamp or meeting.get("validTo", stamp) < stamp:
            continue
        if selected and (stamp < selected["classesStart"] or stamp > selected["classesEnd"] or stamp in selected["suspendedDates"]):
            continue
        schedule_weekday = substitutions.get(stamp, weekday)
        for interval in meeting.get("intervals", []):
            if interval["weekday"] == schedule_weekday:
                shift = (weekday - schedule_weekday) * 86400
                result.append({"weekday": weekday, "startSec": interval["startSec"] + shift, "endSec": interval["endSec"] + shift})
    return result
