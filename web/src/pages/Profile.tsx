import { useEffect, useState, type FormEvent } from 'react';
import { swatches } from '@theme/tokens';
import { api, useResource } from '../data/api';
import type { Profile as ProfileData } from '../data/types';
import { Avatar, Button, Loading, Page, PageHeader, SectionHeading, SelectField, TextField } from '../ui';
import styles from './Profile.module.css';

const swatchNames = ['Blue', 'Green', 'Orange', 'Purple', 'Red', 'Teal'];

type Errors = Partial<Record<'name' | 'lunchTime' | 'dinnerTime', string>>;

function validate(p: ProfileData): Errors {
  const errors: Errors = {};
  if (!p.name.trim()) errors.name = 'Enter the name you’d like to see in Flowcast.';
  if (!p.lunchTime) errors.lunchTime = 'Enter a lunch time, like 12:15 PM.';
  if (!p.dinnerTime) errors.dinnerTime = 'Enter a dinner time, like 6:30 PM.';
  if (p.lunchTime && p.dinnerTime && p.lunchTime >= p.dinnerTime) {
    errors.dinnerTime = 'Dinner needs to be later than lunch. Check both times.';
  }
  return errors;
}

export default function Profile() {
  const profile = useResource(() => api.getProfile());
  const locations = useResource(() => api.getLocations());
  const [draft, setDraft] = useState<ProfileData | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (profile.data && !draft) setDraft(profile.data);
  }, [profile.data, draft]);

  if (profile.error) {
    return (
      <Page>
        <PageHeader title="Profile" />
        <p className={styles.error} role="alert">
          Your profile didn’t load. <button type="button" className={styles.retry} onClick={profile.reload}>Try again</button>
        </p>
      </Page>
    );
  }

  if (!draft || !locations.data) {
    return (
      <Page>
        <PageHeader title="Profile" description="Your dorm, habits and avatar." />
        <Loading label="Loading your profile" />
      </Page>
    );
  }

  const dorms = locations.data.filter((l) => l.kind === 'dorm');
  const libraries = locations.data.filter((l) => l.kind === 'library');

  function update<K extends keyof ProfileData>(key: K, value: ProfileData[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setMessage(null);
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const found = validate(draft);
    setErrors(found);
    if (Object.values(found).some(Boolean)) {
      setMessage({ ok: false, text: 'Some answers need a fix before saving. They’re marked below.' });
      return;
    }
    setSaving(true);
    try {
      const saved = await api.updateProfile({ ...draft, name: draft.name.trim() });
      setDraft(saved);
      profile.setData(saved);
      setMessage({ ok: true, text: 'Saved. Your agent on the map uses these from now on.' });
    } catch {
      setMessage({ ok: false, text: 'Your changes weren’t saved. Check your connection and try again.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page>
      <PageHeader title="Profile" description="Your agent on the map uses these answers to fill in the parts of your day your calendar doesn’t cover." />

      <form className={styles.form} onSubmit={save} noValidate>
        <section className={styles.section}>
          <SectionHeading>About you</SectionHeading>
          <TextField
            label="Name"
            value={draft.name}
            onChange={(e) => update('name', e.target.value)}
            error={errors.name}
            autoComplete="name"
          />
        </section>

        <section className={styles.section}>
          <SectionHeading>Your habits</SectionHeading>
          <div className={styles.fields}>
            <SelectField
              label="Home dorm"
              hint="Where your agent starts and ends each day."
              value={draft.homeLocationId ?? ''}
              onChange={(e) => update('homeLocationId', e.target.value || null)}
            >
              <option value="">I don’t live on campus</option>
              {dorms.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </SelectField>

            <div className={styles.pair}>
              <TextField
                label="Usual lunch time"
                type="time"
                value={draft.lunchTime}
                onChange={(e) => update('lunchTime', e.target.value)}
                error={errors.lunchTime}
              />
              <TextField
                label="Usual dinner time"
                type="time"
                value={draft.dinnerTime}
                onChange={(e) => update('dinnerTime', e.target.value)}
                error={errors.dinnerTime}
              />
            </div>

            <SelectField
              label="Favourite study spot"
              hint="Where your agent goes when you have free time to study."
              value={draft.studySpotId ?? ''}
              onChange={(e) => update('studySpotId', e.target.value || null)}
            >
              <option value="">No favourite</option>
              {libraries.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </SelectField>
          </div>
        </section>

        <section className={styles.section}>
          <SectionHeading>Avatar</SectionHeading>
          <div className={styles.avatarRow}>
            <Avatar name={draft.name || '?'} size={40} color={swatches[draft.avatarSwatch]} />
            <fieldset className={styles.swatches}>
              <legend className={styles.legend}>Avatar colour</legend>
              {swatches.map((color, i) => (
                <label key={color} className={styles.swatch}>
                  <input
                    type="radio"
                    name="avatar-colour"
                    value={i}
                    checked={draft.avatarSwatch === i}
                    onChange={() => update('avatarSwatch', i)}
                  />
                  <i style={{ background: color }} aria-hidden />
                  <span>{swatchNames[i]}</span>
                </label>
              ))}
            </fieldset>
          </div>
        </section>

        <div className={styles.footer}>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </Button>
          <p className={message?.ok ? styles.saved : styles.error} role="status">
            {message?.text}
          </p>
        </div>
      </form>
    </Page>
  );
}
