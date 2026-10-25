import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MessagesSquare } from 'lucide-react';
import { Button } from './Button';
import styles from './AskBar.module.css';

/**
 * The big Ask Flowcast field from Home. `voice` wraps the field and Ask button in the voice control
 * (LiveVoice compact), which puts its mic at the end and swaps the field for a waveform while live.
 */
export function AskBar({
  onSubmit,
  pending = false,
  resetToken = 0,
  voice,
}: {
  onSubmit?: (question: string) => void;
  pending?: boolean;
  resetToken?: number;
  voice?: (field: ReactNode) => ReactNode;
}) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!resetToken) return;
    setQuery('');
    input.current?.focus();
  }, [resetToken]);

  const field = (
    <>
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
    </>
  );

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
      {voice ? voice(field) : field}
    </form>
  );
}
