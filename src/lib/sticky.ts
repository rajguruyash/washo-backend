import { useEffect, useState } from 'react';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

/**
 * State that survives leaving the page and coming back (opening a wash and pressing the back arrow, switching tabs, a reload): a filter someone chose stays chosen until THEY
 * change it. It lives in this browser tab's session storage, so it is forgotten when the tab is closed, and the key carries today's date (Pune) so a date range or a "today" a
 * day later starts fresh. Storage that is blocked or full just means the page behaves as it did before (the choice resets).
 */
export function useSticky<T>(key: string, initial: T) {
  const full = `washo:ui:${today()}:${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(full);
      return raw == null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(full, JSON.stringify(value));
    } catch {
      /* storage blocked or full: the choice is simply not remembered */
    }
  }, [full, value]);
  return [value, setValue] as const;
}
