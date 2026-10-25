import { useState } from 'react';
import { Link } from 'react-router';
import { api, useResource } from '../data/api';
import { Avatar, Button, EmptyState, Loading, Page, PageHeader, Segmented, Tag } from '../ui';
import styles from './Clubs.module.css';

type Filter = 'all' | 'following';

export default function Clubs() {
  const clubs = useResource(api.getClubs);
  const [filter, setFilter] = useState<Filter>('all');
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
  const shown = filter === 'following' ? listed.filter((c) => c.following) : listed;

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
              <p className={styles.description}>{c.description}</p>
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
