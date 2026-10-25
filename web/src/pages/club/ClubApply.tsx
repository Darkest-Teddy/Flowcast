import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useSession } from '../../auth/session';
import { config } from '../../config';
import { api } from '../../data/api';
import type { ClubApplication } from '../../data/types';
import { Button, Logo, StatusBadge, TextArea, TextField } from '../../ui';
import styles from './ClubApply.module.css';

const DESCRIPTION_MAX = 280;

interface Form {
  clubName: string;
  officerName: string;
  officerEmail: string;
  listingUrl: string;
  description: string;
  isOfficer: boolean;
}

type Errors = Partial<Record<keyof Form, string>>;

function validate(f: Form): Errors {
  const e: Errors = {};
  if (!f.clubName.trim()) e.clubName = 'Enter your club’s name.';
  if (!f.officerName.trim()) e.officerName = 'Enter your name.';
  const email = f.officerEmail.trim();
  if (!email) e.officerEmail = 'Enter your email.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.officerEmail = 'Enter an email address like name@bu.edu.';

  const url = f.listingUrl.trim();
  if (!url) {
    e.listingUrl = 'Paste the link to your club’s page on BU Engage.';
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      e.listingUrl = 'That link isn’t complete. Paste the full address, starting with https://';
    } else if (!parsed.hostname.endsWith('campuslabs.com')) {
      e.listingUrl = 'Use the link from BU Engage (bu.campuslabs.com/engage). We use it to confirm your club exists.';
    }
  }

  const description = f.description.trim();
  if (!description) e.description = 'Add a sentence or two about what your club does.';
  else if (description.length > DESCRIPTION_MAX) e.description = `Shorten this to ${DESCRIPTION_MAX} characters or fewer. It’s ${description.length} now.`;

  if (!f.isOfficer) e.isOfficer = 'Confirm that you’re an officer of this club.';
  return e;
}

export default function ClubApply() {
  const { session } = useSession();
  const [form, setForm] = useState<Form>({
    clubName: '',
    officerName: session?.user.name ?? '',
    officerEmail: session?.user.email ?? '',
    listingUrl: '',
    description: '',
    isOfficer: false,
  });
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [application, setApplication] = useState<ClubApplication | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);

  const errors = submitted ? validate(form) : {};

  // After a failed submit, move focus to the first field that needs fixing.
  useEffect(() => {
    if (!focusTick) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusTick]);

  useEffect(() => {
    if (application) doneRef.current?.focus();
  }, [application]);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setSendError(null);
    if (Object.keys(validate(form)).length) {
      setFocusTick((t) => t + 1);
      return;
    }
    setSending(true);
    try {
      const app = await api.submitClubApplication({
        clubName: form.clubName.trim(),
        officerName: form.officerName.trim(),
        officerEmail: form.officerEmail.trim(),
        listingUrl: form.listingUrl.trim(),
        description: form.description.trim(),
      });
      setApplication(app);
    } catch {
      setSendError('Your application wasn’t sent. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={styles.screen}>
      <header className={styles.top}>
        <Link to="/" className={styles.brand}>
          <Logo className={styles.mark} />
          <span>{config.appName}</span>
        </Link>
        <Button variant="ghost" to="/clubs">
          Back to clubs
        </Button>
      </header>

      <main className={styles.column}>
        {application ? (
          <section aria-labelledby="pending-title">
            <StatusBadge tone="warn">Waiting for review</StatusBadge>
            <h1 id="pending-title" ref={doneRef} tabIndex={-1} className={styles.title}>
              We’re checking your club
            </h1>
            <p className={styles.lede}>
              Thanks, {application.officerName.split(' ')[0]}. We received the application for {application.clubName}.
            </p>

            <h2 className={styles.subhead}>What happens next</h2>
            <ol className={styles.steps}>
              <li>
                <span className={styles.stepTitle}>We check your club</span>
                <span>We look for {application.clubName} on BU Engage and make sure you’re listed as an officer.</span>
              </li>
              <li>
                <span className={styles.stepTitle}>We email you</span>
                <span>You’ll hear from us at {application.officerEmail}, usually within a day.</span>
              </li>
              <li>
                <span className={styles.stepTitle}>You upload your calendar</span>
                <span>
                  Once your club is verified, a section called “Your club” appears in the sidebar. Upload an .ics file there and your
                  events show up in Flowcast for every student.
                </span>
              </li>
            </ol>

            <div className={styles.actions}>
              <Button variant="primary" to="/">
                Back to Flowcast
              </Button>
            </div>
          </section>
        ) : (
          <>
            <h1 className={styles.title}>Register your club</h1>
            <p className={styles.lede}>
              Verified clubs can upload their calendar so their events appear in Flowcast for every BU student. The Flowcast team checks
              each club first.
            </p>

            <form ref={formRef} className={styles.form} onSubmit={submit} noValidate>
              <TextField
                label="Club name"
                value={form.clubName}
                onChange={(e) => set('clubName', e.target.value)}
                error={errors.clubName}
                autoComplete="organization"
              />
              <TextField
                label="Your name"
                value={form.officerName}
                onChange={(e) => set('officerName', e.target.value)}
                error={errors.officerName}
                autoComplete="name"
              />
              <TextField
                label="Your email"
                type="email"
                value={form.officerEmail}
                onChange={(e) => set('officerEmail', e.target.value)}
                error={errors.officerEmail}
                hint="Use your bu.edu email. It’s the quickest way for us to confirm you’re at BU."
                autoComplete="email"
              />
              <TextField
                label="BU Engage page"
                type="url"
                inputMode="url"
                placeholder="https://bu.campuslabs.com/engage/organization/…"
                value={form.listingUrl}
                onChange={(e) => set('listingUrl', e.target.value)}
                error={errors.listingUrl}
                hint="The link to your club’s page on BU Engage."
              />
              <TextArea
                label="Short description"
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                error={errors.description}
                hint={`What your club does, in a sentence or two. ${form.description.trim().length} of ${DESCRIPTION_MAX} characters.`}
              />

              <div className={styles.check}>
                <label className={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={form.isOfficer}
                    onChange={(e) => set('isOfficer', e.target.checked)}
                    aria-invalid={Boolean(errors.isOfficer)}
                    aria-describedby={errors.isOfficer ? 'officer-error' : undefined}
                  />
                  <span>I’m an officer of this club and can share its events.</span>
                </label>
                {errors.isOfficer && (
                  <p id="officer-error" className={styles.error}>
                    {errors.isOfficer}
                  </p>
                )}
              </div>

              {sendError && (
                <p className={styles.error} role="alert">
                  {sendError}
                </p>
              )}

              <div className={styles.actions}>
                <Button type="submit" variant="primary" size="lg" disabled={sending}>
                  {sending ? 'Sending…' : 'Send for review'}
                </Button>
              </div>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
