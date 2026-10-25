import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { auth } from '../auth/client';
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
  return <main className={styles.screen}><div className={styles.column}>
    <h1 className={styles.title}>Google sign-in</h1>
    {error ? <><p role="alert" className={styles.error}>{error}</p><Link to="/signin">Try signing in again</Link></> : <p role="status">Completing sign-in…</p>}
  </div></main>;
}
