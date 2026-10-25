import { useState } from 'react';
import { useLocation } from 'react-router';
import { RefreshCw } from 'lucide-react';
import { useSession } from './session';
import { safeReturnRoute } from './client';
import { AuthFrame } from './AuthFrame';
import { Button } from '../ui';
import styles from '../pages/SignIn.module.css';

/**
 * Signed in with Google, but the Flowcast profile (/api/dashboard/me) didn't load: the server or its
 * database is down or behind. Shown in place of the page instead of treating the student as signed
 * out, which used to drop them on the landing page with no word of what happened.
 */
export function AccountError() {
  const { error, refreshSession, signOut, signIn } = useSession();
  const location = useLocation();
  const [busy, setBusy] = useState<'retry' | 'signin' | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);

  async function retry() {
    setBusy('retry');
    setFailure(null);
    await refreshSession(); // on success the page itself replaces this screen
    setAttempts((n) => n + 1);
    setBusy(null);
  }

  async function signInAgain() {
    setBusy('signin');
    setFailure(null);
    try {
      await signOut();
      await signIn(safeReturnRoute(location.pathname));
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Couldn’t start Google sign-in. Please try again.');
      setBusy(null);
    }
  }

  return (
    <AuthFrame title="We couldn’t open your account">
      <p className={styles.lede}>
        You’re signed in with Google, but Flowcast couldn’t load your profile. This is a problem on our side, not with
        your account, and it usually clears up in a moment.
      </p>

      {attempts > 0 && !busy && (
        <p className={styles.error} role="alert">
          Still not working after {attempts === 1 ? 'one more try' : `${attempts} more tries`}. The Flowcast server may be
          down; try again in a few minutes.
        </p>
      )}
      {failure && <p className={styles.error} role="alert">{failure}</p>}

      <div className={styles.actions}>
        <Button variant="accent" size="lg" icon={<RefreshCw aria-hidden />} onClick={retry} disabled={busy !== null} aria-busy={busy === 'retry'}>
          {busy === 'retry' ? 'Trying again…' : 'Try again'}
        </Button>
        <Button size="lg" onClick={signInAgain} disabled={busy !== null} aria-busy={busy === 'signin'}>
          {busy === 'signin' ? 'Opening Google…' : 'Sign in again'}
        </Button>
      </div>

      {error && (
        <details className={styles.details}>
          <summary>Technical details</summary>
          <p>{error}</p>
        </details>
      )}

      <div className={styles.browse}>
        <p>The campus map works without an account.</p>
        <Button to="/landing" size="lg" className={styles.publicMap}>Back to the landing page</Button>
      </div>
    </AuthFrame>
  );
}
