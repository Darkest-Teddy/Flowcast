import { useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { config } from '../config';
import { Logo } from '../ui/Logo';
import { PrivacyPolicy } from './account/PrivacyPolicy';
import { REPO, Terms } from './account/Terms';
import styles from './Legal.module.css';

/**
 * The public home of the privacy policy and the terms: the same two documents the dashboard shows on
 * Privacy & data (account/PrivacyPolicy.tsx, account/Terms.tsx), reachable from the landing footer
 * without an account, because asking someone to sign in to read what they would be agreeing to makes
 * no sense. Dark, like the page it is linked from.
 */
export default function Legal() {
  const { hash } = useLocation();

  useEffect(() => {
    const previous = document.title;
    document.title = 'Privacy & terms · Flowcast';
    return () => {
      document.title = previous;
    };
  }, []);

  // /legal#terms from the footer opens on that document rather than at the top of the page.
  useEffect(() => {
    const target = hash ? document.getElementById(hash.slice(1)) : null;
    if (target) target.scrollIntoView();
  }, [hash]);

  return (
    <div className={styles.page} data-theme="dark">
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <header className={styles.bar}>
        <Link to="/landing" className={styles.brand} aria-label={`${config.appName} home`}>
          <Logo className={styles.mark} />
          {config.appName}
        </Link>
        <Link to="/landing" className={styles.back}>
          <ArrowLeft aria-hidden />
          Back to Flowcast
        </Link>
      </header>

      <main id="main" tabIndex={-1} className={styles.main}>
        <h1 className={styles.title}>Privacy &amp; terms</h1>
        <p className={styles.lede}>
          What Flowcast does with your data, and what you agree to by using it. Signed in? Download or
          delete everything saved to your account on <Link to="/privacy">Privacy &amp; data</Link>.
        </p>
        <nav className={styles.jump} aria-label="Documents">
          <a href="#privacy">Privacy policy</a>
          <a href="#terms">Terms of service</a>
        </nav>

        <PrivacyPolicy />
        <Terms />
      </main>

      <footer className={styles.footer}>
        <span>Flowcast · Built at Hackachusetts, Civic Action track.</span>
        <a href={REPO}>GitHub</a>
      </footer>
    </div>
  );
}
