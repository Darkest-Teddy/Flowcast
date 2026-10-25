import type { ReactNode } from 'react';
import styles from './Page.module.css';

/** Content column with the standard max width and padding. `wide` for tables and admin grids. */
export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className={`${styles.page} ${wide ? styles.wide : ''}`}>{children}</div>;
}

/** Page title, one line of explanation, and actions on the right. */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className={styles.header}>
      <div>
        <h1 className={styles.title}>{title}</h1>
        {description && <p className={styles.description}>{description}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  );
}

/** Group heading inside a page ("Live feeds", "From users and clubs"). */
export function SectionHeading({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className={styles.sectionHeading}>
      <h2>{children}</h2>
      {actions}
    </div>
  );
}

/** Nothing here yet: say what goes here and offer the action that fills it. */
export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>{title}</p>
      {body && <p className={styles.emptyBody}>{body}</p>}
      {action && <div className={styles.emptyAction}>{action}</div>}
    </div>
  );
}

/**
 * Responsive grid of equal columns: at most two under 860px and one on phones, or two on phones
 * with `phoneColumns={2}` (small stat cards).
 */
export function Grid({
  columns,
  children,
  gap = 'md',
  phoneColumns = 1,
}: {
  columns: number;
  children: ReactNode;
  gap?: 'md' | 'lg';
  phoneColumns?: 1 | 2;
}) {
  return (
    <div
      className={[styles.grid, gap === 'lg' && styles.gapLg, phoneColumns === 2 && styles.phonePairs].filter(Boolean).join(' ')}
      style={{ ['--cols' as string]: columns }}
    >
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return <p className={styles.loading} role="status">{label}…</p>;
}
