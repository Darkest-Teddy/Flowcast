import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Select } from './Select';
import styles from './Field.module.css';

function FieldShell({ id, label, hint, error, children }: { id: string; label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <label id={`${id}-label`} htmlFor={id} className={styles.label}>{label}</label>
      {children}
      {error ? (
        <p id={`${id}-msg`} className={styles.error}>{error}</p>
      ) : (
        hint && <p id={`${id}-msg`} className={styles.hint}>{hint}</p>
      )}
    </div>
  );
}

type Common = { label: string; hint?: ReactNode; error?: string };

export function TextField({ label, hint, error, ...input }: Common & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <input id={id} className={styles.control} aria-invalid={Boolean(error)} aria-describedby={hint || error ? `${id}-msg` : undefined} {...input} />
    </FieldShell>
  );
}

export function TextArea({ label, hint, error, ...input }: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <textarea id={id} className={`${styles.control} ${styles.area}`} aria-invalid={Boolean(error)} aria-describedby={hint || error ? `${id}-msg` : undefined} {...input} />
    </FieldShell>
  );
}

/** A labelled custom select (see Select.tsx): native <option> children and `event.target.value` as before. */
export function SelectField({ label, hint, error, children, ...input }: Common & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <Select id={id} aria-invalid={Boolean(error)} aria-describedby={hint || error ? `${id}-msg` : undefined} {...input}>
        {children}
      </Select>
    </FieldShell>
  );
}
