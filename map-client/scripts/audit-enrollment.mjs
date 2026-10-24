// Weekly membership diagnostics; run with Node 26 against saved datasets.
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { buildPopulation } = await import('../src/sim/population.ts');
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
const source = read('campus-data');
const base = buildPopulation(read('demo-day'), source, read('population'));
const agents = new Map(base.agents.map(agent => [agent.id, agent]));
const meetings = new Map(Object.values(source.locations).flatMap(location => location.meetings.map(meeting => [meeting.id, meeting])));
const enrollments = new Map(), sections = new Map();
for (let weekday = 0; weekday < 7; weekday++) {
  for (const assignment of buildSourceDay(base, source, weekday).sourceAssignments) {
    const meeting = meetings.get(assignment.meetingId);
    const section = `${meeting.courseCode}:${meeting.section}`;
    enrollments.set(`${assignment.agentId}>${section}`, { agent: agents.get(assignment.agentId), meeting });
    const row = sections.get(section) ?? { people: new Set(), cap: Infinity };
    row.people.add(assignment.agentId);
    row.cap = Math.min(row.cap, meeting.roomCapacity ?? 24);
    sections.set(section, row);
  }
}
const report = { population: base.agents.length, weeklyUniqueEnrollments: enrollments.size,
  ugEnrollments: 0, ugIn600Plus: 0, ugInProfessionalPrefixes: 0,
  gradEnrollments: 0, gradIn100to399NonProfessional: 0, reservedProgramEnrollments: 0 };
const perAgent = new Map();
for (const { agent, meeting } of enrollments.values()) {
  const number = Number(/\b(\d{3})(?:\D|$)/.exec(meeting.courseCode)?.[1]);
  const school = meeting.courseCode.split(' ')[0];
  const professionalPrefix = /^(MED|GMS|SPH|LAW|SDM)\b/.test(meeting.courseCode);
  if (agent.studentLevel === 'undergraduate') {
    report.ugEnrollments++;
    if (number >= 600) report.ugIn600Plus++;
    if (professionalPrefix) report.ugInProfessionalPrefixes++;
  } else {
    report.gradEnrollments++;
    if (number >= 100 && number < 400 && !professionalPrefix) report.gradIn100to399NonProfessional++;
  }
  if (/reserved for/i.test(meeting.notes ?? '')) report.reservedProgramEnrollments++;
  const row = perAgent.get(agent.id) ?? { courses: new Set(), schools: new Set() };
  row.courses.add(meeting.courseCode); row.schools.add(school); perAgent.set(agent.id, row);
}
const multi = [...perAgent.values()].filter(row => row.courses.size >= 3);
const known = [...sections.values()].filter(row => Number.isFinite(row.cap) && row.cap > 0);
Object.assign(report, {
  studentsWith3PlusCourses: multi.length,
  studentsWith3PlusSchools: multi.filter(row => row.schools.size >= 3).length,
  meanSchoolsFor3Plus: multi.length ? multi.reduce((sum, row) => sum + row.schools.size, 0) / multi.length : 0,
  activeSections: known.length,
  fullyFilledSections: known.filter(row => row.people.size >= row.cap).length,
  meanSeatFraction: known.length ? known.reduce((sum, row) => sum + row.people.size / row.cap, 0) / known.length : 0,
});
writeFileSync(new URL('../audits/enrollment-after.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
