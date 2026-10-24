import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import styles from './SectionList.module.css';

/** Trov-style list block: a quiet header ("Today 4 ›") over hairline-separated rows. */
export function SectionList({
  title,
  count,
  to,
  children,
  empty,
}: {
  title: string;
  count?: number;
  to?: string;
  children?: ReactNode;
  empty?: ReactNode;
}) {
  const heading = (
    <>
      <span>{title}</span>
      {count !== undefined && <span className={styles.count}>{count}</span>}
      {to && <ChevronRight aria-hidden className={styles.chev} />}
    </>
  );
  const hasRows = Array.isArray(children) ? children.some(Boolean) : Boolean(children);
  return (
    <section className={styles.section}>
      {to ? (
        <Link to={to} className={styles.head}>{heading}</Link>
      ) : (
        <div className={styles.head}>{heading}</div>
      )}
      {hasRows ? <div>{children}</div> : empty && <div className={styles.empty}>{empty}</div>}
    </section>
  );
}

/** One row: text on the left, a quiet detail on the right, optional leading badge and link. */
export function ListRow({
  leading,
  title,
  detail,
  to,
  trailing,
}: {
  leading?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  to?: string;
  trailing?: ReactNode;
}) {
  const content = (
    <>
      {leading && <span className={styles.leading}>{leading}</span>}
      <span className={styles.rowTitle}>{title}</span>
      {detail && <span className={styles.detail}>{detail}</span>}
      {trailing}
      {to && <ChevronRight aria-hidden className={styles.chev} />}
    </>
  );
  return to ? (
    <Link to={to} className={`${styles.row} ${styles.link}`}>{content}</Link>
  ) : (
    <div className={styles.row}>{content}</div>
  );
}
