import { useId, type CSSProperties } from 'react';
import styles from './Controls.module.css';

/** Apple-style segmented control. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  animated = false,
}: {
  animated?: boolean;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className={`${styles.segmented} ${animated ? styles.animated : ''}`} role="radiogroup" aria-label={label}
      style={animated ? { '--segment-count': options.length, '--segment-index': Math.max(0, options.findIndex(option => option.value === value)) } as CSSProperties : undefined}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? styles.on : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** On/off switch with its label. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={styles.toggleRow}>
      <label htmlFor={id} className={styles.toggleLabel}>
        <span>{label}</span>
        {description && <span className={styles.toggleDescription}>{description}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={styles.switch}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}
