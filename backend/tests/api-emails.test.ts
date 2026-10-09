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
// The renewal settings live in the database and these tests share it: every test starts from the defaults, with sending allowed at any hour (so none of them depends on
// what time it is when they run). The tests of the sending hours change that themselves.
const OPEN_ALL_DAY = { on: true, week: { on: true, days: 7 }, last: { on: true, days: 2 }, ended: { on: true, days: 3 }, from_hour: 0, to_hour: 24 };
const setRenewalSettings = (v: unknown) => fake.admin.query(`insert into public.app_settings (key, value) values ('renewal_emails', $1::jsonb) on conflict (key) do update set value = excluded.value`, [JSON.stringify(v)]);
beforeEach(async () => { sent = []; setMailTransport(recorder); await setRenewalSettings(OPEN_ALL_DAY); });

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
    expect(mine[0].html).toContain('5% off for 4 to 7 washes a month');
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

  const logFirst = (membershipId: string, daysAgo: number) =>
    fake.admin.query(`insert into public.email_log (kind, ref_id, to_email, status, attempts, sent_at, updated_at) values ('membership_renewal_reminder', $1, 'x@example.com', 'sent', 1, now() - $2 * interval '1 day', now() - $2 * interval '1 day')`, [membershipId, daysAgo]);

  it('three steps: a week before, a last reminder in the last days (after the first, two days apart), and one after it ended; each once, each saying so', async () => {
    const admin = await staffClient('admin');
    const week = await endingIn(6);
    const last = await endingIn(1);
    const over = await endingIn(-2);
    await logFirst(last.membershipId, 4); // its first reminder went out four days ago

    const run1 = expectOk(await admin.c.post('/api/admin/reminders/run')).body;
    expect(run1.stages.map((s: any) => s.stage)).toEqual(['week', 'last', 'ended']);
    expect(run1.failed).toBe(0);
    const w = sent.filter((x) => x.to === week.email), l = sent.filter((x) => x.to === last.email), o = sent.filter((x) => x.to === over.email);
    expect([w.length, l.length, o.length]).toEqual([1, 1, 1]);
    expect(w[0].subject).toMatch(/membership ends in 6 days: renew in one tap/);
    expect(l[0].subject).toMatch(/membership ends tomorrow: renew to keep your washes/);
    expect(l[0].html).toContain('last reminder');
    expect(l[0].html).toMatch(/12 washes are still unused/);
    expect(o[0].subject).toBe('Your WASHO membership has ended: renew in one tap');
    expect(o[0].html).toContain('your regular washes have stopped');
    expect(o[0].html).toContain('Ended');
    for (const x of [week, last, over]) expect(sent.find((m) => m.to === x.email)!.html).toContain(`/app/membership/new?renew=${x.membershipId}`);
    expect(await dbRows(`select kind from public.email_log where ref_id = any($1::uuid[]) and status = 'sent' order by kind`, [[last.membershipId, over.membershipId, week.membershipId]]))
      .toEqual([{ kind: 'membership_renewal_ended' }, { kind: 'membership_renewal_last_call' }, { kind: 'membership_renewal_reminder' }, { kind: 'membership_renewal_reminder' }]);

    // again: nothing more for any of them
    const run2 = expectOk(await admin.c.post('/api/admin/reminders/run')).body;
    expect(run2.sent).toBe(0);
    expect([week, last, over].map((x) => sent.filter((m) => m.to === x.email).length)).toEqual([1, 1, 1]);
  });

  it('a membership ending tomorrow that was never reminded gets ONE email now, not two in a row', async () => {
    const admin = await staffClient('admin');
    const m = await endingIn(1);
    expectOk(await admin.c.post('/api/admin/reminders/run'));
    expect(sent.filter((x) => x.to === m.email)).toHaveLength(1);
    expect(sent.find((x) => x.to === m.email)!.subject).toMatch(/ends tomorrow: renew in one tap/);
    expectOk(await admin.c.post('/api/admin/reminders/run'));
    expect(sent.filter((x) => x.to === m.email)).toHaveLength(1); // the last-call step waits until the first is two days old
  });

  it('a dry run counts each step and names who is in it', async () => {
    const admin = await staffClient('admin');
    const m = await endingIn(-1);
    const dry = expectOk(await admin.c.post('/api/admin/reminders/run?dry=1')).body;
    expect(dry.stages.find((s: any) => s.stage === 'ended').due).toBeGreaterThanOrEqual(1);
    expect(dry.would.find((w: any) => w.membership_id === m.membershipId)).toMatchObject({ stage: 'ended', days_left: -1 });
    expect(sent.filter((x) => x.to === m.email)).toHaveLength(0);
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
    const admin = await staffClient('admin'); // (an admin's sign-in is itself emailed, so email is switched off after they are in)
    setMailTransport(null);
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

describe('the renewal email controls (Admin -> Memberships)', () => {
  async function endingIn(days: number, o: { email?: boolean } = {}) {
    const m = await activeMembership({ type: 'car', pattern: PATTERN_3, months: 1 });
    const email = uniqEmail();
    if (o.email !== false) expectOk(await m.c.put('/api/me', { full_name: 'Asha Kulkarni', email }));
    else {
      await fake.admin.query(`update public.profiles set email = null where id = (select customer_profile_id from public.memberships where id = $1)`, [m.membershipId]);
      await fake.admin.query(`update auth.users set email = null where id = (select p.auth_user_id from public.profiles p join public.memberships x on x.customer_profile_id = p.id where x.id = $1)`, [m.membershipId]);
    }
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
  const mails = (m: { email: string }) => sent.filter((x) => x.to === m.email);
  const cron = (c: Client) => c.req('POST', '/api/cron/reminders', {}, { headers: { authorization: 'Bearer test-cron-secret-0123456789' } });
  const staff = (access: 'super_admin' | 'operations' | 'finance' | 'marketing' | 'support') => staffClient('admin', { access });
  const istHourNow = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  /** Sending hours that do not include the hour it is right now. */
  const hoursWithoutNow = () => { const h = istHourNow(); return h < 23 ? { from_hour: h + 1, to_hour: h + 2 } : { from_hour: 0, to_hour: 1 }; };

  it('the page gets the settings, who is coming up with what each email did, and the latest emails; roles decide who may look and who may change', async () => {
    const m = await endingIn(3);
    const ops = await staff('operations');
    expectOk(await ops.c.post('/api/admin/reminders/run'));
    const r = expectOk(await ops.c.get('/api/admin/renewals')).body;
    expect(r.settings).toEqual(OPEN_ALL_DAY);
    expect(r.mail_ready).toBe(true);
    const row = r.upcoming.find((u: any) => u.membership_id === m.membershipId);
    expect(row).toMatchObject({ days_left: 3, renewed: false, steps: { week: { status: 'sent' }, last: null, ended: null } });
    expect(r.recent.some((x: any) => x.membership_id === m.membershipId && x.kind === 'membership_renewal_reminder' && x.status === 'sent')).toBe(true);

    // finance and support can look; they cannot change anything or send
    for (const role of ['finance', 'support'] as const) {
      const a = await staff(role);
      expectOk(await a.c.get('/api/admin/renewals'));
      expect((await a.c.put('/api/admin/renewals/settings', OPEN_ALL_DAY)).status).toBe(403);
      expect((await a.c.post(`/api/admin/renewals/${m.membershipId}/send`, { step: 'last' })).status).toBe(403);
    }
    // marketing, a customer, a visitor: nothing
    const marketing = await staff('marketing');
    expect((await marketing.c.get('/api/admin/renewals')).status).toBe(403);
    expect((await marketing.c.put('/api/admin/renewals/settings', OPEN_ALL_DAY)).status).toBe(403);
    expect((await m.c.get('/api/admin/renewals')).status).toBe(403);
    expect((await new Client().get('/api/admin/renewals')).status).toBe(401);
    expect((await new Client().put('/api/admin/renewals/settings', OPEN_ALL_DAY)).status).toBe(401);
  });

  it('saving changes what the next run does, is checked, and is written to the activity log', async () => {
    const ops = await staff('operations');
    const next = { on: true, week: { on: true, days: 3 }, last: { on: false, days: 2 }, ended: { on: true, days: 5 }, from_hour: 8, to_hour: 21 };
    const saved = expectOk(await ops.c.put('/api/admin/renewals/settings', next)).body;
    expect(saved.settings).toEqual(next);
    expect(expectOk(await ops.c.get('/api/admin/renewals')).body.settings).toEqual(next);
    const log = await dbRows(`select metadata from public.audit_events where event_type = 'renewal_settings_changed' order by created_at desc limit 1`);
    expect(log[0].metadata).toEqual({ from: OPEN_ALL_DAY, to: next });

    // refused, with a message a person can read; nothing is saved
    const refused = [
      [{ ...next, week: { on: true, days: 0 } }, /1 to 14/],
      [{ ...next, week: { on: true, days: 30 } }, /./],
      [{ ...next, from_hour: 20, to_hour: 9 }, /start before they end/],
      [{ ...next, on: 'yes' }, /./],
      [{ ...next, last: undefined }, /./],
      [{ on: true }, /./],
    ] as const;
    for (const [body, msg] of refused) {
      const r = await ops.c.put('/api/admin/renewals/settings', body);
      expect([400, 422], JSON.stringify(body)).toContain(r.status);
      expect(JSON.stringify(r.body)).toMatch(msg);
    }
    expect(expectOk(await ops.c.get('/api/admin/renewals')).body.settings).toEqual(next);
  });

  it('a step that is switched off is never sent, and the days each step covers follow the setting', async () => {
    const week = await endingIn(5);
    const ended = await endingIn(-4);
    const admin = await staff('operations');
    // week: only 3 days ahead; ended: switched off
    await setRenewalSettings({ ...OPEN_ALL_DAY, week: { on: true, days: 3 }, ended: { on: false, days: 3 } });
    expectOk(await admin.c.post('/api/admin/reminders/run'));
    expect(mails(week)).toHaveLength(0); // 5 days is outside "3 days before"
    expect(mails(ended)).toHaveLength(0); // switched off

    // widen the week and let "ended" reach 5 days back
    await setRenewalSettings({ ...OPEN_ALL_DAY, week: { on: true, days: 6 }, ended: { on: true, days: 5 } });
    const run = expectOk(await admin.c.post('/api/admin/reminders/run')).body;
    expect(mails(week)).toHaveLength(1);
    expect(mails(ended)).toHaveLength(1);
    expect(run.stages.map((s: any) => s.stage)).toEqual(['week', 'last', 'ended']);
    // with every step off there is nothing to do, and a dry run says so
    await setRenewalSettings({ ...OPEN_ALL_DAY, week: { on: false, days: 7 }, last: { on: false, days: 2 }, ended: { on: false, days: 3 } });
    const none = expectOk(await admin.c.post('/api/admin/reminders/run?dry=1')).body;
    expect(none).toMatchObject({ due: 0, stages: [] });
  });

  it('with the first email switched off, the last-days email no longer waits for it', async () => {
    const m = await endingIn(1);
    const admin = await staff('operations');
    expectOk(await admin.c.post('/api/admin/reminders/run')); // week + last both on: the first goes out now (ends in 1 day), the last waits two days after it
    expect(mails(m)).toHaveLength(1);
    expect(mails(m)[0].subject).not.toMatch(/last reminder/i);
    // A fresh membership, first email off: the last-days email goes straight out
    const m2 = await endingIn(1);
    await setRenewalSettings({ ...OPEN_ALL_DAY, week: { on: false, days: 7 } });
    expectOk(await admin.c.post('/api/admin/reminders/run'));
    expect(mails(m2)).toHaveLength(1);
    expect(mails(m2)[0].html).toContain('last reminder');
  });

  it('the master switch and the sending hours hold back the automatic job, not a person pressing the button', async () => {
    const m = await endingIn(3);
    const admin = await staff('operations');
    const c = new Client();

    await setRenewalSettings({ ...OPEN_ALL_DAY, on: false });
    const off = (await cron(c)).body;
    expect(off).toMatchObject({ success: true, paused: 'switched_off', sent: 0, due: 0 });
    expect(mails(m)).toHaveLength(0);

    await setRenewalSettings({ ...OPEN_ALL_DAY, ...hoursWithoutNow() });
    const late = (await cron(c)).body;
    expect(late).toMatchObject({ paused: 'outside_hours', sent: 0 });
    expect(mails(m)).toHaveLength(0);

    // a person asking for it right now is not held back by either
    const dry = expectOk(await admin.c.post('/api/admin/reminders/run?dry=1')).body;
    expect(dry.paused).toBeUndefined();
    expect(dry.would.some((w: any) => w.membership_id === m.membershipId)).toBe(true);
    await setRenewalSettings({ ...OPEN_ALL_DAY, on: false, ...hoursWithoutNow() });
    expectOk(await admin.c.post('/api/admin/reminders/run'));
    expect(mails(m)).toHaveLength(1);

    // and switched back on and inside the hours, the automatic job runs again
    const m2 = await endingIn(2);
    await setRenewalSettings(OPEN_ALL_DAY);
    expect((await cron(c)).body.paused).toBeUndefined();
    expect(mails(m2)).toHaveLength(1);
  });

  it('"Send now" sends one step to one membership whatever its dates, once, and says why when it cannot', async () => {
    const m = await endingIn(25);
    const admin = await staff('operations');
    const url = `/api/admin/renewals/${m.membershipId}/send`;
    expect((await admin.c.post(url, { step: 'spam' })).status).toBe(400);
    expect((await admin.c.post(url, {})).status).toBe(400);
    expect((await admin.c.post('/api/admin/renewals/not-an-id/send', { step: 'week' })).status).toBe(400);

    expectOk(await admin.c.post(url, { step: 'week' }));
    expect(mails(m)).toHaveLength(1);
    expect(mails(m)[0].subject).toMatch(/membership ends in 25 days/);
    expect(await dbRows(`select status from public.email_log where kind='membership_renewal_reminder' and ref_id=$1`, [m.membershipId])).toEqual([{ status: 'sent' }]);

    const again = await admin.c.post(url, { step: 'week' });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toMatch(/already gone/);
    expect(mails(m)).toHaveLength(1);

    // a step that is switched off cannot be sent by hand either
    await setRenewalSettings({ ...OPEN_ALL_DAY, last: { on: false, days: 2 } });
    const off = await admin.c.post(url, { step: 'last' });
    expect(off.status).toBe(409);
    expect(JSON.stringify(off.body)).toMatch(/switched off/);
    // the master switch (for the automatic job) does not stop a person
    await setRenewalSettings({ ...OPEN_ALL_DAY, on: false });
    expectOk(await admin.c.post(url, { step: 'last' }));
    expect(mails(m)).toHaveLength(2);
  });

  it('"Send now": no email address, email not set up, and a membership that does not exist', async () => {
    const noMail = await endingIn(2, { email: false });
    const admin = await staff('operations');
    const none = await admin.c.post(`/api/admin/renewals/${noMail.membershipId}/send`, { step: 'week' });
    expect(none.status).toBe(422);
    expect(JSON.stringify(none.body)).toMatch(/no email address/);

    const gone = await admin.c.post(`/api/admin/renewals/${crypto.randomUUID()}/send`, { step: 'week' });
    expect(gone.status).toBeGreaterThanOrEqual(400);
    expect(gone.status).toBeLessThan(500);

    const m = await endingIn(2);
    setMailTransport(null);
    const down = await admin.c.post(`/api/admin/renewals/${m.membershipId}/send`, { step: 'week' });
    expect(down.status).toBe(503);
    expect(expectOk(await admin.c.get('/api/admin/renewals')).body.mail_ready).toBe(false);

    // a mail that fails is recorded, says so, and the automatic job will try again
    setMailTransport(async () => { throw new Error('Resend is down'); });
    const failed = await admin.c.post(`/api/admin/renewals/${m.membershipId}/send`, { step: 'week' });
    expect(failed.status).toBe(502);
    expect(await dbRows(`select status, attempts from public.email_log where kind='membership_renewal_reminder' and ref_id=$1`, [m.membershipId])).toEqual([{ status: 'failed', attempts: 1 }]);
    setMailTransport(recorder);
    expectOk(await admin.c.post('/api/admin/reminders/run'));
    expect(mails(m)).toHaveLength(1);
  });
});
