import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Download } from 'lucide-react';
import { useSession } from '../auth/session';
import { api } from '../data/api';
import { Button, ListRow, Page, PageHeader, SectionHeading, SectionList } from '../ui';
import { Terms } from './account/Terms';
import styles from './Privacy.module.css';

const kept = [
  { title: 'Your imported schedule', detail: 'Saved to your account. Ask sends up to two weeks of classes, times and rooms to the AI with each question; they do not enter the campus simulation.' },
  { title: 'Your profile', detail: 'The name, dorm, meal times, study spot and avatar colour you enter' },
  { title: 'Your preferences', detail: 'Notification preferences and club follows saved to your Flowcast account' },
];

const notKept = [
  { title: 'Google Calendar', detail: 'Sign-in does not request calendar access; calendar sync is unavailable' },
  { title: 'Your Google password', detail: 'You sign in with Google; Flowcast does not receive your Google password' },
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
      setMessage('Your account data couldn’t be prepared. Please try again.');
    } finally {
      setDownloading(false);
    }
  }

  async function remove() {
    setDeleting(true);
    setMessage(null);
    try {
      await api.deleteMyData();
      await signOut();
      navigate('/signin', { replace: true });
    } catch {
      setMessage('Profile deletion or sign-out could not finish. Please try again.');
      setDeleting(false);
    }
  }

  return (
    <Page>
      <PageHeader title="Privacy & data" description={<>Manage data saved to your Flowcast account. <a href="#terms">Terms of service</a></>} />

      <div className={styles.columns}>
        <SectionList title="Flowcast account data">
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

      <p className={styles.notice}>Your Flowcast profile is linked to your Google sign-in. Appearance settings are stored separately on this browser and are not removed by deleting your profile.</p>
      <p className={styles.notice}>“Was it busy?” answers are stored only as anonymous counts per place and Boston hour (Quiet, OK or Packed), never with your account, schedule or exact time, so they are not part of your download or deletion. This browser remembers which suggestions it already asked about. Student reports are shown beside crowd projections and never change them.</p>

      <SectionHeading>Your data</SectionHeading>
      <div className={styles.actions}>
        <div className={styles.action}>
          <div>
            <p className={styles.actionTitle}>Download account data</p>
            <p className={styles.actionBody}>A JSON file of your saved profile, imported schedule, notification preferences and club follows.</p>
          </div>
          <Button icon={<Download aria-hidden />} onClick={download} disabled={downloading}>
            {downloading ? 'Preparing…' : 'Download account data'}
          </Button>
        </div>

        <div className={styles.action}>
          <div>
            <p className={styles.actionTitle}>Delete profile data</p>
            <p className={styles.actionBody}>
              Clears your Flowcast profile, imported schedule, notification preferences and club follows, then signs you out. This does not delete your Google account.
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
            <p id="delete-confirm">Delete your saved profile, imported schedule, preferences and club follows? This can’t be undone.</p>
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

      <Terms />
    </Page>
  );
}
