import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Segmented } from './Controls';
import styles from './SearchBar.module.css';

export type SearchMode = 'search' | 'ask';

/** The big search field from Home: Search / Ask Flowcast toggle, focuses on Ctrl+K or ⌘K. */
export function SearchBar({
  placeholder,
  onSubmit,
  mode: controlledMode,
  onModeChange,
}: {
  placeholder: string;
  mode?: SearchMode;
  onModeChange?: (mode: SearchMode) => void;
  onSubmit?: (query: string, mode: SearchMode) => void;
}) {
  const [internalMode, setMode] = useState<SearchMode>('search');
  const mode = controlledMode ?? internalMode;
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);

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
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (query.trim()) onSubmit?.(query.trim(), mode);
      }}
    >
      {mode === 'search' && <><Search aria-hidden className={styles.icon} />
      <input
        ref={input}
        className={styles.input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        aria-label="Search"
      />
      </>}
      <Segmented
        label="Search mode"
        value={mode}
        onChange={(value) => { setMode(value); onModeChange?.(value); }}
        options={[
          { value: 'search', label: 'Search' },
          { value: 'ask', label: 'Ask Flowcast' },
        ]}
      />
      {mode === 'search' && <span className={styles.keys} aria-hidden>
        <kbd>Ctrl</kbd>
        <kbd>K</kbd>
      </span>}
    </form>
  );
}
