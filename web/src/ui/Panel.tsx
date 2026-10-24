import type { ReactNode } from 'react';
import styles from './Panel.module.css';

/** A plain white surface with a hairline border. Optional title row with actions on the right. */
export function Panel({
  title,
  description,
  actions,
  children,
  padded = true,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  padded?: boolean;
  className?: string;
}) {
  return (
    <section className={[styles.panel, padded && styles.padded, className].filter(Boolean).join(' ')}>
      {(title || actions) && (
        <header className={styles.head}>
          <div>
            {title && <h3 className={styles.title}>{title}</h3>}
            {description && <p className={styles.description}>{description}</p>}
          </div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
