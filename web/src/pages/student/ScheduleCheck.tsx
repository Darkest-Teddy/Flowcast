// "Schedule check" on the Schedule page, and the context the import summary on Calendars uses.
// Everything is computed in the browser from the student's own schedule; nothing is saved or sent.
import { api, useResource } from '../../data/api';
import type { CampusGeo, CampusLocation, Profile, ScheduleItem } from '../../data/types';
import { bostonTime } from '../../lib/departure';
import { checkSchedule, durationLabel, firstClassDay, weekOfLabel, SCHEDULE_CHECK_NOTES, type ScheduleCheck as Check } from '../../lib/scheduleCheck';
import type { TransitContext } from '../../lib/transitDeparture';
import { useCampusTransit } from '../../lib/transitTimetables';
import { SectionList, Tag } from '../../ui';
import styles from './ScheduleCheck.module.css';

export interface ScheduleCheckContext {
  geo: CampusGeo | null;
  profile: Pick<Profile, 'lunchTime' | 'dinnerTime'> | null;
  transit: TransitContext | undefined;
  /** Walking routes and meal times have loaded (or failed, and the check says what it assumed). */
  ready: boolean;
  routesMissing: boolean;
}

/** Saved walking routes, meal times and published timetables for the check. */
export function useScheduleCheckContext(): ScheduleCheckContext {
  const geo = useResource(api.getCampusGeo);
  const profile = useResource(api.getProfile);
  const transit = useCampusTransit();
  return { geo: geo.data, profile: profile.data, transit: transit.context,
    ready: (!!geo.data || !!geo.error) && (!!profile.data || !!profile.error), routesMissing: !!geo.error };
}

/** The week from `fromDay` (Boston), or null until the walking routes and meal times have loaded. */
export function runScheduleCheck(items: ScheduleItem[], locations: CampusLocation[], context: ScheduleCheckContext, fromDay: string): Check | null {
  if (!context.ready) return null;
  return checkSchedule({ items, locations, geo: context.geo, profile: context.profile, transit: context.transit, fromDay });
}

const KIND_LABEL = { overlap: 'Overlap', short: 'Too short to walk', tight: 'Tight', 'no-route': 'No route' } as const;

export function ScheduleCheckSection({ items, locations, now }: { items: ScheduleItem[]; locations: CampusLocation[] | null; now: number }) {
  const context = useScheduleCheckContext();
  const fromDay = firstClassDay(items, now);
  const title = `Schedule check · week of ${weekOfLabel(fromDay)}`;
  const check = locations && runScheduleCheck(items, locations, context, fromDay);
  if (!check) return <SectionList title={title} empty="Checking walks and meal breaks…" />;
  const days = check.days.filter((d) => d.classCount);
  if (!days.length) return <SectionList title={title} empty="No imported classes from today on." />;
  return <SectionList title={title} count={check.issueCount}>
    {days.map((d) => {
      const flagged = d.transfers.length + d.meals.length > 0 || d.long;
      return <div key={d.day} className={styles.day}>
        <p className={styles.dayHead}><strong>{d.weekday}</strong>
          <span>{d.classCount} {d.classCount === 1 ? 'class' : 'classes'} · {bostonTime(d.firstStart!)}–{bostonTime(d.lastEnd!)} ({durationLabel(d.spanMinutes)})
            {d.rushes > 0 && <> · {d.rushes} rushed {d.rushes === 1 ? 'transition' : 'transitions'}</>}</span></p>
        {flagged ? <ul className={styles.findings}>
          {d.transfers.map((t) => <li key={`${t.from.id}>${t.to.id}`}>
            <Tag tone={t.kind === 'tight' ? 'warn' : 'bad'}>{KIND_LABEL[t.kind]}</Tag>
            <span>{t.text}{t.transit && <span className={styles.note}>{t.transit.text}</span>}</span>
          </li>)}
          {d.meals.map((m) => <li key={m.meal}><Tag tone="warn">No {m.meal} break</Tag><span>{m.text}</span></li>)}
          {d.long && <li><Tag tone="warn">Long day</Tag><span>{durationLabel(d.spanMinutes)} from first class to last</span></li>}
        </ul> : <p className={styles.note}>No tight transfers or missed meal breaks.</p>}
      </div>;
    })}
    <details className={styles.notes}>
      <summary>How this is checked</summary>
      <ul>
        {SCHEDULE_CHECK_NOTES.map((note) => <li key={note}>{note}</li>)}
        {context.routesMissing && <li>Saved walking routes did not load, so walk times are missing.</li>}
        {!context.profile && <li>Your profile did not load, so lunch at 12:00 PM and dinner at 6:00 PM are assumed.</li>}
        <li>Worked out on this device from your own schedule. It describes schedule shape only, is not a health measure, and nothing is saved or sent.</li>
      </ul>
    </details>
  </SectionList>;
}
