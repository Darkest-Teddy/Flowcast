import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Download } from 'lucide-react';
import { useSession } from '../auth/session';
import { api } from '../data/api';
import { Button, ListRow, Page, PageHeader, SectionHeading, SectionList } from '../ui';
import styles from './Privacy.module.css';

const kept = [
  { title: 'Your profile', detail: 'The name, dorm, meal times, study spot and avatar colour you enter' },
  { title: 'Your preferences', detail: 'Notification preferences and club follows saved by Flowcast for this browser' },
];

const notKept = [
  { title: 'Google account or calendar', detail: 'Google sign-in and calendar sync are unavailable' },
  { title: 'A verified identity', detail: 'Your browser-linked profile is not a verified account' },
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
      setMessage('Your profile data couldn’t be prepared. Please try again.');
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
      setMessage('Your profile data wasn’t deleted. Please try again.');
      setDeleting(false);
    }
  }

  return (
    <Page>
      <PageHeader title="Privacy & data" description="Manage profile details and preferences saved by Flowcast and linked to this browser." />

      <div className={styles.columns}>
        <SectionList title="Browser-linked data">
          {kept.map((k) => (
            <ListRow key={k.title} title={k.title} subtitle={k.detail} />
          ))}
        </SectionList>
        <SectionList title="Not connected">
          {notKept.map((k) => (
            <ListRow key={k.title} title={k.title} subtitle={k.detail} />
          ))}
        </SectionList>
      </div>

      <p className={styles.notice}>This profile is linked to this browser, not a Google login. Appearance settings are stored separately on this browser and are not removed by deleting your profile.</p>

      <SectionHeading>Your data</SectionHeading>
      <div className={styles.actions}>
        <div className={styles.action}>
          <div>
            <p className={styles.actionTitle}>Download profile data</p>
            <p className={styles.actionBody}>A JSON file of your saved profile, notification preferences and club follows.</p>
          </div>
          <Button icon={<Download aria-hidden />} onClick={download} disabled={downloading}>
            {downloading ? 'Preparing…' : 'Download profile data'}
          </Button>
        </div>

        <div className={styles.action}>
          <div>
            <p className={styles.actionTitle}>Delete profile data</p>
            <p className={styles.actionBody}>
              Clears your saved profile, notification preferences and club follows. You can continue browsing campus afterward.
            </p>
          </div>
          {!confirming && (
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Delete profile data
            </Button>
          )}
        </div>

        {confirming && (
          <div className={styles.confirm} role="group" aria-labelledby="delete-confirm">
            <p id="delete-confirm">Delete your saved profile, preferences and club follows? This can’t be undone.</p>
            <div className={styles.confirmActions}>
              <Button variant="danger" onClick={remove} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete profile data'}
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
