import { useState } from 'react';
import { api, locationName, useResource } from '../data/api';
import type { EventSource, ScheduleItem } from '../data/types';
import { formatDayLabel, isToday } from '../lib/format';
import { Button, EmptyState, Loading, Page, PageHeader, SectionList, Tag } from '../ui';
import { AgendaRow } from './student/AgendaRow';
import { groupByDay, isUpcoming } from './student/days';
import styles from './Schedule.module.css';

const sourceLabel: Record<EventSource, string> = {
  calendar: 'Calendar',
  club: 'Club',
  habit: 'Habit',
  suggested: 'Suggested',
  course: 'Course',
};

function SourceTag({ item }: { item: ScheduleItem }) {
  if (item.source === 'suggested') {
    return item.accepted ? <Tag tone="ok">Added</Tag> : <Tag tone="accent">Suggested</Tag>;
  }
  return <Tag>{sourceLabel[item.source]}</Tag>;
}

export default function Schedule() {
  const locations = useResource(api.getLocations);
  const schedule = useResource(api.getSchedule);
  const suggestions = useResource(api.getSuggestions);
  const [accepting, setAccepting] = useState<string | null>(null);

  const accept = (suggestionId: string) => {
    setAccepting(suggestionId);
    api
      .acceptSuggestion(suggestionId)
      .then((rest) => {
        suggestions.setData(rest);
        schedule.reload();
      })
      .finally(() => setAccepting(null));
  };

  const header = (
    <PageHeader
      title="Schedule"
      description="Your week from your courses, Google Calendar, clubs and habits, with suggestions when a place is likely to be crowded."
      actions={
        <>
          <Button to="/courses">Add courses</Button>
          <Button variant="ghost" to="/calendars">Manage calendars</Button>
        </>
      }
    />
  );

  if (schedule.error) {
    return (
      <Page>
        {header}
        <EmptyState title="Your schedule didn't load" body={schedule.error.message} action={<Button onClick={schedule.reload}>Try again</Button>} />
      </Page>
    );
  }

  if (!schedule.data) {
    return (
      <Page>
        {header}
        <Loading label="Loading your schedule" />
      </Page>
    );
  }

  const groups = groupByDay(schedule.data.filter((s) => isUpcoming(s.start)), (s) => s.start);
  if (!groups.length || !isToday(groups[0].start)) {
    groups.unshift({ key: 'today', start: new Date().toISOString(), items: [] });
  }

  return (
    <Page>
      {header}
      <div className={styles.days}>
        {groups.map((g) => (
          <SectionList
            key={g.key}
            title={formatDayLabel(g.start)}
            count={g.items.length}
            empty="Nothing scheduled. Classes, club events and habits for this day will show up here."
          >
            {g.items.map((item) => {
              const suggestion = suggestions.data?.find((s) => s.scheduleItemId === item.id);
              return (
                <AgendaRow
                  key={item.id}
                  start={item.start}
                  end={item.end}
                  title={item.title}
                  meta={locationName(locations.data, item.locationId, false)}
                  note={item.note}
                  aside={
                    <>
                      {suggestion && (
                        <Button size="sm" onClick={() => accept(suggestion.id)} disabled={accepting === suggestion.id}>
                          {suggestion.actionLabel}
                        </Button>
                      )}
                      <SourceTag item={item} />
                    </>
                  }
                />
              );
            })}
          </SectionList>
        ))}
      </div>
    </Page>
  );
}
