export type StudentLevel = 'undergraduate' | 'graduate';
export type CourseLevel = 'undergraduate' | 'mixed' | 'graduate' | 'nondegree' | 'unknown';

export const COURSE_LEVEL_SOURCE = 'https://www.bu.edu/academics/bulletin/abbreviations-and-symbols/';
export const PDP_NONCREDIT_SOURCE = 'https://www.bu.edu/fitrec/2024/02/27/fall-2024-changes-to-physical-education-pdp-program-offerings/';

/** Default modeling eligibility; individual permissions and prerequisites are unavailable. */
export function courseLevel(courseCode: string): CourseLevel {
  const code = courseCode.trim().toUpperCase().replace(/\s+/g, ' ');
  if (/^PDP\b/.test(code)) return 'nondegree';
  const number = /\b(\d{3})[A-Z]*$/.exec(code);
  if (!number) return 'unknown';
  const value = Number(number[1]);
  if (value < 100) return 'nondegree';
  // Professional MD numbering is an exception to BU's general numeric guide.
  if (/^MED MD\b/.test(code) || /^(GMS|GRS)\b/.test(code)) return 'graduate';
  if (value < 400) return 'undergraduate';
  if (value < 600) return 'mixed';
  return 'graduate';
}

export function eligibleStudentLevels(courseCode: string): StudentLevel[] {
  const level = courseLevel(courseCode);
  if (level === 'undergraduate') return ['undergraduate'];
  if (level === 'graduate') return ['graduate'];
  return ['undergraduate', 'graduate'];
}

export function countsTowardDegreeLoad(courseCode: string): boolean {
  return courseLevel(courseCode) !== 'nondegree';
}
