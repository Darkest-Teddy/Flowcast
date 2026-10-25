import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { CircleCheck, Map as MapIcon } from 'lucide-react';
import { crowdFor } from '@theme/tokens';
import { LiveVoice } from '@map/LiveVoice';
import { useSession } from '../auth/session';
import { config } from '../config';
import { api, locationName, useResource } from '../data/api';
import type { HourlyForecast } from '../data/types';
import { formatDayTime, formatHour, formatPercent, formatWeekday } from '../lib/format';
import { findStudySpots } from '../lib/studyFinder';
import {
  AskBar,
  Avatar,
  Button,
  ListRow,
  Page,
  SectionList,
  Segmented,
  SelectField,
  StatCard,
  StatusBadge,
  Tag,
} from '../ui';
import { eventVenue } from './student/events';
import { AskChat } from './student/AskChat';
import { bostonDay, bostonTime, getDeparturePlan } from '../lib/departure';
import { DepartureCard, useDepartureClock } from './student/DepartureCard';
import { GapCard } from './student/GapCard';
import { HourlyChart } from './student/HourlyChart';
import { FeatureGrid } from './student/FeatureGrid';
import { CrowdReportPrompt } from './student/CrowdReport';
import { TonightCard } from './student/TonightCard';
import { TodayBrief } from './student/TodayBrief';
import { eventsInGaps, freeWindows, MAX_EVENT_WALK, type EventFit } from '../lib/eventsInGaps';
import { useCampusTransit } from '../lib/transitTimetables';
import styles from './Home.module.css';

const emptyGeo = { positions: {}, walkMeters: {} };
const bostonHour = (at: number) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(at));
const bostonLongDate = (at: number) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' }).format(at);
const greetingFor = (hour: number) => (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening');
/** Waking hours for the campus curve: residence halls are full overnight, which says nothing about where to go. */
const DAY_HOURS = { first: 7, last: 23 };
const shareAt = (f: HourlyForecast, hour: number) => f.hours.find((h) => h.hour === hour)?.share ?? null;
const peakOf = (f: HourlyForecast) => f.hours.reduce((a, b) => (b.share > a.share ? b : a));
const quietestOf = (f: HourlyForecast) => f.hours.reduce((a, b) => (b.share < a.share ? b : a));
const describe = (share: number) => `${formatPercent(share)} ${crowdFor(share).label}`;
/** Stagger index for the entrance animation (Home.module.css .reveal). */
const order = (i: number) => ({ '--i': i }) as CSSProperties;

/** Mean projected share per waking hour across the places you'd go to: the campus-wide shape of the day. */
function campusCurve(forecasts: HourlyForecast[]) {
  const sums = new Map<number, { total: number; n: number }>();
  for (const f of forecasts) for (const h of f.hours) {
    if (h.hour < DAY_HOURS.first || h.hour > DAY_HOURS.last) continue;
    const row = sums.get(h.hour) ?? { total: 0, n: 0 };
    row.total += h.share;
    row.n++;
    sums.set(h.hour, row);
  }
  return [...sums.entries()].sort((a, b) => a[0] - b[0]).map(([hour, { total, n }]) => ({ hour, share: total / n }));
}

export default function Home() {
  const { session, hasRole } = useSession();
  const locations = useResource(api.getLocations);
  const schedule = useResource(api.getSchedule);
  const places = useResource(api.getPlaceForecasts);
  const hourly = useResource(api.getHourlyForecasts);
  const bestTimes = useResource(api.getBestTimes);
  const geo = useResource(api.getCampusGeo);
  const transit = useCampusTransit();
  const profile = useResource(api.getProfile);
  const events = useResource(api.getCampusEvents);
  const impact = useResource(api.getEventImpact);
  const clubs = useResource(api.getClubs);
  const hours = useResource(api.getPlaceHours);
  const venues = useResource(api.getVenueCalendar);
  const spots = useResource(api.getStudySpots);
  const studyHours = useResource(api.getStudyHours);

  const [chartPlace, setChartPlace] = useState<string | null>(null);
  const [eventFilter, setEventFilter] = useState<'all' | 'fits'>('all');
  const now = useDepartureClock();

  const place = (id: string) => locationName(locations.data, id);
  const loadingText = 'Loading…';
  const geoData = geo.data ?? emptyGeo;
  const homeLocationId = profile.data ? profile.data.homeLocationId : session?.user.homeLocationId ?? null;
  const todayKey = bostonDay(now);
  const hourNow = bostonHour(now);

  const today = (schedule.data ?? [])
    .filter((s) => Number.isFinite(Date.parse(s.start)) && bostonDay(s.start) === todayKey)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  // Today's and later events still to finish; a listing that started on an earlier day (a
  // recurring or multi-day one) would sit at the top with a stale weekday.
  const upcomingEvents = (events.data ?? [])
    .filter((e) => Date.parse(e.end ?? e.start) >= now && bostonDay(e.start) >= todayKey)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, 5);
  const eventsToday = (events.data ?? []).filter((e) => bostonDay(e.start) === todayKey);
  const followed = (clubs.data ?? []).filter((c) => c.following);
  // Events that start in one of the student's free windows this week and fit before the next class.
  const fits = useMemo(() => {
    if (!schedule.data?.length || !events.data || !locations.data || !geo.data) return new Map<string, EventFit>();
    const windows = freeWindows({ schedule: schedule.data, now, homeLocationId });
    const list = eventsInGaps({ events: events.data, windows, followedClubIds: followed.map((c) => c.id), geo: geo.data, locations: locations.data, now });
    return new Map(list.map((fit) => [fit.event.id, fit]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule.data, events.data, locations.data, geo.data, clubs.data, homeLocationId, Math.floor(now / 300_000)]);
  const shownEvents = eventFilter === 'fits' ? [...fits.values()].slice(0, 6).map((fit) => fit.event) : upcomingEvents;
  const fitDetail = (fit: EventFit) => [
    fit.followed ? 'Club you follow' : null,
    `${fit.walkThere} min walk from ${fit.window.from ? place(fit.window.from) : 'you'}`,
    fit.leaveBy !== null && fit.window.next ? `leave by ${bostonTime(fit.leaveBy)} for ${fit.window.next.title}` : 'after your classes',
  ].filter(Boolean).join(' · ');


  // At a glance.
  const departure = getDeparturePlan({ items: schedule.data ?? [], locations: locations.data ?? [], geo: geoData, now, homeLocationId });
  const inClass = !!departure.current && departure.target?.id === departure.current.id;
  const forecasts = (hourly.data ?? []).filter((f) => f.hours.length);
  // Dorms are always full at night; leave them out of "where's busy" unless picked by hand.
  const kindOf = (id: string) => locations.data?.find((l) => l.id === id)?.kind;
  const destinations = forecasts.filter((f) => kindOf(f.locationId) !== 'dorm');
  const curve = campusCurve(destinations);
  const campusPeak = curve.length ? curve.reduce((a, b) => (b.share > a.share ? b : a)) : null;

  // Crowds: the chosen place's day, defaulting to whichever is busiest this hour.
  const busiestNow = [...destinations].sort((a, b) => (shareAt(b, hourNow) ?? -1) - (shareAt(a, hourNow) ?? -1) || peakOf(b).share - peakOf(a).share)[0];
  const charted = forecasts.find((f) => f.locationId === chartPlace) ?? busiestNow;
  // Zero means closed or empty in the model, not a good place to go.
  const quietNow = destinations
    .filter((f) => (shareAt(f, hourNow) ?? 0) > 0)
    .sort((a, b) => shareAt(a, hourNow)! - shareAt(b, hourNow)!)
    .slice(0, 3);

  // Study: the same finder as the Study page, from wherever the departure plan puts you.
  const studyFrom = departure.fromLocationId ?? homeLocationId ?? '';
  const study = useMemo(() => findStudySpots({
    spots: spots.data ?? [], locations: locations.data ?? [], geo: geo.data ?? emptyGeo, hours: studyHours.data ?? {},
    forecasts: hourly.data ?? [], schedule: schedule.data ?? [], scheduleKnown: !!schedule.data && !schedule.error,
    now, from: studyFrom, minutes: 60, amenities: [], openOnly: !!studyFrom, lateOnly: false, fitsOnly: false, maxWalk: null, sort: studyFrom ? 'time' : 'crowd',
  }).filter((r) => r.open !== false).slice(0, 3), [spots.data, locations.data, geo.data, studyHours.data, hourly.data, schedule.data, schedule.error, now, studyFrom]);

  // Event impact: the next simulated day with gatherings, today if there is one.
  const impactDate = impact.data ? Object.keys(impact.data.dates).filter((d) => d >= todayKey && impact.data!.dates[d].gatherings.length).sort()[0] : undefined;
  const gatherings = impactDate ? [...impact.data!.dates[impactDate].gatherings].sort((a, b) => b.attendees - a.attendees).slice(0, 4) : [];
  const impactPlace = (id: string) => impact.data?.places.find((p) => p.id === id)?.name ?? place(id);

  // Setup: only what Flowcast can check.
  const setup = [
    { done: !!schedule.data?.length, label: 'Import your classes', to: '/calendars' },
    { done: !!homeLocationId, label: 'Set your home building', to: '/profile' },
    { done: followed.length > 0, label: 'Follow a club', to: '/clubs' },
  ];
  const setupKnown = !!schedule.data && !!profile.data && !!clubs.data;
  const setupDone = setup.filter((s) => s.done).length;

  const firstName = (profile.data?.name || session?.user.name || '').split(' ')[0];
  const calendarStatus = schedule.data?.length ? (
    <StatusBadge tone="ok">{schedule.data.length} imported {schedule.data.length === 1 ? 'class' : 'classes'} · <Link to="/calendars">Manage import</Link></StatusBadge>
  ) : (
    <StatusBadge tone="off">{schedule.loading ? 'Loading your schedule. ' : 'No imported classes. '}<Link to="/calendars">Import .ics schedule</Link></StatusBadge>
  );

  return (
    <Page wide>
      <div className={`${styles.hero} ${styles.reveal}`} style={order(0)}>
        <p className={styles.date}>{bostonLongDate(now)} · {bostonTime(now)} in Boston</p>
        <h1 className={styles.headline}>{greetingFor(hourNow)}{firstName ? `, ${firstName}` : ''}. Where are you headed?</h1>
        <p className={styles.status}>{calendarStatus}</p>
        <Button href={config.mapUrl} variant="accent" size="lg" icon={<MapIcon aria-hidden />} className={styles.mapButton}>Open campus map</Button>
      </div>

      <TodayBrief schedule={schedule.data ?? []} locations={locations.data ?? []}
        geo={geo.data ?? { positions: {}, walkMeters: {} }} hours={hours.data ?? {}} forecasts={hourly.data ?? []}
        profile={profile.data ?? null} homeLocationId={homeLocationId} campusEvents={events.data ?? []} venues={venues.data}
        now={now} transit={transit.context}
        loading={schedule.loading || locations.loading || geo.loading || profile.loading || hours.loading || events.loading} />

      <AskChat scheduleAvailable={schedule.data !== null} visible composer={(ask, pending, resetToken) => (
        <AskBar resetToken={resetToken} pending={pending} onSubmit={(question) => void ask(question)} voice={(field) => <LiveVoice compact>{field}</LiveVoice>} />
      )} data={{
        locations: locations.data ?? [], schedule: schedule.data ?? [],
        events: events.data ?? [], clubs: clubs.data ?? [],
        hourly: hourly.data ?? [], places: places.data ?? [],
        geo: geoData, homeLocationId,
        transit: transit.context,
      }} />

      {[locations, schedule, places, hourly, bestTimes, geo, profile, events, clubs, impact, hours, spots, studyHours].filter((resource) => resource.error).map((resource, index) => (
        <p role="alert" key={index}>{resource.error?.message} <Button variant="ghost" size="sm" onClick={resource.reload}>Try again</Button></p>
      ))}

      {setupKnown && setupDone < setup.length && (
        <section className={`${styles.setup} ${styles.reveal}`} style={order(2)} aria-label="Get set up">
          <p className={styles.setupTitle}>Get set up <span>{setupDone} of {setup.length} done</span></p>
          <Link to="/welcome" className={styles.setupStart}>Start setup</Link>
          <ul>
            {setup.map((s) => (
              <li key={s.label} className={s.done ? styles.done : undefined}>
                {s.done ? <><CircleCheck aria-hidden /> {s.label}</> : <Link to={s.to}>{s.label}</Link>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Bento: every card snaps to a four-column grid and stretches to fill its cell, so neighbours
          line up and no gaps open; a card with nothing in it yet is simply an empty box. */}
      <section className={styles.bento} aria-label="At a glance">
        <div className={`${styles.cell} ${styles.w1} ${styles.reveal}`} style={order(3)}>
          <StatCard
            label={inClass ? 'In class until' : 'Next class'}
            value={departure.target ? bostonTime(inClass ? departure.target.end : departure.target.start) : '—'}
            detail={departure.target
              ? `${departure.target.title}${!inClass && departure.leaveBy !== null ? ` · leave by ${bostonTime(departure.leaveBy)}` : ''}`
              : schedule.loading ? loadingText : 'No upcoming classes'}
          />
        </div>
        <div className={`${styles.cell} ${styles.w1} ${styles.reveal}`} style={order(4)}>
          <StatCard
            label="Classes today"
            value={schedule.data ? String(today.length) : '—'}
            detail={today.length ? `${bostonTime(today[0].start)} to ${bostonTime(today[today.length - 1].end)}` : schedule.loading ? loadingText : 'Nothing imported for today'}
          />
        </div>
        <div className={`${styles.cell} ${styles.w1} ${styles.reveal}`} style={order(5)}>
          <StatCard
            label="Campus peak"
            value={campusPeak ? formatHour(campusPeak.hour) : '—'}
            detail={campusPeak ? `${formatPercent(campusPeak.share)} average across ${destinations.length} places` : hourly.loading ? loadingText : 'No projection today'}
            series={curve.length ? curve.map((h) => h.share) : undefined}
            axis={curve.length ? [formatHour(curve[0].hour), formatHour(curve[curve.length - 1].hour)] : undefined}
            highlightIndex={campusPeak ? curve.indexOf(campusPeak) : undefined}
            format={(share, i) => `${formatHour(curve[i].hour)} · ${formatPercent(share)}`}
          />
        </div>
        <div className={`${styles.cell} ${styles.w1} ${styles.reveal}`} style={order(6)}>
          <StatCard
            label="Events today"
            value={events.data ? String(eventsToday.length) : '—'}
            detail={events.data
              ? `${eventsToday.filter((e) => e.mapStatus === 'simulated').length} change crowds on the map`
              : events.loading ? loadingText : 'Events unavailable'}
          />
        </div>
      </section>

      <CrowdReportPrompt locations={locations.data ?? []} />

      <div className={`${styles.strip} ${styles.reveal}`} style={order(7)}>
        <GapCard schedule={schedule.data ?? []} locations={locations.data ?? []}
          geo={geoData} hours={hours.data ?? {}} forecasts={hourly.data ?? []}
          profile={profile.data ?? null} now={now} homeLocationId={homeLocationId}
          loading={schedule.loading || locations.loading || geo.loading || profile.loading || hours.loading} />
      </div>

      <TonightCard schedule={schedule.data ?? []} locations={locations.data ?? []}
        geo={geoData} hours={hours.data ?? {}} forecasts={hourly.data ?? []}
        homeLocationId={homeLocationId} now={now} transit={transit.context}
        loading={schedule.loading || locations.loading || geo.loading || profile.loading || hours.loading || transit.loading} />

      <div className={styles.bento}>
        <div className={`${styles.cell} ${styles.w2} ${styles.reveal}`} style={order(8)}>
          <SectionList
            title="Today · Boston time"
            count={schedule.data ? today.length : undefined}
            to="/schedule"
            empty={schedule.loading ? loadingText : 'No imported classes today.'}
          >
            {today.map((item) => (
              <ListRow
                key={item.id}
                title={
                  <>
                    {item.title}
                    <span className={styles.where}>{item.locationText || (item.locationId ? place(item.locationId) : 'Building not mapped')}</span>
                  </>
                }
                detail={`${bostonTime(item.start)}${Date.parse(item.end) < now ? ' · done' : ''}`}
              />
            ))}
          </SectionList>
        </div>
        <div className={`${styles.cell} ${styles.w2} ${styles.reveal}`} style={order(9)}>
          <DepartureCard items={schedule.data ?? []} locations={locations.data ?? []}
          geo={geoData} now={now} homeLocationId={homeLocationId}
          loading={schedule.loading || locations.loading || geo.loading || profile.loading} />
        </div>
        <div className={`${styles.cell} ${styles.w2} ${styles.h2} ${styles.reveal}`} style={order(10)}>
          <SectionList
            title="Campus crowds today"
            to={charted ? `/forecasts?place=${charted.locationId}` : '/forecasts'}
            empty={hourly.loading ? loadingText : 'No comparable crowd projection is available today.'}
          >
            {charted && (
              <div className={styles.chartBlock}>
                <SelectField label="Place" value={charted.locationId} onChange={(event) => setChartPlace(event.target.value)}>
                  {forecasts.map((f) => <option key={f.locationId} value={f.locationId}>{place(f.locationId)}</option>)}
                </SelectField>
                <HourlyChart key={charted.locationId} hours={charted.hours} label={`Hourly forecast for ${place(charted.locationId)}`} />
                <p className={styles.forecastNote}>
                  Peak {describe(peakOf(charted).share)} at {formatHour(peakOf(charted).hour)} · quietest {describe(quietestOf(charted).share)} at {formatHour(quietestOf(charted).hour)}
                </p>
              </div>
            )}
            {quietNow.map((f) => {
              const level = crowdFor(shareAt(f, hourNow)!);
              return (
                <ListRow
                  key={f.locationId}
                  leading={<i className={styles.crowdDot} style={{ background: level.color }} aria-hidden />}
                  title={place(f.locationId)}
                  subtitle="Among the quietest this hour"
                  detail={`${formatPercent(shareAt(f, hourNow)!)} ${level.label}`}
                />
              );
            })}
            {charted?.basis && <details className={styles.forecastNote}><summary>About these projections</summary><p>{charted.basis}</p></details>}
          </SectionList>
        </div>
        <div className={`${styles.cell} ${styles.w2} ${styles.reveal}`} style={order(11)}>
          <SectionList
            title="Study spots for the next hour"
            to="/study"
            empty={spots.loading || studyHours.loading ? loadingText : 'No study space is open right now by its published hours.'}
          >
            {!spots.loading && !studyHours.loading && study.map((r) => (
              <ListRow
                key={r.spot.id}
                to="/study"
                title={r.spot.name}
                subtitle={[
                  r.walk !== null ? `${r.walk} min walk` : null,
                  r.usable !== null && r.usable > 0 ? `${r.usable} min to study` : r.open === null ? 'Hours unconfirmed' : null,
                ].filter(Boolean).join(' · ') || r.spot.area}
                detail={r.crowd !== null ? `${formatPercent(r.crowd)} ${crowdFor(r.crowd).label}` : undefined}
              />
            ))}
            {!studyFrom && !studyHours.loading && study.length > 0 && <p className={styles.forecastNote}><Link to="/profile">Set your home building</Link> to rank by walk and study time.</p>}
          </SectionList>
        </div>
        <div className={`${styles.cell} ${styles.w2} ${styles.reveal}`} style={order(12)}>
          <SectionList
            title="Best times this week"
            to="/forecasts"
            empty={bestTimes.loading ? loadingText : 'No published hours to rank this week.'}
          >
            {(bestTimes.data ?? []).filter((w) => w.quietest[0]).slice(0, 5).map((w) => {
              const q = w.quietest[0];
              return (
                <ListRow
                  key={w.locationId}
                  to={`/forecasts?place=${w.locationId}`}
                  title={place(w.locationId)}
                  subtitle={w.busiest[0] ? `Busiest ${formatWeekday(`${w.busiest[0].date}T12:00:00`)} ${formatHour(w.busiest[0].hour)}` : undefined}
                  detail={`Quietest ${formatWeekday(`${q.date}T12:00:00`)} ${formatHour(q.hour)}`}
                />
              );
            })}
          </SectionList>
        </div>
        <div className={`${styles.cell} ${styles.w2} ${styles.h2} ${styles.reveal}`} style={order(13)}>
          <SectionList
            title="Happening on campus"
            to="/events"
            empty={events.loading ? loadingText : eventFilter === 'fits' ? 'No upcoming event this week fits your free time and walking range.' : 'No campus events coming up.'}
          >
            {schedule.data?.length ? <div className={styles.eventFilter}>
              <Segmented label="Show events" value={eventFilter} onChange={setEventFilter}
                options={[{ value: 'all', label: 'Coming up' }, { value: 'fits', label: `Fits your free time (${fits.size})` }]} />
            </div> : null}
            {shownEvents.map((e) => {
              const fit = fits.get(e.id);
              return (
                <ListRow
                  key={e.id}
                  title={
                    <>
                      {e.title}
                      <span className={styles.where}>{eventVenue(e)}</span>
                    </>
                  }
                  subtitle={fit ? fitDetail(fit) : undefined}
                  trailing={fit ? <Tag tone="ok">Fits your gap</Tag> : undefined}
                  detail={bostonDay(e.start) === todayKey ? `Today ${bostonTime(e.start)}` : formatDayTime(e.start)}
                />
              );
            })}
            {schedule.data?.length && !shownEvents.length && !events.loading ? <p className={styles.forecastNote}>{eventFilter === 'fits' ? 'No upcoming event this week fits your free time and walking range.' : 'No campus events coming up.'}</p> : null}
            {eventFilter === 'fits' && fits.size > 0 && <p className={styles.forecastNote}>Starts while you're free, within a {MAX_EVENT_WALK}-minute walk on saved routes, with time to stay and still make your next class (5 min buffer). Followed clubs first. Registration counts are never treated as attendance.</p>}
          </SectionList>
        </div>
        <div className={`${styles.cell} ${styles.w2} ${styles.reveal}`} style={order(14)}>
          <SectionList
            title={impactDate && impactDate !== todayKey
              ? `Event impact · ${formatWeekday(`${impactDate}T12:00:00`, true)}`
              : 'Event impact · today'}
            to={impactDate ? `/event-impact?date=${impactDate}` : '/event-impact'}
            empty={impact.loading ? loadingText : 'No simulated events coming up.'}
          >
            {gatherings.map((g) => (
              <ListRow
                key={`${g.eventId}-${g.locationId}`}
                title={g.name}
                subtitle={impactPlace(g.locationId)}
                detail={`${g.attendees.toLocaleString()} attending`}
              />
            ))}
          </SectionList>
        </div>
        <div className={`${styles.cell} ${styles.w2} ${styles.reveal}`} style={order(15)}>
          <SectionList
            title="Your clubs"
            count={clubs.data ? followed.length : undefined}
            to="/clubs"
            empty={
              clubs.loading ? (
                loadingText
              ) : (
                <>
                  You don't follow any clubs yet. <Link to="/clubs">Find clubs</Link>
                </>
              )
            }
          >
            {followed.map((c) => (
              <ListRow key={c.id} to="/clubs" leading={<Avatar name={c.name} />} title={c.name} />
            ))}
            {hasRole('clubOfficer') && <ListRow to="/club" title="Manage your club" subtitle="Club page and calendar upload" />}
          </SectionList>
        </div>
      </div>

      <FeatureGrid style={order(16)} clubOfficer={hasRole('clubOfficer')} admin={hasRole('admin')} />
    </Page>
  );
}
