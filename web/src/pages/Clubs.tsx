import { useState } from 'react';
import { api, useResource } from '../data/api';
import { Avatar, Button, EmptyState, Loading, Page, PageHeader, Segmented, Tag } from '../ui';
import styles from './Clubs.module.css';

type Filter = 'all' | 'following';

export default function Clubs() {
  const clubs = useResource(api.getClubs);
  const [filter, setFilter] = useState<Filter>('all');
  const [pending, setPending] = useState<string | null>(null);

  const setFollowing = (clubId: string, following: boolean) => {
    setPending(clubId);
    api
      .setFollowing(clubId, following)
      .then(clubs.setData)
      .finally(() => setPending(null));
  };

  const header = (
    <PageHeader
      title="Clubs"
      description="Follow a club to see its events on your schedule. Only clubs verified by Flowcast are listed."
      actions={<Button to="/clubs/register">Register your club</Button>}
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

  const verified = clubs.data.filter((c) => c.verified);
  const followingCount = verified.filter((c) => c.following).length;
  const shown = filter === 'following' ? verified.filter((c) => c.following) : verified;

  return (
    <Page>
      {header}
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
          {shown.length} {filter === 'following' ? 'followed' : 'verified'} {shown.length === 1 ? 'club' : 'clubs'}
        </p>
      </div>

      {shown.length ? (
        <ul className={styles.grid} aria-label={filter === 'following' ? 'Clubs you follow' : 'Verified clubs'}>
          {shown.map((c) => (
            <li key={c.id} className={styles.card}>
              <div className={styles.name}>
                <Avatar name={c.name} size={32} />
                <h2>{c.name}</h2>
                {c.following && <Tag tone="accent">Following</Tag>}
              </div>
              <p className={styles.description}>{c.description}</p>
              <div className={styles.foot}>
                <p className={styles.members}>{c.members.toLocaleString()} members</p>
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
            title={filter === 'following' ? "You don't follow any clubs yet" : 'No verified clubs yet'}
            body={filter === 'following' ? 'Follow one to see its events on your schedule.' : undefined}
          />
        </div>
      )}

      <p className={styles.footnote}>
        Run a club? Register it with your bu.edu email, and once it's verified you can upload its calendar.
      </p>
    </Page>
  );
}
