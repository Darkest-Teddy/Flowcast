import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, type useResource } from '../../data/api';
import type { ClubNotification } from '../../data/types';
import { errorText } from '../../lib/orgs';
import { formatRelative } from '../../lib/format';
import { Button, EmptyState, Loading, Tag } from '../../ui';
import styles from '../Meetings.module.css';

type Notes = ReturnType<typeof useResource<{ enabled: boolean; items: ClubNotification[] }>>;

/** Announcements and meeting changes from clubs you follow. Opening this marks them read. */
export function Updates({ notes }: { notes: Notes }) {
  const [turningOn, setTurningOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unread = notes.data?.items.some((n) => n.unread) ?? false;
  useEffect(() => {
    // Mark read once seen; the list keeps showing which were new this time.
    if (unread) void api.markClubNotificationsRead().catch(() => undefined);
  }, [unread]);

  async function turnOn() {
    setTurningOn(true); setError(null);
    try { await api.updateNotificationPrefs({ clubEvents: true }); notes.reload(); }
    catch (e) { setError(errorText(e, 'Club updates could not be turned on.')); }
    finally { setTurningOn(false); }
  }

  if (notes.loading) return <Loading label="Loading club updates" />;
  if (notes.error) return <p role="alert">{errorText(notes.error)}</p>;
  if (!notes.data!.enabled) return <EmptyState title="Club updates are off"
    body="Turn them on to see new meetings, room and time changes, cancellations and announcements from clubs you follow. You can turn them off in Settings."
    action={<><Button variant="primary" onClick={turnOn} disabled={turningOn}>Turn on club updates</Button>{error && <p role="alert">{error}</p>}</>} />;
  if (!notes.data!.items.length) return <EmptyState title="No updates in the last 30 days" body="Follow clubs on the Clubs page to hear about their meetings here." action={<Button to="/clubs">Browse clubs</Button>} />;
  return <ul className={styles.updates} aria-label="Club updates">
    {notes.data!.items.map((n) => <li key={n.id} className={styles.card}>
      <p className={styles.when}>{formatRelative(n.at)}{n.unread && <> · <Tag tone="accent">New</Tag></>}</p>
      <Link className={styles.organizer} to={`/clubs/${encodeURIComponent(n.clubId)}`}>{n.clubName.replace(/\s+-\s+\d+$/, '')}</Link>
      <p>{n.body}</p>
    </li>)}
  </ul>;
}
