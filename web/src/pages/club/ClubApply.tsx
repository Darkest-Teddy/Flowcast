import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useSession } from '../../auth/session';
import { api, useResource } from '../../data/api';
import { errorText } from '../../lib/orgs';
import { Button, EmptyState, Loading, Page, PageHeader, SelectField, Tag, TextArea, TextField } from '../../ui';
import styles from '../Meetings.module.css';

/** Request officer access to a club; an administrator confirms it before anything can be posted. */
export default function ClubApply() {
  const [params] = useSearchParams();
  const { session } = useSession();
  const clubs = useResource(api.getClubs);
  const org = useResource(api.getOrgMe);
  const [clubId, setClubId] = useState(params.get('club') ?? '');
  const [name, setName] = useState(session?.user.name ?? '');
  const [note, setNote] = useState('');
  const [state, setState] = useState<{ status: 'idle' | 'sending' } | { status: 'sent'; club: string } | { status: 'error'; message: string }>({ status: 'idle' });
  const header = <PageHeader title="Request officer access" description="Officers post their club’s meetings and announcements on Flowcast and see when members are free. An administrator confirms each request." />;
  if (clubs.loading || org.loading) return <Page>{header}<Loading label="Loading clubs" /></Page>;
  if (clubs.error) return <Page>{header}<EmptyState title="Clubs didn’t load" body={errorText(clubs.error)} /></Page>;
  if (state.status === 'sent') return <Page>{header}<EmptyState title="Request sent" body={`Your request for ${state.club} is waiting for review. You’ll be able to manage the club once it’s approved.`} action={<Button to="/clubs">Back to clubs</Button>} /></Page>;

  const pending = new Set(org.data?.requests.filter((r) => r.status === 'pending').map((r) => r.clubId));
  const officer = new Set(org.data?.officerOf);
  const chosen = clubs.data?.find((c) => c.id === clubId);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    setState({ status: 'sending' });
    try { await api.requestOfficerRole(chosen.id, name.trim(), note.trim()); setState({ status: 'sent', club: chosen.name }); }
    catch (error) { setState({ status: 'error', message: errorText(error, 'Your request could not be sent.') }); }
  }
  return <Page>
    {header}
    <form className={styles.panel} onSubmit={submit}>
      <SelectField label="Club" value={clubId} onChange={(e) => setClubId(e.target.value)}>
        <option value="">Choose your club</option>
        {(clubs.data ?? []).map((c) => <option key={c.id} value={c.id} disabled={pending.has(c.id) || officer.has(c.id)}>
          {c.name}{officer.has(c.id) ? ' (you’re an officer)' : pending.has(c.id) ? ' (request pending)' : ''}
        </option>)}
      </SelectField>
      <TextField label="Your name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      <TextArea label="Your role, and how an administrator can confirm it" maxLength={1000} rows={3} value={note} onChange={(e) => setNote(e.target.value)}
        hint="For example: “Treasurer since September; listed on our Terrier Central page.”" />
      <p className={styles.muted}>Your BU sign-in email ({session?.user.email}) is sent with the request so the reviewer can contact you.</p>
      <div className={styles.inline}>
        <Button type="submit" variant="primary" disabled={!chosen || !name.trim() || state.status === 'sending'}>Send request</Button>
        {state.status === 'error' && <span role="alert"><Tag tone="bad">{state.message}</Tag></span>}
      </div>
    </form>
  </Page>;
}
