/**
 * API answers are never stored by a cache and have no ETag (so nothing can be revalidated and an old Set-Cookie replayed): the Android app's HTTP cache once replayed an admin's
 * old second-step cookie from a "not modified" answer and signed them out. The public catalogue still says it may be kept for a minute.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, boot, customerWithVehicle, expectOk, shutdown, siteUrl, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

const raw = (path: string, headers: Record<string, string> = {}) => fetch(`${siteUrl()}${path}`, { headers });

describe('no API answer can be revalidated', () => {
  it('an admin answer, the signed-in person, a customer list and the health check carry no-store and no ETag, and an If-None-Match changes nothing', async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    for (const [who, path] of [[admin.c, '/api/admin/overview'], [admin.c, '/api/me'], [cust.c, '/api/vehicles'], [new Client(), '/api/health']] as const) {
      const r = await who.get(path);
      expect(r.status, path).toBe(200);
      const res = await raw(path, who === admin.c || who === cust.c ? { cookie: who.cookieHeader() } : {});
      expect(res.headers.get('cache-control'), path).toBe('no-store');
      expect(res.headers.get('etag'), path).toBeNull();
      const again = await raw(path, { 'if-none-match': 'W/"anything"', ...(who === admin.c || who === cust.c ? { cookie: who.cookieHeader() } : {}) });
      expect(again.status, path).toBe(200);   // never a "304 not modified" a cache could merge old headers into
    }
  });

  it('the public catalogue is still allowed to be kept for a minute', async () => {
    const res = await raw('/api/catalog');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });
});
