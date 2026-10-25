import { useMemo } from 'react';
import { Link } from 'react-router';
import { crowdFor } from '@theme/tokens';
import type { CampusGeo, CampusLocation, HourlyForecast, ScheduleItem } from '../../data/types';
import { bostonTime } from '../../lib/departure';
import { nightMode, planTonight, type LastRide, type NightKind } from '../../lib/lateNight';
import type { StudyHoursByLocation } from '../../lib/studyFinder';
import { departureBasisLabel, exclusionLabel, type TransitContext } from '../../lib/transitDeparture';
import styles from './GapCard.module.css';

const KIND: Record<NightKind, string> = { dining: 'Eat', library: 'Study', gym: 'Work out' };

/** One line for the last published ride home, or why there isn't one. */
function rideLine(ride: LastRide, compact: boolean): string | null {
  const option = ride.option;
  if (ride.status === 'ride' && option) {
    const route = `${option.routeName}${option.toward ? ` ${option.toward}` : ''}`;
    return compact
      ? `Last ride home: ${route} at ${bostonTime(option.departure)} from ${option.boardStop.name} (leave by ${bostonTime(option.leaveBy)})`
      : `${route} departs ${option.boardStop.name} at ${bostonTime(option.departure)}: leave by ${bostonTime(option.leaveBy)} (${option.walkToStopMinutes} min walk to the stop), ${option.rideMinutes} min to ${option.alightStop.name}, home about ${bostonTime(option.atClass)}`;
  }
  if (compact) return null;
  if (ride.status === 'none-left') return 'The last published trip home from nearby stops has left.';
  if (ride.status === 'no-direct') return 'No published trip tonight runs from a stop near here to one near home.';
  if (ride.status === 'not-covered') return 'No published timetable covers tonight.';
  if (ride.status === 'no-stops') return 'No mapped stop has a walking route between here and home.';
  return null;
}

/** "Tonight": what's still open by published hours, and the last published ride home. */
export function TonightCard({ schedule, locations, geo, hours, forecasts, homeLocationId, now, transit, loading }: {
  schedule: ScheduleItem[]; locations: CampusLocation[]; geo: CampusGeo; hours: StudyHoursByLocation; forecasts: HourlyForecast[];
  homeLocationId: string | null; now: number; transit: TransitContext | undefined; loading: boolean;
}) {
  const mode = nightMode(schedule, now);
  const minute = Math.floor(now / 60_000);
  // A ride search walks the whole timetable: plan once a minute, not on every render.
  const plan = useMemo(() => mode && !loading ? planTonight({ schedule, locations, geo, hours, forecasts, homeLocationId, now: minute * 60_000, transit }) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, loading, schedule, locations, geo, hours, forecasts, homeLocationId, transit, minute]);
  if (!mode || !plan) return null;
  const name = (id: string | null) => locations.find((l) => l.id === id)?.name ?? 'your building';
  const title = mode === 'late' ? 'Tonight' : mode === 'classes-done' ? 'Done with classes today' : 'No classes today';
  const places = plan.options;
  const ride = plan.rideHome;
  const rideText = ride && ride.status !== 'at-home' ? rideLine(ride, false) : null;
  const excluded = [...new Set([ride, ...places.map((p) => p.rideHome)].flatMap((r) => r?.excluded ?? []).map(exclusionLabel))];
  const anyRide = ride?.option ?? places.find((p) => p.rideHome.option)?.rideHome.option ?? null;
  return (
    <section className={styles.card} aria-label="Tonight">
      <p className={styles.muted}>{title} · {plan.from ? `from ${name(plan.from)}${plan.fromSource === 'class' ? ' (your last class)' : ''}` : 'Boston time'}</p>
      {!plan.from ? <>
        <h2>What's still open</h2>
        <p>Set your home building in <Link to="/profile">your profile</Link> to see what's open nearby and the last ride home.</p>
      </> : <>
        <h2>{places.length ? `Still open${mode === 'late' ? ' tonight' : ' now'}` : 'Nothing nearby is open by its published hours'}</h2>
        {rideText && <p className={styles.muted}>Last ride home to {name(plan.homeLocationId)}: {rideText}</p>}
        {places.length > 0 && <ul className={styles.options}>
          {places.map((option) => {
            const level = option.crowd === null ? null : crowdFor(option.crowd);
            const last = rideLine(option.rideHome, true);
            return <li key={option.locationId} className={styles.option}>
              <p><strong>{KIND[option.kind]}: {name(option.locationId)}</strong> · {option.walkMinutes} min walk</p>
              <p className={styles.detail}>
                {option.closesAt ? <>Open until <strong>{bostonTime(option.closesAt)}</strong></> : 'Open late'} (published hours)
                {level ? <> · <i className={styles.dot} style={{ background: level.color }} aria-hidden />Projected {level.label.toLowerCase()} when you arrive</> : null}
              </p>
              {(last || option.walkHomeMinutes !== null) && plan.homeLocationId !== option.locationId && <p className={styles.detail}>
                {[last, option.walkHomeMinutes !== null ? `${option.walkHomeMinutes} min walk home` : null].filter(Boolean).join(' · ')}
              </p>}
            </li>;
          })}
        </ul>}
      </>}
      <p className={styles.note}>
        Opening hours are BU's published hours; check before you go. Crowd levels are model projections built from real day-to-day data (MBTA ridership, pedestrian and FitRec counts, published class schedules and hours), not live head counts.
        {anyRide ? ` Ride times are published timetable times, not live: ${departureBasisLabel(anyRide)}.` : ''}
        {excluded.length ? ` ${excluded.join(' ')}` : ''}
      </p>
    </section>
  );
}
