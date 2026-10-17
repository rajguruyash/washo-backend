/**
 * Push to a closed phone over the website API: a signed-in customer hands over their phone's Firebase token; when a Campaigns manager sends an announcement, the server pushes it to the
 * phones of the customers who received it, forgets phones Firebase says are gone, and never lets a push problem fail the send. (The sender is a recording stand-in; the real one is
 * tested in push-fcm.test.ts. Supabase is a local stand-in; the rules are the database's.)
 */
import crypto from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, boot, customerWithVehicle, expectOk, fake, shutdown, staffClient } from './helpers';

type Msg = { token: string; title: string; body: string; data?: Record<string, string> };
let setPushTransport: (t: ((m: Msg[]) => Promise<('sent' | 'dead' | 'failed')[]>) | null) => void;
let pushed: Msg[] = [];

beforeAll(async () => {
  await boot();
  ({ setPushTransport } = await import('../src/push'));
});
afterAll(async () => {
  setPushTransport(null);
  await shutdown();
});
beforeEach(async () => {
  pushed = [];
  await fake.admin.query('delete from public.device_tokens');
  // dead-* phones are gone, boom-* fail, everything else is delivered
  setPushTransport(async (messages) => {
    pushed.push(...messages);
    return messages.map((m) => (m.token.startsWith('dead-') ? 'dead' : m.token.startsWith('boom-') ? 'failed' : 'sent'));
  });
});

const tok = (label: string) => `${label}-${crypto.randomBytes(8).toString('hex')}-${'z'.repeat(24)}`;
const save = (c: Client, token: string) => c.put('/api/devices', { token, platform: 'android', app_version: '1.0.0' });
const rowsFor = async (token: string) => (await fake.admin.query('select profile_id from public.device_tokens where token = $1', [token])).rows;

describe('saving a phone', () => {
  it('a signed-in customer saves their phone and takes it back on sign-out; only they can', async () => {
    const a = await customerWithVehicle('car');
    const b = await customerWithVehicle('car');
    const t = tok('good');
    expectOk(await save(a.c, t));
    expect(await rowsFor(t)).toHaveLength(1);

    expectOk(await b.c.post('/api/devices/remove', { token: t })); // someone else's phone: nothing happens
    expect(await rowsFor(t)).toHaveLength(1);
    expectOk(await a.c.post('/api/devices/remove', { token: t }));
    expect(await rowsFor(t)).toHaveLength(0);
  });

  it('says what is wrong with a bad token, and needs a signed-in person', async () => {
    const a = await customerWithVehicle('car');
    expect((await save(a.c, 'short')).status).toBe(400);
    expect((await a.c.put('/api/devices', { token: tok('good'), platform: 'windows' })).status).toBe(400);
    expect((await save(new Client(), tok('good'))).status).toBe(401);
    expect((await new Client().post('/api/devices/remove', { token: tok('good') })).status).toBe(401);
  });
});

describe('pushing an announcement', () => {
  it('goes to the phones of the customers who received it, with their own notification id, and the admin is told how many', async () => {
    const a = await customerWithVehicle('car');
    const b = await customerWithVehicle('car');
    const ta1 = tok('good'), ta2 = tok('good'), tb = tok('good');
    expectOk(await save(a.c, ta1)); expectOk(await save(a.c, ta2)); expectOk(await save(b.c, tb));
    const mkt = await staffClient('admin', { access: 'marketing' });

    const r = expectOk(await mkt.c.post('/api/admin/announcements', { title: `Free foam wash ${crypto.randomBytes(2).toString('hex')}`, body: 'Book before 6 pm.', audience: 'all' }));
    expect(r.status).toBe(201);
    expect(r.body.push).toEqual({ configured: true, devices: 3, sent: 3, failed: 0, removed: 0 });
    expect(pushed.map((m) => m.token).sort()).toEqual([ta1, ta2, tb].sort());
    expect(pushed[0]).toMatchObject({ title: expect.stringMatching(/^Free foam wash /), body: 'Book before 6 pm.', data: { category: 'announcement', announcement_id: r.body.id } });

    // each phone carries its own customer's notification: opening it from the tray is the same message the list shows
    const mine = (expectOk(await a.c.get('/api/notifications')).body.notifications as { id: string; reference_id: string }[]).find((n) => n.reference_id === r.body.id)!;
    expect(pushed.filter((m) => [ta1, ta2].includes(m.token)).map((m) => m.data!.notification_id)).toEqual([mine.id, mine.id]);
  });

  it('forgets a phone that Firebase says is gone, counts a failure, and still sends the announcement', async () => {
    const a = await customerWithVehicle('car');
    const good = tok('good'), dead = tok('dead'), boom = tok('boom');
    expectOk(await save(a.c, good)); expectOk(await save(a.c, dead)); expectOk(await save(a.c, boom));
    const ops = await staffClient('admin', { access: 'operations' });

    const r = expectOk(await ops.c.post('/api/admin/announcements', { title: `Gone phones ${crypto.randomBytes(2).toString('hex')}`, body: 'Hello.', audience: 'all' }));
    expect(r.body.push).toEqual({ configured: true, devices: 3, sent: 1, failed: 1, removed: 1 });
    expect(await rowsFor(dead)).toHaveLength(0);
    expect(await rowsFor(good)).toHaveLength(1);
    expect(await rowsFor(boom)).toHaveLength(1); // a failure is not a reason to forget the phone
    expect((expectOk(await a.c.get('/api/notifications')).body.notifications as { title: string }[]).some((n) => n.title.startsWith('Gone phones'))).toBe(true);
  });

  it('a signed-out phone (token removed) is not pushed to', async () => {
    const a = await customerWithVehicle('car');
    const t = tok('good');
    expectOk(await save(a.c, t));
    expectOk(await a.c.post('/api/devices/remove', { token: t }));
    const mkt = await staffClient('admin', { access: 'marketing' });
    const r = expectOk(await mkt.c.post('/api/admin/announcements', { title: `Nobody home ${crypto.randomBytes(2).toString('hex')}`, body: 'Hello.', audience: 'all' }));
    expect(r.body.push).toMatchObject({ configured: true, devices: 0 });
    expect(pushed).toHaveLength(0);
  });

  it('without a Firebase key nothing is pushed and the announcement still reaches every customer list', async () => {
    setPushTransport(null);
    const a = await customerWithVehicle('car');
    expectOk(await save(a.c, tok('good')));
    const mkt = await staffClient('admin', { access: 'marketing' });
    const title = `No key ${crypto.randomBytes(2).toString('hex')}`;
    const r = expectOk(await mkt.c.post('/api/admin/announcements', { title, body: 'Hello.', audience: 'all' }));
    expect(r.status).toBe(201);
    expect(r.body.push).toEqual({ configured: false, devices: 0, sent: 0, failed: 0, removed: 0 });
    expect((expectOk(await a.c.get('/api/notifications')).body.notifications as { title: string }[]).some((n) => n.title === title)).toBe(true);
  });

  it('a push that blows up never turns a saved announcement into an error', async () => {
    const a = await customerWithVehicle('car');
    expectOk(await save(a.c, tok('good')));
    setPushTransport(async () => { throw new Error('Firebase exploded'); });
    const mkt = await staffClient('admin', { access: 'marketing' });
    const r = expectOk(await mkt.c.post('/api/admin/announcements', { title: `Boom ${crypto.randomBytes(2).toString('hex')}`, body: 'Hello.', audience: 'all' }));
    expect(r.status).toBe(201);
    expect(r.body.push).toMatchObject({ configured: true, devices: 1, sent: 0, failed: 1 });
  });
});
