import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useSession } from '../../auth/session';
import { api, useResource } from '../../data/api';
import type { AdminSettings as Settings } from '../../data/types';
import { Avatar, Button, ListRow, Loading, Page, PageHeader, SectionHeading, SectionList, SelectField, StatusBadge, TextField } from '../../ui';
import { SettingRow } from './components/SettingRow';
import { StatusLine, useFlash } from './components/StatusLine';
import styles from './AdminSettings.module.css';

const retentionOptions: { value: Settings['retention']; label: string }[] = [
  { value: '30d', label: '30 days after last sign-in' },
  { value: '90d', label: '90 days after last sign-in' },
  { value: 'semester', label: 'Until the end of the semester' },
  { value: 'forever', label: 'Until someone deletes it' },
];

export default function AdminSettings() {
  const { session } = useSession();
  const { data: settings, setData, error: settingsError } = useResource(api.getAdminSettings);
  const { data: users } = useResource(api.getAdminUsers);

  const loadError = settingsError;
  if (loadError) return <Page><PageHeader title="Settings" /><p role="alert">{loadError.message}</p></Page>;

  if (!settings) {
    return (
      <Page>
        <PageHeader title="Settings" />
        <Loading label="Loading settings" />
      </Page>
    );
  }

  const save = async (patch: Partial<Settings>) => {
    const updated = await api.updateAdminSettings(patch);
    setData(updated);
    return updated;
  };

  return (
    <Page>
      <PageHeader title="Settings" description="Who can use the admin area, the Google sign-in app, and what happens to people's data." />
      <TeamAdmins settings={settings} myEmail={session?.user.email ?? ''} knownNames={users ?? []} onSave={save} />
      <GoogleApp settings={settings} />
      <Retention settings={settings} onSave={save} />
      <DangerZone settings={settings} onDeleted={setData} />
    </Page>
  );
}

function TeamAdmins({
  settings,
  myEmail,
  knownNames,
  onSave,
}: {
  settings: Settings;
  myEmail: string;
  knownNames: { name: string; email: string }[];
  onSave: (patch: Partial<Settings>) => Promise<Settings>;
}) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const message = useFlash();

  const add = async () => {
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@bu\.edu$/.test(clean)) return setError('Use a bu.edu email address.');
    if (settings.admins.some((a) => a.email === clean)) return setError('That person is already an admin.');
    setError(undefined);
    const name = knownNames.find((u) => u.email === clean)?.name ?? clean;
    await onSave({ admins: [...settings.admins, { id: `admin-${Date.now()}`, name, email: clean }] });
    setEmail('');
    message.show(`Added ${name} as an admin`);
  };

  const remove = async (id: string) => {
    const who = settings.admins.find((a) => a.id === id);
    await onSave({ admins: settings.admins.filter((a) => a.id !== id) });
    message.show(`Removed ${who?.name ?? 'admin'}`, 'off');
  };

  return (
    <section aria-label="Team admins">
      <SectionList title="Team admins" count={settings.admins.length}>
        {settings.admins.map((a) => {
          const me = a.email === myEmail;
          return (
            <ListRow
              key={a.id}
              leading={<Avatar name={a.name} size={28} />}
              title={a.name}
              subtitle={a.email}
              trailing={
                me ? (
                  <span className={styles.quiet}>You</span>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => remove(a.id)} aria-label={`Remove ${a.name} as admin`}>
                    Remove
                  </Button>
                )
              }
            />
          );
        })}
        <form
          className={styles.addRow}
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className={styles.addField}>
            <TextField
              label="Add an admin"
              type="email"
              placeholder="name@bu.edu"
              value={email}
              error={error}
              hint="Admins can change the shared map, data sources and club approvals."
              onChange={(e) => {
                setEmail(e.target.value);
                setError(undefined);
              }}
            />
          </div>
          <Button type="submit" disabled={!email.trim()}>
            Add admin
          </Button>
        </form>
      </SectionList>
      <StatusLine flash={message.flash} className={styles.flash} />
    </section>
  );
}

function GoogleApp({ settings }: { settings: Settings }) {
  const { oauth } = settings;
  const nearCap = oauth.usersConnected / oauth.userCap >= 0.8;
  return (
    <section>
      <SectionHeading
        actions={
          <Button href={oauth.consoleUrl} target="_blank" rel="noreferrer" size="sm" icon={<ExternalLink aria-hidden />}>
            Open Google Cloud console
          </Button>
        }
      >
        Google sign-in app
      </SectionHeading>
      <div className={styles.rows}>
        <SettingRow label="Verification">
          {oauth.verified ? <StatusBadge tone="ok">Verified by Google</StatusBadge> : <StatusBadge tone="warn">Not verified by Google</StatusBadge>}
        </SettingRow>
        <SettingRow label="Users connected" description={oauth.verified ? undefined : `Unverified apps are capped at ${oauth.userCap} users.`}>
          <StatusBadge tone={nearCap ? 'warn' : 'ok'}>
            {oauth.usersConnected} of {oauth.userCap}
          </StatusBadge>
        </SettingRow>
        <SettingRow label="Permission asked for" description="Read-only access to calendars. Flowcast never changes events.">
          <code className={styles.code}>{oauth.scope}</code>
        </SettingRow>
      </div>
      {!oauth.verified && (
        <p className={styles.note}>
          Until Google verifies the app, people see a “Google hasn't verified this app” screen when they connect a calendar. Verification takes a few weeks.
        </p>
      )}
    </section>
  );
}

function Retention({ settings, onSave }: { settings: Settings; onSave: (patch: Partial<Settings>) => Promise<Settings> }) {
  const [value, setValue] = useState(settings.retention);
  const [saving, setSaving] = useState(false);
  const message = useFlash();

  return (
    <section>
      <SectionHeading>Data retention</SectionHeading>
      <div className={`${styles.inline} ${styles.card}`}>
        <div className={styles.addField}>
          <SelectField
            label="Keep persona data"
            hint="Profiles, habits and synced calendar events. Deleted automatically after this."
            value={value}
            onChange={(e) => setValue(e.target.value as Settings['retention'])}
          >
            {retentionOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </SelectField>
        </div>
        <Button
          variant="accent"
          disabled={value === settings.retention || saving}
          onClick={async () => {
            setSaving(true);
            await onSave({ retention: value });
            setSaving(false);
            message.show('Saved');
          }}
        >
          {saving ? 'Saving' : 'Save'}
        </Button>
      </div>
      <StatusLine flash={message.flash} className={styles.flash} />
    </section>
  );
}

function DangerZone({ settings, onDeleted }: { settings: Settings; onDeleted: (s: Settings) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const message = useFlash(8000);
  const confirmRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const remove = async () => {
    setDeleting(true);
    const updated = await api.deletePersonaData();
    onDeleted(updated);
    setDeleting(false);
    setConfirming(false);
    message.show('Deleted all persona data', 'off');
  };

  return (
    <section>
      <SectionHeading>Danger zone</SectionHeading>
      <div className={styles.danger}>
        {!confirming ? (
          <div className={styles.dangerRow}>
            <div>
              <p className={styles.dangerTitle}>Delete all persona data</p>
              <p className={styles.dangerText}>
                {settings.personaProfiles > 0
                  ? `${settings.personaProfiles} profiles with their habits and synced calendar events. Accounts and clubs stay.`
                  : 'There is no persona data right now.'}
              </p>
            </div>
            <Button variant="danger" onClick={() => setConfirming(true)} disabled={settings.personaProfiles === 0}>
              Delete all persona data
            </Button>
          </div>
        ) : (
          <div
            className={styles.confirm}
            ref={confirmRef}
            tabIndex={-1}
            role="group"
            aria-labelledby="confirm-delete"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setConfirming(false);
            }}
          >
            <p id="confirm-delete" className={styles.dangerTitle}>
              Delete {settings.personaProfiles} profiles for good?
            </p>
            <p className={styles.dangerText}>
              Every profile, habit and synced calendar event goes, and the map falls back to generated students. This can't be undone.
            </p>
            <div className={styles.confirmButtons}>
              <Button variant="danger" onClick={remove} disabled={deleting}>
                {deleting ? 'Deleting' : `Yes, delete ${settings.personaProfiles} profiles`}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={deleting}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
      <StatusLine flash={message.flash} className={styles.flash} />
    </section>
  );
}
