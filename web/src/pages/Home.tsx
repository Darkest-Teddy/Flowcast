import { useState } from 'react';
import { Link } from 'react-router';
import { crowdFor } from '@theme/tokens';
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
import styles from './Home.module.css';

export default function Home() {
  const { session } = useSession();
  const locations = useResource(api.getLocations);
  const schedule = useResource(api.getSchedule);
  const places = useResource(api.getPlaceForecasts);
  const hourly = useResource(api.getHourlyForecasts);
  const geo = useResource(api.getCampusGeo);
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
    <StatusBadge tone="ok">Imported schedule · {schedule.data.length} classes · <Link to="/calendars">Manage import</Link></StatusBadge>
  ) : (
    <StatusBadge tone="off">{schedule.loading ? 'Loading your schedule. ' : 'No imported classes. '}<Link to="/calendars">Import .ics schedule</Link></StatusBadge>
  );

  return (
    <Page>
      <div className={styles.hero}>
        <h1 className={styles.headline}>Where are you headed today?</h1>
        <p className={styles.status}>{calendarStatus}</p>
      </div>

      <SearchBar
        placeholder="Search buildings, events, clubs and classes"
        mode={mode}
        onModeChange={setMode}
        onSubmit={(query) => setSearch(query)}
      />

      <AskChat visible={mode === 'ask'} data={{
        locations: locations.data ?? [], schedule: schedule.data ?? [],
        events: events.data ?? [], clubs: clubs.data ?? [],
        hourly: hourly.data ?? [], places: places.data ?? [],
        geo: geo.data ?? { positions: {}, walkMeters: {} },
        homeLocationId: session?.user.homeLocationId ?? null,
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

      <p className={styles.status}>{places.data?.[0]?.basis ?? 'Campus crowd figures are model-derived projections, not live head counts.'}</p>
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
        </SectionList>


      </div>

      <SectionList title="Published campus data">
        <ListRow title="Mapped places" detail={locations.data ? `${locations.data.length} locations` : loadingText} />
        <ListRow title="Upcoming public events" detail={events.data ? `${events.data.filter((event) => Date.parse(event.end ?? event.start) >= Date.now()).length} in the saved listings` : loadingText} to="/events" />
        <ListRow title="Event organizers" detail={clubs.data ? `${clubs.data.length} named in public listings` : loadingText} to="/clubs" />
      </SectionList>

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
