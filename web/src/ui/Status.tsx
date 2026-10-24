import { crowdFor, swatchFor } from '@theme/tokens';
import { formatPercent } from '../lib/format';
import type { SourceHealth } from '../data/types';
import styles from './Status.module.css';

type Tone = 'ok' | 'warn' | 'bad' | 'off' | 'accent';

const healthTone: Record<SourceHealth, Tone> = { healthy: 'ok', attention: 'warn', failing: 'bad', off: 'off' };

/** A coloured dot plus words. Colour is never the only signal. */
export function StatusBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={`${styles.badge} ${styles[tone]}`}>
      <i aria-hidden />
      {children}
    </span>
  );
}

export function HealthBadge({ health, text }: { health: SourceHealth; text: string }) {
  return <StatusBadge tone={healthTone[health]}>{text}</StatusBadge>;
}

/** Small filled label: "Club", "Verified", "Admin". */
export function Tag({ tone = 'off', children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`${styles.tag} ${styles[tone]}`}>{children}</span>;
}

/** "88% Busy" with a bar, on the shared crowd scale. */
export function CrowdMeter({ share, showBar = true }: { share: number; showBar?: boolean }) {
  const level = crowdFor(share);
  return (
    <span className={styles.crowd}>
      {showBar && (
        <span className={styles.meter} aria-hidden>
          <b style={{ width: `${Math.min(100, share * 100)}%`, background: level.color }} />
        </span>
      )}
      <span className={styles.crowdText}>
        {formatPercent(share)} {level.label}
      </span>
    </span>
  );
}

/** Square initials avatar with a stable colour per name. */
export function Avatar({ name, size = 22, color }: { name: string; size?: number; color?: string }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className={styles.avatar} style={{ width: size, height: size, background: color ?? swatchFor(name), fontSize: size * 0.45 }} aria-hidden>
      {initials}
    </span>
  );
}
