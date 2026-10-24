import { useState } from 'react';
import { api, useResource } from '../data/api';
import type { NotificationPrefs } from '../data/types';
import { savedTheme, setTheme, type ThemeChoice } from '../lib/theme';
import { Button, Loading, Page, PageHeader, SectionHeading, Segmented, Toggle } from '../ui';
import styles from './Settings.module.css';

const notificationRows: { key: keyof NotificationPrefs; label: string; description: string }[] = [
  {
    key: 'packedRoute',
    label: 'Warn me when a place on my route will be packed',
    description: 'A heads-up before you leave, with a quieter option when there is one.',
  },
  {
    key: 'clubEvents',
    label: 'New events from clubs I follow',
    description: 'When a club you follow publishes events in Flowcast.',
  },
  {
    key: 'scheduleChanges',
    label: 'Changes to my classes',
    description: 'When a class in your synced calendar moves to a new time or room.',
  },
];

export default function Settings() {
  const [theme, setThemeChoice] = useState<ThemeChoice>(savedTheme);
  const prefs = useResource(() => api.getNotificationPrefs());
  const [error, setError] = useState<string | null>(null);

  function chooseTheme(choice: ThemeChoice) {
    setThemeChoice(choice);
    setTheme(choice);
  }

  async function togglePref(key: keyof NotificationPrefs, on: boolean) {
    if (!prefs.data) return;
    const before = prefs.data;
    prefs.setData({ ...before, [key]: on });
    setError(null);
    try {
      prefs.setData(await api.updateNotificationPrefs({ [key]: on }));
    } catch {
      prefs.setData(before);
      setError('That change wasn’t saved. Check your connection and try again.');
    }
  }

  return (
    <Page>
      <PageHeader title="Settings" description="Appearance and notifications. Changes save as you make them." />

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
