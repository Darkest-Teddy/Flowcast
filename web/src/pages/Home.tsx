import { useState } from 'react';
import { Link } from 'react-router';
import { crowdFor } from '@theme/tokens';
import { useSession } from '../auth/session';
import { api, locationName, useResource } from '../data/api';
import type { StatRange } from '../data/types';
import { formatDayTime, formatPercent, formatRelative, formatTime, isToday } from '../lib/format';
import {
  Avatar,
  Button,
  Grid,
  ListRow,
  Page,
  SearchBar,
  SectionHeading,
  SectionList,
  Segmented,
  StatCard,
  StatusBadge,
  type SearchMode,
} from '../ui';
import { isUpcoming } from './student/days';
import { eventVenue } from './student/events';
import { AskChat } from './student/AskChat';
import { SearchResults } from './student/SearchResults';
import styles from './Home.module.css';

export default function Home() {
  const { session } = useSession();
  const locations = useResource(api.getLocations);
  const schedule = useResource(api.getSchedule);
  const places = useResource(api.getPlaceForecasts);
  const hourly = useResource(api.getHourlyForecasts);
  const geo = useResource(api.getCampusGeo);
  const suggestions = useResource(api.getSuggestions);
  const events = useResource(api.getCampusEvents);
  const clubs = useResource(api.getClubs);
  const [range, setRange] = useState<StatRange>('7d');
  const stats = useResource(() => api.getWeekStats(range), [range]);

  const [search, setSearch] = useState<string | null>(null);
  const [mode, setMode] = useState<SearchMode>('search');
  const [accepting, setAccepting] = useState<string | null>(null);
  const [acceptedCount, setAcceptedCount] = useState(0);

  const place = (id: string) => locationName(locations.data, id);
  const loadingText = 'Loading…';

  const today = (schedule.data ?? [])
    .filter((s) => isToday(s.start))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const upcomingEvents = (events.data ?? [])
    .filter((e) => isUpcoming(e.start))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, 5);
  const followed = (clubs.data ?? []).filter((c) => c.following);

  const accept = (id: string) => {
    setAccepting(id);
    api
      .acceptSuggestion(id)
      .then((rest) => {
        suggestions.setData(rest);
        setAcceptedCount((n) => n + 1);
        schedule.reload();
      })
      .finally(() => setAccepting(null));
  };

  const calendarStatus =
    session?.calendarConnected && session.calendarSyncedAt ? (
      <StatusBadge tone="ok">Google Calendar synced {formatRelative(session.calendarSyncedAt)}</StatusBadge>
    ) : (
      <StatusBadge tone="off">
        No calendar connected yet. <Link to="/calendars">Connect Google Calendar</Link>
      </StatusBadge>
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

      <div className={styles.forYou}>
        <SectionList
          title="For you"
          empty={
            suggestions.loading ? (
              loadingText
            ) : acceptedCount > 0 ? (
              <>
                Added to your day. <Link to="/schedule">See your schedule</Link>
              </>
            ) : (
              'No suggestions right now. Flowcast will suggest a quieter time or place when one of yours gets crowded.'
            )
          }
        >
          {(suggestions.data ?? []).map((g) => (
            <div key={g.id} className={styles.suggestion}>
              <p>{g.text}</p>
              <Button onClick={() => accept(g.id)} disabled={accepting === g.id}>
                {g.actionLabel}
              </Button>
            </div>
          ))}
        </SectionList>
      </div>

      <div className={styles.columns}>
        <SectionList
          title="Today"
          count={schedule.data ? today.length : undefined}
          to="/schedule"
          empty={schedule.loading ? loadingText : 'Nothing on your calendar today.'}
        >
          {today.map((item) => (
            <ListRow
              key={item.id}
              title={
                <>
                  {item.title}
                  <span className={styles.where}>{place(item.locationId)}</span>
                </>
              }
              detail={formatTime(item.start)}
            />
          ))}
        </SectionList>

        <SectionList
          title="Your places"
          to="/forecasts"
          empty={places.loading ? loadingText : 'Places you visit will show up here.'}
        >
          {(places.data ?? []).map((p) => {
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

      <SectionHeading
        actions={
          <Segmented
            label="Time range"
            value={range}
            onChange={setRange}
            options={[
              { value: '7d', label: '7D' },
              { value: '30d', label: '30D' },
            ]}
          />
        }
      >
        {range === '7d' ? 'This week' : 'Last 30 days'}
      </SectionHeading>
      <Grid columns={4} phoneColumns={2}>
        {(stats.data ?? []).map((s) => (
          <StatCard
            key={s.id}
            label={s.label}
            value={s.value}
            detail={s.detail}
            series={s.series}
            axis={s.axis}
            highlightIndex={s.highlightIndex}
          />
        ))}
      </Grid>

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
