import { useState } from 'react';
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
  StatusBadge,
  type SearchMode,
} from '../ui';
import { eventVenue } from './student/events';
import { AskChat } from './student/AskChat';
import { SearchResults } from './student/SearchResults';
import { bostonDay, bostonTime } from '../lib/departure';
import { DepartureCard, useDepartureClock } from './student/DepartureCard';
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

  const [search, setSearch] = useState<string | null>(null);
  const [mode, setMode] = useState<SearchMode>('search');
  const now = useDepartureClock();

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
          empty={events.loading ? loadingText : 'No campus events coming up.'}
        >
          {upcomingEvents.map((e) => (
            <ListRow
              key={e.id}
              title={
                <>
                  {e.title}
                  <span className={styles.where}>{eventVenue(e)}</span>
                </>
              }
              detail={isToday(e.start) ? `Today ${formatTime(e.start)}` : formatDayTime(e.start)}
            />
          ))}
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
