import { useEffect, useState } from 'react';
import { useLocation, Navigate } from 'react-router';
import { useSession } from '../auth/session';
import { savedReturnRoute, safeReturnRoute } from '../auth/client';
import { AuthFrame } from '../auth/AuthFrame';
import { config } from '../config';
import { Button } from '../ui';
import styles from './SignIn.module.css';

export default function SignIn() {
  const { ready, session, signIn: googleSignIn, error: sessionError } = useSession();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = safeReturnRoute((location.state as { from?: string } | null)?.from ?? savedReturnRoute());
  useEffect(() => {
    const returned = () => setBusy(false);
    window.addEventListener('pageshow', returned);
    return () => window.removeEventListener('pageshow', returned);
  }, []);

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
    <AuthFrame title="Sign in to Flowcast">
        <p className={styles.lede}>
          Keep your schedule and followed clubs in one place.
        </p>
        <Button variant="accent" size="lg" className={styles.google} onClick={signIn} disabled={busy || !ready} aria-busy={busy || !ready}>
          {!ready ? 'Checking your account…' : busy ? 'Opening Google…' : 'Continue with Google'}
        </Button>
        {!busy && (error || sessionError) && (
          <p className={styles.error} role="alert">
            {error || sessionError}
          </p>
        )}

        <p className={styles.fine}>
          Google Calendar stays private. Import your schedule after signing in.
        </p>

        <div className={styles.browse}>
          <p>No account needed for the campus map.</p>
          <Button href={config.mapUrl} size="lg" className={styles.publicMap}>Explore the map</Button>
        </div>
    </AuthFrame>
  );
}
