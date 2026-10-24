import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './BigButton.module.css';

type Tone = 'default' | 'accent' | 'danger';

/** A large presenter button: one bold line plus an optional quieter line. `pressed` makes it a toggle. */
export function BigButton({
  title,
  detail,
  icon,
  pressed,
  tone = 'default',
  className,
  ...rest
}: {
  title: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  pressed?: boolean;
  tone?: Tone;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'>) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={[styles.big, styles[tone], pressed && styles.pressed, className].filter(Boolean).join(' ')}
      {...rest}
    >
      {icon && <span className={styles.icon}>{icon}</span>}
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {detail && <span className={styles.detail}>{detail}</span>}
      </span>
    </button>
  );
}
