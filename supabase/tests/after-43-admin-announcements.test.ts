/**
 * GREEN tests for 20261004000043_admin_announcements.sql: an admin who manages Campaigns (super admin, operations, marketing) sends a short message that lands in the
 * Notifications of every customer (or only customers with a membership that is on); nobody else can send or read the history; a double tap does not message people twice.
 */
import { describe, expect, it } from 'vitest';
import { createAdmin, createCustomer, createWorker, inTx, paidMembership } from './helpers';

const NOPE = /access|permission denied|Unauthorized/i;
const send = (s: any, who: { authId: string }, title = 'Free car wash this Sunday', body = 'Book any wash this Sunday and the first one is on us.', audience = 'all') =>
  (async () => { await s.as('authenticated', who.authId); return s.err('select public.admin_send_announcement($1,$2,$3)', [title, body, audience]); })();
const sent = async (s: any, who: { authId: string }, title = 'Free car wash this Sunday', body = 'Book any wash this Sunday and the first one is on us.', audience = 'all') => {
  await s.as('authenticated', who.authId);
  return (await s.q('select public.admin_send_announcement($1,$2,$3) r', [title, body, audience]))[0].r as { id: string; recipients: number };
};
const mine = async (s: any, who: { authId: string }) => {
  await s.as('authenticated', who.authId);
  return s.q(`select category, title, body, read, reference_id from public.notifications where category = 'announcement' order by created_at`);
};

describe('sending', () => {
  it('reaches every customer, once, with the words the admin wrote; the customer reads it in their own notifications', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'marketing');
      const c1 = await createCustomer(s);
      const c2 = await createCustomer(s);
      const r = await sent(s, a);
      expect(r.recipients).toBeGreaterThanOrEqual(2);
      for (const c of [c1, c2]) {
        const n = await mine(s, c);
        expect(n).toHaveLength(1);
        expect(n[0]).toMatchObject({ category: 'announcement', title: 'Free car wash this Sunday', read: false, reference_id: r.id });
      }
    }));

  it('does not reach specialists, admins or archived customers', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'operations');
      const w = await createWorker(s);
      const gone = await createCustomer(s);
      await s.as('postgres');
      await s.q('update public.profiles set archived_at = now() where id = $1', [gone.profileId]);
      await sent(s, a);
      expect(await mine(s, w)).toHaveLength(0);
      expect(await mine(s, a)).toHaveLength(0);
      expect(await mine(s, gone)).toHaveLength(0);
    }));

  it('"members" reaches only customers with a membership that is on', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'super_admin');
      const m = await paidMembership(s);
      const plain = await createCustomer(s);
      const r = await sent(s, a, 'Members only', 'A note for people on a plan.', 'members');
      expect(await mine(s, m.u)).toHaveLength(1);
      expect(await mine(s, plain)).toHaveLength(0);
      expect(r.recipients).toBeGreaterThanOrEqual(1);
    }));

  it('is recorded in the history and in the audit log', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'marketing');
      await createCustomer(s);
      const r = await sent(s, a);
      await s.as('authenticated', a.authId);
      const list = (await s.q('select public.admin_announcements_list() l'))[0].l as any[];
      expect(list[0]).toMatchObject({ id: r.id, title: 'Free car wash this Sunday', audience: 'all', recipients: r.recipients });
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.audit_events where entity_id = $1 and event_type = 'announcement_sent'`, [r.id]))[0].n).toBe(1);
    }));
});

describe('who may', () => {
  it('support, finance, specialists, customers and signed-out callers cannot send or read the history', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      const w = await createWorker(s);
      const sup = await createAdmin(s, 'support');
      const fin = await createAdmin(s, 'finance');
      for (const who of [c, w, sup, fin]) {
        expect(await send(s, who), JSON.stringify(who.authId)).toMatch(NOPE);
        await s.as('authenticated', who.authId);
        expect(await s.err('select public.admin_announcements_list()')).toMatch(NOPE);
      }
      await s.as('anon');
      expect(await s.err(`select public.admin_send_announcement('x','y','all')`)).toMatch(NOPE);
    }));

  it('nobody can read or change the table directly', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'super_admin');
      const c = await createCustomer(s);
      for (const who of [a, c]) {
        await s.as('authenticated', who.authId);
        expect(await s.err('select * from public.admin_announcements')).toMatch(/permission denied/i);
        expect(await s.err(`insert into public.admin_announcements (title, body, audience) values ('x','y','all')`)).toMatch(/permission denied/i);
      }
    }));
});

describe('the words and the double tap', () => {
  it('needs a title, a message of a sensible length, and a known audience', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'marketing');
      expect(await send(s, a, '   ', 'hello')).toMatch(/title/i);
      expect(await send(s, a, 'x'.repeat(81), 'hello')).toMatch(/title/i);
      expect(await send(s, a, 'Hello', '  ')).toMatch(/message/i);
      expect(await send(s, a, 'Hello', 'y'.repeat(501))).toMatch(/message/i);
      expect(await send(s, a, 'Hello', 'hello', 'staff')).toMatch(/who gets it/i);
      expect(await send(s, a, 'x'.repeat(80), 'y'.repeat(500))).toBeNull();
    }));

  it('refuses the same words twice in two minutes, but different words are fine', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'marketing');
      await createCustomer(s);
      expect(await send(s, a)).toBeNull();
      expect(await send(s, a)).toMatch(/just sent/i);
      expect(await send(s, a, 'Another note', 'Something else entirely.')).toBeNull();
    }));
});
