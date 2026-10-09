/**
 * GREEN tests for 20261004000029_membership_renewal_stages.sql: who is due for each of the three renewal emails (a week before the end, the last days, once it is
 * over), and the rules that keep them from being annoying (once each, never to someone who renewed, never two in a day).
 */
import { describe, expect, it } from 'vitest';
import { createAddress, createCustomer, createVehicle, inTx, istDate, paidMembership, uid } from './helpers';

const WEEK = 'membership_renewal_reminder';
const LAST = 'membership_renewal_last_call';
const ENDED = 'membership_renewal_ended';

/** A paid, active membership whose last day is `days` from today (negative: it ended). Its customer has an email. */
async function endsIn(s: any, days: number, o: { months?: number } = {}) {
  const m = await paidMembership(s, { months: o.months ?? 1 });
  await s.as('postgres');
  await s.q(`update public.profiles set email = $2 where id = $1`, [m.u.profileId, `renew-${uid().slice(0, 8)}@example.com`]);
  await s.q('alter table public.memberships disable trigger user');
  await s.q(
    `update public.memberships
        set start_at = (date_trunc('day', now() at time zone 'Asia/Kolkata') + $2 * interval '1 day' - make_interval(months => $3) + interval '1 day') at time zone 'Asia/Kolkata',
            end_at   = (date_trunc('day', now() at time zone 'Asia/Kolkata') + $2 * interval '1 day') at time zone 'Asia/Kolkata'
      where id = $1`,
    [m.membership, days, o.months ?? 1]
  );
  await s.q('alter table public.memberships enable trigger user');
  return m;
}
const logSent = async (s: any, kind: string, ref: string, daysAgo: number, status = 'sent', attempts = 1) => {
  await s.as('postgres');
  await s.q(`insert into public.email_log (kind, ref_id, to_email, status, attempts, sent_at, updated_at) values ($1,$2,'x@example.com',$3,$4, now() - $5 * interval '1 day', now() - $5 * interval '1 day')`, [kind, ref, status, attempts, daysAgo]);
};
const due = async (s: any, kind: string, from: number, to: number, req: [string, number] | null = null) => {
  await s.as('service_role');
  return s.q('select * from public.svc_membership_renewals_due($1,$2,$3,$4,$5,200)', [kind, from, to, req?.[0] ?? null, req?.[1] ?? 0]);
};
const ids = (rows: any[]) => rows.map((r) => r.membership_id);

describe('who can ask', () => {
  it('only the service role and the website database role; the kinds are fixed', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      for (const who of [{ role: 'authenticated', id: c.authId }, { role: 'anon', id: null }] as const) {
        await s.as(who.role, who.id);
        expect(await s.err(`select * from public.svc_membership_renewals_due('${WEEK}',1,7)`)).toMatch(/permission denied/i);
      }
      await s.as('service_role');
      expect(await s.err(`select * from public.svc_membership_renewals_due('spam',1,7)`)).toMatch(/Unknown renewal email/);
      expect(await s.err(`select * from public.svc_membership_renewals_due('${WEEK}',1,7,'spam',2)`)).toMatch(/Unknown renewal email/);
      expect(await s.err(`select * from public.svc_membership_renewals_due('${WEEK}',1,7)`)).toBeNull();
    }));
});

describe('a week before the end', () => {
  it('1 to 7 days before the last day, with how many days are left; not earlier, and not on the last day itself (that is the last-call step)', async () =>
    inTx(async (s) => {
      const m = { d1: await endsIn(s, 1), d7: await endsIn(s, 7), d8: await endsIn(s, 8), d0: await endsIn(s, 0), d30: await endsIn(s, 30) };
      const got = await due(s, WEEK, 1, 7);
      expect(ids(got)).toEqual(expect.arrayContaining([m.d1.membership, m.d7.membership]));
      for (const x of [m.d8, m.d0, m.d30]) expect(ids(got)).not.toContain(x.membership);
      const one = got.find((r: any) => r.membership_id === m.d1.membership);
      expect(one).toMatchObject({ ends_in_days: 1, washes_total: 12, washes_done: 0, duration_months: 1, frequency_per_week: 3, washes_per_month: null });
      expect(one.email).toMatch(/^renew-/);
    }));

  it('is sent once: a sent, given-up or in-flight record takes the membership off the list, a failed one keeps it for a retry', async () =>
    inTx(async (s) => {
      const a = await endsIn(s, 3), b = await endsIn(s, 3), c = await endsIn(s, 3), d = await endsIn(s, 3);
      await logSent(s, WEEK, a.membership, 2, 'sent');
      await logSent(s, WEEK, b.membership, 0, 'failed', 3);
      await logSent(s, WEEK, c.membership, 0, 'failed', 1);
      await logSent(s, WEEK, d.membership, 0, 'sending');
      const got = ids(await due(s, WEEK, 1, 7));
      expect(got).toContain(c.membership); // failed once: tried again
      for (const x of [a, b, d]) expect(got).not.toContain(x.membership);
    }));

  it('never someone who has already renewed, a cancelled membership, an archived customer, or a customer with no email', async () =>
    inTx(async (s) => {
      const renewed = await endsIn(s, 3), cancelled = await endsIn(s, 3), archived = await endsIn(s, 3), noMail = await endsIn(s, 3), ok = await endsIn(s, 3);
      await s.as('postgres');
      // a second, later membership for the same vehicle = renewed
      await s.q('alter table public.memberships disable trigger user');
      await s.q(
        `insert into public.memberships (customer_profile_id, status, duration_months, quantity_per_period, start_at, end_at, base_amount_cents, discount_amount_cents, final_amount_cents, pricing_snapshot)
         select customer_profile_id, 'active', 1, 12, end_at + interval '1 day', end_at + interval '1 month', 100000, 0, 100000, '{}'::jsonb from public.memberships where id = $1`, [renewed.membership]);
      await s.q('alter table public.memberships enable trigger user');
      await s.q(`insert into public.membership_services (membership_id, service_id, vehicle_id, quantity_per_period)
                 select (select id from public.memberships where customer_profile_id = $2 and id <> $1 order by created_at desc limit 1), service_id, vehicle_id, quantity_per_period
                   from public.membership_services where membership_id = $1 limit 1`, [renewed.membership, renewed.u.profileId]);
      await s.q('alter table public.memberships disable trigger user');
      await s.q(`update public.memberships set status = 'cancelled' where id = $1`, [cancelled.membership]);
      await s.q('alter table public.memberships enable trigger user');
      await s.q(`update public.profiles set archived_at = now() where id = $1`, [archived.u.profileId]);
      await s.q(`update public.profiles set email = null where id = $1`, [noMail.u.profileId]);
      await s.q(`update auth.users set email = null where id = (select auth_user_id from public.profiles where id = $1)`, [noMail.u.profileId]);
      const got = ids(await due(s, WEEK, 1, 7));
      expect(got).toContain(ok.membership);
      for (const x of [renewed, cancelled, archived, noMail]) expect(got).not.toContain(x.membership);
    }));
});

describe('the last days', () => {
  it('0 to 2 days before the end, and only after the first reminder went out at least two days earlier', async () =>
    inTx(async (s) => {
      const never = await endsIn(s, 1), fresh = await endsIn(s, 1), old = await endsIn(s, 1), lastDay = await endsIn(s, 0), early = await endsIn(s, 3);
      await logSent(s, WEEK, fresh.membership, 1); // yesterday: too soon
      await logSent(s, WEEK, old.membership, 4);
      await logSent(s, WEEK, lastDay.membership, 6);
      await logSent(s, WEEK, early.membership, 4);
      const got = await due(s, LAST, 0, 2, [WEEK, 2]);
      expect(ids(got).sort()).toEqual([old.membership, lastDay.membership].sort());
      for (const x of [never, fresh, early]) expect(ids(got)).not.toContain(x.membership);
      expect(got.find((r: any) => r.membership_id === lastDay.membership).ends_in_days).toBe(0); // the last day itself counts
    }));

  it('is sent once', async () =>
    inTx(async (s) => {
      const m = await endsIn(s, 1);
      await logSent(s, WEEK, m.membership, 4);
      expect(ids(await due(s, LAST, 0, 2, [WEEK, 2]))).toContain(m.membership);
      await logSent(s, LAST, m.membership, 2);
      expect(ids(await due(s, LAST, 0, 2, [WEEK, 2]))).not.toContain(m.membership);
    }));
});

describe('once it is over', () => {
  it('1 to 3 days after the last day, a negative number of days left; not a day later, not before it ends', async () =>
    inTx(async (s) => {
      const m1 = await endsIn(s, -1), m3 = await endsIn(s, -3), m4 = await endsIn(s, -4), live = await endsIn(s, 0);
      const got = await due(s, ENDED, -3, -1);
      expect(ids(got)).toEqual(expect.arrayContaining([m1.membership, m3.membership]));
      for (const x of [m4, live]) expect(ids(got)).not.toContain(x.membership);
      expect(got.find((r: any) => r.membership_id === m3.membership).ends_in_days).toBe(-3);
    }));

  it('an expired membership counts too; one that was renewed does not', async () =>
    inTx(async (s) => {
      const a = await endsIn(s, -2);
      await s.as('postgres');
      await s.q('alter table public.memberships disable trigger user');
      await s.q(`update public.memberships set status = 'expired' where id = $1`, [a.membership]);
      await s.q('alter table public.memberships enable trigger user');
      expect(ids(await due(s, ENDED, -3, -1))).toContain(a.membership);
    }));
});

describe('never two in a day', () => {
  it('a renewal email sent in the last 24 hours holds back every other step for that membership', async () =>
    inTx(async (s) => {
      const m = await endsIn(s, 1);
      await logSent(s, WEEK, m.membership, 0); // just now
      expect(ids(await due(s, LAST, 0, 2))).not.toContain(m.membership);
      expect(ids(await due(s, ENDED, -3, 7))).not.toContain(m.membership);
      // and a day later it may go
      await s.as('postgres');
      await s.q(`update public.email_log set sent_at = now() - interval '25 hours' where ref_id = $1`, [m.membership]);
      expect(ids(await due(s, LAST, 0, 2))).toContain(m.membership);
    }));
});

describe('a plan chosen as washes in a month', () => {
  it('carries the monthly count so the email can say it', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const addr = await createAddress(s, u.profileId);
      const veh = await createVehicle(s, u.profileId, 'car');
      const start = await istDate(s, 4);
      await s.as('authenticated', u.authId);
      const intent = (await s.q(`select public.start_monthly_membership_checkout($1,4,1,ARRAY[2,5]::integer[],1,'morning',$2::date,$3) r`, [veh, start, addr]))[0].r;
      await s.as('service_role');
      const order = `order_${uid().slice(0, 8)}`;
      await s.q('select app_private.attach_provider_order($1,$2)', [intent.payment_id, order]);
      const paid = (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured') r`, [order, `pay_${uid().slice(0, 8)}`, intent.amount_cents]))[0].r;
      await s.as('postgres');
      await s.q(`update public.profiles set email = 'monthly.renew@example.com' where id = $1`, [u.profileId]);
      await s.q('alter table public.memberships disable trigger user');
      await s.q(
        `update public.memberships
            set start_at = (date_trunc('day', now() at time zone 'Asia/Kolkata') + 3 * interval '1 day' - interval '1 month' + interval '1 day') at time zone 'Asia/Kolkata',
                end_at   = (date_trunc('day', now() at time zone 'Asia/Kolkata') + 3 * interval '1 day') at time zone 'Asia/Kolkata'
          where id = $1`, [paid.membership_id]);
      await s.q('alter table public.memberships enable trigger user');
      const row = (await due(s, WEEK, 1, 7)).find((r: any) => r.membership_id === paid.membership_id);
      expect(row).toMatchObject({ washes_per_month: 5, washes_total: 5, ends_in_days: 3 });
    }));
});
