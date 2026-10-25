import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MessagesSquare } from 'lucide-react';
import { Button } from './Button';
import styles from './AskBar.module.css';

/** The big Ask Flowcast field from Home. `trailing` sits inside the capsule after the Ask button (the mic). */
export function AskBar({
  onSubmit,
  pending = false,
  resetToken = 0,
  trailing,
}: {
  onSubmit?: (question: string) => void;
  pending?: boolean;
  resetToken?: number;
  trailing?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!resetToken) return;
    setQuery('');
    input.current?.focus();
  }, [resetToken]);

  return (
    <form
      className={styles.bar}
      aria-label="Ask Flowcast"
      onSubmit={(e) => {
        e.preventDefault();
        if (query.trim() && !pending) {
          onSubmit?.(query.trim());
          setQuery('');
        }
      }}
    >
      <MessagesSquare aria-hidden className={styles.icon} />
      <input
        ref={input}
        className={styles.input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Ask about campus or your day…"
        aria-label="Ask Flowcast"
        maxLength={300}
      />
      <Button type="submit" size="sm" className={styles.submit} disabled={pending || !query.trim()}>{pending ? 'Asking…' : 'Ask'}</Button>
      {trailing}
    </form>
  );
}
