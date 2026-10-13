/**
 * GREEN tests for 20261004000041_support_pictures.sql: an admin with the support role adds pictures (up to 4) to a reply; the customer sees them on their own complaint
 * only once the reply is sent; nobody else can add or see them.
 */
import { describe, expect, it } from 'vitest';
import { createAdmin, createCustomer, createWorker, inTx, uid } from './helpers';

const NOPE = /access|permission denied|Unauthorized/i;

async function setup(s: any, o: { role?: 'support' | 'operations' | 'finance' | 'super_admin' } = {}) {
  const c = await createCustomer(s);
  const a = await createAdmin(s, o.role ?? 'support');
  await s.as('authenticated', c.authId);
  const t = (await s.q(`select public.create_support_ticket('booking','Wash was not done','The specialist did not come at all today') t`))[0].t as { id: string };
  return { c, a, id: t.id };
}
const pathFor = (id: string, n = 1) => `${id}/support-${Date.now()}-${n}-${uid().slice(0, 4)}.jpg`;
const add = async (s: any, who: { authId: string }, id: string, path = pathFor(id), type = 'image/jpeg', bytes = 1234): Promise<string> => {
  await s.as('authenticated', who.authId);
  await s.c.query('SAVEPOINT add_picture');
  try {
    const r = await s.q(`select public.admin_support_add_attachment($1,$2,$3,$4) id`, [id, path, type, bytes]);
    await s.c.query('RELEASE SAVEPOINT add_picture');
    return r[0].id as string;
  } catch (e) {
    await s.c.query('ROLLBACK TO SAVEPOINT add_picture');
    return (e as Error).message;
  }
};
const reply = (s: any, who: { authId: string }, id: string, ids: string[], message = 'Here is what we found', status: string | null = null) =>
  (async () => { await s.as('authenticated', who.authId); return s.err(`select public.admin_support_reply_with_pictures($1,$2,$3,$4::uuid[])`, [id, message, status, ids]); })();
const customerView = async (s: any, who: { authId: string }, id: string) => { await s.as('authenticated', who.authId); return (await s.q('select public.my_support_ticket($1) r', [id]))[0].r; };
const adminView = async (s: any, who: { authId: string }, id: string) => { await s.as('authenticated', who.authId); return (await s.q('select public.admin_support_get($1) r', [id]))[0].r; };

describe('adding a picture', () => {
  it('the support role can; the path must be inside the complaint\'s own folder and start with support-', async () =>
    inTx(async (s) => {
      const { a, id } = await setup(s);
      expect(await add(s, a, id)).toMatch(/^[0-9a-f-]{36}$/);
      expect(await add(s, a, id, `${uid()}/support-x.jpg`)).toMatch(/not a valid picture/);       // another folder (a wash photo's, say)
      expect(await add(s, a, id, `${id}/before-front-1.jpg`)).toMatch(/not a valid picture/);     // not a support picture
      expect(await add(s, a, id, `${id}/support-../../x.jpg`)).toMatch(/not a valid picture/);
      expect(await add(s, a, id, `${id}/support-x.jpg`.padEnd(260, 'a'))).toMatch(/not a valid picture/);
    }));

  it('only an image type and a sensible size are accepted', async () =>
    inTx(async (s) => {
      const { a, id } = await setup(s);
      expect(await add(s, a, id, pathFor(id, 2), 'application/pdf')).toMatch(/content_type_check|violates check/);
      expect(await add(s, a, id, pathFor(id, 3), 'image/png', 0)).toMatch(/bytes_check|violates check/);
      expect(await add(s, a, id, pathFor(id, 4), 'image/webp', 20_000_000)).toMatch(/^[0-9a-f-]{36}$/);
    }));

  it('the customer, a specialist, a finance or operations admin and a signed-out caller cannot', async () =>
    inTx(async (s) => {
      const { c, id } = await setup(s);
      const w = await createWorker(s);
      const fin = await createAdmin(s, 'finance');
      const ops = await createAdmin(s, 'operations');
      for (const who of [c, w, fin, ops]) expect(await add(s, who, id), JSON.stringify(who.authId)).toMatch(NOPE);
      await s.as('anon');
      expect(await s.err(`select public.admin_support_add_attachment('${id}','${pathFor(id)}','image/jpeg',10)`)).toMatch(/permission denied/);
    }));

  it('a super admin can too; a missing or closed complaint is refused', async () =>
    inTx(async (s) => {
      const { a, id } = await setup(s, { role: 'super_admin' });
      expect(await add(s, a, id)).toMatch(/^[0-9a-f-]{36}$/);
      expect(await add(s, a, uid())).toMatch(/Complaint not found/);
      await s.as('authenticated', a.authId);
      await s.q(`select public.admin_support_set_status($1,'closed')`, [id]);
      expect(await add(s, a, id)).toMatch(/closed/);
    }));

  it('at most 8 unsent pictures at once, and 40 on a complaint', async () =>
    inTx(async (s) => {
      const { a, id } = await setup(s);
      for (let i = 0; i < 8; i++) expect(await add(s, a, id, pathFor(id, i))).toMatch(/^[0-9a-f-]{36}$/);
      expect(await add(s, a, id, pathFor(id, 9))).toMatch(/Send your reply before adding more pictures/);
      await s.as('postgres');
      await s.q(`update public.support_attachments set message_id = (select id from public.support_messages where ticket_id = $1 limit 1) where ticket_id = $1`, [id]);
      for (let i = 0; i < 32; i++) await s.q(`insert into public.support_attachments (ticket_id, message_id, uploaded_by, from_admin, storage_path, content_type, bytes) select $1, message_id, uploaded_by, true, $2, 'image/jpeg', 5 from public.support_attachments where ticket_id = $1 limit 1`, [id, `${id}/support-bulk-${i}.jpg`]);
      expect(await add(s, a, id, pathFor(id, 10))).toMatch(/as many pictures as it can hold/);
    }));
});

describe('sending a reply with pictures', () => {
  it('the customer sees the pictures with that reply, and only after it is sent', async () =>
    inTx(async (s) => {
      const { c, a, id } = await setup(s);
      const p1 = await add(s, a, id, pathFor(id, 1));
      const p2 = await add(s, a, id, pathFor(id, 2), 'image/png');
      // staged, not sent: the customer sees nothing, the admin's thread shows no pictures either
      expect((await customerView(s, c, id)).messages.every((m: any) => m.attachments.length === 0)).toBe(true);
      expect((await adminView(s, a, id)).messages.every((m: any) => m.attachments.length === 0)).toBe(true);

      expect(await reply(s, a, id, [p1, p2], 'We have looked at it', 'resolved')).toBeNull();
      const mine = await customerView(s, c, id);
      const last = mine.messages[mine.messages.length - 1];
      expect(last).toMatchObject({ from_admin: true, body: 'We have looked at it' });
            expect(new Set(last.attachments.map((x: any) => x.id))).toEqual(new Set([p1, p2]));
      expect(last.attachments.every((x: any) => x.storage_path.startsWith(`${id}/support-`))).toBe(true);
      expect(mine.messages[0].attachments).toEqual([]);                                  // their own first message has none
      const admins = await adminView(s, a, id);
      expect(admins.messages[admins.messages.length - 1].attachments).toHaveLength(2);
      await s.as('postgres');
      expect((await s.q(`select status from public.support_tickets where id = $1`, [id]))[0].status).toBe('resolved');
      expect((await s.q(`select count(*)::int n from public.audit_events where event_type = 'support_pictures_sent' and entity_id = $1`, [id]))[0].n).toBe(1);
    }));

  it('a reply with no pictures works as it always did', async () =>
    inTx(async (s) => {
      const { c, a, id } = await setup(s);
      expect(await reply(s, a, id, [])).toBeNull();
      const m = (await customerView(s, c, id)).messages;
      expect(m[m.length - 1]).toMatchObject({ from_admin: true, attachments: [] });
    }));

  it('at most 4 pictures to one reply; the same picture twice counts once', async () =>
    inTx(async (s) => {
      const { a, id } = await setup(s);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await add(s, a, id, pathFor(id, i)));
      expect(await reply(s, a, id, ids)).toMatch(/up to 4 pictures/);
      expect(await reply(s, a, id, [ids[0], ids[0], ids[1]])).toBeNull();
    }));

  it('all or nothing: another admin\'s picture, another complaint\'s picture, a sent picture or a made-up one stops the whole reply', async () =>
    inTx(async (s) => {
      const one = await setup(s);
      const two = await setup(s);
      const other = await createAdmin(s, 'support');
      const mine = await add(s, one.a, one.id, pathFor(one.id, 1));
      const theirs = await add(s, other, one.id, pathFor(one.id, 2));
      const elsewhere = await add(s, two.a, two.id, pathFor(two.id, 3));
      for (const bad of [theirs, elsewhere, uid()]) {
        expect(await reply(s, one.a, one.id, [mine, bad], 'This should not be sent')).toMatch(/could not be found/);
      }
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.support_messages where ticket_id = $1 and from_admin`, [one.id]))[0].n).toBe(0);   // no reply was left behind
      expect((await s.q(`select count(*)::int n from public.support_attachments where message_id is not null and ticket_id = $1`, [one.id]))[0].n).toBe(0);
      expect(await reply(s, one.a, one.id, [mine], 'Now it is fine')).toBeNull();
      expect(await reply(s, one.a, one.id, [mine], 'Again')).toMatch(/could not be found/);   // already sent
    }));

  it('a closed complaint cannot be replied to', async () =>
    inTx(async (s) => {
      const { a, id } = await setup(s);
      const p = await add(s, a, id);
      await s.as('authenticated', a.authId);
      await s.q(`select public.admin_support_set_status($1,'closed')`, [id]);
      expect(await reply(s, a, id, [p])).toMatch(/closed/);
    }));

  it('only the support role may send it', async () =>
    inTx(async (s) => {
      const { c, a, id } = await setup(s);
      const p = await add(s, a, id);
      const fin = await createAdmin(s, 'finance');
      expect(await reply(s, c, id, [p])).toMatch(NOPE);
      expect(await reply(s, fin, id, [p])).toMatch(NOPE);
    }));
});

describe('who can see them', () => {
  it('a customer sees only their own complaint\'s pictures, and nobody else can open it', async () =>
    inTx(async (s) => {
      const one = await setup(s);
      const two = await setup(s);
      const p = await add(s, one.a, one.id);
      await reply(s, one.a, one.id, [p]);
      await s.as('authenticated', two.c.authId);
      expect(await s.err(`select public.my_support_ticket('${one.id}')`)).toMatch(/Complaint not found/);
      const w = await createWorker(s);
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.my_support_ticket('${one.id}')`)).toMatch(/customer access required|Unauthorized/);
      expect(await s.err(`select public.admin_support_get('${one.id}')`)).toMatch(NOPE);
      // the table itself is closed to everyone but the database's own functions
      for (const who of [two.c, w]) { await s.as('authenticated', who.authId); expect(await s.err(`select * from public.support_attachments`)).toMatch(/permission denied/); }
      await s.as('anon');
      expect(await s.err(`select * from public.support_attachments`)).toMatch(/permission denied/);
    }));

  it('a finance admin cannot read a complaint, so cannot see its pictures; a support admin can', async () =>
    inTx(async (s) => {
      const { a, id } = await setup(s);
      const p = await add(s, a, id);
      await reply(s, a, id, [p]);
      const fin = await createAdmin(s, 'finance');
      await s.as('authenticated', fin.authId);
      expect(await s.err(`select public.admin_support_get('${id}')`)).toMatch(NOPE);
      expect((await adminView(s, a, id)).messages.some((m: any) => m.attachments.length === 1)).toBe(true);
    }));
});
