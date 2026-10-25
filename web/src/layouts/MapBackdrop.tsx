import { introSources } from '@map/intro';
import styles from './MapBackdrop.module.css';

/**
 * The campus from above, frosted, behind the whole student app: the map's own intro still, the
 * daytime one in light mode and the night one in dark, blurred and washed toward the canvas so the
 * glass panels keep their contrast. Decorative; hidden when transparency is reduced. Lazy, so the
 * still the theme hides is never fetched.
 */
export function MapBackdrop() {
  return (
    <div className={styles.backdrop} aria-hidden>
      <img {...introSources('day')} className={styles.light} sizes="100vw" alt="" loading="lazy" decoding="async" />
      <img {...introSources('night')} className={styles.dark} sizes="100vw" alt="" loading="lazy" decoding="async" />
    </div>
  );
}
