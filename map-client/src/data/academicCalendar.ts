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

/** Dates are actual attendance days; interval weekdays describe the published timetable. */
export function effectiveMeetingIntervals(meeting: SourceMeeting, data: CampusData): SourceMeeting['intervals'] {
  const calendar = data.academicCalendar;
  const prefix = meeting.courseCode.split(' ')[0];
  const term = calendar?.applicableCoursePrefixes.includes(prefix)
    ? calendar.terms.find(row => row.term === data.term.toUpperCase()) : undefined;
  return Array.from({ length: 7 }, (_, weekday) => {
    const date = dateForWeekday(data, weekday);
    if (!meetingActiveOnDate(meeting, date)) return [];
    if (term && (date < term.classesStart || date > term.classesEnd || term.suspendedDates.includes(date))) return [];
    const scheduleWeekday = term?.substitutions.find(row => row.date === date)?.scheduleWeekday ?? weekday;
    return meeting.intervals.filter(interval => interval.weekday === scheduleWeekday).map(interval => {
      const shift = (weekday - scheduleWeekday) * 86400;
      return { weekday, startSec: interval.startSec + shift, endSec: interval.endSec + shift };
    });
  }).flat();
}
