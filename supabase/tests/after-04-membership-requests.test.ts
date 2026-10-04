/** GREEN tests for 20261004000004_membership_request_flow.sql */
import { describe, expect, it } from 'vitest';
import { createAddress, createAdmin, createCustomer, createVehicle, createWorker, inTx, istDate } from './helpers';

const PATTERN_3 = [{ weekday: 1, kind: 'body' }, { weekday: 3, kind: 'deep' }, { weekday: 5, kind: 'body' }];

async function submit(s: any, user: any, veh: string, o: { pattern?: any[]; months?: number; start?: number } = {}) {
  await s.as('authenticated', user.authId);
  const start = await istDate(s, o.start ?? 4);
  await s.as('authenticated', user.authId);
  const r = await s.q(
    `select public.create_membership_request($1,$2::jsonb,$3,'morning',$4::date,null,'Basement P1',null,null) id`,
    [veh, JSON.stringify(o.pattern ?? PATTERN_3), o.months ?? 3, start]
  );
  return r[0].id as string;
}

describe('creating a request', () => {
  it('a customer can request a membership for their own vehicle', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const veh = await createVehicle(s, u.profileId, 'car');
      const id = await submit(s, u, veh);
      await s.as('postgres');
      const r = (await s.q('select * from public.membership_requests where id=$1', [id]))[0];
      expect(r).toMatchObject({ status: 'submitted', frequency_per_week: 3, duration_months: 3, time_slot: 'morning' });
      expect(r.reference_code).toMatch(/^MR-[A-Z2-9]{6}$/);
      expect(r.weekly_pattern.map((p: any) => p.weekday)).toEqual([1, 3, 5]);
      expect(r.system_quote.final_cents).toBe(533520); // 3/wk x 3 months, as computed in the pricing tests
      expect((await s.q(`select event_type from public.audit_events where entity_id=$1`, [id]))[0].event_type).toBe('membership_requested');
    }));

  it("can't request for someone else's vehicle, or with an invalid pattern, or a start date that's too soon", async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const other = await createCustomer(s);
      const veh = await createVehicle(s, other.profileId);
      const mine = await createVehicle(s, u.profileId);
      const ok = await istDate(s, 4);
      const tooSoon = await istDate(s, 0);
      await s.as('authenticated', u.authId);
      const q = (v: string, pattern: any, start: string) =>
        s.err(`select public.create_membership_request('${v}','${JSON.stringify(pattern)}'::jsonb,3,'morning','${start}'::date)`);
      expect(await q(veh, PATTERN_3, ok)).toMatch(/Vehicle not found/);
      expect(await q(mine, [{ weekday: 1, kind: 'body' }, { weekday: 2, kind: 'body' }], ok)).toMatch(/1 body wash \+ 1 deep/);
      expect(await q(mine, PATTERN_3, tooSoon)).toMatch(/can start from/);
    }));

  it('allows one open request per vehicle', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const veh = await createVehicle(s, u.profileId);
      await submit(s, u, veh);
      await s.as('authenticated', u.authId);
      expect(await s.err(`select public.create_membership_request('${veh}','${JSON.stringify(PATTERN_3)}'::jsonb,3,'morning',(current_date+10))`)).toMatch(/already have a membership request/);
    }));

  it('workers and anon cannot create requests', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const c = await createCustomer(s);
      const veh = await createVehicle(s, c.profileId);
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.create_membership_request('${veh}','${JSON.stringify(PATTERN_3)}'::jsonb,3,'morning',(current_date+10))`)).toMatch(/Customer profile not found/);
      await s.as('anon');
      expect(await s.err(`select public.create_membership_request('${veh}','[]'::jsonb,3,'morning',(current_date+10))`)).toMatch(/permission denied/);
    }));
});

describe('the customer never sees a price before WASHO approves one', () => {
  it('submitted: no price fields, and the table itself is closed to customers', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const veh = await createVehicle(s, u.profileId);
      await submit(s, u, veh);
      await s.as('authenticated', u.authId);
      const rows = await s.q('select * from public.my_membership_requests()');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'submitted', quoted_amount_cents: null, quoted_breakdown: null, quote_expires_at: null });
      expect(JSON.stringify(rows[0])).not.toMatch(/system_quote|533520/);
      expect(await s.q('select * from public.membership_requests')).toHaveLength(0); // RLS: no customer policy
    }));

  it("customers can't read each other's requests", async () =>
    inTx(async (s) => {
      const a = await createCustomer(s);
      const b = await createCustomer(s);
      await submit(s, a, await createVehicle(s, a.profileId));
      await s.as('authenticated', b.authId);
      expect(await s.q('select * from public.my_membership_requests()')).toHaveLength(0);
    }));
});

describe('WASHO review', () => {
  it('only admins can list or review', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const id = await submit(s, u, await createVehicle(s, u.profileId));
      await s.as('authenticated', u.authId);
      expect(await s.err(`select public.admin_list_membership_requests()`)).toMatch(/admin access required/);
      expect(await s.err(`select public.admin_review_membership_request('${id}','quote')`)).toMatch(/admin access required/);
    }));

  it('admin sees the request with the rate-card price and the customer details', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const u = await createCustomer(s);
      await createAddress(s, u.profileId);
      await submit(s, u, await createVehicle(s, u.profileId));
      await s.as('authenticated', admin.authId);
      const list = (await s.q('select public.admin_list_membership_requests($1) r', ['submitted']))[0].r;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ status: 'submitted', customer: { phone: u.phone } });
      expect(list[0].system_quote.final_cents).toBe(533520);
    }));

  it('quoting at the rate-card price makes the customer\'s price visible, with the full explicit breakdown', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const u = await createCustomer(s);
      const id = await submit(s, u, await createVehicle(s, u.profileId));
      await s.as('authenticated', admin.authId);
      const r = (await s.q(`select public.admin_review_membership_request($1,'quote') r`, [id]))[0].r;
      expect(r).toMatchObject({ status: 'quoted', quoted_amount_cents: 533520 });
      await s.as('authenticated', u.authId);
      const mine = (await s.q('select * from public.my_membership_requests()'))[0];
      expect(mine).toMatchObject({ status: 'quoted', quoted_amount_cents: 533520 });
      expect(mine.quoted_breakdown).toMatchObject({
        subtotal_cents: 624000,
        frequency_discount: { bp: 1000, cents: 62400 },
        duration_discount: { bp: 500, cents: 28080 },
        adjustment: { cents: 0, reason: null },
        final_cents: 533520,
      });
      expect(new Date(mine.quote_expires_at).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000); // 7 days
    }));

  it('a WASHO adjustment is a labelled line, needs a reason, and changes the price by exactly that amount', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const u = await createCustomer(s);
      const id = await submit(s, u, await createVehicle(s, u.profileId));
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_review_membership_request('${id}','quote',-20000,null)`)).toMatch(/needs a reason/);
      await s.q(`select public.admin_review_membership_request($1,'quote',-33520,'Loyalty offer for a neighbour')`, [id]);
      await s.as('authenticated', u.authId);
      const mine = (await s.q('select * from public.my_membership_requests()'))[0];
      expect(mine.quoted_amount_cents).toBe(500000);
      expect(mine.quoted_breakdown.adjustment).toEqual({ cents: -33520, reason: 'Loyalty offer for a neighbour' });
      await s.as('postgres');
      const audit = await s.q(`select metadata from public.audit_events where entity_id=$1 and event_type='membership_quoted'`, [id]);
      expect(audit[0].metadata).toMatchObject({ system_final_cents: 533520, adjustment_cents: -33520, quoted_amount_cents: 500000 });
    }));

  it('re-quoting picks up current rates; rejecting needs a reason and is shown to the customer', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const u = await createCustomer(s);
      const id = await submit(s, u, await createVehicle(s, u.profileId));
      await s.as('authenticated', admin.authId);
      await s.q(`select public.admin_review_membership_request($1,'quote')`, [id]);
      await s.as('postgres');
      await s.q(`update public.membership_discount_rules set discount_bp=0 where kind='duration' and key_value=3`);
      await s.as('authenticated', admin.authId);
      const r = (await s.q(`select public.admin_review_membership_request($1,'quote') r`, [id]))[0].r;
      expect(r.quoted_amount_cents).toBe(624000 - 62400); // new duration rate applied
      expect(await s.err(`select public.admin_review_membership_request('${id}','reject')`)).toMatch(/reason/);
      await s.q(`select public.admin_review_membership_request($1,'reject',0,null,'We do not service that area yet')`, [id]);
      await s.as('authenticated', u.authId);
      const mine = (await s.q('select * from public.my_membership_requests()'))[0];
      expect(mine).toMatchObject({ status: 'rejected', rejection_reason: 'We do not service that area yet', quoted_amount_cents: null });
    }));

  it('the price can never fall below ₹1', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const u = await createCustomer(s);
      const id = await submit(s, u, await createVehicle(s, u.profileId));
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_review_membership_request('${id}','quote',-533500,'Free trial month')`)).toMatch(/at least/);
    }));
});

describe('accepting a quote', () => {
  async function quoted(s: any) {
    const admin = await createAdmin(s);
    const u = await createCustomer(s);
    const id = await submit(s, u, await createVehicle(s, u.profileId));
    await s.as('authenticated', admin.authId);
    await s.q(`select public.admin_review_membership_request($1,'quote')`, [id]);
    return { admin, u, id };
  }

  it('creates a PENDING payment for exactly the quoted amount, and no membership', async () =>
    inTx(async (s) => {
      const { u, id } = await quoted(s);
      await s.as('authenticated', u.authId);
      const r = (await s.q('select public.accept_membership_quote($1) r', [id]))[0].r;
      expect(r).toMatchObject({ amount_cents: 533520, currency: 'INR' });
      await s.as('postgres');
      const pay = (await s.q('select * from public.payments where id=$1', [r.payment_id]))[0];
      expect(pay).toMatchObject({ status: 'pending', amount_cents: 533520, payment_kind: 'membership', membership_request_id: id, booking_id: null, membership_id: null });
      expect((await s.q('select count(*)::int n from public.memberships'))[0].n).toBe(0); // nothing is active
      expect((await s.q('select status from public.membership_requests where id=$1', [id]))[0].status).toBe('accepted');
    }));

  it('accepting twice reuses the same open payment', async () =>
    inTx(async (s) => {
      const { u, id } = await quoted(s);
      await s.as('authenticated', u.authId);
      const a = (await s.q('select public.accept_membership_quote($1) r', [id]))[0].r;
      const b = (await s.q('select public.accept_membership_quote($1) r', [id]))[0].r;
      expect(b.payment_id).toBe(a.payment_id);
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.payments'))[0].n).toBe(1);
    }));

  it('an expired payment is superseded by a fresh one', async () =>
    inTx(async (s) => {
      const { u, id } = await quoted(s);
      await s.as('authenticated', u.authId);
      const a = (await s.q('select public.accept_membership_quote($1) r', [id]))[0].r;
      await s.as('postgres');
      await s.q(`update public.payments set expires_at = now() - interval '1 minute' where id=$1`, [a.payment_id]);
      await s.as('authenticated', u.authId);
      const b = (await s.q('select public.accept_membership_quote($1) r', [id]))[0].r;
      expect(b.payment_id).not.toBe(a.payment_id);
      await s.as('postgres');
      expect((await s.q('select status::text from public.payments where id=$1', [a.payment_id]))[0].status).toBe('failed');
    }));

  it("another customer can't accept it", async () =>
    inTx(async (s) => {
      const { id } = await quoted(s);
      const other = await createCustomer(s);
      await s.as('authenticated', other.authId);
      expect(await s.err(`select public.accept_membership_quote('${id}')`)).toMatch(/Request not found/);
    }));

  it('an unquoted or expired request cannot be accepted', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const id = await submit(s, u, await createVehicle(s, u.profileId));
      await s.as('authenticated', u.authId);
      expect(await s.err(`select public.accept_membership_quote('${id}')`)).toMatch(/not waiting for your approval/);

      const { u: u2, id: id2 } = await quoted(s);
      await s.as('postgres');
      await s.q(`update public.membership_requests set quote_expires_at = now() - interval '1 hour' where id=$1`, [id2]);
      await s.as('authenticated', u2.authId);
      expect((await s.q('select * from public.my_membership_requests()'))[0].status).toBe('expired'); // shown as expired immediately
      expect(await s.err(`select public.accept_membership_quote('${id2}')`)).toMatch(/expired/);
    }));

  it('declining closes the request and frees the vehicle for a new one', async () =>
    inTx(async (s) => {
      const { u, id } = await quoted(s);
      await s.as('authenticated', u.authId);
      await s.q('select public.decline_membership_quote($1)', [id]);
      expect((await s.q('select * from public.my_membership_requests()'))[0].status).toBe('declined');
      expect(await s.err(`select public.accept_membership_quote('${id}')`)).toMatch(/not waiting/);
      await s.as('postgres');
      const veh = (await s.q('select vehicle_id from public.membership_requests where id=$1', [id]))[0].vehicle_id;
      await s.as('authenticated', u.authId);
      expect(await s.err(`select public.create_membership_request('${veh}','${JSON.stringify(PATTERN_3)}'::jsonb,3,'morning',(current_date+10))`)).toBeNull();
    }));

  it('expire_membership_quotes closes stale quotes (service only)', async () =>
    inTx(async (s) => {
      const { u, id } = await quoted(s);
      await s.as('postgres');
      await s.q(`update public.membership_requests set quote_expires_at = now() - interval '1 hour' where id=$1`, [id]);
      await s.as('authenticated', u.authId);
      expect(await s.err('select app_private.expire_membership_quotes()')).toMatch(/permission denied/);
      await s.as('service_role');
      expect((await s.q('select app_private.expire_membership_quotes() n'))[0].n).toBe(1);
    }));
});
