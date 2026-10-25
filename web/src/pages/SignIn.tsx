import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useSession } from '../auth/session';
import { config } from '../config';
import { Button, Logo } from '../ui';
import styles from './SignIn.module.css';

export default function SignIn() {
  const { ready, startLocalSession } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from;

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await startLocalSession();
      navigate(from?.startsWith('/') && !from.startsWith('//') && from !== '/signin' ? from : '/', { replace: true });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Couldn’t open a browsing session. Please try again.');
      setBusy(false);
    }
  }

  return (
    <main className={styles.screen}>
      <div className={styles.column}>
        <div className={styles.brand}>
          <Logo className={styles.mark} />
          <span>{config.appName}</span>
        </div>

        <h1 className={styles.title}>Browse campus</h1>
        <p className={styles.lede}>
          Explore BU places, published events and model-derived crowd projections. No account is required.
        </p>

        <Button variant="primary" size="lg" className={styles.google} onClick={signIn} disabled={busy || !ready}>
          {busy ? 'Opening…' : 'Continue to campus'}
        </Button>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <p className={styles.fine}>
          Google sign-in and calendar connection are unavailable. You can enter an optional profile saved by Flowcast and linked to this browser.
        </p>

        <p className={styles.footer}>
          <Link to="/profile">Edit your profile</Link>
        </p>
      </div>
    </main>
  );
}
