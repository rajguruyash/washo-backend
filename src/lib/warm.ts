import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { type PageName, pageFor, preloadPage } from './pages';
import { bookingsQuery, campaignQuery, keys, membershipsQuery, requestsQuery } from './queries';
import type { User } from './types';

/**
 * Getting ahead of the click. WASHO's server and its files are an ocean away for most visitors, so every file or answer a click waits for costs a quarter of a second or more. What is done here:
 *  - when the browser is idle, the code of the pages a visitor is likely to open next is loaded, and for a signed-in customer so is the data of the home screen, so "Open app" opens at once;
 *  - when a link is hovered, focused or touched (a touch comes a moment before the click), the page behind it is loaded then, if it was not already.
 * It is all quiet work: one file at a time, only when the browser has nothing else to do, and none of it for someone on a slow or data-saving connection.
 */
const CUSTOMER_PAGES: PageName[] = ['dashboard', 'bookings', 'membership', 'account', 'vehicles', 'book', 'membershipNew'];
const VISITOR_PAGES: PageName[] = ['services'];
const STAFF_PAGES: Record<string, PageName[]> = { worker: ['workerHome', 'workerWash'], admin: ['admin'] };

type Net = { saveData?: boolean; effectiveType?: string };
/** Someone on a slow or data-saving connection gets nothing fetched they did not ask for. */
const frugal = (): boolean => {
  const c = (navigator as Navigator & { connection?: Net }).connection;
  return Boolean(c?.saveData) || c?.effectiveType === '2g' || c?.effectiveType === 'slow-2g';
};

const idle = (fn: () => void, timeout = 4000) => {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(fn, { timeout });
    return () => w.cancelIdleCallback?.(id);
  }
  const t = window.setTimeout(fn, 1500);
  return () => window.clearTimeout(t);
};

/** The data of the customer's home screen, with the very same keys and answers the screen uses (a recent answer is kept, so this is free when it is fresh). */
export function warmCustomerData(qc: QueryClient): void {
  void qc.prefetchQuery(membershipsQuery);
  void qc.prefetchQuery(requestsQuery);
  void qc.prefetchQuery(bookingsQuery('upcoming'));
  void qc.prefetchQuery(bookingsQuery('past'));
  void qc.prefetchQuery(campaignQuery);
}

const isCustomerReady = (u: User | null | undefined): u is User => Boolean(u && u.role === 'customer' && !u.needs_profile);

/** Loads, one by one while the browser is idle, the pages this visitor is most likely to open next. `ready` is false while the opening loading screen is up. */
export function useWarm(user: User | null, qc: QueryClient, ready: boolean): void {
  const role = user?.role ?? null;
  const customer = isCustomerReady(user);
  useEffect(() => {
    if (!ready || frugal()) return undefined;
    const names: PageName[] = customer ? CUSTOMER_PAGES : role ? (STAFF_PAGES[role] ?? []) : VISITOR_PAGES;
    let cancelled = false;
    let cancel = () => undefined as void;
    const next = (i: number) => {
      if (cancelled) return;
      if (i === 0 && customer) warmCustomerData(qc);
      if (i < names.length) {
        preloadPage(names[i]);
        cancel = idle(() => next(i + 1), 2000);
      }
    };
    cancel = idle(() => next(0));
    return () => {
      cancelled = true;
      cancel();
    };
  }, [ready, customer, role, qc]);
}

/** One listener for the whole site: the page behind a link is loaded as soon as the pointer is over it, a finger touches it or the keyboard reaches it. */
export function installLinkWarm(qc: QueryClient): void {
  const seen = new WeakSet<Element>();
  const onNear = (e: Event) => {
    if (frugal()) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.target === '_blank' || a.origin !== location.origin || seen.has(a)) return;
    seen.add(a);
    const name = pageFor(a.pathname);
    if (name) preloadPage(name);
    if (a.pathname.startsWith('/app') && isCustomerReady(qc.getQueryData<User | null>(keys.me))) warmCustomerData(qc);
    // links are looked at again after a while (an answer is not kept for ever): see warmCustomerData
    window.setTimeout(() => seen.delete(a), 30_000);
  };
  const opts = { passive: true, capture: true } as const;
  document.addEventListener('pointerover', onNear, opts);
  document.addEventListener('touchstart', onNear, opts);
  document.addEventListener('focusin', onNear, opts);
}
