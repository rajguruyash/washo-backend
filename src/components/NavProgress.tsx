import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * A thin bar along the top of the screen from the moment a link is clicked until the next page is there. A page whose code has not arrived yet used to leave the click looking dead (the address does
 * not change until the page is ready); now it shows at once that something is happening. With the pages loaded early (lib/warm.ts) it is rarely on screen for more than a blink.
 */
export function NavProgress() {
  const { key } = useLocation();
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState(key);
  // a new page arrived: done (derived while rendering, not in an effect)
  if (seen !== key) {
    setSeen(key);
    setBusy(false);
  }

  useEffect(() => {
    // capture phase: it must hear the click before the router's own link handler stops it
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.hasAttribute('download') || a.origin !== location.origin) return;
      if (a.pathname === location.pathname && a.search === location.search) return; // the same page (a jump within it)
      setBusy(true);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // never stuck on screen, whatever happens to the navigation
  useEffect(() => {
    if (!busy) return undefined;
    const t = window.setTimeout(() => setBusy(false), 8000);
    return () => window.clearTimeout(t);
  }, [busy]);

  return busy ? <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[300] h-0.5 origin-left animate-nav-progress bg-gradient-to-r from-washo-500 via-washo-300 to-washo-200" /> : null;
}
