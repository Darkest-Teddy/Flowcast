import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Download } from 'lucide-react';
import { useSession } from '../auth/session';
import { api } from '../data/api';
import { Button, ListRow, Page, PageHeader, SectionHeading, SectionList } from '../ui';
import styles from './Privacy.module.css';

const kept = [
  { title: 'Your name and email', detail: 'From your Google account' },
  { title: 'Event times, titles and places', detail: 'Only from the calendars you turn on' },
  { title: 'Your profile answers', detail: 'Home dorm, meal times, study spot, avatar colour' },
  { title: 'The clubs you follow', detail: 'So their events show up for you' },
];

const notKept = [
  { title: 'Calendars you turned off', detail: 'Flowcast never reads them' },
  { title: 'Event descriptions, guests and attachments', detail: 'Skipped when syncing' },
  { title: 'Your Google password', detail: 'You sign in on Google’s own page' },
  { title: 'Your location', detail: 'The map follows your schedule, not your phone' },
];

export default function Privacy() {
  const { signOut } = useSession();
  const navigate = useNavigate();
  const [downloading, setDownloading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function download() {
    setDownloading(true);
    setMessage(null);
    try {
      const data = await api.exportMyData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'flowcast-my-data.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setMessage('Your data couldn’t be prepared. Check your connection and try again.');
    } finally {
      setDownloading(false);
    }
  }

  async function remove() {
    setDeleting(true);
    setMessage(null);
    try {
      await api.deleteMyData();
      signOut();
      navigate('/signin', { replace: true });
    } catch {
      setMessage('Your data wasn’t deleted. Check your connection and try again.');
      setDeleting(false);
    }
  }

  return (
    <Page>
      <PageHeader title="Privacy & data" description="What Flowcast keeps about you, and how to take it with you or remove it." />

      <div className={styles.columns}>
        <SectionList title="What Flowcast keeps">
          {kept.map((k) => (
            <ListRow key={k.title} title={k.title} subtitle={k.detail} />
          ))}
        </SectionList>
        <SectionList title="What Flowcast doesn’t keep">
          {notKept.map((k) => (
            <ListRow key={k.title} title={k.title} subtitle={k.detail} />
          ))}
        </SectionList>
      </div>

      <p className={styles.notice}>Your name, avatar, and schedule may be kept and shown in future demos of this project.</p>

      <SectionHeading>Your data</SectionHeading>
      <div className={styles.actions}>
        <div className={styles.action}>
          <div>
            <p className={styles.actionTitle}>Download my data</p>
            <p className={styles.actionBody}>A JSON file with everything listed under what Flowcast keeps.</p>
          </div>
          <Button icon={<Download aria-hidden />} onClick={download} disabled={downloading}>
            {downloading ? 'Preparing…' : 'Download my data'}
          </Button>
        </div>

        <div className={styles.action}>
          <div>
            <p className={styles.actionTitle}>Delete my data</p>
            <p className={styles.actionBody}>
              Removes your profile, your calendar connection and your agent on the map, then signs you out.
            </p>
          </div>
          {!confirming && (
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Delete my data
            </Button>
          )}
        </div>

        {confirming && (
          <div className={styles.confirm} role="group" aria-labelledby="delete-confirm">
            <p id="delete-confirm">This can’t be undone. Delete everything Flowcast keeps about you and sign out?</p>
            <div className={styles.confirmActions}>
              <Button variant="danger" onClick={remove} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete everything and sign out'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={deleting}>
                Keep my data
              </Button>
            </div>
          </div>
        )}
      </div>

      {message && (
        <p className={styles.error} role="alert">
          {message}
        </p>
      )}
    </Page>
  );
}
