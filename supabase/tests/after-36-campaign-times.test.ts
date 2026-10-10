/**
 * GREEN tests for 20261004000036_campaign_times.sql: a free-wash campaign's claims open and close at an exact time (Pune time), decided by the clock; a campaign with no times keeps
 * opening at the start of its first day and closing at the end of its last day.
 */
import { describe, expect, it } from 'vitest';
import { createAdmin, createCustomer, createVehicle, inTx, istDate, uid } from './helpers';

const NOT_ADMIN = /admin access required|permission denied/i;

/** A campaign inserted directly with the exact times given as SQL expressions (relative to now()). */
async function timed(s: any, o: { opens: string; closes: string; active?: boolean; code?: string; useBy?: string }) {
  await s.as('postgres');
  const useBy = o.useBy ?? (await istDate(s, 8));
  return (await s.q(
    `insert into public.campaigns (code, name, is_active, claim_opens_on, claim_closes_on, claim_opens_at, claim_closes_at, use_by_date, total_cap, pack_offer_days, pack_offer_bp_1, pack_offer_bp_2, pack_offer_bp_3plus, new_customers_only)
     values ($1, 'Timed free wash', $2, ((${o.opens}) at time zone 'Asia/Kolkata')::date, ((${o.closes}) at time zone 'Asia/Kolkata')::date, ${o.opens}, ${o.closes}, $3::date, 100, 14, 500, 1000, 1500, false) returning id`,
    [o.code ?? `t-${uid().slice(0, 8)}`, o.active ?? true, useBy]
  ))[0].id as string;
}
/** A campaign with no times at all (how every campaign was before): dates only. */
async function dated(s: any, o: { opens: number; closes: number }) {
  const opens = await istDate(s, o.opens), closes = await istDate(s, o.closes), useBy = await istDate(s, 8);
  await s.as('postgres');
  return (await s.q(
    `insert into public.campaigns (code, name, is_active, claim_opens_on, claim_closes_on, use_by_date, total_cap, pack_offer_days, pack_offer_bp_1, pack_offer_bp_2, pack_offer_bp_3plus, new_customers_only)
     values ($1, 'Dated free wash', true, $2, $3, $4, 100, 14, 500, 1000, 1500, false) returning id`, [`d-${uid().slice(0, 8)}`, opens, closes, useBy]
  ))[0].id as string;
}
async function person(s: any) {
  const u = await createCustomer(s);
  await s.as('postgres');
  const addr = (await s.q(`insert into public.customer_addresses (customer_profile_id, society_name, building_block, flat_number, parking_location, is_default) values ($1,'Yashwin Orizzonte','B',$2,'Basement P1',true) returning id`, [u.profileId, `F-${uid().slice(0, 6)}`]))[0].id as string;
  const veh = await createVehicle(s, u.profileId, 'car');
  return { u, addr, veh };
}
const claimSql = `select public.claim_campaign_wash($1::uuid, $2::uuid, $3::date, 'morning', $4::uuid, 'Basement P1') r`;
const claim = async (s: any, p: any, camp: string) => {
  const day = await istDate(s, 3);
  await s.as('authenticated', p.u.authId);
  return s.err(claimSql, [camp, p.veh, day, p.addr]);
};
const status = async (s: any) => { await s.as('anon'); return (await s.q('select public.get_campaign_status() r'))[0].r; };

describe('claims open and close by the clock', () => {
  it('before the opening time: "upcoming", and a claim is refused with the exact time', async () =>
    inTx(async (s) => {
      const p = await person(s);
      const id = await timed(s, { opens: `now() + interval '2 hours'`, closes: `now() + interval '3 days'` });
      const st = (await status(s)).campaign;
      expect(st).toMatchObject({ id, state: 'upcoming' });
      await s.as('postgres');
      const expected = (await s.q(`select to_char(claim_opens_at at time zone 'Asia/Kolkata', 'FMDD Mon, FMHH12:MI am') t from public.campaigns where id = $1`, [id]))[0].t;
      expect(await claim(s, p, id)).toBe(`This offer opens on ${expected}`);
      expect(expected).toMatch(/^\d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (am|pm)$/);
    }));

  it('from the opening time to the closing time: "open", and a claim works', async () =>
    inTx(async (s) => {
      const p = await person(s);
      const id = await timed(s, { opens: `now() - interval '1 minute'`, closes: `now() + interval '5 hours'` });
      expect((await status(s)).campaign).toMatchObject({ id, state: 'open' });
      expect(await claim(s, p, id)).toBeNull();
    }));

  it('at the closing time it is over: no campaign on the website, and a claim is refused', async () =>
    inTx(async (s) => {
      const p = await person(s);
      const id = await timed(s, { opens: `now() - interval '2 hours'`, closes: `now()` });   // closes at this very instant
      expect((await status(s)).campaign).toBeNull();
      expect(await claim(s, p, id)).toBe('This offer has ended');
      const late = await timed(s, { opens: `now() - interval '3 days'`, closes: `now() - interval '1 second'` });
      expect(await claim(s, p, late)).toBe('This offer has ended');
    }));

  it('at the opening time exactly it is already open', async () =>
    inTx(async (s) => {
      const p = await person(s);
      const id = await timed(s, { opens: `now()`, closes: `now() + interval '1 day'` });
      expect((await status(s)).campaign).toMatchObject({ id, state: 'open' });
      expect(await claim(s, p, id)).toBeNull();
    }));

  it('hours matter inside a single day: a window that opened an hour ago and closes in an hour is open, one that closed an hour ago on the same day is not', async () =>
    inTx(async (s) => {
      const p = await person(s);
      const live = await timed(s, { opens: `now() - interval '1 hour'`, closes: `now() + interval '1 hour'` });
      const over = await timed(s, { opens: `now() - interval '3 hours'`, closes: `now() - interval '1 hour'` });
      expect(await claim(s, p, over)).toBe('This offer has ended');
      expect(await claim(s, p, live)).toBeNull();
    }));

  it('a campaign that is switched off is not running, whatever the times', async () =>
    inTx(async (s) => {
      const p = await person(s);
      const id = await timed(s, { opens: `now() - interval '1 hour'`, closes: `now() + interval '1 day'`, active: false });
      expect((await status(s)).campaign).toBeNull();
      expect(await claim(s, p, id)).toBe('This offer is not running right now');
    }));

  it('the website shows the open campaign before one that is still to come', async () =>
    inTx(async (s) => {
      const soon = await timed(s, { opens: `now() + interval '1 day'`, closes: `now() + interval '5 days'` });
      const now = await timed(s, { opens: `now() - interval '1 hour'`, closes: `now() + interval '2 days'` });
      expect((await status(s)).campaign.id).toBe(now);
      await s.as('postgres');
      await s.q(`update public.campaigns set is_active = false where id = $1`, [now]);
      expect((await status(s)).campaign).toMatchObject({ id: soon, state: 'upcoming' });
    }));

  it('the status carries the exact times and the dates (Pune dates, not UTC dates)', async () =>
    inTx(async (s) => {
      // 00:30 in Pune is the evening before in UTC: the date must still be the Pune one
      await s.as('postgres');
      const id = await timed(s, { opens: `timestamptz '2099-03-10 00:30:00+05:30'`, closes: `timestamptz '2099-03-12 23:45:00+05:30'`, useBy: '2099-12-31' });
      expect((await s.q('select claim_opens_on::text a, claim_closes_on::text b from public.campaigns where id = $1', [id]))[0]).toEqual({ a: '2099-03-10', b: '2099-03-12' });
      await s.q(`update public.campaigns set claim_opens_at = now() - interval '1 hour', claim_closes_at = now() + interval '1 day' where id = $1`, [id]);
      const c = (await status(s)).campaign;
      expect(c.id).toBe(id);
      expect(Date.parse(c.claim_opens_at)).toBeLessThan(Date.now());
      expect(Date.parse(c.claim_closes_at)).toBeGreaterThan(Date.now());
      expect(c).toHaveProperty('claim_opens_on');
      expect(c).toHaveProperty('claim_closes_on');
    }));
});

describe('a campaign with no times keeps its old behaviour', () => {
  it('open from the start of its first day to the end of its last day', async () =>
    inTx(async (s) => {
      const p = await person(s);
      const today = await dated(s, { opens: 0, closes: 0 });          // one day, today
      expect((await status(s)).campaign).toMatchObject({ id: today, state: 'open', claim_opens_at: null, claim_closes_at: null });
      expect(await claim(s, p, today)).toBeNull();
      const gone = await dated(s, { opens: -3, closes: -1 });
      expect(await claim(s, await person(s), gone)).toBe('This offer has ended');
      const later = await dated(s, { opens: 2, closes: 4 });
      const e = await claim(s, await person(s), later);
      expect(e).toMatch(/^This offer opens on \d{1,2} [A-Z][a-z]{2}$/);      // a date only, no time of day
    }));
});

describe('the admin sets the times', () => {
  const save = (extra: string, useBy = 'current_date + 6') => `select public.admin_save_campaign(null,$1,'Navratri free wash','',current_date,current_date,${useBy},50,null,14,500,1000,1500,true,false${extra}) r`;

  it('saves both times, derives the dates, and returns them; the old call without times still works and has none', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s, 'super_admin');
      await s.as('authenticated', admin.authId);
      const id = (await s.q(save(`, timestamptz '2099-03-10 00:30:00+05:30', timestamptz '2099-03-12 20:00:00+05:30'`, `date '2099-12-31'`), [`n-${uid().slice(0, 6)}`]))[0].r;
      await s.as('postgres');
      const row = (await s.q(`select claim_opens_on::text a, claim_closes_on::text b, to_char(claim_opens_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') c, to_char(claim_closes_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') d from public.campaigns where id = $1`, [id]))[0];
      expect(row).toEqual({ a: '2099-03-10', b: '2099-03-12', c: '2099-03-10 00:30', d: '2099-03-12 20:00' });
      await s.as('authenticated', admin.authId);
      const old = (await s.q(save(''), [`o-${uid().slice(0, 6)}`]))[0].r;
      await s.as('postgres');
      expect((await s.q('select claim_opens_at, claim_closes_at from public.campaigns where id = $1', [old]))[0]).toEqual({ claim_opens_at: null, claim_closes_at: null });
    }));

  it('changing a campaign changes its times, and saving without times returns it to whole days', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s, 'super_admin');
      await s.as('authenticated', admin.authId);
      const id = (await s.q(save(`, now() + interval '1 hour', now() + interval '2 days'`), [`c-${uid().slice(0, 6)}`]))[0].r;
      await s.q(`select public.admin_save_campaign($1,'','Navratri free wash','',current_date,current_date + 2,current_date + 6,50,null,14,500,1000,1500,null,null, now() + interval '5 hours', now() + interval '6 hours')`, [id]);
      await s.as('postgres');
      const a = (await s.q(`select (claim_closes_at - claim_opens_at) = interval '1 hour' ok from public.campaigns where id = $1`, [id]))[0].ok;
      expect(a).toBe(true);
      await s.as('authenticated', admin.authId);
      await s.q(`select public.admin_save_campaign($1,'','Navratri free wash','',current_date,current_date + 2,current_date + 6,50,null,14,500,1000,1500)`, [id]);
      await s.as('postgres');
      expect((await s.q('select claim_opens_at, claim_closes_at from public.campaigns where id = $1', [id]))[0]).toEqual({ claim_opens_at: null, claim_closes_at: null });
    }));

  it('says what is wrong: only one time, closing before opening, closing at the opening time', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s, 'super_admin');
      await s.as('authenticated', admin.authId);
      const code = () => `e-${uid().slice(0, 6)}`;
      expect(await s.err(save(`, now(), null`), [code()])).toMatch(/Set both the time claims open and the time they close/);
      expect(await s.err(save(`, null, now()`), [code()])).toMatch(/Set both the time claims open and the time they close/);
      expect(await s.err(save(`, now() + interval '2 hours', now() + interval '1 hour'`), [code()])).toMatch(/Claims must close after they open/);
      expect(await s.err(save(`, now() + interval '2 hours', now() + interval '2 hours'`), [code()])).toMatch(/Claims must close after they open/);
    }));

  it('only an admin may set them; the table cannot be written to directly', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      await s.as('authenticated', c.authId);
      expect(await s.err(save(`, now(), now() + interval '1 day'`), [`x-${uid().slice(0, 6)}`])).toMatch(NOT_ADMIN);
      expect(await s.err(`update public.campaigns set claim_opens_at = now()`)).toMatch(/permission denied/);
      await s.as('anon');
      expect(await s.err(save(`, now(), now() + interval '1 day'`), [`x-${uid().slice(0, 6)}`])).toMatch(NOT_ADMIN);
    }));
});
