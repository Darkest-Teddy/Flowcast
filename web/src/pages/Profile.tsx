import { useEffect, useState, type FormEvent } from 'react';
import { swatches } from '@theme/tokens';
import { useSession } from '../auth/session';
import { api, useResource } from '../data/api';
import type { Profile as ProfileData } from '../data/types';
import { Avatar, Button, Loading, Page, PageHeader, SectionHeading, SelectField, TextField } from '../ui';
import styles from './Profile.module.css';

const swatchNames = ['Blue', 'Green', 'Orange', 'Purple', 'Red', 'Teal'];

type Errors = Partial<Record<'name' | 'lunchTime' | 'dinnerTime', string>>;

function validate(p: ProfileData): Errors {
  const errors: Errors = {};
  if (p.name.trim().length > 100) errors.name = 'Use 100 characters or fewer.';
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (p.lunchTime && !time.test(p.lunchTime)) errors.lunchTime = 'Enter a valid lunch time.';
  if (p.dinnerTime && !time.test(p.dinnerTime)) errors.dinnerTime = 'Enter a valid dinner time.';
  if (p.lunchTime && p.dinnerTime && p.lunchTime >= p.dinnerTime) {
    errors.dinnerTime = 'Dinner needs to be later than lunch. Check both times.';
  }
  return errors;
}

export default function Profile() {
  const { refreshSession } = useSession();
  const profile = useResource(() => api.getProfile());
  const locations = useResource(() => api.getLocations());
  const [draft, setDraft] = useState<ProfileData | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (profile.data && !draft) setDraft(profile.data);
  }, [profile.data, draft]);

  if (profile.error || locations.error) {
    return (
      <Page>
        <PageHeader title="Profile" />
        <p className={styles.error} role="alert">
          Your profile or campus places didn’t load. <button type="button" className={styles.retry} onClick={() => { profile.reload(); locations.reload(); }}>Try again</button>
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
      await refreshSession();
      setMessage({ ok: true, text: 'Profile saved to your Flowcast account.' });
    } catch {
      setMessage({ ok: false, text: 'Couldn’t finish saving your profile. Please try again.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page>
      <PageHeader title="Your profile" description="Optional Flowcast preferences. They don’t affect the shared simulation." />

      <form className={styles.form} onSubmit={save} noValidate>
        <section className={styles.section}>
          <SectionHeading>About you</SectionHeading>
          <div className={styles.card}>
            <TextField
              label="Name (optional)"
              value={draft.name}
              onChange={(e) => update('name', e.target.value)}
              error={errors.name}
              autoComplete="name"
            />
          </div>
        </section>

        <section className={styles.section}>
          <SectionHeading>Your habits</SectionHeading>
          <div className={`${styles.card} ${styles.fields}`}>
            <SelectField
              label="Home dorm"
              hint="Optional profile preference."
              value={draft.homeLocationId ?? ''}
              onChange={(e) => update('homeLocationId', e.target.value || null)}
            >
              <option value="">Not specified</option>
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
              hint="Optional profile preference."
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
          <div className={`${styles.card} ${styles.avatarRow}`}>
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
