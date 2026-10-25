import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { auth } from '../auth/client';
import { AuthFrame } from '../auth/AuthFrame';
import { Button, Loading } from '../ui';
import { config } from '../config';
import styles from './SignIn.module.css';

export default function AuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    auth.completeCallback(window.location.href, () => {
      window.history.replaceState(window.history.state, '', '/auth/callback');
    }).then((next) => { if (active) navigate(next, { replace: true }); })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [navigate]);
  return <AuthFrame title={error ? 'Sign-in didn’t finish' : 'Finishing sign-in'}>
    {error ? <>
      <p role="alert" className={styles.error}>{error}</p>
      <Button to="/signin" variant="accent" size="lg" className={styles.google}>Try again</Button>
      <div className={styles.browse}><Button href={config.mapUrl} size="lg" className={styles.publicMap}>Explore the map</Button></div>
    </> : <div className={styles.progress}><Loading label="Connecting your Flowcast account…" /></div>}
  </AuthFrame>;
}
