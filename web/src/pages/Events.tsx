import { useState } from 'react';
import { api, useResource } from '../data/api';
import { formatDayLabel } from '../lib/format';
import { Button, EmptyState, Loading, Page, PageHeader, SectionList, Segmented } from '../ui';
import { AgendaRow } from './student/AgendaRow';
import { groupByDay, isUpcoming } from './student/days';
import { eventDate, eventVenue, mapStatusText } from './student/events';
import styles from './Events.module.css';

type Filter = 'all' | 'map' | 'offMap';

const sinceDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export default function Events() {
  const events = useResource(api.getCampusEvents);
  const [filter, setFilter] = useState<Filter>('all');

  const header = (
    <PageHeader
      title="Events"
      description="Public listings from BU’s Terrier Central."
      actions={<Button to="/event-impact">See crowd impact by date</Button>}
    />
  );

  if (events.error) {
    return (
      <Page>
        {header}
        <EmptyState title="Events didn't load" body={events.error.message} action={<Button onClick={events.reload}>Try again</Button>} />
      </Page>
    );
  }
  if (!events.data) {
    return (
      <Page>
        {header}
        <Loading label="Loading events" />
      </Page>
    );
  }

  // Multi-day listings stay visible while they're still running.
  const upcoming = events.data.filter((e) => isUpcoming(e.end ?? e.start));
  const visible = upcoming.filter((e) => filter === 'all' || (filter === 'map') === (e.mapStatus === 'simulated'));
  // Listings that began on an earlier day and are still running get their own group up top,
  // rather than a stale "Wednesday, Sep 9" heading above today.
  const running = visible.filter((e) => !isUpcoming(e.start)).sort((a, b) => a.start.localeCompare(b.start));
  const groups = groupByDay(visible.filter((e) => isUpcoming(e.start)), (e) => e.start);
  const onMap = upcoming.filter((e) => e.mapStatus === 'simulated').length;

  return (
    <Page>
      {header}
      <Segmented
        label="Show"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: `All events (${upcoming.length})` },
          { value: 'map', label: `On the map (${onMap})` },
          { value: 'offMap', label: `Not on the map (${upcoming.length - onMap})` },
        ]}
      />

      <div className={styles.days}>
        {running.length > 0 && (
          <SectionList title="Still running" count={running.length}>
            {running.map((e) => (
              <AgendaRow
                key={e.id}
                start={e.start}
                timeLabel={`Since ${sinceDate.format(new Date(e.start))}`}
                title={e.sourceUrl ? <a href={e.sourceUrl} target="_blank" rel="noreferrer">{e.title}</a> : e.title}
                meta={`${eventVenue(e)}${e.organizer ? `, hosted by ${e.organizer}` : ''}`}
                note={mapStatusText(e)}
              />
            ))}
          </SectionList>
        )}
        {groups.length || running.length ? (
          groups.map((g) => (
            <SectionList key={g.key} title={formatDayLabel(g.start)} count={g.items.length}>
              {g.items.map((e) => (
                <AgendaRow
                  key={e.id}
                  start={e.start}
                  end={e.end && eventDate(e) === e.end.slice(0, 10) ? e.end : undefined}
                  title={e.sourceUrl ? <a href={e.sourceUrl} target="_blank" rel="noreferrer">{e.title}</a> : e.title}
                  meta={`${eventVenue(e)}${e.organizer ? `, hosted by ${e.organizer}` : ''}`}
                  note={mapStatusText(e)}
                  aside={
                    e.mapStatus === 'simulated' && (
                      <Button size="sm" to={`/event-impact?date=${eventDate(e)}`}>Crowd impact</Button>
                    )
                  }
                />
              ))}
            </SectionList>
          ))
        ) : (
          <EmptyState
            title="No upcoming events here"
            body={filter === 'map' ? 'None of the upcoming events are at places on the map.' : 'No upcoming events in the saved listings.'}
            action={filter !== 'all' && <Button onClick={() => setFilter('all')}>Show all events</Button>}
          />
        )}
      </div>
    </Page>
  );
}
