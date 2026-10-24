import { useState } from 'react';
import { api, useResource } from '../data/api';
import { Avatar, Button, EmptyState, Loading, Page, PageHeader, SectionList, Segmented, Tag } from '../ui';
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
      <Segmented
        label="Show"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All clubs' },
          { value: 'following', label: `Following (${followingCount})` },
        ]}
      />

      <div className={styles.list}>
        <SectionList
          title={filter === 'following' ? 'Clubs you follow' : 'Verified clubs'}
          count={shown.length}
          empty={filter === 'following' ? "You don't follow any clubs yet. Follow one to see its events on your schedule." : 'No verified clubs yet.'}
        >
          {shown.map((c) => (
            <div key={c.id} className={styles.row}>
              <Avatar name={c.name} />
              <div className={styles.main}>
                <div className={styles.name}>
                  {c.name}
                  {c.following && <Tag tone="accent">Following</Tag>}
                </div>
                <p className={styles.description}>{c.description}</p>
                <p className={styles.members}>{c.members.toLocaleString()} members</p>
              </div>
              <Button
                variant={c.following ? 'ghost' : 'secondary'}
                size="sm"
                disabled={pending === c.id}
                onClick={() => setFollowing(c.id, !c.following)}
                aria-label={`${c.following ? 'Unfollow' : 'Follow'} ${c.name}`}
              >
                {c.following ? 'Unfollow' : 'Follow'}
              </Button>
            </div>
          ))}
        </SectionList>
      </div>

      <p className={styles.footnote}>
        Run a club? Register it with your bu.edu email, and once it's verified you can upload its calendar.
      </p>
    </Page>
  );
}
