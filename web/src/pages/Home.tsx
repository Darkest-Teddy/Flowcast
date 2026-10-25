import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { crowdFor } from '@theme/tokens';
import { LiveVoice } from '@map/LiveVoice';
import { useSession } from '../auth/session';
import { api, locationName, useResource } from '../data/api';
import { formatDayTime, formatPercent, formatTime, isToday } from '../lib/format';
import {
  Avatar,
  Button,
  ListRow,
  Page,
  SearchBar,
  SectionList,
  Segmented,
  StatusBadge,
  Tag,
  type SearchMode,
} from '../ui';
import { eventVenue } from './student/events';
import { AskChat } from './student/AskChat';
import { SearchResults } from './student/SearchResults';
import { bostonDay, bostonTime } from '../lib/departure';
import { DepartureCard, useDepartureClock } from './student/DepartureCard';
import { GapCard } from './student/GapCard';
import { CrowdReportPrompt } from './student/CrowdReport';
import { TonightCard } from './student/TonightCard';
import { TodayBrief } from './student/TodayBrief';
import { eventsInGaps, freeWindows, MAX_EVENT_WALK, type EventFit } from '../lib/eventsInGaps';
import { useCampusTransit } from '../lib/transitTimetables';
import styles from './Home.module.css';

export default function Home() {
  const { session } = useSession();
  const locations = useResource(api.getLocations);
  const schedule = useResource(api.getSchedule);
  const places = useResource(api.getPlaceForecasts);
  const hourly = useResource(api.getHourlyForecasts);
  const geo = useResource(api.getCampusGeo);
  const transit = useCampusTransit();
  const profile = useResource(api.getProfile);
  const events = useResource(api.getCampusEvents);
  const clubs = useResource(api.getClubs);
  const hours = useResource(api.getPlaceHours);
  const venues = useResource(api.getVenueCalendar);

  const [search, setSearch] = useState<string | null>(null);
  const [mode, setMode] = useState<SearchMode>('search');
  const [eventFilter, setEventFilter] = useState<'all' | 'fits'>('all');
  const now = useDepartureClock();
  const homeLocationId = profile.data ? profile.data.homeLocationId : session?.user.homeLocationId ?? null;

  const place = (id: string) => locationName(locations.data, id);
  const loadingText = 'Loading…';

  const today = (schedule.data ?? [])
    .filter((s) => Number.isFinite(Date.parse(s.start)) && bostonDay(s.start) === bostonDay(now))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const upcomingEvents = (events.data ?? [])
    .filter((e) => Date.parse(e.end ?? e.start) >= Date.now())
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, 5);
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

  const calendarStatus = schedule.data?.length ? (
    <StatusBadge tone="ok">{schedule.data.length} imported {schedule.data.length === 1 ? 'class' : 'classes'} · <Link to="/calendars">Manage import</Link></StatusBadge>
  ) : (
    <StatusBadge tone="off">{schedule.loading ? 'Loading your schedule. ' : 'No imported classes. '}<Link to="/calendars">Import .ics schedule</Link></StatusBadge>
  );

  return (
    <Page>
      <div className={styles.hero}>
        <h1 className={styles.headline}>Where are you headed today?</h1>
        <p className={styles.status}>{calendarStatus}</p>
      </div>

      <TodayBrief schedule={schedule.data ?? []} locations={locations.data ?? []}
        geo={geo.data ?? { positions: {}, walkMeters: {} }} hours={hours.data ?? {}} forecasts={hourly.data ?? []}
        profile={profile.data ?? null} homeLocationId={homeLocationId} campusEvents={events.data ?? []} venues={venues.data}
        now={now} transit={transit.context}
        loading={schedule.loading || locations.loading || geo.loading || profile.loading || hours.loading || events.loading} />

      <AskChat scheduleAvailable={schedule.data !== null} visible={mode === 'ask'} composer={(ask, pending, resetToken) => (
        <div className={styles.searchControls}>
          <SearchBar placeholder="Search buildings, events, clubs and classes" mode={mode}
            resetToken={resetToken} onModeChange={setMode} pending={mode === 'ask' && pending}
            onSubmit={(query, selectedMode) => { if (selectedMode === 'ask') void ask(query); else setSearch(query); }} />
          <LiveVoice compact />
        </div>
      )} data={{
        locations: locations.data ?? [], schedule: schedule.data ?? [],
        events: events.data ?? [], clubs: clubs.data ?? [],
        hourly: hourly.data ?? [], places: places.data ?? [],
        geo: geo.data ?? { positions: {}, walkMeters: {} },
        homeLocationId: session?.user.homeLocationId ?? null,
        transit: transit.context,
      }} />

      {mode === 'search' && search && (
        <SearchResults query={search} onClear={() => setSearch(null)}
          data={{
            locations: locations.data ?? [], schedule: schedule.data ?? [],
            events: events.data ?? [], clubs: clubs.data ?? [],
            hourly: hourly.data ?? [], places: places.data ?? [],
            geo: geo.data ?? { positions: {}, walkMeters: {} },
            homeLocationId: session?.user.homeLocationId ?? null,
          }} />
      )}

      {[locations, schedule, places, hourly, geo, profile, events, clubs].filter((resource) => resource.error).map((resource, index) => (
        <p role="alert" key={index}>{resource.error?.message} <Button variant="ghost" size="sm" onClick={resource.reload}>Try again</Button></p>
      ))}

      <CrowdReportPrompt locations={locations.data ?? []} />

      <GapCard schedule={schedule.data ?? []} locations={locations.data ?? []}
        geo={geo.data ?? { positions: {}, walkMeters: {} }} hours={hours.data ?? {}} forecasts={hourly.data ?? []}
        profile={profile.data ?? null} now={now}
        homeLocationId={homeLocationId}
        loading={schedule.loading || locations.loading || geo.loading || profile.loading || hours.loading} />

      <TonightCard schedule={schedule.data ?? []} locations={locations.data ?? []}
        geo={geo.data ?? { positions: {}, walkMeters: {} }} hours={hours.data ?? {}} forecasts={hourly.data ?? []}
        homeLocationId={homeLocationId} now={now} transit={transit.context}
        loading={schedule.loading || locations.loading || geo.loading || profile.loading || hours.loading || transit.loading} />

      <DepartureCard items={schedule.data ?? []} locations={locations.data ?? []}
        geo={geo.data ?? { positions: {}, walkMeters: {} }} now={now}
        homeLocationId={profile.data ? profile.data.homeLocationId : session?.user.homeLocationId ?? null}
        loading={schedule.loading || locations.loading || geo.loading || profile.loading} />

      <div className={styles.columns}>
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
              detail={bostonTime(item.start)}
            />
          ))}
        </SectionList>

        <SectionList
          title="Campus crowd projections"
          to="/forecasts"
          empty={places.loading ? loadingText : 'No comparable crowd projection is available for this hour.'}
        >
          <p className={styles.forecastNote}>Modeled crowd levels, not live head counts.</p>
          {!places.data?.length && <p className={styles.forecastNote}>{places.loading ? loadingText : 'No comparable crowd projection is available for this hour.'}</p>}
          {(places.data ?? []).slice(0, 6).map((p) => {
            const level = crowdFor(p.share);
            return (
              <ListRow
                key={p.locationId}
                leading={<i className={styles.crowdDot} style={{ background: level.color }} aria-hidden />}
                title={place(p.locationId)}
                detail={`${formatPercent(p.share)} ${level.label} at ${formatTime(p.at)}`}
              />
            );
          })}
          <ListRow title="Find a study spot" subtitle="Amenities and walking time" to="/study" />
          {places.data?.[0]?.basis && <details className={styles.forecastNote}><summary>About these projections</summary><p>{places.data[0].basis}</p></details>}
        </SectionList>


      </div>


      <div className={styles.bottom}>
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
                detail={isToday(e.start) ? `Today ${formatTime(e.start)}` : formatDayTime(e.start)}
              />
            );
          })}
          {schedule.data?.length && !shownEvents.length && !events.loading ? <p className={styles.forecastNote}>{eventFilter === 'fits' ? 'No upcoming event this week fits your free time and walking range.' : 'No campus events coming up.'}</p> : null}
          {eventFilter === 'fits' && fits.size > 0 && <p className={styles.forecastNote}>Starts while you're free, within a {MAX_EVENT_WALK}-minute walk on saved routes, with time to stay and still make your next class (5 min buffer). Followed clubs first. Registration counts are never treated as attendance.</p>}
        </SectionList>

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
        </SectionList>
      </div>
    </Page>
  );
}
