import { useState } from 'react';
import { api, locationName, useResource } from '../data/api';
import { formatDayLabel } from '../lib/format';
import { Button, EmptyState, Loading, Page, PageHeader, SectionList, Segmented, Tag } from '../ui';
import { AgendaRow } from './student/AgendaRow';
import { groupByDay, isUpcoming } from './student/days';
import styles from './Events.module.css';

type Filter = 'all' | 'following' | 'university';

export default function Events() {
  const locations = useResource(api.getLocations);
  const events = useResource(api.getCampusEvents);
  const clubs = useResource(api.getClubs);
  const [filter, setFilter] = useState<Filter>('all');

  const header = (
    <PageHeader
      title="Events"
      description="Club and university events coming up on campus. Big events change how crowded nearby places get."
      actions={<Button to="/clubs">Find clubs to follow</Button>}
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

  const clubOf = (id: string | null) => (id ? clubs.data?.find((c) => c.id === id) : undefined);
  const visible = events.data.filter((e) => {
    if (!isUpcoming(e.start)) return false;
    if (filter === 'university') return e.clubId === null;
    if (filter === 'following') return Boolean(clubOf(e.clubId)?.following);
    return true;
  });
  const groups = groupByDay(visible, (e) => e.start);

  return (
    <Page>
      {header}
      <Segmented
        label="Show"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All events' },
          { value: 'following', label: 'Clubs you follow' },
          { value: 'university', label: 'University' },
        ]}
      />

      <div className={styles.days}>
        {groups.length ? (
          groups.map((g) => (
            <SectionList key={g.key} title={formatDayLabel(g.start)} count={g.items.length}>
              {g.items.map((e) => {
                const club = clubOf(e.clubId);
                const where = locationName(locations.data, e.locationId, false);
                return (
                  <AgendaRow
                    key={e.id}
                    start={e.start}
                    title={e.title}
                    meta={e.clubId === null ? `At ${where}, hosted by Boston University` : `At ${where}, hosted by ${club?.name ?? 'a club'}`}
                    aside={
                      <>
                        {club?.following && <Tag tone="accent">Following</Tag>}
                        {e.clubId === null ? <Tag>University</Tag> : <Tag>Club</Tag>}
                      </>
                    }
                  />
                );
              })}
            </SectionList>
          ))
        ) : (
          <EmptyState
            title="No upcoming events here"
            body={filter === 'following' ? 'Clubs you follow have nothing scheduled yet.' : 'New events show up as clubs upload their calendars.'}
            action={filter !== 'all' && <Button onClick={() => setFilter('all')}>Show all events</Button>}
          />
        )}
      </div>
    </Page>
  );
}
