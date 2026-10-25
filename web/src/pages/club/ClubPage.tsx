import { Upload } from 'lucide-react';
import { useSession } from '../../auth/session';
import { api, useResource } from '../../data/api';
import { formatDate, formatDateTime, formatRelative } from '../../lib/format';
import { Button, EmptyState, ListRow, Loading, Page, PageHeader, SectionList, Tag } from '../../ui';
import styles from './ClubPage.module.css';
import { eventVenue } from '../student/events';

export default function ClubPage() {
  const { session } = useSession();
  const clubId = session?.officerOfClubId ?? '';
  const club = useResource(() => (clubId ? api.getClubDetails(clubId) : Promise.resolve(null)), [clubId]);
  const events = useResource(() => api.getCampusEvents(), []);
  const imports = useResource(() => (clubId ? api.getCalendarImports(clubId) : Promise.resolve([])), [clubId]);

  if (!clubId) {
    return (
      <Page>
        <PageHeader title="Club page" />
        <EmptyState
          title="You’re not an officer of a club yet"
          body="Club registration and officer verification are currently unavailable."
          action={<Button to="/clubs/register">Register your club</Button>}
        />
      </Page>
    );
  }

  if (club.error) {
    return (
      <Page>
        <PageHeader title="Club page" />
        <p className={styles.error} role="alert">
          Your club didn’t load. <Button variant="ghost" size="sm" onClick={club.reload}>Try again</Button>
        </p>
      </Page>
    );
  }

  if (!club.data) {
    return (
      <Page>
        <PageHeader title="Club page" />
        <Loading label="Loading your club" />
      </Page>
    );
  }

  const c = club.data;
  const now = Date.now();
  const upcoming = (events.data ?? [])
    .filter((e) => e.clubId === clubId && new Date(e.start).getTime() >= now - 60 * 60 * 1000)
    .sort((a, b) => a.start.localeCompare(b.start));
  const lastImport = imports.data?.find((i) => !i.error);

  return (
    <Page>
      <PageHeader
        title={c.name}
        description={c.description}
        actions={
          <Button variant="accent" to="/club/calendar" icon={<Upload aria-hidden />}>
            Preview a calendar
          </Button>
        }
      />

      <div className={styles.status}>
        {c.verified ? <Tag tone="ok">Verified</Tag> : <Tag tone="off">Not verified</Tag>}
        <span>
          {c.verified
            ? c.verifiedAt
              ? `Checked by the Flowcast team on ${formatDate(c.verifiedAt)}. Your events can appear in Flowcast.`
              : 'Checked by the Flowcast team. Your events can appear in Flowcast.'
            : 'No verified officer review is recorded. Calendar publishing is unavailable.'}
        </span>
      </div>

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>Followers</dt>
          <dd>{c.followers?.toLocaleString() ?? 'Not available'}</dd>
        </div>
        <div className={styles.fact}>
          <dt>Upcoming events</dt>
          <dd>{events.error ? 'Unavailable' : events.data ? upcoming.length : 'Loading'}</dd>
        </div>
        <div className={styles.fact}>
          <dt>Last calendar upload</dt>
          <dd className={styles.small}>{imports.error ? 'Unavailable' : !imports.data ? 'Loading' : lastImport ? formatRelative(lastImport.importedAt) : 'None recorded'}</dd>
        </div>
      </dl>

      <div className={styles.columns}>
        <SectionList
          title="Upcoming events"
          count={events.data ? upcoming.length : undefined}
          empty={events.error ? <p role="alert">{events.error.message}</p> : events.data ? 'No upcoming events in the published data.' : <Loading />}
        >
          {upcoming.map((e) => (
            <ListRow
              key={e.id}
              title={e.title}
              subtitle={eventVenue(e)}
              detail={formatDateTime(e.start)}
            />
          ))}
        </SectionList>

        <SectionList title="Club details">
          <ListRow title="BU Engage page" detail={c.listingUrl ? <a href={c.listingUrl} target="_blank" rel="noreferrer">Open listing</a> : 'Not added'} />
          <ListRow title="Officers" detail={c.officers.length ? c.officers.join(', ') : 'Not listed'} />
          <ListRow title="Members on BU Engage" detail={c.members?.toLocaleString() ?? 'Not published'} />
        </SectionList>
      </div>
    </Page>
  );
}
