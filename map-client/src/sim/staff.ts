// BU faculty and staff (employees) on campus: a roster from BU's published employee headcounts and
// a simple, labelled working day. Students are planned first (sim/sourceDay.ts); employees are
// planned after every student and only use room the students leave, so adding them never moves a
// student. Every number below is a named model assumption unless it cites a published source.
import type { Agent, CampusLocation } from './playback';

/** The `employees` block of population.json (BU Facts & Figures FY2026, end of November 2025 payroll). */
export interface EmployeeHeadcounts {
  total: number;
  charlesRiver: number;
  medical: number;
  overseas?: number;
  reportingPeriod: string;
  scope?: string;
}

/** Marks an agent as an employee (faculty or staff); students carry no role. */
export const isStaff = (agent: Pick<Agent, 'role'>): boolean => agent.role === 'staff';

/**
 * The working day. All uncalibrated model assumptions (no BU attendance, badge or schedule data):
 * - onSiteShare: share of employees on campus on an ordinary weekday. Covers hybrid/remote days,
 *   leave, part-time schedules and work away from the mapped buildings. Weekends and university
 *   holidays: nobody (weekend shifts in dining, athletics, facilities and research are not modeled).
 * - arrive / leave: most at the desk between 08:00–09:00 and leaving 17:00–18:00; a `shoulderShare`
 *   keep earlier or later hours (07:00–10:30 in, 15:30–19:00 out: faculty and flexible schedules), with
 *   at least `minHours` on site. Each person keeps a usual time for the week with a small daily jitter.
 * - lunch: 11:45–13:15 for 30 minutes; a share eat at a campus dining venue, a share leave campus
 *   through their gateway, and the rest eat at their desk. Residential dining halls are meal-plan
 *   halls and carry a reduced weight.
 * - gym: a share of on-site employees use a campus gym that day (FitRec offers faculty/staff
 *   memberships), before work, at lunch (instead of a meal) or after work.
 */
export const STAFF_ASSUMPTIONS = Object.freeze({
  onSiteShare: 0.75,
  arrive: [8, 9] as const,
  leave: [17, 18] as const,
  shoulderShare: 0.3,
  arriveShoulder: [7, 10.5] as const,
  leaveShoulder: [15.5, 19] as const,
  minHours: 6,
  dailyJitterMinutes: 10,
  lunch: { window: [11.75, 13.25] as const, minutes: 30, campusDiningShare: 0.3, offCampusShare: 0.15 },
  residentialHallWeight: 0.15,
  /** After work, the visit starts within `afterSpreadHours` of leaving the desk (working late first). */
  gym: { share: 0.12, minutes: 50, slots: { before: 0.2, lunch: 0.25, after: 0.55 }, beforeWindow: [6.25, 7.75] as const, lunchWindow: [11.75, 12.75] as const,
    afterSpreadHours: 1.5 },
  /** Different mapped academic buildings tried for an employee's workplace before they work off the map. */
  workplaceAttempts: 4,
});

/** BU's residential (meal-plan) dining halls; retail venues (GSU, cafés, the pub) have no reduction. */
export const RESIDENTIAL_DINING_HALLS: ReadonlySet<string> = new Set(['warren-dining', 'west-dining', 'marciano', 'fenway-dining']);

export const STAFF_ASSUMPTION_TEXT = (employees: EmployeeHeadcounts | undefined): string[] => {
  const a = STAFF_ASSUMPTIONS;
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  return [
    `BU faculty and staff are simulated from the published employee headcount${employees ? ` (${employees.total.toLocaleString('en-US')}: ${employees.charlesRiver.toLocaleString('en-US')} Charles River, ${employees.medical.toLocaleString('en-US')} Medical; ${employees.reportingPeriod})` : ''}. Headcounts are not daily attendance and may overlap enrolled students; each employee's day is a modeled assumption, not observed.`,
    `A modeled ${pct(a.onSiteShare)} of employees are on campus on a weekday (hybrid and remote days, leave and part-time schedules are not published); none on weekends or university holidays. They commute in like commuting students (the same 31.5% transit share, which BU's master plan measured over employees and students together), most at their desk 08:00–09:00 and leaving 17:00–18:00 (${pct(a.shoulderShare)} keep earlier or later hours, 07:00–10:30 in and 15:30–19:00 out).`,
    'Each employee works in one mapped academic building on their campus for the week (buildings with published classes; places described only by an estimated student-activity profile are left out), drawn in proportion to its capacity (offices are not mapped separately), and counts against that building\'s capacity. Employees are planned after every student and use only room students leave; one whose building has no room that day (up to 4 buildings are tried) works off the map.',
    `Lunch 11:45–13:15: ${pct(a.lunch.campusDiningShare)} at a campus dining venue (residential meal-plan halls weighted ${a.residentialHallWeight}×), ${pct(a.lunch.offCampusShare)} off campus through their gateway, the rest at their desk. ${pct(a.gym.share)} use a campus gym that day: before work, at lunch or after work. All uncalibrated.`,
  ];
};

function hash(key: string): number {
  let n = 2166136261;
  for (let i = 0; i < key.length; i++) n = Math.imul(n ^ key.charCodeAt(i), 16777619);
  n ^= n >>> 16; n = Math.imul(n, 0x85ebca6b); n ^= n >>> 13;
  return (n >>> 0) / 4294967296;
}

/** One agent per published employee, after the students: off campus at night, commuting in. */
export function buildStaffRoster(employees: EmployeeHeadcounts | undefined, campuses: readonly string[]): Agent[] {
  if (!employees) return [];
  const rows: [string, number][] = [['charles-river', employees.charlesRiver], ['medical', employees.medical]];
  const agents: Agent[] = [];
  for (const [campus, headcount] of rows) {
    if (!Number.isInteger(headcount) || headcount < 0) throw new Error('Invalid employee headcount');
    if (!campuses.includes(campus)) continue;
    for (let i = 0; i < headcount; i++) {
      const id = `staff:${campus}:${i}`;
      agents.push({ id, home: 'off-campus', residency: 'commuter', role: 'staff', campus, academicCampus: campus,
        model: Math.floor(hash(`model:${id}`) * 12), walkSpeed: 1.4 });
    }
  }
  return agents;
}

export type StaffStopKind = 'work' | 'dining' | 'gym' | 'off-campus-meal';
export interface StaffStop { location: string; start: number; end: number; weekday: number; pool: ''; activity: StaffStopKind }
export interface StaffDayStats {
  /** Employees in the roster, and those on campus today (in a mapped building or working off the map). */
  roster: number;
  onSite: number;
  inMappedBuildings: number;
  workingOffMap: number;
  lunchAtDining: number;
  lunchOffCampus: number;
  gymVisits: number;
}
export const emptyStaffStats = (): StaffDayStats => ({ roster: 0, onSite: 0, inMappedBuildings: 0, workingOffMap: 0, lunchAtDining: 0, lunchOffCampus: 0, gymVisits: 0 });

/** What the planner lends the employee day: walking times, opening hours and an atomic try-and-reserve. */
export interface StaffPlanContext {
  agent: Agent;
  weekday: number;
  /** Mapped academic buildings on the employee's campus, with weights (capacity). */
  workplaces: readonly { id: string; weight: number }[];
  dining: readonly CampusLocation[];
  gyms: readonly CampusLocation[];
  /** Seconds of walking between two places ('off-campus' = the agent's gateway), Infinity without a route. */
  walk(from: string, to: string): number;
  isOpen(stop: StaffStop): boolean;
  /** Plan the day with these stops; if it fits every capacity, keep it and return true. */
  commit(stops: StaffStop[], addedSeconds: number): boolean;
  /** Transit riders eat at work or on campus (an off-campus lunch would be a train ride). */
  rider: boolean;
  venueWeight(capacity: number, travelSeconds: number): number;
}

const H = 3600;
const MARGIN = 60;
const between = (u: number, [from, to]: readonly [number, number]) => (from + u * (to - from)) * H;

/** Stable workplace order for the week: weighted draws without replacement. */
export function workplaceOrder(agentId: string, workplaces: readonly { id: string; weight: number }[], attempts: number): string[] {
  const pool = [...workplaces];
  const out: string[] = [];
  for (let k = 0; k < attempts && pool.length; k++) {
    let point = hash(`${agentId}:staff-workplace:${k}`) * pool.reduce((sum, row) => sum + row.weight, 0);
    let index = pool.findIndex(row => (point -= row.weight) < 0);
    if (index < 0) index = pool.length - 1;
    out.push(pool[index].id); pool.splice(index, 1);
  }
  return out;
}

/** A usual time for the week plus a small daily jitter, kept inside the window. */
function usualTime(agentId: string, slot: string, weekday: number, window: readonly [number, number]): number {
  const usual = between(hash(`${agentId}:staff-${slot}`), window);
  const jitter = (hash(`${agentId}:${weekday}:staff-${slot}-jitter`) * 2 - 1) * STAFF_ASSUMPTIONS.dailyJitterMinutes * 60;
  return Math.max(window[0] * H, Math.min(window[1] * H, usual + jitter));
}

/**
 * Plan one employee's day: a work block, then (each optional, each only if it fits) a lunch away
 * from the desk and a gym visit. Returns what was planned for the day's stats; the stops themselves
 * are kept through `commit`.
 */
export function planStaffDay(ctx: StaffPlanContext, holiday: boolean): { onSite: boolean; placed: boolean; lunch: 'desk' | 'dining' | 'off-campus'; gym: boolean } {
  const { agent, weekday } = ctx;
  const a = STAFF_ASSUMPTIONS;
  const none = { onSite: false, placed: false, lunch: 'desk' as const, gym: false };
  if (weekday >= 5 || holiday || hash(`${agent.id}:${weekday}:staff-on-site`) >= a.onSiteShare) return none;
  const shoulder = (slot: string) => hash(`${agent.id}:staff-${slot}-shoulder`) < a.shoulderShare;
  const arrive = usualTime(agent.id, 'arrive', weekday, shoulder('arrive') ? a.arriveShoulder : a.arrive);
  const leave = Math.max(arrive + a.minHours * H, usualTime(agent.id, 'leave', weekday, shoulder('leave') ? a.leaveShoulder : a.leave));
  const stop = (location: string, start: number, end: number, activity: StaffStopKind): StaffStop => ({ location, start, end, weekday, pool: '', activity });
  let work: string | undefined;
  for (const id of workplaceOrder(agent.id, ctx.workplaces, a.workplaceAttempts)) {
    if (ctx.commit([stop(id, arrive, leave, 'work')], leave - arrive)) { work = id; break; }
  }
  if (!work) return { ...none, onSite: true };
  const result: { onSite: boolean; placed: boolean; lunch: 'desk' | 'dining' | 'off-campus'; gym: boolean } = { onSite: true, placed: true, lunch: 'desk', gym: false };
  const seed = `${agent.id}:${weekday}`;
  // Gym first (it can replace lunch), then lunch around whatever the day now holds.
  let gymSlot: 'before' | 'lunch' | 'after' | undefined;
  if (ctx.gyms.length && hash(`${seed}:staff-gym`) < a.gym.share) {
    const u = hash(`${seed}:staff-gym-slot`);
    gymSlot = u < a.gym.slots.before ? 'before' : u < a.gym.slots.before + a.gym.slots.lunch ? 'lunch' : 'after';
  }
  const weighted = <T,>(rows: { row: T; weight: number }[], key: string): T | undefined => {
    let point = hash(key) * rows.reduce((sum, item) => sum + item.weight, 0);
    return rows.find(item => (point -= item.weight) < 0)?.row;
  };
  let day = [stop(work, arrive, leave, 'work')];
  if (gymSlot) {
    const seconds = a.gym.minutes * 60;
    const options: { row: CampusLocation; weight: number; stops: StaffStop[] }[] = [];
    for (const gym of ctx.gyms) {
      const toGym = ctx.walk(work, gym.id), fromGym = ctx.walk(gym.id, work);
      let stops: StaffStop[] | undefined;
      if (gymSlot === 'before') {
        const start = between(hash(`${seed}:staff-gym-time`), a.gym.beforeWindow), workStart = start + seconds + fromGym + MARGIN;
        if (Number.isFinite(workStart) && workStart < leave - H) stops = [stop(gym.id, start, start + seconds, 'gym'), stop(work, Math.max(arrive, workStart), leave, 'work')];
      } else if (gymSlot === 'lunch') {
        const start = between(hash(`${seed}:staff-gym-time`), a.gym.lunchWindow);
        if (Number.isFinite(toGym + fromGym) && start - toGym - MARGIN > arrive) stops = [stop(work, arrive, start - toGym - MARGIN, 'work'),
          stop(gym.id, start, start + seconds, 'gym'), stop(work, start + seconds + fromGym + MARGIN, leave, 'work')];
      } else if (Number.isFinite(toGym)) {
        const start = leave + toGym + MARGIN + hash(`${seed}:staff-gym-time`) * a.gym.afterSpreadHours * H;
        stops = [stop(work, arrive, start - toGym - MARGIN, 'work'), stop(gym.id, start, start + seconds, 'gym')];
      }
      if (!stops || !stops.every(row => row.start < row.end) || !ctx.isOpen(stops.find(row => row.activity === 'gym')!)) continue;
      options.push({ row: gym, weight: ctx.venueWeight(gym.capacity, toGym + fromGym), stops });
    }
    const choice = weighted(options.map(option => ({ row: option, weight: option.weight })), `${seed}:staff-gym-venue`);
    if (choice && ctx.commit(choice.stops, seconds)) { day = choice.stops; result.gym = true; }
  }
  if (result.gym && gymSlot === 'lunch') return result;
  const lunchStart = between(hash(`${seed}:staff-lunch-time`), a.lunch.window), lunchEnd = lunchStart + a.lunch.minutes * 60;
  const u = hash(`${seed}:staff-lunch`);
  const where = u < a.lunch.campusDiningShare ? 'dining' : u < a.lunch.campusDiningShare + a.lunch.offCampusShare && !ctx.rider ? 'off-campus' : 'desk';
  if (where === 'desk') return result;
  // Split the work block that holds lunch time: work, walk, lunch, walk back, work.
  const index = day.findIndex(row => row.activity === 'work' && row.start < lunchStart && lunchEnd < row.end);
  if (index < 0) return result;
  const block = day[index];
  const withLunch = (venue: string, activity: StaffStopKind): StaffStop[] | undefined => {
    const out = ctx.walk(block.location, venue), back = ctx.walk(venue, block.location);
    const before = lunchStart - out - MARGIN, after = lunchEnd + back + MARGIN;
    if (!Number.isFinite(before + after) || before <= block.start || after >= block.end) return undefined;
    return [...day.slice(0, index), stop(block.location, block.start, before, 'work'), stop(venue, lunchStart, lunchEnd, activity),
      stop(block.location, after, block.end, 'work'), ...day.slice(index + 1)];
  };
  if (where === 'off-campus') {
    const stops = withLunch('off-campus', 'off-campus-meal');
    if (stops && ctx.commit(stops, a.lunch.minutes * 60)) result.lunch = 'off-campus';
    return result;
  }
  const options: { row: CampusLocation; weight: number }[] = [];
  const plans = new Map<string, StaffStop[]>();
  for (const venue of ctx.dining) {
    const stops = withLunch(venue.id, 'dining');
    if (!stops || !ctx.isOpen(stops.find(row => row.activity === 'dining')!)) continue;
    plans.set(venue.id, stops);
    options.push({ row: venue, weight: ctx.venueWeight(venue.capacity, ctx.walk(block.location, venue.id) + ctx.walk(venue.id, block.location))
      * (RESIDENTIAL_DINING_HALLS.has(venue.id) ? a.residentialHallWeight : 1) });
  }
  const venue = weighted(options, `${seed}:staff-lunch-venue`);
  if (venue && ctx.commit(plans.get(venue.id)!, a.lunch.minutes * 60)) result.lunch = 'dining';
  return result;
}
