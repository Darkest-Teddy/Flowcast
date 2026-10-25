import { Link } from 'react-router';
import { config } from '../config';
import { MapBackdrop } from '../layouts/MapBackdrop';
import { Button, Logo, Page } from '../ui';
import { PrivacyPolicy } from './account/PrivacyPolicy';
import { Terms } from './account/Terms';
import styles from './PublicPrivacy.module.css';

/**
 * /privacy for someone who isn't signed in (Google's OAuth review, a visitor from the landing page):
 * the privacy policy and terms, readable without an account. Signed in, /privacy is the full page
 * with the download and delete tools (Privacy.tsx), which show the same two documents.
 */
export default function PublicPrivacy() {
  return (
    <main className={styles.screen}>
      <MapBackdrop />
      <Page>
        <header className={styles.top}>
          <Link to="/landing" className={styles.brand} aria-label={`${config.appName} home`}>
            <Logo className={styles.mark} />
            <span>{config.appName}</span>
          </Link>
          <Button to="/signin" variant="secondary" size="sm">Sign in</Button>
        </header>

        <h1 className={styles.title}>Privacy &amp; terms</h1>
        <p className={styles.lede}>
          How Flowcast handles your data, and the terms for using it. <a href="#privacy">Privacy policy</a> · <a href="#terms">Terms of service</a>
        </p>
        <p className={styles.account}>
          Signed in, this page also lets you download everything Flowcast stores about you, or delete it. <Link to="/signin">Sign in</Link> to use them.
        </p>

        <PrivacyPolicy />
        <Terms />

        <footer className={styles.footer}>
          <Link to="/landing">Back to Flowcast</Link>
        </footer>
      </Page>
    </main>
  );
}
