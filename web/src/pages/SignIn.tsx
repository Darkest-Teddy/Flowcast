import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useSession } from '../auth/session';
import { config } from '../config';
import { Button, Logo } from '../ui';
import styles from './SignIn.module.css';

export default function SignIn() {
  const { session, ready, signInWithGoogle } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from;

  // Once someone is signed in (just now, or already), send them on.
  useEffect(() => {
    if (!ready || !session) return;
    const dest = !session.onboarded ? '/welcome' : from && from !== '/signin' ? from : '/';
    navigate(dest, { replace: true });
  }, [ready, session, from, navigate]);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch {
      setError('Couldn’t reach Google. Check your connection and try again.');
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

        <h1 className={styles.title}>Know how busy campus will be before you go</h1>
        <p className={styles.lede}>
          Flowcast is a 3D map of BU where simulated students follow real schedules, so it can project how crowded dining halls,
          libraries and classrooms will get.
        </p>

        <Button variant="primary" size="lg" className={styles.google} onClick={signIn} disabled={busy || !ready}>
          {busy ? 'Signing in…' : 'Continue with Google'}
        </Button>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <p className={styles.fine}>
          Flowcast reads your Google Calendar to place your classes on the map. You can disconnect it or delete your data anytime.
        </p>

        <p className={styles.footer}>
          Run a club? <Link to="/clubs/register">Register your club</Link>
        </p>
      </div>
    </main>
  );
}
