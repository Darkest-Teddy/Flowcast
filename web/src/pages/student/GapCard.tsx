import { Link } from 'react-router';
import { crowdFor } from '@theme/tokens';
import type { CampusGeo, CampusLocation, HourlyForecast, Profile, ScheduleItem } from '../../data/types';
import { bostonTime } from '../../lib/departure';
import { planGap, type GapActivity } from '../../lib/gapPlanner';
import type { StudyHoursByLocation } from '../../lib/studyFinder';
import styles from './GapCard.module.css';

const VERB: Record<GapActivity, string> = { eat: 'Eat', study: 'Study', gym: 'Work out' };

/** "Your next gap": what fits before the next class, with leave-by times. */
export function GapCard({ schedule, locations, geo, hours, forecasts, profile, homeLocationId, now, loading }: {
  schedule: ScheduleItem[]; locations: CampusLocation[]; geo: CampusGeo; hours: StudyHoursByLocation;
  forecasts: HourlyForecast[]; profile: Profile | null; homeLocationId: string | null; now: number; loading: boolean;
}) {
  if (loading || !schedule.length) return null;
  const plan = planGap({ schedule, locations, geo, hours, forecasts, profile, homeLocationId, now });
  const name = (id: string | null) => locations.find((l) => l.id === id)?.name ?? 'your building';
  if (plan.status === 'no-next' || plan.status === 'unmapped-class' || !plan.next) return null;
  const next = plan.next;
  const head = plan.current
    ? `After ${plan.current.title} (ends ${bostonTime(plan.current.end)})`
    : plan.fromSource === 'home' ? `From ${name(plan.from)}` : `From ${name(plan.from)}`;
  return (
    <section className={styles.card} aria-label="Your next gap">
      <p className={styles.muted}>Your next gap · {head}</p>
      {plan.status === 'unknown-origin' && <>
        <h2>Next: {next.title} at {bostonTime(next.start)}</h2>
        <p>Set your home building in <Link to="/profile">your profile</Link> to plan the time before it.</p>
      </>}
      {plan.status === 'tight' && <>
        <h2>{plan.gapMinutes !== null && plan.gapMinutes > 0 ? `${plan.gapMinutes} min` : 'No time'} before {next.title}</h2>
        <p>{plan.leaveForClassBy !== null ? <>Head straight there: leave by <strong>{bostonTime(plan.leaveForClassBy)}</strong> for {name(next.locationId)}.</> : `No saved walking route to ${name(next.locationId)}.`}</p>
      </>}
      {plan.status === 'gap' && <>
        <h2>{plan.gapMinutes} min until {next.title} at {name(next.locationId)}</h2>
        <p className={styles.muted}>Class at {bostonTime(next.start)} · leave by {plan.leaveForClassBy !== null ? bostonTime(plan.leaveForClassBy) : '—'} if you go straight there</p>
        {plan.options.length ? <ul className={styles.options}>
          {plan.options.map((option) => {
            const level = option.crowd === null ? null : crowdFor(option.crowd);
            return <li key={option.activity} className={styles.option}>
              <p><strong>{VERB[option.activity]}: {name(option.locationId)}</strong> · {option.walkThere} min walk</p>
              <p className={styles.detail}>
                {level ? <><i className={styles.dot} style={{ background: level.color }} aria-hidden /> Projected {level.label.toLowerCase()} when you arrive · </> : 'No crowd projection · '}
                {option.closesAt ? `open until ${bostonTime(option.closesAt)}` : 'open'} (published hours)
              </p>
              <p className={styles.detail}>Up to {option.stayMinutes} min there · leave by <strong>{bostonTime(option.leaveBy)}</strong> ({option.walkBack} min back to class)</p>
            </li>;
          })}
        </ul> : <p>Nothing with published hours fits this gap. <Link to="/study">Find a study spot</Link></p>}
      </>}
      <p className={styles.note}>All crowd levels here are model projections built from real day-to-day data (MBTA ridership, pedestrian and FitRec counts, published class schedules and hours), not live head counts. Opening hours are BU's published hours; check before you go.</p>
    </section>
  );
}
