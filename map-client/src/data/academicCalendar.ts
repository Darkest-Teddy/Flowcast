import { dateForWeekday, meetingActiveOnDate, type CampusData, type SourceMeeting } from './campusData';

export interface AcademicCalendar {
  sourceUrl: string;
  scopeSourceUrl: string;
  applicableCoursePrefixes: string[];
  excludedCoursePrefixes: string[];
  terms: {
    term: string;
    classesStart: string;
    classesEnd: string;
    suspendedDates: string[];
    substitutions: { date: string; scheduleWeekday: number }[];
    sourceUrl: string;
    events: { kind: string; label: string; start: string; end: string }[];
  }[];
  limitations: string;
}

/**
 * A meeting's intervals on one attendance date (Boston calendar day), placed on `weekday` of the
 * week (seconds from Monday 00:00). Empty when the course session, the term's class dates or a
 * suspension rule it out; substitution days ("Monday schedule on a Tuesday") use the substituted timetable.
 */
export function meetingIntervalsOn(meeting: SourceMeeting, data: CampusData, date: string, weekday: number): SourceMeeting['intervals'] {
  const calendar = data.academicCalendar;
  const prefix = meeting.courseCode.split(' ')[0];
  const term = calendar?.applicableCoursePrefixes.includes(prefix)
    ? calendar.terms.find(row => row.term === data.term.toUpperCase()) : undefined;
  if (!meetingActiveOnDate(meeting, date)) return [];
  if (term && (date < term.classesStart || date > term.classesEnd || term.suspendedDates.includes(date))) return [];
  const scheduleWeekday = term?.substitutions.find(row => row.date === date)?.scheduleWeekday ?? weekday;
  return meeting.intervals.filter(interval => interval.weekday === scheduleWeekday).map(interval => {
    const shift = (weekday - scheduleWeekday) * 86400;
    return { weekday, startSec: interval.startSec + shift, endSec: interval.endSec + shift };
  });
}

/** Dates are actual attendance days; interval weekdays describe the published timetable. */
export function effectiveMeetingIntervals(meeting: SourceMeeting, data: CampusData): SourceMeeting['intervals'] {
  return Array.from({ length: 7 }, (_, weekday) => meetingIntervalsOn(meeting, data, dateForWeekday(data, weekday), weekday)).flat();
}
