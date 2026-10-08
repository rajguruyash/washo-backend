/**
 * GREEN tests for 20261004000027_admin_roles_support_settings.sql: admin roles, the team, app settings, safe refunds, complaints, the activity log,
 * the dashboard numbers and data export.
 */
import { describe, expect, it } from 'vitest';
import { createAddress, createAdmin, createAuthUser, createCustomer, createVehicle, createWorker, inTx, istDate, serviceId, uid, type AdminAccess } from './helpers';

const ROLES: AdminAccess[] = ['super_admin', 'operations', 'finance', 'marketing', 'support'];
const as = async (s: any, u: { authId: string }) => s.as('authenticated', u.authId);
const call = async (s: any, who: { authId: string }, sql: string) => { await as(s, who); return s.err(sql); };
const denied = /your admin role cannot do this|admin access required|permission denied/i;

async function paidWash(s: any, code = 'car-body-wash') {
  const u = await createCustomer(s);
  const veh = await createVehicle(s, u.profileId, 'car');
  const date = await istDate(s, 4);
  const svc = await serviceId(s, code);
  await s.as('authenticated', u.authId);
  const intent = (await s.q(`select public.create_booking_payment_intent($1,$2,$3::date,'morning',null,'P1',null,'website') i`, [veh, svc, date]))[0].i;
  await s.as('service_role');
  const order = `order_${uid().slice(0, 8)}`;
  await s.q('select app_private.attach_provider_order($1,$2)', [intent.payment_id, order]);
  const r = (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured') r`, [order, `pay_${uid().slice(0, 8)}`, intent.amount_cents]))[0].r;
  await s.as('postgres');
  return { u, veh, bookingId: r.booking_id as string, paymentId: intent.payment_id as string, amount: intent.amount_cents as number };
}
async function cancelledWash(s: any) {
  const w = await paidWash(s);
  await s.as('authenticated', w.u.authId);
  expect(await s.err(`select public.cancel_customer_booking('${w.bookingId}','Plans changed')`)).toBeNull();
  await s.as('postgres');
  const refundId = (await s.q('select id from public.refunds where payment_id=$1', [w.paymentId]))[0].id as string;
  return { ...w, refundId };
}

describe('roles', () => {
  it('the owner is the super admin and any other existing admin keeps working as operations (what the migration did on top of production data)', async () =>
    inTx(async (s) => {
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.admin_role_areas where access='super_admin'`))[0].n).toBe(21);
      // The seed insert is re-run here on two fresh admin profiles: the owner's email, and someone else.
      const owner = await createAdmin(s, null);
      const other = await createAdmin(s, null);
      await s.q(`update auth.users set email='rajguruyash29@gmail.com' where id=$1`, [owner.authId]).catch(() => undefined);
      await s.q(`update auth.users set email='someone.else@t.test' where id=$1`, [other.authId]);
      await s.q(`delete from public.admin_access where profile_id in ($1,$2)`, [owner.profileId, other.profileId]);
      await s.q(`INSERT INTO public.admin_access (profile_id, access)
                 SELECT p.id, CASE WHEN lower(u.email) = 'rajguruyash29@gmail.com' THEN 'super_admin' ELSE 'operations' END
                   FROM public.profiles p JOIN auth.users u ON u.id = p.auth_user_id WHERE p.role = 'admin' AND p.id IN ($1,$2) ON CONFLICT (profile_id) DO NOTHING`, [owner.profileId, other.profileId]);
      const got = Object.fromEntries((await s.q(`select profile_id, access from public.admin_access where profile_id in ($1,$2)`, [owner.profileId, other.profileId])).map((r: any) => [r.profile_id, r.access]));
      expect(got[owner.profileId]).toBe('super_admin');
      expect(got[other.profileId]).toBe('operations');
    }));

  it('my_admin_access tells each role what it may do, and nothing to anyone who is not an admin with a role', async () =>
    inTx(async (s) => {
      const admins = Object.fromEntries(await Promise.all(ROLES.map(async (r) => [r, await createAdmin(s, r)] as const)));
      const seen: Record<string, any> = {};
      for (const r of ROLES) { await as(s, admins[r]); seen[r] = (await s.q('select public.my_admin_access() a'))[0].a; }
      expect(seen.super_admin.access).toBe('super_admin');
      expect(Object.keys(seen.super_admin.areas)).toHaveLength(21);
      expect(seen.operations.areas).toMatchObject({ bookings: 'manage', people: 'manage', services: 'manage', overview: 'view', history: 'view' });
      expect(seen.operations.areas).not.toHaveProperty('payments');
      expect(seen.operations.areas).not.toHaveProperty('settings');
      expect(seen.operations.areas).not.toHaveProperty('team');
      expect(seen.finance.areas).toMatchObject({ payments: 'manage', export_payments: 'manage', bookings: 'view' });
      expect(seen.finance.areas).not.toHaveProperty('people');
      expect(seen.marketing.areas).toEqual({ overview: 'view', campaigns: 'manage' });
      expect(seen.support.areas).toMatchObject({ support: 'manage', people: 'view' });
      expect(seen.support.areas).not.toHaveProperty('payments');

      const noRole = await createAdmin(s, null);
      await as(s, noRole);
      expect((await s.q('select public.my_admin_access() a'))[0].a).toBeNull();
      const customer = await createCustomer(s);
      await as(s, customer);
      expect((await s.q('select public.my_admin_access() a'))[0].a).toBeNull();
      await s.as('anon');
      expect(await s.err('select public.my_admin_access()')).toMatch(/permission denied/i);
    }));

  it('an admin with no role can do nothing new (fails closed)', async () =>
    inTx(async (s) => {
      const none = await createAdmin(s, null);
      for (const sql of ['select public.admin_dashboard()', 'select public.admin_team()', 'select public.admin_get_settings()', 'select public.admin_activity()', "select public.admin_export('customers')", 'select public.admin_support_list()']) {
        expect(await call(s, none, sql), sql).toMatch(denied);
      }
    }));

  it('the team: only the super admin lists it, changes roles, adds and switches off admins; never themselves, never the super admin', async () =>
    inTx(async (s) => {
      const owner = await createAdmin(s, 'super_admin');
      const ops = await createAdmin(s, 'operations');
      const fin = await createAdmin(s, 'finance');
      await as(s, owner);
      const team = (await s.q('select public.admin_team() t'))[0].t;
      expect(team.map((t: any) => t.access)).toContain('operations');
      expect(team[0].access).toBe('super_admin');
      expect(await call(s, ops, 'select public.admin_team()')).toMatch(denied);

      expect(await call(s, owner, `select public.admin_set_access('${ops.profileId}','finance')`)).toBeNull();
      await s.as('postgres');
      expect((await s.q('select access from public.admin_access where profile_id=$1', [ops.profileId]))[0].access).toBe('finance');
      expect(await call(s, owner, `select public.admin_set_access('${owner.profileId}','support')`)).toMatch(/cannot change your own role/);
      expect(await call(s, owner, `select public.admin_set_access('${fin.profileId}','super_admin')`)).toMatch(/Choose a role/);
      expect(await call(s, fin, `select public.admin_set_access('${ops.profileId}','support')`)).toMatch(denied);
      const second = await createAdmin(s, 'super_admin'); // a second super admin made by hand: still cannot be changed from the website
      expect(await call(s, owner, `select public.admin_set_access('${second.profileId}','support')`)).toMatch(/super admin's role cannot be changed/);
      expect(await call(s, owner, `select public.admin_set_access('${uid()}','support')`)).toMatch(/Admin not found/);
      const cust = await createCustomer(s);
      expect(await call(s, owner, `select public.admin_set_access('${cust.profileId}','support')`)).toMatch(/Admin not found/);

      expect(await call(s, owner, `select public.admin_set_admin_active('${fin.profileId}', false)`)).toBeNull();
      await s.as('postgres');
      expect((await s.q('select archived_at is not null a from public.profiles where id=$1', [fin.profileId]))[0].a).toBe(true);
      expect(await call(s, owner, `select public.admin_set_admin_active('${fin.profileId}', true)`)).toBeNull();
      expect(await call(s, owner, `select public.admin_set_admin_active('${owner.profileId}', false)`)).toMatch(/your own account/);
      expect(await call(s, owner, `select public.admin_set_admin_active('${second.profileId}', false)`)).toMatch(/super admin cannot be switched off/);
      await s.as('postgres');
      expect((await s.q(`select event_type from public.audit_events where entity_id=$1 and event_type like 'admin_%' order by created_at`, [ops.profileId])).map((e: any) => e.event_type)).toContain('admin_role_changed');
    }));

  it('a brand-new login can be made an admin, an existing customer never can', async () =>
    inTx(async (s) => {
      const owner = await createAdmin(s, 'super_admin');
      const fresh = await createAuthUser(s, { email: `${uid()}@t.test` });
      expect(await call(s, owner, `select public.admin_promote_to_admin('${fresh.authId}','New Person','support')`)).toBeNull();
      await s.as('postgres');
      expect((await s.q('select role::text r from public.profiles where id=$1', [fresh.profileId]))[0].r).toBe('admin');
      expect((await s.q('select access from public.admin_access where profile_id=$1', [fresh.profileId]))[0].access).toBe('support');
      expect(await call(s, owner, `select public.admin_promote_to_admin('${fresh.authId}','New Person','support')`)).toMatch(/already belongs to a admin account/);

      const old = await createAuthUser(s, { email: `${uid()}@t.test` });
      await s.as('postgres');
      await s.q(`update public.profiles set created_at = now() - interval '2 hours' where id=$1`, [old.profileId]);
      expect(await call(s, owner, `select public.admin_promote_to_admin('${old.authId}','Old Customer','support')`)).toMatch(/already belongs to a customer/);

      const busy = await createAuthUser(s, { email: `${uid()}@t.test` });
      await createVehicle(s, busy.profileId, 'car');
      expect(await call(s, owner, `select public.admin_promote_to_admin('${busy.authId}','Busy Customer','support')`)).toMatch(/already belongs to a customer/);
      expect(await call(s, owner, `select public.admin_promote_to_admin('${fresh.authId}','x','support')`)).toMatch(/full name|already belongs/);
      const ops = await createAdmin(s, 'operations');
      const fresh2 = await createAuthUser(s, { email: `${uid()}@t.test` });
      expect(await call(s, ops, `select public.admin_promote_to_admin('${fresh2.authId}','Other Person','support')`)).toMatch(denied);
    }));
});

describe('app settings', () => {
  it('anyone may read whether the site is paused; only the super admin changes settings, and they are checked and audited', async () =>
    inTx(async (s) => {
      await s.as('anon');
      let pub = (await s.q('select public.get_public_settings() p'))[0].p;
      expect(pub).toMatchObject({ maintenance_mode: false });
      expect(pub.maintenance_message.length).toBeGreaterThan(10);

      const owner = await createAdmin(s, 'super_admin');
      const ops = await createAdmin(s, 'operations');
      expect(await call(s, ops, `select public.admin_set_setting('maintenance_mode','true'::jsonb)`)).toMatch(denied);
      expect(await call(s, ops, 'select public.admin_get_settings()')).toMatch(denied);
      expect(await call(s, owner, `select public.admin_set_setting('maintenance_mode','"yes"'::jsonb)`)).toMatch(/on or off/);
      expect(await call(s, owner, `select public.admin_set_setting('maintenance_message','"x"'::jsonb)`)).toMatch(/3 to 200/);
      expect(await call(s, owner, `select public.admin_set_setting('big_refund_threshold_cents','-5'::jsonb)`)).toMatch(/whole number/);
      expect(await call(s, owner, `select public.admin_set_setting('big_refund_threshold_cents','12.5'::jsonb)`)).toMatch(/whole number/);
      expect(await call(s, owner, `select public.admin_set_setting('nope','1'::jsonb)`)).toMatch(/Unknown setting/);

      expect(await call(s, owner, `select public.admin_set_setting('maintenance_mode','true'::jsonb)`)).toBeNull();
      expect(await call(s, owner, `select public.admin_set_setting('maintenance_message','"  Back at 6pm  "'::jsonb)`)).toBeNull();
      await s.as('anon');
      pub = (await s.q('select public.get_public_settings() p'))[0].p;
      expect(pub).toEqual({ maintenance_mode: true, maintenance_message: 'Back at 6pm' });
      await as(s, owner);
      const all = (await s.q('select public.admin_get_settings() a'))[0].a;
      expect(all.big_refund_threshold_cents).toBe(100000);
      await s.as('postgres');
      const ev = await s.q(`select metadata from public.audit_events where event_type='setting_changed' and metadata->>'key'='maintenance_mode'`);
      expect(ev[0].metadata).toMatchObject({ from: false, to: true });
    }));

  it('the tables themselves cannot be read or written by customers, anonymous visitors or even admins', async () =>
    inTx(async (s) => {
      const owner = await createAdmin(s, 'super_admin');
      for (const who of [null, owner] as const) {
        await (who ? as(s, who) : s.as('anon'));
        for (const t of ['app_settings', 'admin_access', 'admin_role_areas', 'support_tickets', 'support_messages']) {
          expect(await s.err(`select * from public.${t}`), t).toMatch(/permission denied/i);
          expect(await s.err(`delete from public.${t}`), t).toMatch(/permission denied/i);
        }
      }
    }));
});

describe('safe refunds', () => {
  it('only a role with payments may approve or record a refund; a refund at or above the threshold needs the super admin', async () =>
    inTx(async (s) => {
      const owner = await createAdmin(s, 'super_admin');
      const fin = await createAdmin(s, 'finance');
      const ops = await createAdmin(s, 'operations');
      const sup = await createAdmin(s, 'support');
      const mkt = await createAdmin(s, 'marketing');
      const w = await cancelledWash(s); // Rs 150
      for (const who of [ops, sup, mkt]) {
        expect(await call(s, who, `select public.admin_begin_refund('${w.refundId}')`), 'begin').toMatch(denied);
        expect(await call(s, who, `select public.admin_finish_refund('${w.refundId}','rfnd_123456')`), 'finish').toMatch(denied);
        expect(await call(s, who, `select public.admin_fail_refund('${w.refundId}','x')`), 'fail').toMatch(denied);
        expect(await call(s, who, `select public.admin_resolve_refund('${w.refundId}','failed')`), 'resolve').toMatch(denied);
      }
      // below the threshold (Rs 1,000 by default) finance can do it
      expect(await call(s, fin, `select public.admin_begin_refund('${w.refundId}')`)).toBeNull();

      // the owner lowers the threshold to Rs 100: now Rs 150 is "big"
      expect(await call(s, owner, `select public.admin_set_setting('big_refund_threshold_cents','10000'::jsonb)`)).toBeNull();
      const w2 = await cancelledWash(s);
      expect(await call(s, fin, `select public.admin_begin_refund('${w2.refundId}')`)).toMatch(/needs the super admin/);
      expect(await call(s, fin, `select public.admin_resolve_refund('${w2.refundId}','processed','rfnd_big_1')`)).toMatch(/needs the super admin/);
      expect(await call(s, owner, `select public.admin_begin_refund('${w2.refundId}')`)).toBeNull();
      expect(await call(s, owner, `select public.admin_finish_refund('${w2.refundId}','rfnd_big_1')`)).toBeNull();
      await s.as('postgres');
      expect((await s.q('select status::text s from public.refunds where id=$1', [w2.refundId]))[0].s).toBe('processed');
    }));
});

describe('complaints', () => {
  async function ticket(s: any, u: any, o: { subject?: string; booking?: string | null; category?: string } = {}) {
    await as(s, u);
    return (await s.q('select public.create_support_ticket($1,$2,$3,$4) t', [o.category ?? 'booking', o.subject ?? 'Specialist did not come', 'He never arrived at the time we agreed.', o.booking ?? null]))[0].t;
  }

  it('a customer raises a complaint and sees only their own; the thread works both ways', async () =>
    inTx(async (s) => {
      const a = await createCustomer(s);
      const b = await createCustomer(s);
      const sup = await createAdmin(s, 'support');
      const t = await ticket(s, a);
      expect(t.reference_code).toMatch(/^SUP-\d{5,}$/);
      await as(s, b);
      expect((await s.q('select public.my_support_tickets() t'))[0].t).toEqual([]);
      expect(await s.err(`select public.my_support_ticket('${t.id}')`)).toMatch(/not found/);
      expect(await s.err(`select public.reply_to_my_ticket('${t.id}','sneaky')`)).toMatch(/not found/);

      await as(s, a);
      const mine = (await s.q('select public.my_support_tickets() t'))[0].t;
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ subject: 'Specialist did not come', status: 'open', last_from_admin: false });

      // support answers: first reply moves it to in progress
      expect(await call(s, sup, `select public.admin_support_reply('${t.id}','Sorry about that, we are looking into it.')`)).toBeNull();
      await as(s, a);
      let one = (await s.q(`select public.my_support_ticket('${t.id}') t`))[0].t;
      expect(one.ticket.status).toBe('in_progress');
      expect(one.messages.map((m: any) => m.from_admin)).toEqual([false, true]);
      expect((await s.q('select public.my_support_tickets() t'))[0].t[0].last_from_admin).toBe(true);

      // resolved, then the customer writes again: it reopens
      expect(await call(s, sup, `select public.admin_support_reply('${t.id}','We sent a new specialist. Closing this.','resolved')`)).toBeNull();
      await as(s, a);
      expect(await s.err(`select public.reply_to_my_ticket('${t.id}','Still waiting actually')`)).toBeNull();
      one = (await s.q(`select public.my_support_ticket('${t.id}') t`))[0].t;
      expect(one.ticket.status).toBe('open');

      // closed is final for the customer
      expect(await call(s, sup, `select public.admin_support_set_status('${t.id}','closed')`)).toBeNull();
      expect(await call(s, a, `select public.reply_to_my_ticket('${t.id}','hello?')`)).toMatch(/closed/);
      expect(await call(s, sup, `select public.admin_support_reply('${t.id}','one more','open')`)).toMatch(/closed/);
    }));

  it('is validated: a wash must be theirs, titles and messages are bounded, and 5 open ones is the limit', async () =>
    inTx(async (s) => {
      const a = await createCustomer(s);
      const b = await createCustomer(s);
      const w = await paidWash(s);
      await as(s, a);
      expect(await s.err(`select public.create_support_ticket('booking','Not my wash','Something about it here',$1)`, [w.bookingId])).toMatch(/not yours/);
      expect(await s.err(`select public.create_support_ticket('nonsense','Title here','Some words here')`)).toMatch(/what this is about/);
      expect(await s.err(`select public.create_support_ticket('booking','ab','Some words here')`)).toMatch(/short title/);
      expect(await s.err(`select public.create_support_ticket('booking','Title here','abc')`)).toMatch(/what happened/);
      expect(await s.err(`select public.create_support_ticket('booking','Title here',$1)`, ['x'.repeat(2001)])).toMatch(/what happened/);
      await as(s, w.u);
      expect(await s.err(`select public.create_support_ticket('booking','About my wash','The foam was missing.',$1)`, [w.bookingId])).toBeNull();
      await as(s, a);
      for (let i = 0; i < 5; i++) expect(await s.err(`select public.create_support_ticket('other','Complaint number ${i}','Some words here')`)).toBeNull();
      expect(await s.err(`select public.create_support_ticket('other','One too many','Some words here')`)).toMatch(/5 open complaints/);
      await as(s, b);
      expect(await s.err(`select public.create_support_ticket('other','Mine is separate','Some words here')`)).toBeNull();
    }));

  it('workers, admins and visitors cannot raise complaints; roles without support cannot read or answer them', async () =>
    inTx(async (s) => {
      const a = await createCustomer(s);
      const t = await ticket(s, a);
      const worker = await createWorker(s);
      const owner = await createAdmin(s, 'super_admin');
      for (const who of [worker, owner]) expect(await call(s, who, `select public.create_support_ticket('other','Title here','Some words here')`), 'raise').toMatch(/customer access required/);
      await s.as('anon');
      expect(await s.err(`select public.create_support_ticket('other','Title here','Some words here')`)).toMatch(/permission denied/i);
      for (const r of ['operations', 'finance', 'marketing'] as const) {
        const adm = await createAdmin(s, r);
        expect(await call(s, adm, 'select public.admin_support_list()'), r).toMatch(denied);
        expect(await call(s, adm, `select public.admin_support_get('${t.id}')`), r).toMatch(denied);
        expect(await call(s, adm, `select public.admin_support_reply('${t.id}','hi')`), r).toMatch(denied);
      }
      const sup = await createAdmin(s, 'support');
      await as(s, sup);
      const list = (await s.q(`select public.admin_support_list('open') l`))[0].l;
      expect(list.find((x: any) => x.id === t.id)).toMatchObject({ subject: 'Specialist did not come', messages: 1 });
      expect((await s.q(`select public.admin_support_list('resolved') l`))[0].l.find((x: any) => x.id === t.id)).toBeUndefined();
      const got = (await s.q(`select public.admin_support_get('${t.id}') g`))[0].g;
      expect(got.messages).toHaveLength(1);
      expect(got.ticket.customer_name).toBe((await (async () => { await s.as('postgres'); return (await s.q('select full_name n from public.profiles where id=$1', [a.profileId]))[0].n; })()));
    }));
});

describe('activity log', () => {
  it('only the super admin reads it; it shows who did what, can be searched, and records the changes made above', async () =>
    inTx(async (s) => {
      const owner = await createAdmin(s, 'super_admin');
      const ops = await createAdmin(s, 'operations');
      expect(await call(s, ops, 'select public.admin_activity()')).toMatch(denied);
      await as(s, owner);
      expect(await s.err(`select public.admin_set_setting('maintenance_mode','true'::jsonb)`)).toBeNull();
      expect(await s.err(`select public.admin_log_event('admin_signed_in')`)).toBeNull();
      const rows = (await s.q('select public.admin_activity(50) a'))[0].a;
      const signedIn = rows.find((r: any) => r.event_type === 'admin_signed_in'); // (one transaction = one timestamp, so the order of same-instant events is not asserted)
      expect(signedIn).toMatchObject({ actor_role: 'admin', entity_type: 'profile' });
      expect(rows.some((r: any) => r.event_type === 'setting_changed')).toBe(true);
      const found = (await s.q(`select public.admin_activity(50, null, 'maintenance_mode') a`))[0].a;
      expect(found.every((r: any) => r.event_type === 'setting_changed' || JSON.stringify(r.metadata).includes('maintenance_mode'))).toBe(true);
      expect(found.length).toBeGreaterThan(0);
      const none = (await s.q(`select public.admin_activity(50, null, 'zzz-no-such-thing') a`))[0].a;
      expect(none).toEqual([]);
      const old = (await s.q(`select public.admin_activity(50, now() - interval '1 day') a`))[0].a;
      expect(old.some((r: any) => r.event_type === 'setting_changed')).toBe(false);
      expect((await s.q('select jsonb_array_length(public.admin_activity(100000)) n'))[0].n).toBeLessThanOrEqual(500);
      expect(await s.err(`select public.admin_log_event('something_else')`)).toMatch(/Unknown event/);
      await as(s, await createCustomer(s));
      expect(await s.err(`select public.admin_log_event('admin_signed_in')`)).toMatch(/admin access required/);
    }));
});

describe('dashboard', () => {
  it('counts today by Pune calendar day, and money only for roles that may see payments', async () =>
    inTx(async (s) => {
      const fin = await createAdmin(s, 'finance');
      const mkt = await createAdmin(s, 'marketing');
      const sup = await createAdmin(s, 'support');
      const owner = await createAdmin(s, 'super_admin');
      await as(s, fin);
      const before = (await s.q('select public.admin_dashboard() d'))[0].d;
      expect(before.series).toHaveLength(14);
      expect(before.money.collected_today_cents).toBeTypeOf('number');
      const w = await cancelledWash(s); // a paid wash (Rs 150) and a refund request
      await createCustomer(s);
      await as(s, fin);
      const after = (await s.q('select public.admin_dashboard() d'))[0].d;
      expect(after.new_customers.today - before.new_customers.today).toBe(2);
      expect(after.orders.paid_today - before.orders.paid_today).toBe(1);
      expect(after.money.collected_today_cents - before.money.collected_today_cents).toBe(w.amount);
      expect(after.series[13].date).toBe(after.today);
      expect(after.series[13].collected_cents - before.series[13].collected_cents).toBe(w.amount);
      expect(after.open_complaints).toBeNull(); // finance has no support area
      expect(after.payment_problems).toMatchObject({ failed_today: 0 });

      // refunded money is shown as refunded (processed refunds only)
      await as(s, owner);
      expect(await s.err(`select public.admin_begin_refund('${w.refundId}')`)).toBeNull();
      expect(await s.err(`select public.admin_finish_refund('${w.refundId}','rfnd_dash_1')`)).toBeNull();
      const refunded = (await s.q('select public.admin_dashboard() d'))[0].d;
      expect(refunded.money.refunded_today_cents - before.money.refunded_today_cents).toBe(w.amount);

      for (const who of [mkt, sup]) {
        await as(s, who);
        const d = (await s.q('select public.admin_dashboard() d'))[0].d;
        expect(d.money).toBeNull();
        expect(d.payment_problems).toBeNull();
        expect(d.series[13].collected_cents).toBeNull();
        expect(d.new_customers.today).toBeGreaterThanOrEqual(2);
      }
      await as(s, sup);
      expect((await s.q('select public.admin_dashboard() d'))[0].d.open_complaints).toBeTypeOf('number');
      await as(s, await createCustomer(s));
      expect(await s.err('select public.admin_dashboard()')).toMatch(/admin access required/);
    }));
});

describe('data export', () => {
  it('each kind needs its own permission, and the answer is columns + rows', async () =>
    inTx(async (s) => {
      const w = await cancelledWash(s);
      const who = Object.fromEntries(await Promise.all(ROLES.map(async (r) => [r, await createAdmin(s, r)] as const)));
      const allowed: Record<string, AdminAccess[]> = {
        customers: ['super_admin', 'operations'],
        washes: ['super_admin', 'operations'],
        memberships: ['super_admin', 'operations', 'finance'],
        payments: ['super_admin', 'finance'],
        refunds: ['super_admin', 'finance'],
        support: ['super_admin', 'support'],
        activity: ['super_admin'],
      };
      for (const [kind, ok] of Object.entries(allowed)) {
        for (const r of ROLES) {
          const err = await call(s, who[r], `select public.admin_export('${kind}')`);
          if (ok.includes(r)) expect(err, `${r} ${kind}`).toBeNull();
          else expect(err, `${r} ${kind}`).toMatch(denied);
        }
      }
      expect(await call(s, who.super_admin, `select public.admin_export('everything')`)).toMatch(/Unknown export/);
      expect(await call(s, who.super_admin, `select public.admin_export('payments', '2026-02-01', '2026-01-01')`)).toMatch(/after the end date/);

      await as(s, who.finance);
      const pay = (await s.q(`select public.admin_export('payments') e`))[0].e;
      expect(pay.columns).toContain('Amount (Rs)');
      expect(pay.columns).toHaveLength(pay.rows[0].length);
      expect(pay.truncated).toBe(false);
      const mine = pay.rows.find((r: any[]) => r[1] === w.amount / 100);
      expect(mine).toBeTruthy();
      expect(JSON.stringify(pay)).not.toMatch(/\+91|@t\.test/); // names only, no contact details in money exports
      const ref = (await s.q(`select public.admin_export('refunds') e`))[0].e;
      expect(ref.rows.some((r: any[]) => r[1] === w.amount / 100 && r[2] === 'requested')).toBe(true);

      await as(s, who.operations);
      const cust = (await s.q(`select public.admin_export('customers') e`))[0].e;
      expect(cust.columns.slice(0, 3)).toEqual(['Name', 'Mobile', 'Email']);
      expect(cust.rows.some((r: any[]) => /^\+91/.test(r[1] ?? ''))).toBe(true);
      const washes = (await s.q(`select public.admin_export('washes') e`))[0].e;
      expect(washes.rows.some((r: any[]) => r[0] && r[3] === 'cancelled' || r[3] === 'refund_requested' || r[3] === 'cancelled')).toBe(true);
    }));

  it('respects the date range, is audited with its size, and never leaves the database unrecorded', async () =>
    inTx(async (s) => {
      const owner = await createAdmin(s, 'super_admin');
      await createCustomer(s);
      const today = await istDate(s, 0);
      await as(s, owner);
      const inside = (await s.q(`select public.admin_export('customers', $1::date, $1::date) e`, [today]))[0].e;
      expect(inside.rows.length).toBeGreaterThanOrEqual(1);
      expect(inside.rows.every((r: any[]) => r[3].startsWith(today))).toBe(true);
      const outside = (await s.q(`select public.admin_export('customers', '2001-01-01', '2001-01-02') e`))[0].e;
      expect(outside.rows).toEqual([]);
      const log = (await s.q('select public.admin_activity(20) a'))[0].a.filter((r: any) => r.event_type === 'data_exported');
      expect(log.length).toBeGreaterThanOrEqual(2);
      expect(log.find((r: any) => r.metadata.rows === 0)).toMatchObject({ actor_role: 'admin', metadata: { kind: 'customers', from: '2001-01-01', to: '2001-01-02', rows: 0, truncated: false } });
      // exports cannot be requested by customers or visitors
      await as(s, await createCustomer(s));
      expect(await s.err(`select public.admin_export('customers')`)).toMatch(/admin access required/);
      await s.as('anon');
      expect(await s.err(`select public.admin_export('customers')`)).toMatch(/permission denied/i);
    }));
});
