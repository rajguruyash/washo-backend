/**
 * Announcements from the Admin page: an admin who manages Campaigns sends a message and it appears in every customer's Notifications in the app.
 * (The roles are enforced by the one admin gate; the delivery and the rules are the database's. Supabase Auth is a local stand-in.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, customerWithVehicle, expectOk, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

describe('announcements', () => {
  it('marketing sends one; the customer sees it in their notifications; it shows in the history', async () => {
    const cust = await customerWithVehicle('car');
    const mkt = await staffClient('admin', { access: 'marketing' });
    const r = expectOk(await mkt.c.post('/api/admin/announcements', { title: 'Free wash this Sunday', body: 'Book any wash this Sunday and the first one is on us.', audience: 'all' }));
    expect(r.status).toBe(201);
    expect(r.body.recipients).toBeGreaterThanOrEqual(1);

    const mine = expectOk(await cust.c.get('/api/notifications')).body.notifications as { category: string; title: string; body: string; read: boolean }[];
    expect(mine.find((n) => n.category === 'announcement')).toMatchObject({ title: 'Free wash this Sunday', read: false });

    const list = expectOk(await mkt.c.get('/api/admin/announcements')).body.announcements as { title: string; recipients: number; audience: string }[];
    expect(list[0]).toMatchObject({ title: 'Free wash this Sunday', audience: 'all' });
  });

  it('only Campaigns managers can send; Campaigns viewers and others are refused by the one gate', async () => {
    const sup = await staffClient('admin', { access: 'support' });
    const fin = await staffClient('admin', { access: 'finance' });
    const cust = await customerWithVehicle('car');
    const body = { title: 'Hello', body: 'Not allowed.', audience: 'all' };
    for (const who of [sup, fin, cust]) {
      expect((await who.c.post('/api/admin/announcements', body)).status).toBe(403);
      expect((await who.c.get('/api/admin/announcements')).status).toBe(403);
    }
    const ops = await staffClient('admin', { access: 'operations' });
    expect(expectOk(await ops.c.post('/api/admin/announcements', { title: 'Ops note', body: 'Operations may send.', audience: 'all' })).status).toBe(201);
  });

  it('says what is wrong with an empty or oversized message, and refuses the same words twice in a row', async () => {
    const mkt = await staffClient('admin', { access: 'marketing' });
    expect((await mkt.c.post('/api/admin/announcements', { title: '', body: 'x', audience: 'all' })).status).toBe(400);
    expect((await mkt.c.post('/api/admin/announcements', { title: 'x', body: 'y'.repeat(501), audience: 'all' })).status).toBe(400);
    expect((await mkt.c.post('/api/admin/announcements', { title: 'x', body: 'y', audience: 'staff' })).status).toBe(400);
    expectOk(await mkt.c.post('/api/admin/announcements', { title: 'Same words', body: 'Sent once.', audience: 'all' }));
    const again = await mkt.c.post('/api/admin/announcements', { title: 'Same words', body: 'Sent once.', audience: 'all' });
    expect(again.status).toBe(422); // a database rule, said in plain words
    expect(again.body.message).toMatch(/just sent/i);
  });
});
