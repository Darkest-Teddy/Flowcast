import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, useResource } from '../data/api';
import { discoverClubs, officerMeetingEvents } from '../lib/orgs';
import { studyWalkMinutes } from '../lib/studyFinder';
import { Avatar, Button, EmptyState, Loading, Page, PageHeader, Segmented, Tag } from '../ui';
import { CLUB_TAGS } from './club/ClubAdmin';
import styles from './Clubs.module.css';

const NEAR_MINUTES = 10;
const nextFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

type Filter = 'all' | 'following';

export default function Clubs() {
  const clubs = useResource(api.getClubs);
  const profiles = useResource(api.getClubProfiles);
  const events = useResource(api.getCampusEvents);
  const posted = useResource(api.getClubMeetings);
  const locations = useResource(api.getLocations);
  const geo = useResource(api.getCampusGeo);
  const profile = useResource(api.getProfile);
  const schedule = useResource(api.getSchedule);
  const [filter, setFilter] = useState<Filter>('all');
  const [tag, setTag] = useState<string | null>(null);
  const [near, setNear] = useState(false);
  const [free, setFree] = useState(false);
  const [now] = useState(Date.now);
  const home = profile.data?.homeLocationId ?? null;
  const discovery = useMemo(() => {
    const names = new Map((clubs.data ?? []).map((c) => [c.id, c.name]));
    const all = [...officerMeetingEvents(posted.data?.meetings ?? [], names), ...(events.data ?? [])];
    return discoverClubs(all, schedule.data ?? [], now, (id) => (home && geo.data && locations.data ? studyWalkMinutes(geo.data, locations.data, home, id) : null));
  }, [clubs.data, posted.data, events.data, schedule.data, now, home, geo.data, locations.data]);
  const [pending, setPending] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const setFollowing = (clubId: string, following: boolean) => {
    setPending(clubId);
    setSaveError(null);
    api
      .setFollowing(clubId, following)
      .then(clubs.setData)
      .catch((error: unknown) => setSaveError(error instanceof Error ? error.message : 'Your follow preference could not be saved.'))
      .finally(() => setPending(null));
  };

  const header = (
    <PageHeader
      title="Clubs"
      description="Organizers from BU’s public event listings."
      actions={<><Button to="/meetings" variant="secondary">Find meetings</Button><Button to="/meetings?tab=plan" variant="secondary">Plan a meeting</Button><Button to="/clubs/register" variant="ghost">Run a club?</Button></>}
    />
  );

  if (clubs.error) {
    return (
      <Page>
        {header}
        <EmptyState title="Clubs didn't load" body={clubs.error.message} action={<Button onClick={clubs.reload}>Try again</Button>} />
      </Page>
    );
  }
  if (!clubs.data) {
    return (
      <Page>
        {header}
        <Loading label="Loading clubs" />
      </Page>
    );
  }

  const listed = clubs.data;
  const followingCount = listed.filter((c) => c.following).length;
  const shown = listed.filter((c) => (filter !== 'following' || c.following)
    && (!tag || profiles.data?.[c.id]?.tags.includes(tag))
    && (!near || (discovery.get(c.id)?.walk ?? Infinity) <= NEAR_MINUTES)
    && (!free || !!discovery.get(c.id)?.freeFit));
  const usedTags = CLUB_TAGS.filter((t) => Object.values(profiles.data ?? {}).some((p) => p.tags.includes(t)));

  return (
    <Page>
      {header}
      {saveError && <p role="alert">{saveError}</p>}
      <div className={styles.toolbar}>
        <Segmented
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All clubs' },
            { value: 'following', label: `Following (${followingCount})` },
          ]}
        />
        <div className={styles.discover} role="group" aria-label="Discover clubs">
          {usedTags.map((t) => <button key={t} type="button" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>{t}</button>)}
          <button type="button" aria-pressed={near} disabled={!home} title={home ? undefined : 'Set your home building in Profile'} onClick={() => setNear(!near)}>Meets near my dorm</button>
          <button type="button" aria-pressed={free} disabled={!schedule.data?.length} title={schedule.data?.length ? undefined : 'Import your class schedule in Calendars'} onClick={() => setFree(!free)}>Meets when I’m free</button>
        </div>
        <p className={styles.count}>
          {shown.length} {filter === 'following' ? 'followed' : 'listed'} {shown.length === 1 ? 'club' : 'clubs'}
        </p>
      </div>

      {shown.length ? (
        <ul className={styles.grid} aria-label={filter === 'following' ? 'Clubs you follow' : 'Published event organizers'}>
          {shown.map((c) => (
            <li key={c.id} className={styles.card}>
              <div className={styles.name}>
                <Avatar name={c.name} size={32} />
                <h2><Link to={`/clubs/${encodeURIComponent(c.id)}`}>{c.name}</Link></h2>
                {c.following && <Tag tone="accent">Following</Tag>}
              </div>
              <p className={styles.description}>{profiles.data?.[c.id]?.blurb || c.description}</p>
              {profiles.data?.[c.id]?.tags.length ? <p className={styles.tags}>{profiles.data[c.id].tags.map((t) => <Tag key={t}>{t}</Tag>)}</p> : null}
              {(() => {
                const d = discovery.get(c.id);
                if (!d?.next) return null;
                const fit = free && d.freeFit ? d.freeFit : d.next;
                return <p className={styles.next}>Next: {fit.title}, {nextFormat.format(new Date(fit.start))}{d.walk !== null ? ` · ${d.walk} min walk` : ''}</p>;
              })()}
              <div className={styles.foot}>
                <p className={styles.members}>{c.members == null ? 'Membership count not published' : `${c.members.toLocaleString()} members`}</p>
                <Button
                  variant={c.following ? 'ghost' : 'secondary'}
                  disabled={pending === c.id}
                  onClick={() => setFollowing(c.id, !c.following)}
                  aria-label={`${c.following ? 'Unfollow' : 'Follow'} ${c.name}`}
                >
                  {c.following ? 'Unfollow' : 'Follow'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.empty}>
          <EmptyState
            title={filter === 'following' ? "You don't follow any clubs yet" : 'No published organizers available'}
            body={filter === 'following' ? 'Follow an organizer to keep it in your list.' : undefined}
          />
        </div>
      )}

      <p className={styles.footnote}>
        Listings do not verify membership. Officers are confirmed by an administrator before they can post.
      </p>
    </Page>
  );
}
