/** GREEN tests for 20261004000018_email_log.sql: each email goes out once, and the renewal reminders pick the right memberships. */
import { describe, expect, it } from 'vitest';
import { createCustomer, inTx, paidMembership, serviceId, uid } from './helpers';

const NOPE = /permission denied/i;

/** A paid, active membership whose term now ends `endsInDays` days from today (start and end moved together, by the same rule the table enforces). */
async function endingIn(s: any, endsInDays: number, o: { months?: number } = {}) {
  const m = await paidMembership(s, { months: o.months ?? 1 });
  await s.as('postgres');
  // end = start + months - 1 day, so start = end - months + 1 day. (A membership's terms are locked once it exists; the test moves its dates the way time would.)
  await s.q('alter table public.memberships disable trigger user');
  await s.q(
    `update public.memberships
        set start_at = (date_trunc('day', now() at time zone 'Asia/Kolkata') + $2 * interval '1 day' - make_interval(months => $3) + interval '1 day') at time zone 'Asia/Kolkata',
            end_at   = (date_trunc('day', now() at time zone 'Asia/Kolkata') + $2 * interval '1 day') at time zone 'Asia/Kolkata'
      where id = $1`,
    [m.membership, endsInDays, o.months ?? 1]
  );
  await s.q('alter table public.memberships enable trigger user');
  return m;
}
const due = async (s: any, days = 7) => { await s.as('service_role'); return s.q('select * from public.svc_membership_reminders_due($1, 50)', [days]); };

describe('who can call it', () => {
  it('only the service role and the website database role', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      const calls = [`select public.svc_claim_email('free_wash_confirmation','${uid()}','a@b.test')`, `select public.svc_finish_email('${uid()}', true)`, `select * from public.svc_membership_reminders_due(7, 5)`];
      for (const who of [{ role: 'authenticated', id: c.authId }, { role: 'anon', id: null }] as const) {
        await s.as(who.role, who.id);
        for (const sql of calls) expect(await s.err(sql), sql).toMatch(NOPE);
      }
      // the log itself: a signed-in customer reads nothing (admins only), a visitor is refused
      await s.as('authenticated', c.authId);
      expect(await s.q('select * from public.email_log')).toEqual([]);
      await s.as('anon');
      expect(await s.err('select * from public.email_log')).toMatch(NOPE);
      await s.as('service_role');
      expect(await s.err(calls[2])).toBeNull();
    }));
});

describe('sending once', () => {
  const claim = async (s: any, kind: string, ref: string) => { await s.as('service_role'); return (await s.q('select public.svc_claim_email($1,$2,$3) id', [kind, ref, ' Asha@Example.com ']))[0].id as string | null; };
  const finish = async (s: any, id: string, ok: boolean, err?: string) => { await s.as('service_role'); await s.q('select public.svc_finish_email($1,$2,$3)', [id, ok, err ?? null]); };
  const row = async (s: any, kind: string, ref: string) => { await s.as('postgres'); return (await s.q('select status, attempts, to_email, error, sent_at is not null sent from public.email_log where kind=$1 and ref_id=$2', [kind, ref]))[0]; };

  it('the first claim wins, a sent email is never sent again, and a second claim while sending is refused', async () =>
    inTx(async (s) => {
      const ref = uid();
      const id = await claim(s, 'free_wash_confirmation', ref);
      expect(id).toBeTruthy();
      expect(await claim(s, 'free_wash_confirmation', ref)).toBeNull(); // still sending
      await finish(s, id!, true);
      expect(await row(s, 'free_wash_confirmation', ref)).toEqual({ status: 'sent', attempts: 1, to_email: 'asha@example.com', error: null, sent: true });
      expect(await claim(s, 'free_wash_confirmation', ref)).toBeNull(); // sent
      // a different email about the same thing is its own record
      expect(await claim(s, 'membership_renewal_reminder', ref)).toBeTruthy();
    }));

  it('a failed send can be tried again, three times in all, and then it is left alone', async () =>
    inTx(async (s) => {
      const ref = uid();
      for (let n = 1; n <= 3; n++) {
        const id = await claim(s, 'free_wash_confirmation', ref);
        expect(id, `try ${n}`).toBeTruthy();
        await finish(s, id!, false, 'Resend said no');
      }
      expect(await row(s, 'free_wash_confirmation', ref)).toMatchObject({ status: 'failed', attempts: 3, error: 'Resend said no' });
      expect(await claim(s, 'free_wash_confirmation', ref)).toBeNull();
    }));

  it('a send that never reported back (the server died) is retried after fifteen minutes', async () =>
    inTx(async (s) => {
      const ref = uid();
      expect(await claim(s, 'membership_renewal_reminder', ref)).toBeTruthy();
      await s.as('postgres');
      await s.q(`update public.email_log set updated_at = now() - interval '20 minutes' where ref_id = $1`, [ref]);
      expect(await claim(s, 'membership_renewal_reminder', ref)).toBeTruthy();
      expect((await row(s, 'membership_renewal_reminder', ref)).attempts).toBe(2);
    }));
});

describe('which memberships get a renewal reminder', () => {
  it('one that ends within the week, with an email address, is listed with what the email needs', async () =>
    inTx(async (s) => {
      const m = await endingIn(s, 5);
      const rows = (await due(s)).filter((r: any) => r.membership_id === m.membership);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ customer_profile_id: m.u.profileId, ends_in_days: 5, duration_months: 1, vehicle_type: 'car', washes_done: 0 });
      expect(rows[0].email).toMatch(/@t\.test$/);
      expect(rows[0].washes_total).toBeGreaterThan(0);
    }));

  it('not one that ends later, one already over, or a customer with no email', async () =>
    inTx(async (s) => {
      const later = await endingIn(s, 20);
      const over = await endingIn(s, -2);
      const noMail = await endingIn(s, 3);
      await s.as('postgres');
      await s.q('update public.profiles set email = null where id = $1', [noMail.u.profileId]);
      await s.q('update auth.users set email = null where id = $1', [noMail.u.authId]);
      const ids = (await due(s)).map((r: any) => r.membership_id);
      expect(ids).not.toContain(later.membership);
      expect(ids).not.toContain(over.membership);
      expect(ids).not.toContain(noMail.membership);
    }));

  it('not once the reminder is sent; a failed one stays on the list until it has been tried three times', async () =>
    inTx(async (s) => {
      const m = await endingIn(s, 4);
      const has = async () => (await due(s)).some((r: any) => r.membership_id === m.membership);
      expect(await has()).toBe(true);
      await s.as('service_role');
      const id = (await s.q(`select public.svc_claim_email('membership_renewal_reminder',$1,'x@y.test') id`, [m.membership]))[0].id;
      expect(await has()).toBe(false); // being sent right now
      await s.as('service_role');
      await s.q('select public.svc_finish_email($1, false, $2)', [id, 'boom']);
      expect(await has()).toBe(true); // failed once: try again
      await s.as('service_role');
      const again = (await s.q(`select public.svc_claim_email('membership_renewal_reminder',$1,'x@y.test') id`, [m.membership]))[0].id;
      await s.q('select public.svc_finish_email($1, true, null)', [again]);
      expect(await has()).toBe(false); // sent
    }));

  it('not for a customer who has already renewed the same vehicle', async () =>
    inTx(async (s) => {
      const m = await endingIn(s, 4);
      await s.as('postgres');
      const svc = await serviceId(s, 'car-body-wash');
      const vehicle = (await s.q('select vehicle_id from public.membership_services where membership_id = $1 limit 1', [m.membership]))[0].vehicle_id;
      const renewed = (await s.q(
        `insert into public.memberships (customer_profile_id, status, duration_months, quantity_per_period, start_at, end_at, base_amount_cents, discount_amount_cents, final_amount_cents, pricing_snapshot)
         select customer_profile_id, 'active', 1, 4, s, s + make_interval(months => 1) - interval '1 day', 60000, 0, 60000, '{}'::jsonb
           from (select customer_profile_id, end_at + interval '1 day' as s from public.memberships where id = $1) x returning id`,
        [m.membership]
      ))[0].id;
      await s.q('insert into public.membership_services (membership_id, service_id, vehicle_id, quantity_per_period) values ($1,$2,$3,4)', [renewed, svc, vehicle]);
      const ids = (await due(s, 7)).map((r: any) => r.membership_id);
      expect(ids).not.toContain(m.membership);
    }));

  it('not for an archived customer', async () =>
    inTx(async (s) => {
      const m = await endingIn(s, 3);
      await s.as('postgres');
      await s.q(`update public.profiles set archived_at = now() where id = $1`, [m.u.profileId]);
      expect((await due(s)).map((r: any) => r.membership_id)).not.toContain(m.membership);
    }));
});
