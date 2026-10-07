/** GREEN tests for 20261004000002_catalog_and_pricing.sql */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createAdmin, createCustomer, inTx } from './helpers';

const quote = async (s: any, vtype: string, pattern: any[], months: number) => {
  await s.as('service_role');
  const r = await s.q(`select app_private.compute_membership_quote($1::public.vehicle_type, $2::jsonb, $3) as q`, [vtype, JSON.stringify(pattern), months]);
  return r[0].q;
};
const quoteErr = async (s: any, vtype: string, pattern: any, months: number) => {
  await s.as('service_role');
  return s.err(`select app_private.compute_membership_quote('${vtype}'::public.vehicle_type, '${JSON.stringify(pattern)}'::jsonb, ${months})`);
};
const days = (...kinds: string[]) => kinds.map((kind, i) => ({ weekday: [1, 3, 5][i], kind }));

describe('WASHO rate card', () => {
  it('has exactly the canonical unit prices (paise), SUV rows included', async () =>
    inTx(async (s) => {
      const rows = await s.q(`
        select sv.code, r.vehicle_type::text vt, r.base_amount_cents c
          from public.pricing_rules r join public.services sv on sv.id=r.service_id
         where r.active and r.duration_months=1 and r.quantity_tier=1 order by 1,2`);
      expect(rows.map((r: any) => `${r.code}/${r.vt}=${r.c}`)).toEqual([
        'bike-body-wash/bike=6500',
        'car-body-wash/car=15000',
        'car-body-wash/suv=15000',
        'car-deep-cleaning/car=22000',
        'car-deep-cleaning/suv=22000',
        'suv-deep-cleaning/suv=25000',
      ]);
    }));

  it('versioned the outdated price instead of editing it, and deactivated (not deleted) the stray 3-month rule', async () =>
    inTx(async (s) => {
      const hist = await s.q(`
        select r.rule_version v, r.base_amount_cents c, r.active a, r.duration_months d from public.pricing_rules r
          join public.services sv on sv.id=r.service_id where sv.code='car-body-wash' and r.vehicle_type='car' order by d, v`);
      expect(hist).toEqual([
        { v: 1, c: 14000, a: false, d: 1 }, // old price kept for history
        { v: 2, c: 15000, a: true, d: 1 },
        { v: 1, c: 40000, a: false, d: 3 }, // stray rule deactivated, still present
      ]);
    }));

  it('re-running the migration changes nothing (idempotent)', async () =>
    inTx(async (s) => {
      const sql = fs.readFileSync(path.join(__dirname, '../migrations/20261004000002_catalog_and_pricing.sql'), 'utf8');
      const before = (await s.q('select count(*)::int n from public.pricing_rules'))[0].n;
      const opts = (await s.q('select count(*)::int n from public.membership_service_options'))[0].n;
      await s.c.query(sql);
      expect((await s.q('select count(*)::int n from public.pricing_rules'))[0].n).toBe(before);
      expect((await s.q('select count(*)::int n from public.membership_service_options'))[0].n).toBe(opts);
      expect((await s.q('select count(*)::int n from public.membership_discount_rules'))[0].n).toBe(11); // 3 frequency + 4 duration rules from migration 02, plus 4-7 a week from migration 10
    }));

  it('classifies services as body / deep', async () =>
    inTx(async (s) => {
      const r = await s.q(`select code, wash_kind from public.services order by code`);
      expect(r).toEqual([
        { code: 'bike-body-wash', wash_kind: 'body' },
        { code: 'car-body-wash', wash_kind: 'body' },
        { code: 'car-deep-cleaning', wash_kind: 'deep' },
        { code: 'suv-deep-cleaning', wash_kind: 'deep' },
      ]);
    }));
});

describe('membership quote: every discount is an explicit line', () => {
  it('1/week, 1 month, no discount: 4 washes at list price', async () =>
    inTx(async (s) => {
      const q = await quote(s, 'car', days('body').slice(0, 1), 1);
      expect(q).toMatchObject({ washes_total: 4, subtotal_cents: 60000, total_discount_cents: 0, final_cents: 60000 });
      expect(q.lines).toEqual([expect.objectContaining({ code: 'car-body-wash', per_week: 1, quantity: 4, unit_cents: 15000, line_cents: 60000 })]);
    }));

  it('2/week is 1 body + 1 deep, with no discount', async () =>
    inTx(async (s) => {
      const q = await quote(s, 'car', days('body', 'deep').slice(0, 2), 1);
      expect(q.subtotal_cents).toBe(4 * 15000 + 4 * 22000);
      expect(q.frequency_discount.cents).toBe(0);
      expect(q.final_cents).toBe(148000);
    }));

  it('3/week gets exactly 10% frequency discount (2 body + 1 deep)', async () =>
    inTx(async (s) => {
      const q = await quote(s, 'car', days('body', 'body', 'deep'), 1);
      expect(q.washes_total).toBe(12);
      expect(q.subtotal_cents).toBe(8 * 15000 + 4 * 22000);
      expect(q.frequency_discount).toMatchObject({ bp: 1000, cents: 20800 });
      expect(q.duration_discount.cents).toBe(0);
      expect(q.final_cents).toBe(208000 - 20800);
    }));

  it('3 months x 3/week: 10% then 5% = 14.5%, under the cap, so no cap line', async () =>
    inTx(async (s) => {
      const q = await quote(s, 'car', days('body', 'body', 'deep'), 3);
      expect(q.subtotal_cents).toBe(624000);
      expect(q.frequency_discount.cents).toBe(62400);
      expect(q.duration_discount).toMatchObject({ bp: 500, cents: 28080 }); // 5% of what remains after frequency
      expect(q.cap).toMatchObject({ applied: false, adjustment_cents: 0 });
      expect(q.final_cents).toBe(624000 - 62400 - 28080);
    }));

  it('12 months x 3/week would be 23.5%: the 15% cap applies and is shown as its own line', async () =>
    inTx(async (s) => {
      const q = await quote(s, 'car', days('body', 'body', 'deep'), 12);
      expect(q.subtotal_cents).toBe(2496000);
      expect(q.frequency_discount.cents).toBe(249600);
      expect(q.duration_discount.cents).toBe(336960);
      expect(q.cap).toMatchObject({ max_bp: 1500, applied: true, adjustment_cents: 586560 - 374400 });
      expect(q.total_discount_cents).toBe(374400); // exactly 15% of the subtotal
      expect(q.final_cents).toBe(2496000 - 374400);
    }));

  it('6 months x 3/week is capped too (19% -> 15%)', async () =>
    inTx(async (s) => {
      const q = await quote(s, 'car', days('body', 'deep', 'body'), 6);
      expect(q.total_discount_cents).toBe(Math.round(q.subtotal_cents * 0.15));
      expect(q.cap.applied).toBe(true);
    }));

  it('12 months x 1/week gets the 15% duration discount and is exactly at the cap', async () =>
    inTx(async (s) => {
      const q = await quote(s, 'bike', days('body').slice(0, 1), 12);
      expect(q.subtotal_cents).toBe(48 * 6500);
      expect(q.duration_discount.cents).toBe(46800);
      expect(q.cap.applied).toBe(false);
      expect(q.final_cents).toBe(312000 - 46800);
    }));

  it('SUV: body is Car Body Wash at the car price, deep is SUV Deep Cleaning', async () =>
    inTx(async (s) => {
      const q = await quote(s, 'suv', days('body', 'deep').slice(0, 2), 1);
      const byKind = Object.fromEntries(q.lines.map((l: any) => [l.kind, l]));
      expect(byKind.body).toMatchObject({ code: 'car-body-wash', unit_cents: 15000 });
      expect(byKind.deep).toMatchObject({ code: 'suv-deep-cleaning', unit_cents: 25000 });
      expect(q.final_cents).toBe(4 * 15000 + 4 * 25000);
    }));

  it('rounds half-up to the paisa', async () =>
    inTx(async (s) => {
      await s.q(`update public.pricing_rules set base_amount_cents=6501
                  where active and service_id=(select id from public.services where code='bike-body-wash')`);
      const q = await quote(s, 'bike', days('body').slice(0, 1), 3);
      expect(q.subtotal_cents).toBe(12 * 6501); // 78012
      expect(q.duration_discount.cents).toBe(3901); // 5% = 3900.6 -> 3901
    }));

  it('the cap is a setting, not code', async () =>
    inTx(async (s) => {
      await s.q(`update public.pricing_settings set value_int = 2500 where key='max_total_discount_bp'`);
      const q = await quote(s, 'car', days('body', 'body', 'deep'), 12);
      expect(q.cap.applied).toBe(false);
      expect(q.total_discount_cents).toBe(249600 + 336960); // full 23.5%, since cap is now 25%
    }));
});

describe('weekly pattern validation', () => {
  const cases: [string, string, any, number, RegExp][] = [
    ['0 washes', 'car', [], 1, /1 to 7 washes/],
    ['4 washes a week', 'car', [0, 1, 2, 3, 4, 5, 6, 7].map((d) => ({ weekday: d, kind: 'body' })), 1, /1 to 7 washes/],
    ['the same weekday twice', 'car', [{ weekday: 1, kind: 'body' }, { weekday: 1, kind: 'deep' }], 1, /different day/],
    ['a deep cleaning for a bike', 'bike', days('deep').slice(0, 1), 1, /Bikes have one wash type/],
    ['a 2-month membership', 'car', days('body').slice(0, 1), 2, /1, 3, 6 or 12 months/],
    ['a bad weekday', 'car', [{ weekday: 9, kind: 'body' }], 1, /weekday/],
    ['a bad kind', 'car', [{ weekday: 1, kind: 'premium' }], 1, /kind/],
  ];
  for (const [name, vtype, pattern, months, re] of cases) {
    it(`rejects ${name}`, async () => inTx(async (s) => expect(await quoteErr(s, vtype, pattern, months)).toMatch(re)));
  }

  it('allows bikes to repeat the bike wash 2 or 3 times a week', async () =>
    inTx(async (s) => {
      expect((await quote(s, 'bike', days('body', 'body'), 1)).subtotal_cents).toBe(8 * 6500);
      expect((await quote(s, 'bike', days('body', 'body', 'body'), 1)).frequency_discount.bp).toBe(1000);
    }));

  it('allows any mix: 2 a week as two Body washes or two Deep cleanings, 3 as all one kind', async () =>
    inTx(async (s) => {
      expect((await quote(s, 'car', days('body', 'body'), 1)).subtotal_cents).toBe(8 * 15000);
      expect((await quote(s, 'car', days('deep', 'deep'), 1)).subtotal_cents).toBe(8 * 22000);
      expect((await quote(s, 'suv', days('deep', 'deep', 'deep'), 1)).subtotal_cents).toBe(12 * 25000);
      expect((await quote(s, 'car', days('body', 'body', 'body'), 1)).frequency_discount.bp).toBe(1000);
    }));

  it('allows 3/week as 1 body + 2 deep', async () =>
    inTx(async (s) => expect((await quote(s, 'car', days('body', 'deep', 'deep'), 1)).subtotal_cents).toBe(4 * 15000 + 8 * 22000)));
});

describe('access', () => {
  it('the calculator is internal: customers and anon cannot call it', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      await s.as('authenticated', u.authId);
      expect(await s.err(`select app_private.compute_membership_quote('car','[{"weekday":1,"kind":"body"}]',1)`)).toMatch(/permission denied/);
      await s.as('anon');
      expect(await s.err(`select app_private.unit_price_cents(gen_random_uuid(),'car')`)).toMatch(/permission denied/);
    }));

  it('the public catalogue is readable without logging in and shows prices + discounts', async () =>
    inTx(async (s) => {
      await s.as('anon');
      const c = (await s.q('select public.get_public_catalog() c'))[0].c;
      expect(c.services).toHaveLength(4);
      const car = c.services.find((x: any) => x.code === 'car-body-wash');
      expect(car.unit_prices).toEqual([{ vehicle_type: 'car', price_cents: 15000 }, { vehicle_type: 'suv', price_cents: 15000 }]);
      expect(c.discounts.filter((d: any) => d.kind === 'duration').map((d: any) => d.discount_bp)).toEqual([0, 500, 1000, 1500]);
      expect(c.max_total_discount_bp).toBe(1500);
      expect(JSON.stringify(c)).not.toMatch(/cost|margin/i);
    }));

  it('discount rules are public but only admins can change them', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const admin = await createAdmin(s);
      await s.as('authenticated', u.authId);
      expect(await s.q('select * from public.membership_discount_rules')).toHaveLength(11);
      await s.q(`update public.membership_discount_rules set discount_bp = 9999 where kind='frequency' and key_value=3`);
      await s.as('postgres');
      expect((await s.q(`select discount_bp from public.membership_discount_rules where kind='frequency' and key_value=3`))[0].discount_bp).toBe(1000);
      await s.as('authenticated', admin.authId);
      await s.q(`update public.membership_discount_rules set discount_bp = 1200 where kind='frequency' and key_value=3`);
      await s.as('postgres');
      expect((await s.q(`select discount_bp from public.membership_discount_rules where kind='frequency' and key_value=3`))[0].discount_bp).toBe(1200);
    }));
});
