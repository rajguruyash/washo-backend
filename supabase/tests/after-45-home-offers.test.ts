/**
 * GREEN tests for 20261004000045_home_offers.sql: an admin who manages Campaigns (super admin, operations, marketing) writes an offer (a discount or a complimentary wash) and switches
 * it on; everyone, signed in or not, then sees it; a coupon code is only shown while that coupon works; nobody else can write or read the offers; the website and app never see an
 * offer that is off, has not started or has ended.
 */
import { describe, expect, it } from 'vitest';
import { createAdmin, createCustomer, createWorker, inTx } from './helpers';

const NOPE = /access|permission denied|Unauthorized/i;
type Offer = { id: string; kind: string; headline: string; details: string | null; code: string | null; is_active: boolean; status: string; code_works: boolean | null };

const save = async (s: any, who: { authId: string }, o: { id?: string | null; kind?: string; headline?: string; details?: string | null; code?: string | null; from?: string | null; to?: string | null; active?: boolean } = {}) => {
  await s.as('authenticated', who.authId);
  return s.err('select public.admin_save_offer($1,$2,$3,$4,$5,$6::date,$7::date,$8)', [o.id ?? null, o.kind ?? 'discount', o.headline ?? 'Extra 10% off memberships', o.details ?? null, o.code ?? null, o.from ?? null, o.to ?? null, o.active ?? false]);
};
const made = async (s: any, who: { authId: string }, o: Parameters<typeof save>[2] = {}) => {
  await s.as('authenticated', who.authId);
  return (await s.q('select public.admin_save_offer($1,$2,$3,$4,$5,$6::date,$7::date,$8) r', [o.id ?? null, o.kind ?? 'discount', o.headline ?? 'Extra 10% off memberships', o.details ?? null, o.code ?? null, o.from ?? null, o.to ?? null, o.active ?? false]))[0].r as Offer;
};
const live = async (s: any, as: 'anon' | { authId: string }) => {
  if (as === 'anon') await s.as('anon'); else await s.as('authenticated', as.authId);
  return (await s.q('select public.get_live_offers() r'))[0].r as { id: string; kind: string; headline: string; details: string | null; code: string | null }[];
};
const switchTo = async (s: any, who: { authId: string }, id: string, on: boolean) => {
  await s.as('authenticated', who.authId);
  return s.err('select public.admin_set_offer_active($1,$2)', [id, on]);
};
const day = (n: number) => new Date(Date.now() + 5.5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);

describe('the offer on the home screen', () => {
  it('starts switched off, shows to everyone once it is on, and goes when it is switched off', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'marketing');
      const c = await createCustomer(s);
      const o = await made(s, a, { headline: 'Extra 10% off memberships', details: 'This week only.' });
      expect(o).toMatchObject({ is_active: false, status: 'off', kind: 'discount', details: 'This week only.' });
      expect(await live(s, 'anon')).toHaveLength(0);

      expect(await switchTo(s, a, o.id, true)).toBeNull();
      for (const who of ['anon', c] as const) {
        const l = await live(s, who);
        expect(l).toHaveLength(1);
        expect(l[0]).toMatchObject({ id: o.id, kind: 'discount', headline: 'Extra 10% off memberships', details: 'This week only.', code: null });
      }
      expect(await switchTo(s, a, o.id, false)).toBeNull();
      expect(await live(s, 'anon')).toHaveLength(0);
    }));

  it('a complimentary wash is an offer too, and can be made switched on', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'operations');
      const o = await made(s, a, { kind: 'complimentary_wash', headline: 'A free wash for new customers', active: true });
      expect(o).toMatchObject({ kind: 'complimentary_wash', status: 'live' });
      expect((await live(s, 'anon')).map((x) => x.kind)).toEqual(['complimentary_wash']);
    }));

  it('shows the newest first, at most three', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'super_admin');
      for (let i = 1; i <= 4; i++) await made(s, a, { headline: `Offer number ${i}`, active: true });
      // (inside one test transaction they would all carry the same moment; real offers are made one request at a time)
      await s.as('postgres');
      await s.q(`update public.promo_offers set created_at = now() - ((5 - substring(headline from '\\d+')::int) || ' hours')::interval where headline like 'Offer number %'`);
      const l = await live(s, 'anon');
      expect(l).toHaveLength(3);
      expect(l[0].headline).toBe('Offer number 4');
    }));

  it('respects its first and last day (Pune time)', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'marketing');
      const later = await made(s, a, { headline: 'Starts tomorrow', from: day(1), to: day(5), active: true });
      expect(later.status).toBe('scheduled');
      const today = await made(s, a, { headline: 'Runs today', from: day(0), to: day(0), active: true });
      expect(today.status).toBe('live');
      expect((await live(s, 'anon')).map((x) => x.headline)).toEqual(['Runs today']);

      // an offer whose last day has passed is never shown, even though it was left switched on
      await s.as('postgres');
      await s.q(`update public.promo_offers set ends_on = $1::date, starts_on = $2::date where id = $3`, [day(-1), day(-3), today.id]);
      expect(await live(s, 'anon')).toHaveLength(0);
      await s.as('authenticated', a.authId);
      expect(((await s.q('select public.admin_list_offers() l'))[0].l as Offer[]).find((x) => x.id === today.id)?.status).toBe('ended');
      expect(await switchTo(s, a, today.id, true)).toMatch(/last day has passed/i);
    }));
});

describe('the coupon code on a discount', () => {
  const coupon = async (s: any, who: { authId: string }, code = 'EXTRA10', extra: { expires?: string | null; max?: number | null } = {}) => {
    await s.as('authenticated', who.authId);
    return (await s.q('select public.admin_save_coupon(null,$1,1000,$2,$3::date,$4,true,$5) r', [code, 'Extra 10%', extra.expires ?? null, extra.max ?? null, 'both']))[0].r as { id: string };
  };

  it('shows the code while the coupon works, and leaves it out once the coupon is switched off', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'super_admin');
      const k = await coupon(s, a);
      const o = await made(s, a, { code: 'extra10', active: true });
      expect(o.code).toBe('EXTRA10');
      expect(o.code_works).toBe(true);
      expect((await live(s, 'anon'))[0].code).toBe('EXTRA10');

      await s.as('authenticated', a.authId);
      await s.q('select public.admin_set_coupon_active($1,false)', [k.id]);
      expect((await live(s, 'anon'))[0]).toMatchObject({ headline: 'Extra 10% off memberships', code: null });
      await s.as('authenticated', a.authId);
      expect(((await s.q('select public.admin_list_offers() l'))[0].l as Offer[])[0].code_works).toBe(false);
    }));

  it('refuses a code that is not a coupon, and a code on a complimentary wash', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'marketing');
      expect(await save(s, a, { code: 'NOSUCH1' })).toMatch(/no coupon with the code NOSUCH1/i);
      expect(await save(s, a, { code: 'bad code!' })).toMatch(/3 to 20 letters and numbers/i);
      await coupon(s, a, 'REAL5');
      expect(await save(s, a, { kind: 'complimentary_wash', code: 'REAL5' })).toMatch(/only a discount/i);
      expect(await save(s, a, { code: 'REAL5' })).toBeNull();
    }));
});

describe('the words and the dates', () => {
  it('needs a known kind, a headline of a sensible length, a short extra line, and dates in order', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'marketing');
      expect(await save(s, a, { kind: 'bogus' })).toMatch(/discount or a complimentary wash/i);
      expect(await save(s, a, { headline: 'ab' })).toMatch(/3 to 60 characters/i);
      expect(await save(s, a, { headline: 'x'.repeat(61) })).toMatch(/3 to 60 characters/i);
      expect(await save(s, a, { details: 'y'.repeat(141) })).toMatch(/140 characters/i);
      expect(await save(s, a, { from: day(3), to: day(1) })).toMatch(/last day cannot be before/i);
      expect(await save(s, a, { to: day(-1), active: true })).toMatch(/last day cannot be in the past/i);
      expect(await save(s, a, { headline: 'x'.repeat(60), details: 'y'.repeat(140) })).toBeNull();
    }));

  it('changing an offer keeps its identity, and is written to the audit log', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'marketing');
      const o = await made(s, a);
      const o2 = await made(s, a, { id: o.id, headline: 'Extra 12% off memberships', active: true });
      expect(o2).toMatchObject({ id: o.id, headline: 'Extra 12% off memberships', is_active: true });
      await switchTo(s, a, o.id, false);
      await s.as('postgres');
      const events = (await s.q(`select event_type from public.audit_events where entity_id = $1 order by created_at`, [o.id])).map((r: any) => r.event_type);
      expect([...events].sort()).toEqual(['offer_changed', 'offer_created', 'offer_switched_off']);   // (all three share one moment inside the test's transaction)
    }));

  it('deleting removes it for good, and says so in the audit log', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'super_admin');
      const o = await made(s, a, { active: true });
      await s.as('authenticated', a.authId);
      await s.q('select public.admin_delete_offer($1)', [o.id]);
      expect(await live(s, 'anon')).toHaveLength(0);
      await s.as('authenticated', a.authId);
      expect(await s.err('select public.admin_delete_offer($1)', [o.id])).toMatch(/no longer exists/i);
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.audit_events where entity_id = $1 and event_type = 'offer_deleted'`, [o.id]))[0].n).toBe(1);
    }));
});

describe('who may', () => {
  it('support, finance, specialists, customers and signed-out callers cannot make, list, switch or delete offers', async () =>
    inTx(async (s) => {
      const boss = await createAdmin(s, 'super_admin');
      const o = await made(s, boss);
      const c = await createCustomer(s);
      const w = await createWorker(s);
      const sup = await createAdmin(s, 'support');
      const fin = await createAdmin(s, 'finance');
      for (const who of [c, w, sup, fin]) {
        expect(await save(s, who), JSON.stringify(who.authId)).toMatch(NOPE);
        await s.as('authenticated', who.authId);
        expect(await s.err('select public.admin_list_offers()')).toMatch(NOPE);
        expect(await switchTo(s, who, o.id, true)).toMatch(NOPE);
        await s.as('authenticated', who.authId);
        expect(await s.err('select public.admin_delete_offer($1)', [o.id])).toMatch(NOPE);
      }
      await s.as('anon');
      expect(await s.err(`select public.admin_save_offer(null,'discount','Hello there',null,null,null,null,true)`)).toMatch(NOPE);
      expect(await s.err('select public.admin_list_offers()')).toMatch(NOPE);
    }));

  it('everyone can read what is live, nobody can read or change the table directly', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s, 'super_admin');
      const c = await createCustomer(s);
      await made(s, a, { active: true });
      expect(await live(s, 'anon')).toHaveLength(1);
      for (const who of [a, c]) {
        await s.as('authenticated', who.authId);
        expect(await s.err('select * from public.promo_offers')).toMatch(/permission denied/i);
        expect(await s.err(`insert into public.promo_offers (kind, headline) values ('discount','Sneaky offer')`)).toMatch(/permission denied/i);
      }
      await s.as('anon');
      expect(await s.err('select * from public.promo_offers')).toMatch(/permission denied/i);
    }));
});
