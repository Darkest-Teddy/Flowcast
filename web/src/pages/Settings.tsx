import { useState } from 'react';
import { useSession } from '../auth/session';
import { api, useResource } from '../data/api';
import type { NotificationPrefs } from '../data/types';
import { savedTheme, savedTransparency, setTheme, setTransparency, type ThemeChoice } from '../lib/theme';
import { Button, Loading, Page, PageHeader, SectionHeading, Segmented, Toggle } from '../ui';
import styles from './Settings.module.css';

const notificationRows: { key: keyof NotificationPrefs; label: string; description: string }[] = [
  {
    key: 'packedRoute',
    label: 'Crowding alerts preference',
    description: 'Saved with your Flowcast profile. Crowding alerts are not delivered in this version.',
  },
  {
    key: 'clubEvents',
    label: 'New events from clubs I follow',
    description: 'Saved with your Flowcast profile. Club event notifications are not delivered in this version.',
  },
  {
    key: 'scheduleChanges',
    label: 'Changes to my classes',
    description: 'Saved with your Flowcast profile. Calendar sync and class alerts are unavailable.',
  },
];

export default function Settings() {
  const { signOut } = useSession();
  const [theme, setThemeChoice] = useState<ThemeChoice>(savedTheme);
  const [reduced, setReduced] = useState(savedTransparency);
  // The device setting wins in tokens.css, so the switch shows it and can't turn it off.
  const [systemReduced] = useState(() => window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches ?? false);
  const prefs = useResource(() => api.getNotificationPrefs());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function chooseTheme(choice: ThemeChoice) {
    setThemeChoice(choice);
    setTheme(choice);
  }

  function chooseTransparency(on: boolean) {
    setReduced(on);
    setTransparency(on);
  }

  async function togglePref(key: keyof NotificationPrefs, on: boolean) {
    if (!prefs.data) return;
    const before = prefs.data;
    setSaving(true);
    prefs.setData({ ...before, [key]: on });
    setError(null);
    try {
      prefs.setData(await api.updateNotificationPrefs({ [key]: on }));
    } catch {
      prefs.setData(before);
      setError('That preference wasn’t saved. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page>
      <PageHeader title="Settings" description="Appearance is saved on this browser. Flowcast saves notification preferences with your Flowcast profile; no notifications are sent." />

      <SectionHeading>Account</SectionHeading>
      <p>Signed in with Google. Signing out of Flowcast does not sign you out of Google.</p>
      <Button onClick={async () => {
        setSaving(true);
        try { await signOut(); } catch (e) { setError(e instanceof Error ? e.message : 'Sign-out failed.'); }
        finally { setSaving(false); }
      }} disabled={saving}>Sign out of Flowcast</Button>

      <SectionHeading>Appearance</SectionHeading>
      <div className={styles.rows}>
        <div className={styles.row}>
          <div>
            <p className={styles.label}>Theme</p>
            <p className={styles.description}>System matches your device’s light or dark setting.</p>
          </div>
          <Segmented
            label="Theme"
            value={theme}
            onChange={chooseTheme}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
        <Toggle
          label="Reduce transparency"
          description={
            systemReduced
              ? 'Your device’s Reduce transparency setting is on, so Flowcast already uses solid backgrounds.'
              : 'Use solid backgrounds instead of see-through glass.'
          }
          checked={reduced || systemReduced}
          disabled={systemReduced}
          onChange={chooseTransparency}
        />
      </div>

      <SectionHeading>Notifications</SectionHeading>
      {prefs.error ? (
        <p className={styles.error} role="alert">
          Your notification settings didn’t load. <Button variant="ghost" size="sm" onClick={prefs.reload}>Try again</Button>
        </p>
      ) : !prefs.data ? (
        <Loading label="Loading notification settings" />
      ) : (
        <div className={styles.rows}>
          {notificationRows.map((r) => (
            <Toggle
              key={r.key}
              label={r.label}
              description={r.description}
              checked={prefs.data![r.key]}
              disabled={saving}
              onChange={(on) => togglePref(r.key, on)}
            />
          ))}
        </div>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Page>
  );
}
