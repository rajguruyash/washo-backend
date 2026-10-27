/**
 * GREEN tests for 20261004000050_traffic.sql: a signed-in person's sign-ins and "seen just now" are recorded for THEM only; the dashboard numbers split customers, specialists and admins and
 * count "now" as the last five minutes and "today" as a Pune day; only an admin whose role has Activity access can read any of it; the tables cannot be read or written directly.
 */
import { describe, expect, it } from 'vitest';
import { createAdmin, createCustomer, createWorker, inTx } from './helpers';

const NOPE = /access|permission denied|Unauthorized/i;

const signIn = async (s: any, who: { authId: string }, method = 'phone', source = 'website') => {
  await s.as('authenticated', who.authId);
  return s.err('select public.record_sign_in($1,$2)', [method, source]);
};
const seen = async (s: any, who: { authId: string }, source = 'website') => {
  await s.as('authenticated', who.authId);
  return (await s.q('select public.record_activity($1) r', [source]))[0].r as boolean;
};
const summary = async (s: any, admin: { authId: string }) => {
  await s.as('authenticated', admin.authId);
  return (await s.q('select public.admin_traffic_summary() r'))[0].r as any;
};
const traffic = async (s: any, admin: { authId: string }, day: string | null = null, days = 14) => {
  await s.as('authenticated', admin.authId);
  return (await s.q('select public.admin_traffic($1::date, $2) r', [day, days]))[0].r as any;
};
const setSeen = async (s: any, profileId: string, minutesAgo: number) => {
  await s.as('postgres');
  await s.q(`update public.user_activity_days set last_seen_at = now() - ($2 || ' minutes')::interval where profile_id = $1`, [profileId, String(minutesAgo)]);
};

describe('recording', () => {
  it('a signed-in person records their own sign-in (and is seen); an unknown method is refused', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      expect(await signIn(s, c, 'phone', 'app')).toBeNull();
      expect(await signIn(s, c, 'google')).toBeNull();
      expect(await signIn(s, c, 'carrier pigeon')).toMatch(/Unknown sign-in method/);
      await s.as('postgres');
      const ev = await s.q('select profile_id, role, method, source from public.sign_in_events order by id');
      expect(ev).toEqual([
        { profile_id: c.profileId, role: 'customer', method: 'phone', source: 'app' },
        { profile_id: c.profileId, role: 'customer', method: 'google', source: 'website' },
      ]);
      expect(await s.q('select source from public.user_activity_days where profile_id = $1', [c.profileId])).toEqual([{ source: 'website' }]); // signing in is being seen
    }));

  it('being seen is one row a day, moved forward each time; a source that is not "app" is the website', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      expect(await seen(s, c)).toBe(true);
      await setSeen(s, c.profileId, 30);
      expect(await seen(s, c, 'app')).toBe(true);
      await s.as('postgres');
      const rows = await s.q('select source, last_seen_at > now() - interval \'1 minute\' as fresh from public.user_activity_days where profile_id = $1', [c.profileId]);
      expect(rows).toEqual([{ source: 'app', fresh: true }]);
      expect(await seen(s, c, 'anything else')).toBe(true);
      await s.as('postgres');
      expect((await s.q('select source from public.user_activity_days where profile_id = $1', [c.profileId]))[0].source).toBe('website');
    }));

  it('nobody signed in records nothing and gets no error; the public cannot call these at all', async () =>
    inTx(async (s) => {
      await s.as('authenticated', null);
      expect((await s.q('select public.record_activity($1) r', ['website']))[0].r).toBe(false);
      await s.as('anon');
      expect(await s.err('select public.record_activity($1)', ['website'])).toMatch(NOPE);
      expect(await s.err('select public.record_sign_in($1,$2)', ['phone', 'website'])).toMatch(NOPE);
    }));

  it('a switched-off person records nothing', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      await s.as('postgres');
      await s.q('update public.profiles set archived_at = now() where id = $1', [c.profileId]);
      expect(await seen(s, c)).toBe(false);
      expect(await signIn(s, c)).toBeNull();
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.sign_in_events where profile_id = $1', [c.profileId]))[0].n).toBe(0);
    }));

  it('the tables cannot be read or written directly, by anyone', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      await s.as('authenticated', c.authId);
      for (const sql of ['select * from public.sign_in_events', 'select * from public.user_activity_days', `insert into public.user_activity_days (profile_id, day) values ('${c.profileId}', current_date)`, 'delete from public.sign_in_events'])
        expect(await s.err(sql), sql).toMatch(NOPE);
      await s.as('anon');
      expect(await s.err('select * from public.sign_in_events')).toMatch(NOPE);
    }));
});

describe('the dashboard numbers', () => {
  it('splits customers, specialists and admins; "now" is the last five minutes, "today" is today', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s, 'super_admin');
      const a = await createCustomer(s);
      const b = await createCustomer(s);
      const c = await createCustomer(s);
      const w = await createWorker(s);
      for (const who of [a, b, c, w, admin]) await seen(s, who);
      await signIn(s, a);
      await signIn(s, a, 'email'); // twice: one person
      await signIn(s, w, 'email');
      await signIn(s, admin, 'admin_email');
      await setSeen(s, b.profileId, 4);
      await setSeen(s, c.profileId, 12); // seen today, but not now

      const r = await summary(s, admin);
      expect(r.window_minutes).toBe(5);
      expect(r.active_now).toEqual({ customers: 2, workers: 1, admins: 1 }); // a and b, the specialist, the admin
      expect(r.active_today).toEqual({ customers: 3, workers: 1, admins: 1 });
      expect(r.signed_in_today).toEqual({ customers: 1, workers: 1, admins: 1, sign_ins: 4 });
    }));

  it('a person last seen yesterday is not today, and a switched-off person is not counted', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s, 'super_admin');
      const a = await createCustomer(s);
      const gone = await createCustomer(s);
      await seen(s, a);
      await seen(s, gone);
      await s.as('postgres');
      await s.q(`update public.user_activity_days set day = day - 1, last_seen_at = now() - interval '1 day' where profile_id = $1`, [a.profileId]);
      await s.q('update public.profiles set archived_at = now() where id = $1', [gone.profileId]);
      const r = await summary(s, admin);
      expect(r.active_today.customers).toBe(0);
      expect(r.active_now.customers).toBe(0);
    }));

  it('only an admin whose role has Activity access can read it; everybody else is refused', async () =>
    inTx(async (s) => {
      const boss = await createAdmin(s, 'super_admin');
      const ops = await createAdmin(s, 'operations');
      const c = await createCustomer(s);
      const w = await createWorker(s);
      expect((await summary(s, boss)).active_now).toBeDefined();
      for (const who of [ops, c, w]) {
        await s.as('authenticated', who.authId);
        expect(await s.err('select public.admin_traffic_summary()')).toMatch(NOPE);
        expect(await s.err('select public.admin_traffic(null, 14)')).toMatch(NOPE);
      }
      await s.as('anon');
      expect(await s.err('select public.admin_traffic_summary()')).toMatch(NOPE);
    }));
});

describe('the Traffic tab', () => {
  it('lists who is on the site now, who was active and who signed in, with their details, newest first', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s, 'super_admin');
      const a = await createCustomer(s);
      const b = await createCustomer(s);
      await s.as('postgres');
      await s.q(`update public.profiles set full_name = 'Asha Kulkarni', phone = '+919876500001' where id = $1`, [a.profileId]);
      await s.q(`update public.profiles set full_name = 'Ravi Patil', phone = '+919876500002' where id = $1`, [b.profileId]);
      await signIn(s, a, 'phone');
      await seen(s, b, 'app');
      await signIn(s, b, 'email', 'app');
      await setSeen(s, a.profileId, 3);
      await setSeen(s, b.profileId, 1);

      const t = await traffic(s, admin);
      expect(t.day).toBe(t.today);
      expect(t.live.map((p: any) => p.name)).toEqual(['Ravi Patil', 'Asha Kulkarni']); // newest first
      expect(t.live[0]).toMatchObject({ role: 'customer', phone: '+919876500002', source: 'app' });
      expect(t.people.find((p: any) => p.name === 'Asha Kulkarni')).toMatchObject({ sign_ins: 1, role: 'customer' });
      expect(t.sign_ins.map((e: any) => `${e.name}:${e.method}:${e.source}`).sort()).toEqual(['Asha Kulkarni:phone:website', 'Ravi Patil:email:app']);
    }));

  it('a day is a Pune day: a sign-in at 00:15 in Pune belongs to that Pune day, whatever time zone the server is in', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s, 'super_admin');
      const a = await createCustomer(s);
      await s.as('postgres');
      // 18:45 UTC on 10 January is 00:15 on 11 January in Pune
      await s.q(`insert into public.sign_in_events (profile_id, role, method, source, created_at) values ($1, 'customer', 'phone', 'website', '2026-01-10 18:45:00+00')`, [a.profileId]);
      await s.q(`insert into public.user_activity_days (profile_id, day, last_seen_at, first_seen_at) values ($1, '2026-01-11', '2026-01-10 18:45:00+00', '2026-01-10 18:45:00+00')`, [a.profileId]);
      expect((await traffic(s, admin, '2026-01-11')).sign_ins).toHaveLength(1);
      expect((await traffic(s, admin, '2026-01-10')).sign_ins).toHaveLength(0);
      expect((await traffic(s, admin, '2026-01-11')).people).toHaveLength(1);
      const series = (await traffic(s, admin, null, 60)).days as { date: string }[];
      expect(series).toHaveLength(60);
    }));

  it('the series has one entry per day ending today, oldest first, and counts customers apart from the team', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s, 'super_admin');
      const a = await createCustomer(s);
      const w = await createWorker(s);
      await seen(s, a);
      await signIn(s, a);
      await seen(s, w);
      const t = await traffic(s, admin, null, 7);
      expect(t.days).toHaveLength(7);
      expect(t.days.map((d: any) => d.date)).toEqual([...t.days.map((d: any) => d.date)].sort());
      expect(t.days.at(-1)).toMatchObject({ date: t.today, customers_active: 1, customers_signed_in: 1, team_active: 1 });
      expect(t.days[0]).toMatchObject({ customers_active: 0, customers_signed_in: 0, team_active: 0 });
    }));

  it('a day in the future is today, and the number of days is kept sensible', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s, 'super_admin');
      const t = await traffic(s, admin, '2999-01-01', 9999);
      expect(t.day).toBe(t.today);
      expect(t.days).toHaveLength(60);
      expect((await traffic(s, admin, '1999-01-01', 0)).days).toHaveLength(1);
    }));
});
