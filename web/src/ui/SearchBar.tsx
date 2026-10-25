import { useEffect, useRef, useState } from 'react';
import { Search, MessagesSquare } from 'lucide-react';
import { Button } from './Button';
import { Segmented } from './Controls';
import styles from './SearchBar.module.css';

export type SearchMode = 'search' | 'ask';

/** The big search field from Home: Search / Ask Flowcast toggle, focuses on Ctrl+K or ⌘K. */
export function SearchBar({
  placeholder,
  onSubmit,
  mode: controlledMode,
  onModeChange,
  pending = false,
  resetToken = 0,
}: {
  placeholder: string;
  pending?: boolean;
  resetToken?: number;
  mode?: SearchMode;
  onModeChange?: (mode: SearchMode) => void;
  onSubmit?: (query: string, mode: SearchMode) => void;
}) {
  const [internalMode, setMode] = useState<SearchMode>('search');
  const mode = controlledMode ?? internalMode;
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!resetToken) return;
    setQuery('');
    input.current?.focus();
  }, [resetToken]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <form
      className={styles.bar}
      role={mode === 'search' ? 'search' : undefined}
      aria-label={mode === 'search' ? 'Campus search' : 'Ask Flowcast'}
      onSubmit={(e) => {
        e.preventDefault();
        if (query.trim() && !pending) {
          onSubmit?.(query.trim(), mode);
          if (mode === 'ask') setQuery('');
        }
      }}
    >
      {mode === 'search' ? <Search aria-hidden className={styles.icon} /> : <MessagesSquare aria-hidden className={styles.icon} />}
      <input
        ref={input}
        className={styles.input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={mode === 'ask' ? 'Ask about campus or your day…' : placeholder}
        aria-label={mode === 'ask' ? 'Ask Flowcast' : 'Search'}
        maxLength={mode === 'ask' ? 300 : undefined}
      />
      <Segmented
        animated
        label="Search mode"
        value={mode}
        onChange={(value) => { setMode(value); onModeChange?.(value); input.current?.focus(); }}
        options={[
          { value: 'search', label: 'Search' },
          { value: 'ask', label: 'Ask Flowcast' },
        ]}
      />
      <Button type="submit" size="sm" className={styles.submit} disabled={pending || !query.trim()}>{pending ? 'Asking…' : mode === 'ask' ? 'Ask' : 'Search'}</Button>
      <span className={styles.keys} aria-hidden>
        <kbd>Ctrl</kbd>
        <kbd>K</kbd>
      </span>
    </form>
  );
}
