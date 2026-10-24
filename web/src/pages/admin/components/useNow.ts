import { useEffect, useState } from 'react';

/** Current time that re-renders the caller every `everyMs`, so "4 minutes ago" stays true. */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
