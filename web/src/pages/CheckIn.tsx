import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useSession } from '../auth/session';
import { api } from '../data/api';
import { errorText } from '../lib/orgs';
import { Button, EmptyState, Loading, Page } from '../ui';

const PENDING = 'flowcast.checkin.pending';
type Pending = { meetingId: string; code: string };
function readPending(): Pending | null {
  try { const v = JSON.parse(window.sessionStorage.getItem(PENDING) ?? 'null'); return v && typeof v.meetingId === 'string' && typeof v.code === 'string' ? v : null; } catch { return null; }
}

/**
 * Where a meeting's QR code leads. Signed out, it keeps the code in this tab, sends the student
 * through Google sign-in (which returns to /checkin) and finishes there. Checks in once.
 */
export default function CheckIn() {
  const params = useParams();
  const [search] = useSearchParams();
  const { ready, session, signIn } = useSession();
  // Read once: the saved code is cleared when the check-in is sent.
  const [target] = useState<Pending | null>(() => (params.meetingId && search.get('code') ? { meetingId: params.meetingId, code: search.get('code')! } : readPending()));
  const [state, setState] = useState<{ status: 'working' } | { status: 'done'; title: string; clubId: string; clubName: string } | { status: 'error'; message: string }>({ status: 'working' });
  const sent = useRef(false);
  useEffect(() => {
    if (!ready || !session || !target || sent.current) return;
    sent.current = true;
    try { window.sessionStorage.removeItem(PENDING); } catch { /* Storage may be blocked. */ }
    api.checkIn(target.meetingId, target.code)
      .then((r) => setState({ status: 'done', ...r }))
      .catch((e) => setState({ status: 'error', message: errorText(e, 'Check-in didn’t work. Try scanning the code again.') }));
  }, [ready, session, target]);

  if (!target) return <Page><EmptyState title="No check-in code" body="Scan the code shown at the meeting." action={<Button to="/meetings">Club meetings</Button>} /></Page>;
  if (!ready) return <Page><Loading label="Loading" /></Page>;
  if (!session) {
    const go = () => {
      try { window.sessionStorage.setItem(PENDING, JSON.stringify(target)); } catch { /* Without storage the code is lost after sign-in: scan again. */ }
      void signIn('/checkin');
    };
    return <Page><EmptyState title="Sign in to check in" body="Use your BU Google account. You’ll come straight back here and be checked in." action={<Button variant="primary" onClick={go}>Continue with Google</Button>} /></Page>;
  }
  return <Page>
    {state.status === 'working' ? <Loading label="Checking you in" />
      : state.status === 'done' ? <EmptyState title="You’re checked in" body={`${state.title}, ${state.clubName.replace(/\s+-\s+\d+$/, '')}. Officers see how many came, not who.`}
          action={<Button to={`/clubs/${encodeURIComponent(state.clubId)}`}>See the club</Button>} />
      : <EmptyState title="Couldn’t check you in" body={state.message} action={<Button to="/meetings">Club meetings</Button>} />}
  </Page>;
}
