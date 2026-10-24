import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBadge } from '../../../ui';
import styles from './StatusLine.module.css';

type Tone = 'ok' | 'warn' | 'bad' | 'off' | 'accent';
export interface Flash {
  text: string;
  tone: Tone;
}

/** A polite live region that shows one short result ("Saved", "Approved"). Always rendered so screen readers hear changes. */
export function StatusLine({ flash, className }: { flash: Flash | null; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={[styles.line, className].filter(Boolean).join(' ')}>
      {flash && <StatusBadge tone={flash.tone}>{flash.text}</StatusBadge>}
    </div>
  );
}

/** Holds a result message and clears it after a few seconds (pass `sticky` to keep it). */
export function useFlash(timeoutMs = 4000) {
  const [flash, setFlash] = useState<Flash | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback(
    (text: string, tone: Tone = 'ok', sticky = false) => {
      clearTimeout(timer.current);
      setFlash({ text, tone });
      if (!sticky) timer.current = setTimeout(() => setFlash(null), timeoutMs);
    },
    [timeoutMs],
  );
  const clear = useCallback(() => {
    clearTimeout(timer.current);
    setFlash(null);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { flash, show, clear };
}
