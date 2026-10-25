import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { crowdFor } from '@theme/tokens';
import { useSession } from '../auth/session';
import { config } from '../config';
import { api, locationName, useResource } from '../data/api';
import { formatDayTime, formatPercent } from '../lib/format';
import { findStudySpots } from '../lib/studyFinder';
import { Button, ListRow, Page, SectionList, Segmented } from '../ui';
import { eventVenue } from './student/events';
import { bostonDay, bostonTime, getDeparturePlan } from '../lib/departure';
import { DepartureCard, useDepartureClock } from './student/DepartureCard';
import { GapCard } from './student/GapCard';
import { CrowdReportPrompt } from './student/CrowdReport';
import { TonightCard } from './student/TonightCard';
import { TodayBrief } from './student/TodayBrief';
import { eventsInGaps, freeWindows } from '../lib/eventsInGaps';
import { useCampusTransit } from '../lib/transitTimetables';
import styles from './Home.module.css';

const emptyGeo = { positions: {}, walkMeters: {} };
const dateLabel = (at: number) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric',
}).format(at);

export default function Home() {
  const { session } = useSession();
  const locations = useResource(api.getLocations);
  const schedule = useResource(api.getSchedule);
  const hourly = useResource(api.getHourlyForecasts);
  const geo = useResource(api.getCampusGeo);
  const transit = useCampusTransit();
  const profile = useResource(api.getProfile);
  const events = useResource(api.getCampusEvents);
  const clubs = useResource(api.getClubs);
  const hours = useResource(api.getPlaceHours);
  const venues = useResource(api.getVenueCalendar);
  const spots = useResource(api.getStudySpots);
  const studyHours = useResource(api.getStudyHours);
  const [eventFilter, setEventFilter] = useState<'all' | 'fits'>('all');
  const [planningOpen, setPlanningOpen] = useState(false);
  const now = useDepartureClock();
  const todayKey = bostonDay(now);
  const geoData = geo.data ?? emptyGeo;
  const place = (id: string) => locationName(locations.data, id);
  const homeLocationId = profile.data ? profile.data.homeLocationId : session?.user.homeLocationId ?? null;
  const firstName = (profile.data?.name || session?.user.name || '').split(' ')[0];
  const today = (schedule.data ?? [])
    .filter((item) => Number.isFinite(Date.parse(item.start)) && bostonDay(item.start) === todayKey)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const remaining = today.filter((item) => Date.parse(item.end) > now);
  const departure = getDeparturePlan({ items: schedule.data ?? [], locations: locations.data ?? [], geo: geoData, now, homeLocationId });
  const studyFrom = departure.fromLocationId ?? homeLocationId ?? '';
  const study = useMemo(() => findStudySpots({
    spots: spots.data ?? [], locations: locations.data ?? [], geo: geo.data ?? emptyGeo, hours: studyHours.data ?? {},
    forecasts: hourly.data ?? [], schedule: schedule.data ?? [], scheduleKnown: !!schedule.data && !schedule.error,
    now, from: studyFrom, minutes: 60, amenities: [], openOnly: !!studyFrom, lateOnly: false, fitsOnly: false,
    maxWalk: null, sort: studyFrom ? 'time' : 'crowd',
  }).filter((result) => result.open !== false).slice(0, 3),
  [spots.data, locations.data, geo.data, studyHours.data, hourly.data, schedule.data, schedule.error, now, studyFrom]);
  const fits = useMemo(() => {
    if (!schedule.data?.length || !events.data || !locations.data || !geo.data) return [];
    return eventsInGaps({
      events: events.data, windows: freeWindows({ schedule: schedule.data, now, homeLocationId }),
      followedClubIds: (clubs.data ?? []).filter((club) => club.following).map((club) => club.id),
      geo: geo.data, locations: locations.data, now,
    });
  }, [schedule.data, events.data, locations.data, geo.data, clubs.data, homeLocationId, now]);
  const upcoming = (events.data ?? [])
    .filter((event) => Date.parse(event.end ?? event.start) >= now && bostonDay(event.start) >= todayKey)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const shownEvents = (eventFilter === 'fits' ? fits.map((fit) => fit.event) : upcoming).slice(0, 3);
  const resources = [
    ['Schedule', schedule], ['Places', locations], ['Crowd projections', hourly], ['Walking routes', geo],
    ['Profile', profile], ['Events', events], ['Clubs', clubs], ['Opening hours', hours],
    ['Venue calendar', venues], ['Study spots', spots], ['Study hours', studyHours],
  ] as const;
  const planningResources = [schedule, locations, geo, profile, hours, hourly];
  const planningLoading = planningResources.some((resource) => resource.loading);
  const planningFailed = planningResources.some((resource) => resource.error);
  const studyLoading = [spots, studyHours, locations, geo, hourly, schedule, profile].some((resource) => resource.loading);
  const studyFailed = [spots, studyHours, locations, geo, hourly].some((resource) => resource.error);
  const fitsUnavailable = [schedule, locations, geo, clubs].some((resource) => resource.loading || resource.error);

  return (
    <Page wide>
      <div className={styles.home}>
        <header className={styles.header}>
          <div>
            <p className={styles.date}>{dateLabel(now)} · Boston time</p>
            <h1>{firstName ? `${firstName}’s day` : 'Your day'}</h1>
          </div>
          <div className={styles.actions}>
            <Button to="/ask" variant="ghost">Ask Flowcast</Button>
            <Button href={config.mapUrl} variant="secondary">Open campus map</Button>
          </div>
        </header>

        {resources.filter(([, resource]) => resource.error).map(([label, resource]) => (
          <p role="alert" className={styles.error} key={label}>
            <span>{label}: {resource.error?.message}</span>
            <Button variant="ghost" size="sm" onClick={resource.reload}>Try again</Button>
          </p>
        ))}

        <div className={styles.content}>
          <div className={styles.primary}>
            <div className={styles.departure}>
              {schedule.error || locations.error || geo.error || profile.error
                ? <p>Next-class details are unavailable. Retry the failed data above.</p>
                : <DepartureCard compact items={schedule.data ?? []} locations={locations.data ?? []} geo={geoData}
                    now={now} homeLocationId={homeLocationId}
                    loading={schedule.loading || locations.loading || geo.loading || profile.loading} />}
            </div>
            <div className={`${styles.list} ${styles.schedule}`}>
              <SectionList title="Today’s schedule" to="/schedule"
                empty={schedule.error ? 'Schedule unavailable.' : schedule.loading ? 'Loading your schedule…'
                  : today.length ? 'You’re done with classes today.' : 'No imported classes today.'}>
                {!schedule.error && remaining.map((item) => (
                  <ListRow key={item.id} title={item.title}
                    subtitle={item.locationText || (item.locationId ? place(item.locationId) : 'Building not mapped')}
                    detail={Date.parse(item.start) <= now ? `Until ${bostonTime(item.end)}` : bostonTime(item.start)} />
                ))}
              </SectionList>
              {!schedule.loading && !schedule.error && <Link className={styles.textLink} to="/calendars">
                {schedule.data?.length ? 'Manage class import' : 'Import your classes'}
              </Link>}
            </div>
          </div>

          <section className={styles.campus} aria-labelledby="campus-heading">
          <h2 id="campus-heading" className={styles.sectionTitle}>Around campus</h2>
          <div className={styles.secondary}>
            <div className={styles.list}>
              <SectionList title="Study for an hour" to="/study"
                empty={studyFailed ? 'Study recommendations unavailable.' : studyLoading ? 'Finding study spots…'
                  : 'No study space is open right now by its published hours.'}>
                {!studyLoading && !studyFailed && study.map((result) => (
                  <ListRow key={result.spot.id} to="/study" title={result.spot.name}
                    subtitle={[
                      result.walk !== null ? `${result.walk} min walk` : null,
                      result.usable !== null && result.usable > 0 ? `${result.usable} min to study`
                        : result.open === null ? 'Hours unconfirmed' : null,
                    ].filter(Boolean).join(' · ') || result.spot.area}
                    detail={result.crowd !== null ? `${formatPercent(result.crowd)} ${crowdFor(result.crowd).label}` : undefined} />
                ))}
              </SectionList>
              {!studyFailed && !studyLoading && study.length > 0 && <p className={styles.note}>Crowds are model projections, not live counts.</p>}
              {!homeLocationId && profile.data && <Link className={styles.textLink} to="/profile">Set your home for walking times</Link>}
            </div>
            <div className={styles.list}>
              <SectionList title="Coming up on campus" to="/events">
                {!!schedule.data?.length && <div className={styles.filter}>
                  <Segmented label="Show events" value={eventFilter} onChange={setEventFilter}
                    options={[{ value: 'all', label: 'Coming up' }, { value: 'fits', label: 'Fits your day' }]} />
                </div>}
                {events.error ? <p className={styles.note}>Events unavailable.</p>
                  : events.loading || (eventFilter === 'fits' && fitsUnavailable)
                    ? <p className={styles.note}>{eventFilter === 'fits' && !events.loading ? 'Schedule-fit data is not ready.' : 'Loading events…'}</p>
                    : shownEvents.length ? shownEvents.map((event) => {
                      const fit = eventFilter === 'fits' ? fits.find((entry) => entry.event.id === event.id) : undefined;
                      return <ListRow key={event.id} title={event.title} subtitle={[
                        eventVenue(event),
                        fit ? `${fit.walkThere} min walk${fit.leaveBy !== null ? ` · leave by ${bostonTime(fit.leaveBy)}` : ''}` : null,
                      ].filter(Boolean).join(' · ')}
                        detail={bostonDay(event.start) === todayKey ? bostonTime(event.start) : formatDayTime(event.start)} />;
                    }) : <p className={styles.note}>{eventFilter === 'fits' ? 'No upcoming events fit your free time and walking range.' : 'No campus events coming up.'}</p>}
              </SectionList>
            </div>
          </div>
          </section>

          <details className={styles.planning} open={planningOpen} onToggle={(event) => setPlanningOpen(event.currentTarget.open)}>
            <summary>Plan the rest of your day <span>Meals, free time & getting home</span></summary>
            {planningOpen && <div className={styles.planningBody}>
              {planningFailed ? <p>Daily planning is unavailable. Retry the failed data above.</p>
                : planningLoading ? <p role="status">Loading your daily plan…</p> : <>
                  {events.error || venues.error ? <p>Today’s brief is unavailable. Retry the event or venue data above.</p>
                    : events.loading || venues.loading ? <p role="status">Loading today’s brief…</p>
                    : <TodayBrief schedule={schedule.data ?? []} locations={locations.data ?? []} geo={geoData}
                    hours={hours.data ?? {}} forecasts={hourly.data ?? []} profile={profile.data ?? null}
                    homeLocationId={homeLocationId} campusEvents={events.data ?? []} venues={venues.data}
                    now={now} transit={transit.context} loading={false} />}
                  <GapCard schedule={schedule.data ?? []} locations={locations.data ?? []} geo={geoData}
                    hours={hours.data ?? {}} forecasts={hourly.data ?? []} profile={profile.data ?? null}
                    now={now} homeLocationId={homeLocationId} loading={false} />
                  <TonightCard schedule={schedule.data ?? []} locations={locations.data ?? []} geo={geoData}
                    hours={hours.data ?? {}} forecasts={hourly.data ?? []} homeLocationId={homeLocationId}
                    now={now} transit={transit.context} loading={transit.loading} />
                </>}
              {!locations.loading && !locations.error && <CrowdReportPrompt locations={locations.data ?? []} />}
            </div>}
          </details>
        </div>
      </div>
    </Page>
  );
}
