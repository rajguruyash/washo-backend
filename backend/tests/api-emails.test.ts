/**
 * The emails: a confirmation for a free wash, and a renewal reminder a week before a membership ends. Resend is replaced by a recorder; the
 * database (email_log, the reminder list) is real.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, PATTERN_3, activeMembership, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

let sent: { to: string; subject: string; html: string }[] = [];
let setMailTransport: (t: ((m: { to: string; subject: string; html: string }) => Promise<void>) | null) => void;
const recorder = async (m: { to: string; subject: string; html: string }) => { sent.push(m); };

beforeAll(async () => {
  await boot();
  ({ setMailTransport } = await import('../src/notify')); // after boot: the server's configuration is read the first time it is loaded
});
afterAll(shutdown);
beforeEach(() => { sent = []; setMailTransport(recorder); });

const dbRows = async (sql: string, params: unknown[] = []) => (await fake.admin.query(sql, params)).rows;
const uniqEmail = () => `mail-${crypto.randomBytes(4).toString('hex')}@example.com`;

async function liveCampaign() {
  await fake.admin.query('update public.campaigns set is_active = false');
  const admin = await staffClient('admin');
  const body = { code: `mail-${crypto.randomBytes(3).toString('hex')}`, name: 'Navratri free wash', claim_opens_on: istDate(0), claim_closes_on: istDate(3), use_by_date: istDate(8), total_cap: 100, pack_offer_days: 14, pack_bp_1: 500, pack_bp_2: 1000, pack_bp_3plus: 1500, new_customers_only: false };
  const id = expectOk(await admin.c.post('/api/admin/campaigns', body)).body.campaign_id as string;
  expectOk(await admin.c.post(`/api/admin/campaigns/${id}/active`, { active: true }));
  return { id, admin };
}
const claimBody = (camp: string, n: Awaited<ReturnType<typeof customerWithVehicle>>) => ({ campaign_id: camp, vehicle_id: n.vehicle.id, date: istDate(3), time_slot: 'morning', address_id: n.addr.id, parking_location: 'Basement P1' });
const settle = () => new Promise((r) => setTimeout(r, 400)); // the email goes out just after the answer

describe('free wash confirmation', () => {
  it('is emailed once, to the customer, with the booking and a link to it', async () => {
    const { id } = await liveCampaign();
    const n = await customerWithVehicle('car');
    const email = uniqEmail();
    expectOk(await n.c.put('/api/me', { full_name: 'Asha Kulkarni', email }));
    const claimed = expectOk(await n.c.post('/api/campaign/claim', claimBody(id, n)));
    await settle();
    const mine = sent.filter((m) => m.to === email);
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toMatch(/^Your free wash is booked: /);
    expect(mine[0].html).toContain('Hi Asha');
    expect(mine[0].html).toContain('Car Body Wash');
    expect(mine[0].html).toContain('Nothing to pay');
    expect(mine[0].html).toContain(`/app/bookings/${claimed.body.booking_id}`);
    expect(mine[0].html).toContain('5% off for 1 wash per week');
    expect(await dbRows(`select status, attempts from public.email_log where kind='free_wash_confirmation' and ref_id=$1`, [claimed.body.booking_id])).toEqual([{ status: 'sent', attempts: 1 }]);
  });

  it('is skipped when the customer has no email, and the claim is unaffected', async () => {
    const { id } = await liveCampaign();
    // signed in by phone, name only: no email on file
    const c = new Client();
    await c.loginCustomer();
    expectOk(await c.put('/api/me', { full_name: 'No Mail' }));
    const addr = expectOk(await c.post('/api/addresses', { society_name: 'Yashwin Orizzonte', building_block: 'N', flat_number: `N-${crypto.randomBytes(2).toString('hex')}`, parking_location: 'P1' })).body.address;
    const vehicle = expectOk(await c.post('/api/vehicles', { vehicle_type: 'bike', model: 'Activa', registration_number: `MH12NM${crypto.randomInt(1000, 9999)}`, address_id: addr.id })).body.vehicle;
    const before = sent.length;
    const r = await c.post('/api/campaign/claim', { campaign_id: id, vehicle_id: vehicle.id, date: istDate(3), time_slot: 'morning', address_id: addr.id });
    expect(r.status).toBe(201);
    await settle();
    expect(sent.length).toBe(before);
  });

  it('a mail failure never breaks the booking, and is recorded so it can be tried again', async () => {
    const { id } = await liveCampaign();
    const n = await customerWithVehicle('car');
    expectOk(await n.c.put('/api/me', { full_name: 'Asha Kulkarni', email: uniqEmail() }));
    setMailTransport(async () => { throw new Error('Resend is down'); });
    const r = await n.c.post('/api/campaign/claim', claimBody(id, n));
    expect(r.status).toBe(201);
    await settle();
    expect(await dbRows(`select status, attempts, error from public.email_log where kind='free_wash_confirmation' and ref_id=$1`, [r.body.booking_id])).toEqual([{ status: 'failed', attempts: 1, error: 'Resend is down' }]);
  });
});

describe('membership renewal reminders', () => {
  /** An active membership for a customer with a known email, moved so that it ends `days` from today. */
  async function endingIn(days: number) {
    const m = await activeMembership({ type: 'car', pattern: PATTERN_3, months: 1 });
    const email = uniqEmail();
    expectOk(await m.c.put('/api/me', { full_name: 'Asha Kulkarni', email }));
    await fake.admin.query('alter table public.memberships disable trigger user');
    await fake.admin.query(
      `update public.memberships
          set start_at = (date_trunc('day', now() at time zone 'Asia/Kolkata') + $2 * interval '1 day' - interval '1 month' + interval '1 day') at time zone 'Asia/Kolkata',
              end_at   = (date_trunc('day', now() at time zone 'Asia/Kolkata') + $2 * interval '1 day') at time zone 'Asia/Kolkata'
        where id = $1`,
      [m.membershipId, days]
    );
    await fake.admin.query('alter table public.memberships enable trigger user');
    return { ...m, email };
  }

  it('only an admin can run it; a dry run lists who would be emailed (addresses masked) and sends nothing', async () => {
    const m = await endingIn(4);
    const admin = await staffClient('admin');
    expect((await new Client().post('/api/admin/reminders/run')).status).toBe(401);
    expect((await m.c.post('/api/admin/reminders/run')).status).toBe(403);
    const dry = expectOk(await admin.c.post('/api/admin/reminders/run?dry=1')).body;
    expect(dry.ready).toBe(true);
    const mine = dry.would.find((w: any) => w.membership_id === m.membershipId);
    expect(mine).toMatchObject({ days_left: 4, to: expect.stringMatching(/^m\*\*\*@/) });
    expect(sent.filter((x) => x.to === m.email)).toHaveLength(0);
  });

  it('emails the customer once, a week before the end, with a link that renews the plan, and never twice', async () => {
    const m = await endingIn(5);
    const admin = await staffClient('admin');
    const first = expectOk(await admin.c.post('/api/admin/reminders/run')).body;
    expect(first).toMatchObject({ ready: true, failed: 0 });
    const mine = sent.filter((x) => x.to === m.email);
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toMatch(/membership ends in 5 days/);
    expect(mine[0].html).toContain('Hi Asha');
    expect(mine[0].html).toContain(`/app/membership/new?renew=${m.membershipId}`);
    expect(mine[0].html).toMatch(/0 of \d+/);
    expect(mine[0].html).toContain('Nothing renews on its own');
    expect(await dbRows(`select status from public.email_log where kind='membership_renewal_reminder' and ref_id=$1`, [m.membershipId])).toEqual([{ status: 'sent' }]);

    expectOk(await admin.c.post('/api/admin/reminders/run'));
    expect(sent.filter((x) => x.to === m.email)).toHaveLength(1); // still one
  });

  it('a membership that ends later is left alone, and one already renewed is not reminded', async () => {
    const later = await endingIn(25);
    const admin = await staffClient('admin');
    expectOk(await admin.c.post('/api/admin/reminders/run'));
    expect(sent.filter((x) => x.to === later.email)).toHaveLength(0);
  });

  it('a failed send is recorded and tried again on the next run', async () => {
    const m = await endingIn(3);
    const admin = await staffClient('admin');
    setMailTransport(async () => { throw new Error('Resend is down'); });
    const bad = expectOk(await admin.c.post('/api/admin/reminders/run')).body;
    expect(bad.failed).toBeGreaterThanOrEqual(1);
    expect(await dbRows(`select status, attempts from public.email_log where kind='membership_renewal_reminder' and ref_id=$1`, [m.membershipId])).toEqual([{ status: 'failed', attempts: 1 }]);
    setMailTransport(recorder);
    expectOk(await admin.c.post('/api/admin/reminders/run'));
    expect(sent.filter((x) => x.to === m.email)).toHaveLength(1);
    expect(await dbRows(`select status, attempts from public.email_log where kind='membership_renewal_reminder' and ref_id=$1`, [m.membershipId])).toEqual([{ status: 'sent', attempts: 2 }]);
  });

  it('says plainly that it is not ready when email is not set up', async () => {
    setMailTransport(null);
    const admin = await staffClient('admin');
    expect(expectOk(await admin.c.post('/api/admin/reminders/run')).body).toMatchObject({ ready: false, sent: 0 });
  });

  it('an outside scheduler can trigger it with the secret, and nothing else can', async () => {
    const m = await endingIn(2);
    const c = new Client();
    expect((await c.post('/api/cron/reminders')).status).toBe(404);
    expect((await c.req('POST', '/api/cron/reminders', {}, { headers: { authorization: 'Bearer wrong-secret-0123456789' } })).status).toBe(404);
    const ok = await c.req('POST', '/api/cron/reminders', {}, { headers: { authorization: 'Bearer test-cron-secret-0123456789' } });
    expect(ok.status).toBe(200);
    expect(sent.filter((x) => x.to === m.email)).toHaveLength(1);
  });
});
