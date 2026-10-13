/**
 * The master search at the top of the admin page: one box, the few best matches in each part of the console, only the parts the admin's role may look at. Also: a customer
 * never sees the name of the admin who answered their complaint (they see "Agent").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, activeMembership, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

const search = (c: Client, q: string) => c.get(`/api/admin/search?q=${encodeURIComponent(q)}`);
const svc = async () => (await fake.admin.query(`select id from public.services where code = 'car-body-wash'`)).rows[0].id as string;

/** A customer with a name nobody else has, one wash booked by WASHO and one complaint. */
async function someone() {
  const admin = await staffClient('admin');
  const cust = await customerWithVehicle('car');
  const unique = `Quokka${Math.floor(Math.random() * 1e6)}`;
  expectOk(await cust.c.put('/api/me', { full_name: `Zed ${unique}`, email: 'asha@example.com' }));
  const me = expectOk(await cust.c.get('/api/me')).body.user;
  const wash = expectOk(await admin.c.post('/api/admin/bookings', { customer_id: me.id, vehicle_id: cust.vehicle.id, service_id: await svc(), date: istDate(9), time_slot: 'morning', payment: 'cash' })).body.booking_id as string;
  const ticket = expectOk(await cust.c.post('/api/support', { category: 'booking', subject: `Missed wash ${unique}`, message: 'Nobody came at all today' })).body.ticket as { id: string; reference_code: string };
  const ref = (await fake.admin.query(`select reference_code from public.bookings where id = $1`, [wash])).rows[0].reference_code as string;
  return { admin, cust, unique, me, wash, ticket, ref };
}

describe('what the search finds', () => {
  it('a customer by name (any case, part of it), mobile number however it is spaced, and number plate however it is spaced', async () => {
    const t = await someone();
    const ids = (r: any) => r.body.customers.map((c: any) => c.id);
    expect(ids(expectOk(await search(t.admin.c, t.unique.toLowerCase())))).toContain(t.me.id);
    expect(ids(expectOk(await search(t.admin.c, t.unique.slice(0, 7))))).toContain(t.me.id);
    const digits = t.cust.phone as string;
    expect(ids(expectOk(await search(t.admin.c, digits)))).toContain(t.me.id);
    expect(ids(expectOk(await search(t.admin.c, `${digits.slice(0, 5)} ${digits.slice(5)}`)))).toContain(t.me.id);
    const spaced = `${t.cust.reg.slice(0, 4)} ${t.cust.reg.slice(4, 6)} ${t.cust.reg.slice(6)}`;
    const byPlate = expectOk(await search(t.admin.c, spaced.toLowerCase())).body;
    expect(ids({ body: byPlate })).toContain(t.me.id);
    expect(byPlate.washes.some((w: any) => w.id === t.wash)).toBe(true);
    const row = byPlate.customers.find((c: any) => c.id === t.me.id);
    expect(row.plates).toContain(t.cust.reg);
  });

  it('a wash by its reference, a complaint by its reference or title', async () => {
    const t = await someone();
    const byRef = expectOk(await search(t.admin.c, t.ref)).body;
    expect(byRef.washes.map((w: any) => w.id)).toEqual([t.wash]);
    expect(byRef.washes[0]).toMatchObject({ reference_code: t.ref, service_name: 'Car Body Wash', payment_kind: 'paid', status: 'confirmed' });
    const byTicket = expectOk(await search(t.admin.c, t.ticket.reference_code)).body;
    expect(byTicket.tickets.map((x: any) => x.id)).toEqual([t.ticket.id]);
    const byTitle = expectOk(await search(t.admin.c, `missed wash ${t.unique}`)).body;
    expect(byTitle.tickets.map((x: any) => x.id)).toContain(t.ticket.id);
    expect(byTitle.tickets[0]).toMatchObject({ reference_code: t.ticket.reference_code, status: 'open' });
  });

  it('a membership by its customer and its reference', async () => {
    const admin = await staffClient('admin');
    const m = await activeMembership({ admin: admin.c });
    const ref = (await fake.admin.query(`select r.reference_code from public.membership_requests r join public.memberships mm on mm.membership_request_id = r.id where mm.id = $1`, [m.membershipId])).rows[0].reference_code as string;
    const r = expectOk(await search(admin.c, ref)).body;
    expect(r.memberships.map((x: any) => x.id)).toEqual([m.membershipId]);
    expect(r.memberships[0]).toMatchObject({ status: 'active', reference_code: ref });
    expect(expectOk(await search(admin.c, m.reg)).body.memberships.map((x: any) => x.id)).toContain(m.membershipId);
  });

  it('a short search, a literal % or _, and nonsense find nothing; each group is capped', async () => {
    const t = await someone();
    const empty = { customers: [], washes: [], memberships: [], tickets: [] };
    for (const q of ['', ' ', 'a', '%', '_', 'no-such-person-anywhere-xyz']) expect(expectOk(await search(t.admin.c, q)).body, JSON.stringify(q)).toMatchObject(empty);
    expect(expectOk(await search(t.admin.c, 'Yashwin')).body.washes.length).toBeLessThanOrEqual(6);
    expect(expectOk(await search(t.admin.c, 'x'.repeat(200))).body).toMatchObject(empty);   // too long: no search
  });
});

describe('who may search', () => {
  it('only a signed-in admin with a role', async () => {
    const t = await someone();
    const worker = await staffClient('worker');
    for (const [who, label] of [[t.cust.c, 'customer'], [worker.c, 'worker'], [new Client(), 'nobody']] as const) expect((await search(who, t.unique)).status, label).toBeGreaterThanOrEqual(401);
  });

  it('each group only appears for a role that may look at that part of the console', async () => {
    const t = await someone();
    const sup = await staffClient('admin', { access: 'support' });
    const ops = await staffClient('admin', { access: 'operations' });
    const fin = await staffClient('admin', { access: 'finance' });
    const fromSupport = expectOk(await search(sup.c, t.unique)).body;
    expect(fromSupport.tickets.length).toBeGreaterThan(0);      // support answers complaints
    expect(fromSupport.customers.length).toBeGreaterThan(0);    // and may look at people and washes
    // operations has no Support area: complaints are never searched for it
    expect(expectOk(await search(ops.c, t.unique)).body.tickets).toEqual([]);
    // finance sees no people, washes, memberships or complaints through the search unless its role covers them: whatever it may not open, it is not shown
    const fromFinance = expectOk(await search(fin.c, t.unique)).body;
    expect(fromFinance.tickets).toEqual([]);
    for (const [group, area] of [['customers', 'people'], ['washes', 'bookings'], ['memberships', 'memberships']] as const) {
      const may = expectOk(await fin.c.get('/api/me')).body.user.admin?.areas?.[area];
      if (!may) expect(fromFinance[group], group).toEqual([]);
    }
  });
});

describe('what a customer sees of the admin who answered', () => {
  it('only "from_admin": the admin\'s name never reaches the customer', async () => {
    const t = await someone();
    const agent = await staffClient('admin', { access: 'support', name: 'Yash Rajguru' });
    expectOk(await agent.c.post(`/api/admin/support/${t.ticket.id}/reply`, { message: 'Sorry about that, we will sort it out today.' }));
    const seen = expectOk(await t.cust.c.get(`/api/support/${t.ticket.id}`)).body;
    const reply = seen.messages[seen.messages.length - 1];
    expect(reply).toMatchObject({ from_admin: true, body: 'Sorry about that, we will sort it out today.' });
    expect(Object.keys(reply).sort()).toEqual(['attachments', 'body', 'created_at', 'from_admin', 'id']);   // no author
    expect(JSON.stringify(seen)).not.toMatch(/Yash|Rajguru/);
    // the admin still sees who replied, for the team's own records
    const inAdmin = expectOk(await agent.c.get(`/api/admin/support/${t.ticket.id}`)).body;
    expect(inAdmin.messages[inAdmin.messages.length - 1].author).toBe('Yash Rajguru');
  });
});
