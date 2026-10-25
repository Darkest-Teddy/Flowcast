import { useState } from 'react';
import { Link, useLocation, Navigate } from 'react-router';
import { useSession } from '../auth/session';
import { safeReturnRoute } from '../auth/client';
import { config } from '../config';
import { Button, Logo } from '../ui';
import styles from './SignIn.module.css';

export default function SignIn() {
  const { ready, session, signIn: googleSignIn, error: sessionError } = useSession();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from;

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await googleSignIn(from);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Couldn’t start Google sign-in. Please try again.');
      setBusy(false);
    }
  }

  if (ready && session) return <Navigate to={safeReturnRoute(from)} replace />;

  return (
    <main className={styles.screen}>
      <div className={styles.column}>
        <div className={styles.brand}>
          <Logo className={styles.mark} />
          <span>{config.appName}</span>
        </div>

        <h1 className={styles.title}>Sign in to Flowcast</h1>
        <p className={styles.lede}>
          Use your Google account to save your Flowcast profile and preferences.
        </p>

        <Button variant="primary" size="lg" className={styles.google} onClick={signIn} disabled={busy || !ready}>
          {busy ? 'Opening Google…' : 'Continue with Google'}
        </Button>
        {(error || sessionError) && (
          <p className={styles.error} role="alert">
            {error || sessionError}
          </p>
        )}

        <p className={styles.fine}>
          Sign-in uses your Google identity. It does not grant access to your Google Calendar.
        </p>

        <p className={styles.footer}>
          <Link to="/landing">Explore public campus data</Link>
        </p>
      </div>
    </main>
  );
}
