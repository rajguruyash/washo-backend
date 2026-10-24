import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { pageFor, pages } from './pages';
import { warmCustomerData } from './warm';

describe('which page a path needs (so it can be loaded before the click)', () => {
  it.each([
    ['/app', 'dashboard'],
    ['/app/', 'dashboard'],
    ['/app/bookings', 'bookings'],
    ['/app/bookings/3f2a', 'bookingDetail'],
    ['/app/membership', 'membership'],
    ['/app/membership/new', 'membershipNew'],
    ['/app/membership/requests/9c1', 'requestDetail'],
    ['/app/membership/9c1', 'membershipDetail'],
    ['/app/book', 'book'],
    ['/app/vehicles', 'vehicles'],
    ['/app/account', 'account'],
    ['/app/help', 'help'],
    ['/app/help/77', 'helpTicket'],
    ['/services', 'services'],
    ['/navratri', 'offer'],
    ['/free-wash', 'offer'],
    ['/refund-policy', 'refunds'],
    ['/worker', 'workerHome'],
    ['/worker/washes/12', 'workerWash'],
    ['/admin', 'admin'],
  ])('%s', (path, name) => {
    expect(pageFor(path)).toBe(name);
  });

  it('knows nothing of pages that are in the first download or do not exist', () => {
    for (const path of ['/', '/login', '/app/unknown-page', '/nowhere', '/app/membership/a/b']) expect(pageFor(path)).toBeUndefined();
  });

  it('every page it can name is one the router can load', () => {
    for (const path of ['/app', '/app/book', '/services', '/worker', '/admin']) expect(typeof pages[pageFor(path)!]).toBe('function');
  });
});

describe('warming the customer home screen', () => {
  it('asks for exactly what the home screen asks for, with the same keys', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'prefetchQuery').mockResolvedValue(undefined);
    warmCustomerData(qc);
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey)).toEqual([['memberships'], ['membership-requests'], ['bookings', 'upcoming'], ['bookings', 'past'], ['campaign']]);
  });
});
