import type { ReactNode } from 'react';
import styles from './SettingRow.module.css';

/** One line in a settings panel: what it is on the left, the control on the right. Hairline between rows. */
export function SettingRow({ label, description, labelFor, children }: { label: string; description?: ReactNode; labelFor?: string; children: ReactNode }) {
  const Label = labelFor ? 'label' : 'span';
  return (
    <div className={styles.row}>
      <div className={styles.text}>
        <Label htmlFor={labelFor} className={styles.label}>{label}</Label>
        {description && <span className={styles.description}>{description}</span>}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}
