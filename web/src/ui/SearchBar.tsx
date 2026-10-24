import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Segmented } from './Controls';
import styles from './SearchBar.module.css';

export type SearchMode = 'search' | 'ask';

/** The big search field from Home: Search / Ask Flowcast toggle, focuses on Ctrl+K or ⌘K. */
export function SearchBar({
  placeholder,
  onSubmit,
}: {
  placeholder: string;
  onSubmit?: (query: string, mode: SearchMode) => void;
}) {
  const [mode, setMode] = useState<SearchMode>('search');
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
      <Search aria-hidden className={styles.icon} />
      <input
        ref={input}
        className={styles.input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={mode === 'ask' ? 'Ask anything about campus, like “when is Mugar quiet?”' : placeholder}
        aria-label={mode === 'ask' ? 'Ask Flowcast' : 'Search'}
      />
      <Segmented
        label="Search mode"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'search', label: 'Search' },
          { value: 'ask', label: 'Ask Flowcast' },
        ]}
      />
      <span className={styles.keys} aria-hidden>
        <kbd>Ctrl</kbd>
        <kbd>K</kbd>
      </span>
    </form>
  );
}
