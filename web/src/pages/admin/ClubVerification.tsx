import { useState } from 'react';
import { CircleCheck, CircleDashed, CircleX } from 'lucide-react';
import { api, useResource } from '../../data/api';
import type { ApplicationStatus, ClubApplication } from '../../data/types';
import { formatDayTime, formatRelative } from '../../lib/format';
import { Button, EmptyState, Loading, Page, PageHeader, Segmented, StatusBadge, TextArea } from '../../ui';
import { StatusLine, useFlash } from './components/StatusLine';
import { useNow } from './components/useNow';
import styles from './ClubVerification.module.css';

const tabs: { value: ApplicationStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

export default function ClubVerification() {
  const { data: apps, setData, error } = useResource(api.getClubApplications);
  const [tab, setTab] = useState<ApplicationStatus>('pending');
  const message = useFlash(6000);
  const now = useNow();

  const decide = async (app: ClubApplication, status: ApplicationStatus, note: string) => {
    const updated = await api.setApplicationStatus(app.id, status, note.trim());
    setData((list) => list?.map((a) => (a.id === updated.id ? updated : a)) ?? null);
    const verb = status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Moved back to pending';
    message.show(`${verb}: ${app.clubName}`, status === 'rejected' ? 'off' : 'ok');
  };

  const counts = (s: ApplicationStatus) => apps?.filter((a) => a.status === s).length;
  const shown = (apps ?? [])
    .filter((a) => a.status === tab)
    .sort((a, b) => (tab === 'pending' ? a.submittedAt.localeCompare(b.submittedAt) : (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? '')));

  return (
    <Page>
      <PageHeader title="Club verification" description="Clubs asking to publish events on Flowcast. Check each one, then approve or reject it. Oldest requests are first." />

      <div className={styles.toolbar}>
        <Segmented label="Show applications" value={tab} onChange={setTab} options={tabs.map((t) => ({ value: t.value, label: apps ? `${t.label} ${counts(t.value)}` : t.label }))} />
        <StatusLine flash={message.flash} />
      </div>

      {error ? (
        <p role="alert">Couldn't load applications: {error.message}</p>
      ) : !apps ? (
        <Loading label="Loading applications" />
      ) : shown.length === 0 ? (
        <EmptyState
          title={tab === 'pending' ? 'Nothing waiting for review' : `No ${tab} clubs yet`}
          body={tab === 'pending' ? 'New applications from club officers will show up here.' : undefined}
        />
      ) : (
        <ul className={styles.list}>
          {shown.map((app) => (
            <Application key={app.id} app={app} now={now} onDecide={decide} />
          ))}
        </ul>
      )}
    </Page>
  );
}

function Application({
  app,
  now,
  onDecide,
}: {
  app: ClubApplication;
  now: number;
  onDecide: (app: ClubApplication, status: ApplicationStatus, note: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = app.checks.filter((c) => c.passed === false).length;

  const act = async (status: ApplicationStatus) => {
    setBusy(true);
    setError(null);
    try {
      await onDecide(app, status, note);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Application review was not saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={styles.item}>
      {error && <p role="alert">{error}</p>}
      <div className={styles.head}>
        <h2 className={styles.name}>{app.clubName}</h2>
        <span className={styles.when} title={formatDayTime(app.submittedAt)}>
          Sent {formatRelative(app.submittedAt, now)}
        </span>
      </div>

      <dl className={styles.facts}>
        <dt>Officer</dt>
        <dd>
          {app.officerName}, <a href={`mailto:${app.officerEmail}`}>{app.officerEmail}</a>
        </dd>
        <dt>Listing</dt>
        <dd>
          {app.listingUrl ? (
            <a href={app.listingUrl} target="_blank" rel="noreferrer" className={styles.url}>
              {app.listingUrl.replace(/^https?:\/\//, '')}
            </a>
          ) : (
            <span className={styles.missing}>No link given</span>
          )}
        </dd>
        <dt>About</dt>
        <dd>{app.description}</dd>
      </dl>

      <div className={styles.checks}>
        <h3 className={styles.checksTitle}>
          Automatic checks
          <span className={styles.checksSummary}>{failed ? `${failed} failed` : app.checks.length > 0 && app.checks.every((c) => c.passed) ? 'All passed' : 'Some not checked yet'}</span>
        </h3>
        <ul>
          {app.checks.map((c) => (
            <li key={c.id} className={styles.check}>
              <CheckState passed={c.passed} />
              <span>{c.label}</span>
            </li>
          ))}
        </ul>
      </div>

      {app.status === 'pending' ? (
        <div className={styles.decide}>
          <TextArea
            label="Note to the officer (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="For example, why it was rejected or what to fix"
          />
          <div className={styles.buttons}>
            <Button variant="accent" onClick={() => act('approved')} disabled={busy}>
              Approve
            </Button>
            <Button variant="danger" onClick={() => act('rejected')} disabled={busy}>
              Reject
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.decided}>
          <StatusBadge tone={app.status === 'approved' ? 'ok' : 'bad'}>
            {app.status === 'approved' ? 'Approved' : 'Rejected'}
            {app.reviewedAt && ` ${formatRelative(app.reviewedAt, now)}`}
          </StatusBadge>
          {app.reviewNote && <p className={styles.note}>Note: {app.reviewNote}</p>}
          <Button variant="ghost" size="sm" onClick={() => act('pending')} disabled={busy}>
            Move back to pending
          </Button>
        </div>
      )}
    </li>
  );
}

function CheckState({ passed }: { passed: boolean | null }) {
  if (passed === true) {
    return (
      <span className={`${styles.state} ${styles.pass}`}>
        <CircleCheck aria-hidden />
        Passed
      </span>
    );
  }
  if (passed === false) {
    return (
      <span className={`${styles.state} ${styles.fail}`}>
        <CircleX aria-hidden />
        Failed
      </span>
    );
  }
  return (
    <span className={`${styles.state} ${styles.unknown}`}>
      <CircleDashed aria-hidden />
      Not checked yet
    </span>
  );
}
