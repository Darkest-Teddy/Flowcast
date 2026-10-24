import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, useResource } from '../data/api';
import { formatRelative } from '../lib/format';
import { Button, EmptyState, ListRow, Loading, Page, PageHeader, SectionHeading, SectionList, StatusBadge, Toggle } from '../ui';
import styles from './Calendars.module.css';

export default function Calendars() {
  const { data, error, loading, reload, setData } = useResource(() => api.getCalendarConnection());
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  const header = (
    <PageHeader
      title="Calendars"
      description="Flowcast reads the calendars you choose so your agent on the map follows your real week. It never adds or changes events in Google Calendar."
    />
  );

  if (error) {
    return (
      <Page>
        {header}
        <p className={styles.error} role="alert">
          Your calendars didn’t load. <Button variant="ghost" size="sm" onClick={reload}>Try again</Button>
        </p>
      </Page>
    );
  }

  if (loading && !data) {
    return (
      <Page>
        {header}
        <Loading label="Loading your calendars" />
      </Page>
    );
  }

  if (!data) return null;

  async function toggle(id: string, read: boolean) {
    if (!data) return;
    const before = data;
    setData({ ...data, calendars: data.calendars.map((c) => (c.id === id ? { ...c, read } : c)) });
    setNotice(null);
    try {
      setData(await api.setCalendarRead(id, read));
    } catch {
      setData(before);
      setNotice({ ok: false, text: 'That change wasn’t saved. Check your connection and try again.' });
    }
  }

  async function sync() {
    setSyncing(true);
    setNotice(null);
    try {
      setData(await api.syncCalendars());
      setNotice({ ok: true, text: 'Synced. Your schedule is up to date.' });
    } catch {
      setNotice({ ok: false, text: 'Couldn’t reach Google Calendar. Try again in a minute.' });
    } finally {
      setSyncing(false);
    }
  }

  async function disconnect() {
    setWorking(true);
    try {
      setData(await api.disconnectCalendar());
      setConfirming(false);
      setNotice({ ok: true, text: 'Google Calendar is disconnected, and the events Flowcast copied are deleted.' });
    } catch {
      setNotice({ ok: false, text: 'Couldn’t disconnect. Check your connection and try again.' });
    } finally {
      setWorking(false);
    }
  }

  async function connect() {
    setWorking(true);
    setNotice(null);
    try {
      setData(await api.connectCalendar());
    } catch {
      setNotice({ ok: false, text: 'Couldn’t connect to Google. Check your connection and try again.' });
    } finally {
      setWorking(false);
    }
  }

  const status = notice && (
    <p className={notice.ok ? styles.ok : styles.error} role="status">
      {notice.text}
    </p>
  );

  if (!data.connected) {
    return (
      <Page>
        {header}
        {status}
        <EmptyState
          title="Google Calendar isn’t connected"
          body="Connect it so your agent on the map follows your real classes. Flowcast only reads events, and you choose which calendars."
          action={
            <Button variant="accent" onClick={connect} disabled={working}>
              {working ? 'Connecting…' : 'Connect Google Calendar'}
            </Button>
          }
        />
      </Page>
    );
  }

  const reading = data.calendars.filter((c) => c.read).length;

  return (
    <Page>
      {header}

      <SectionList title="Google account">
        <ListRow
          title={data.email}
          detail={<StatusBadge tone="ok">Connected, read-only</StatusBadge>}
        />
        <ListRow
          title={data.syncedAt ? `Last synced ${formatRelative(data.syncedAt)}` : 'Not synced yet'}
          trailing={
            <Button size="sm" icon={<RefreshCw aria-hidden />} onClick={sync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync now'}
            </Button>
          }
        />
      </SectionList>
      {status}

      <SectionHeading>Calendars Flowcast reads</SectionHeading>
      <p className={styles.lead}>
        {reading === 0
          ? 'Flowcast isn’t reading any calendars, so your agent only follows your profile habits.'
          : `Flowcast reads ${reading} of ${data.calendars.length} calendars. Turn on the ones with your classes.`}
      </p>
      <div className={styles.toggles}>
        {data.calendars.map((c) => (
          <Toggle key={c.id} label={c.name} description={c.detail} checked={c.read} onChange={(on) => toggle(c.id, on)} />
        ))}
      </div>

      <SectionHeading>Disconnect</SectionHeading>
      <div className={styles.danger}>
        <p className={styles.lead}>
          Your agent stops following your classes and Flowcast deletes the events it copied. Nothing changes in your Google Calendar.
        </p>
        {confirming ? (
          <div className={styles.confirm} role="group" aria-label="Confirm disconnect">
            <p>Disconnect {data.email} from Flowcast?</p>
            <div className={styles.confirmActions}>
              <Button variant="danger" onClick={disconnect} disabled={working}>
                {working ? 'Disconnecting…' : 'Yes, disconnect'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={working}>
                Keep it connected
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Disconnect Google Calendar
          </Button>
        )}
      </div>
    </Page>
  );
}
