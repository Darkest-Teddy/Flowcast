import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { config } from '../config';
import { Logo } from '../ui';
import styles from '../pages/SignIn.module.css';

export function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  return <main className={styles.screen}>
    <div className={styles.column}>
      <Link to="/landing" className={styles.brand} aria-label={`${config.appName} home`}>
        <Logo className={styles.mark} /><span>{config.appName}</span>
      </Link>
      <section className={styles.card} aria-labelledby="auth-title">
        <h1 id="auth-title" className={styles.title}>{title}</h1>
        {children}
      </section>
      <Link to="/landing" className={styles.footer}>Back to Flowcast</Link>
    </div>
  </main>;
}
