import type { ReactNode } from 'react';
import styles from './Table.module.css';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  width?: string;
  align?: 'left' | 'right';
}

/**
 * Plain data table with hairline rows, on a glass card. On phones each row becomes a small block:
 * the first column as its heading, then "Header  value" lines (`stack`, the default). Tables whose
 * rows only make sense side by side pass `stack={false}` and scroll sideways inside the card.
 * The explicit table roles keep the semantics in browsers that drop them when CSS changes `display`.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  caption,
  stack = true,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption?: string;
  stack?: boolean;
}) {
  return (
    <div className={`${styles.wrap} ${stack ? styles.stacked : styles.scroll}`}>
      <table className={styles.table} role="table">
        {caption && <caption className="visually-hidden">{caption}</caption>}
        <thead role="rowgroup">
          <tr role="row">
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width, textAlign: c.align }} scope="col" role="columnheader">{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row) => (
            <tr key={rowKey(row)} role="row">
              {columns.map((c) => (
                <td key={c.key} data-label={c.header} style={{ textAlign: c.align }} role="cell">{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Two-line cell: name plus a quieter line under it. */
export function CellStack({ primary, secondary }: { primary: ReactNode; secondary?: ReactNode }) {
  return (
    <div className={styles.stack}>
      <span>{primary}</span>
      {secondary && <span className={styles.secondary}>{secondary}</span>}
    </div>
  );
}
