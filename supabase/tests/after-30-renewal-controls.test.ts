/**
 * GREEN tests for 20261004000030_renewal_email_controls.sql: the Admin page controls for the renewal emails (switches, days, hours), who may change them,
 * and the "who is coming up" view that backs the page.
 */
import { describe, expect, it } from 'vitest';
import { createAdmin, createCustomer, inTx, paidMembership, uid, type AdminAccess } from './helpers';

const WEEK = 'membership_renewal_reminder';
const LAST = 'membership_renewal_last_call';
const ENDED = 'membership_renewal_ended';
const DEFAULTS = { on: true, week: { on: true, days: 7 }, last: { on: true, days: 2 }, ended: { on: true, days: 3 }, from_hour: 9, to_hour: 20 };
const as = async (s: any, u: { authId: string }) => s.as('authenticated', u.authId);
const save = async (s: any, v: unknown) => (await s.q('select public.admin_set_renewal_settings($1::jsonb) r', [JSON.stringify(v)]))[0].r;
const trySave = (s: any, v: unknown) => s.err(`select public.admin_set_renewal_settings('${JSON.stringify(v)}'::jsonb)`);
const denied = /your admin role cannot do this|admin access required|permission denied/i;

/** A paid membership whose last day is `days` from today, belonging to a customer who has an email. */
async function endsIn(s: any, days: number) {
  const m = await paidMembership(s, { months: 1 });
  await s.as('postgres');
  await s.q(`update public.profiles set email = $2 where id = $1`, [m.u.profileId, `renew-${uid().slice(0, 8)}@example.com`]);
  await s.q('alter table public.memberships disable trigger user');
  await s.q(
    `update public.memberships
        set start_at = (date_trunc('day', now() at time zone 'Asia/Kolkata') + $2 * interval '1 day' - interval '1 month' + interval '1 day') at time zone 'Asia/Kolkata',
            end_at   = (date_trunc('day', now() at time zone 'Asia/Kolkata') + $2 * interval '1 day') at time zone 'Asia/Kolkata'
      where id = $1`,
    [m.membership, days]
  );
  await s.q('alter table public.memberships enable trigger user');
  return m;
}

describe('the settings', () => {
  it('start as exactly what the emails always did, and the job and the Admin page read the same thing', async () =>
    inTx(async (s) => {
      await s.as('postgres');
      expect((await s.q(`select value from public.app_settings where key = 'renewal_emails'`))[0].value).toEqual(DEFAULTS);
      await s.as('service_role');
      expect((await s.q('select public.svc_renewal_settings() r'))[0].r).toEqual(DEFAULTS);
      const admin = await createAdmin(s, 'operations');
      await as(s, admin);
      expect((await s.q('select public.admin_get_renewal_settings() r'))[0].r).toEqual(DEFAULTS);
    }));

  it('a half-written row is filled in from the defaults, so it can never break the job', async () =>
    inTx(async (s) => {
      await s.as('postgres');
      await s.q(`update public.app_settings set value = '{"on": false, "week": {"days": 5}}'::jsonb where key = 'renewal_emails'`);
      await s.as('service_role');
      expect((await s.q('select public.svc_renewal_settings() r'))[0].r).toEqual({ ...DEFAULTS, on: false, week: { on: true, days: 5 } });
    }));

  it('only the service role and the website database role can read them for the job', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      await s.as('authenticated', c.authId);
      expect(await s.err('select public.svc_renewal_settings()')).toMatch(/permission denied/i);
      await s.as('anon');
      expect(await s.err('select public.svc_renewal_settings()')).toMatch(/permission denied/i);
      await s.as('washo_api');
      expect(await s.err('select public.svc_renewal_settings()')).toBeNull();
    }));
});

describe('who may look and who may change', () => {
  it('operations and the super admin change them; finance and support can look; marketing, customers and strangers cannot', async () =>
    inTx(async (s) => {
      const ok = { ...DEFAULTS, week: { on: true, days: 5 } };
      for (const role of ['operations', 'super_admin'] as AdminAccess[]) {
        const a = await createAdmin(s, role);
        await as(s, a);
        expect(await save(s, ok)).toEqual(ok);
        expect((await s.q('select public.admin_get_renewal_settings() r'))[0].r).toEqual(ok);
      }
      for (const role of ['finance', 'support'] as AdminAccess[]) {
        const a = await createAdmin(s, role);
        await as(s, a);
        expect(await s.err('select public.admin_get_renewal_settings()')).toBeNull();
        expect(await s.err('select public.admin_renewals_overview()')).toBeNull();
        expect(await trySave(s, DEFAULTS)).toMatch(denied);
        expect(await s.err(`select public.admin_renewal_row('${uid()}')`)).toMatch(denied);
      }
      const marketing = await createAdmin(s, 'marketing');
      const noRole = await createAdmin(s, null);
      const customer = await createCustomer(s);
      for (const who of [marketing, noRole, customer]) {
        await as(s, who);
        expect(await s.err('select public.admin_get_renewal_settings()')).toMatch(denied);
        expect(await s.err('select public.admin_renewals_overview()')).toMatch(denied);
        expect(await trySave(s, DEFAULTS)).toMatch(denied);
      }
      await s.as('anon');
      expect(await s.err('select public.admin_get_renewal_settings()')).toMatch(/permission denied/i);
    }));

  it('saving is audited with what it was and what it became', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'operations');
      await as(s, a);
      const next = { ...DEFAULTS, on: false, ended: { on: false, days: 3 } };
      await save(s, next);
      await s.as('postgres');
      const ev = await s.q(`select metadata from public.audit_events where event_type = 'renewal_settings_changed' and actor_profile_id = $1`, [a.profileId]);
      expect(ev).toHaveLength(1);
      expect(ev[0].metadata).toEqual({ from: DEFAULTS, to: next });
    }));
});

describe('what is refused', () => {
  it('days outside what each email allows, switches that are not true or false, and hours that make no sense', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'operations');
      await as(s, a);
      const bad: Array<[string, unknown, RegExp]> = [
        ['week 0 days', { ...DEFAULTS, week: { on: true, days: 0 } }, /"week" email can go out 1 to 14/],
        ['week 15 days', { ...DEFAULTS, week: { on: true, days: 15 } }, /"week" email can go out 1 to 14/],
        ['last 8 days', { ...DEFAULTS, last: { on: true, days: 8 } }, /"last" email can go out 0 to 7/],
        ['ended 0 days', { ...DEFAULTS, ended: { on: true, days: 0 } }, /"ended" email can go out 1 to 14.*after the membership ended/],
        ['days as text', { ...DEFAULTS, week: { on: true, days: '7' } }, /whole number of days/],
        ['days with a fraction', { ...DEFAULTS, week: { on: true, days: 2.5 } }, /whole number of days/],
        ['negative days', { ...DEFAULTS, last: { on: true, days: -1 } }, /whole number of days/],
        ['master switch missing', { week: DEFAULTS.week, last: DEFAULTS.last, ended: DEFAULTS.ended, from_hour: 9, to_hour: 20 }, /on or off/],
        ['master switch as text', { ...DEFAULTS, on: 'yes' }, /on or off/],
        ['step switch missing', { ...DEFAULTS, last: { days: 2 } }, /"last" email on or off/],
        ['hours as text', { ...DEFAULTS, from_hour: '9' }, /whole numbers/],
        ['hour 24 to start', { ...DEFAULTS, from_hour: 24, to_hour: 24 }, /start before they end/],
        ['hours the wrong way round', { ...DEFAULTS, from_hour: 20, to_hour: 9 }, /start before they end/],
        ['no hours at all', { ...DEFAULTS, from_hour: 9, to_hour: 9 }, /start before they end/],
        ['to_hour 25', { ...DEFAULTS, to_hour: 25 }, /start before they end/],
      ];
      for (const [name, v, msg] of bad) expect(await trySave(s, v), name).toMatch(msg);
      expect(await s.err(`select public.admin_set_renewal_settings('[]'::jsonb)`)).toMatch(/Send the renewal email settings/);
      expect(await s.err(`select public.admin_set_renewal_settings(null)`)).toMatch(/Send the renewal email settings/);
      // nothing above changed anything
      expect((await s.q('select public.admin_get_renewal_settings() r'))[0].r).toEqual(DEFAULTS);
    }));

  it('accepts the edges: the first hour to the last, last-day email on the last day itself, and everything switched off', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'super_admin');
      await as(s, a);
      const edge = { on: false, week: { on: false, days: 14 }, last: { on: false, days: 0 }, ended: { on: false, days: 14 }, from_hour: 0, to_hour: 24 };
      expect(await save(s, edge)).toEqual(edge);
      const edge2 = { on: true, week: { on: true, days: 1 }, last: { on: true, days: 7 }, ended: { on: true, days: 1 }, from_hour: 23, to_hour: 24 };
      expect(await save(s, edge2)).toEqual(edge2);
    }));
});

describe('who is coming up', () => {
  it('lists memberships ending within 14 days (or that ended within 7), with what each email did', async () =>
    inTx(async (s) => {
      const soon = await endsIn(s, 3);
      const later = await endsIn(s, 10);
      const justEnded = await endsIn(s, -4);
      const far = await endsIn(s, 40);
      const longAgo = await endsIn(s, -20);
      await s.q(`insert into public.email_log (kind, ref_id, to_email, status, attempts, sent_at, updated_at) values ($1,$2,'x@example.com','sent',1, now() - interval '1 day', now() - interval '1 day')`, [WEEK, soon.membership]);
      await s.q(`insert into public.email_log (kind, ref_id, to_email, status, attempts, error, updated_at) values ($1,$2,'x@example.com','failed',3,'Mailbox full', now())`, [LAST, soon.membership]);

      const admin = await createAdmin(s, 'operations');
      await as(s, admin);
      const o = (await s.q('select public.admin_renewals_overview() o'))[0].o;
      const byId = Object.fromEntries(o.upcoming.map((r: any) => [r.membership_id, r]));
      expect(byId[soon.membership]).toBeDefined();
      expect(byId[later.membership]).toBeDefined();
      expect(byId[justEnded.membership]).toBeDefined();
      expect(byId[far.membership]).toBeUndefined();
      expect(byId[longAgo.membership]).toBeUndefined();
      expect(byId[soon.membership].days_left).toBe(3);
      expect(byId[justEnded.membership].days_left).toBe(-4);
      expect(byId[soon.membership].renewed).toBe(false);
      expect(byId[soon.membership].steps.week.status).toBe('sent');
      expect(byId[soon.membership].steps.last).toMatchObject({ status: 'failed', attempts: 3, error: 'Mailbox full' });
      expect(byId[soon.membership].steps.ended).toBeNull();
      expect(byId[later.membership].steps.week).toBeNull();
      expect(byId[soon.membership].email).toMatch(/@example\.com$/);
      // soonest first
      const order = o.upcoming.map((r: any) => r.membership_id).filter((id: string) => [soon.membership, later.membership, justEnded.membership].includes(id));
      expect(order).toEqual([justEnded.membership, soon.membership, later.membership]);
      // the latest emails sent
      const mine = o.recent.filter((r: any) => r.membership_id === soon.membership).map((r: any) => r.kind).sort();
      expect(mine).toEqual([LAST, WEEK].sort());
      expect(o.recent.length).toBeLessThanOrEqual(30);
    }));

  it('says a membership has been renewed once the same vehicle has another active membership running past it', async () =>
    inTx(async (s) => {
      const m = await endsIn(s, 4);
      await s.as('postgres');
      await s.q('alter table public.memberships disable trigger user');
      await s.q(
        `insert into public.memberships (customer_profile_id, status, duration_months, quantity_per_period, start_at, end_at, base_amount_cents, discount_amount_cents, final_amount_cents, pricing_snapshot)
         select customer_profile_id, 'active', 1, 12, end_at + interval '1 day', end_at + interval '1 month', 100000, 0, 100000, '{}'::jsonb from public.memberships where id = $1`, [m.membership]);
      await s.q('alter table public.memberships enable trigger user');
      await s.q(`insert into public.membership_services (membership_id, service_id, vehicle_id, quantity_per_period)
                 select (select id from public.memberships where customer_profile_id = $2 and id <> $1 order by created_at desc limit 1), service_id, vehicle_id, quantity_per_period
                   from public.membership_services where membership_id = $1 limit 1`, [m.membership, m.u.profileId]);
      const admin = await createAdmin(s, 'operations');
      await as(s, admin);
      const o = (await s.q('select public.admin_renewals_overview() o'))[0].o;
      expect(o.upcoming.find((r: any) => r.membership_id === m.membership).renewed).toBe(true);
    }));
});

describe('"send it now" row', () => {
  it('gives the email what it needs, for any active or expired membership whatever its dates, and only to someone who manages memberships', async () =>
    inTx(async (s) => {
      const m = await endsIn(s, 25);
      const admin = await createAdmin(s, 'operations');
      await as(s, admin);
      const row = (await s.q('select public.admin_renewal_row($1) r', [m.membership]))[0].r;
      expect(row).toMatchObject({ membership_id: m.membership, ends_in_days: 25, duration_months: 1 });
      expect(row.email).toMatch(/@example\.com$/);
      expect(row.washes_total).toBeGreaterThan(0);
      expect(row.washes_done).toBe(0);
      expect(row).toHaveProperty('washes_per_month');
      expect(await s.err(`select public.admin_renewal_row('${uid()}')`)).toMatch(/Membership not found/);
    }));
});

describe('the older job still works', () => {
  it('the switches change nothing in the database function that lists who is due; they are applied by the website', async () =>
    inTx(async (s) => {
      const m = await endsIn(s, 3);
      await s.as('postgres');
      await s.q(`update public.app_settings set value = jsonb_set(value, '{on}', 'false') where key = 'renewal_emails'`);
      await s.as('service_role');
      const rows = await s.q('select membership_id from public.svc_membership_renewals_due($1,1,7,null,0,200)', [WEEK]);
      expect(rows.map((r: any) => r.membership_id)).toContain(m.membership);
    }));
});
