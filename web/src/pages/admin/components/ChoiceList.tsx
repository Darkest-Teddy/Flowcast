import styles from './ChoiceList.module.css';

/** A hairline list of radio choices, each with one line explaining what it does. */
export function ChoiceList<T extends string>({
  name,
  label,
  options,
  value,
  onChange,
}: {
  name: string;
  label: string;
  options: { value: T; label: string; description?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className={styles.list}>
      <legend className="visually-hidden">{label}</legend>
      {options.map((o) => (
        <label key={o.value} className={`${styles.choice} ${o.value === value ? styles.on : ''}`}>
          <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
          <span className={styles.text}>
            <span className={styles.label}>{o.label}</span>
            {o.description && <span className={styles.description}>{o.description}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
