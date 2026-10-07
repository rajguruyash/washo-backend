/** GREEN tests for 20261004000010_membership_up_to_7_and_estimate.sql */
import { describe, expect, it } from 'vitest';
import { createCustomer, inTx, paidMembership } from './helpers';

const wk = (kinds: string[]) => kinds.map((kind, i) => ({ weekday: i, kind })); // weekdays 0..6, all different
const est = async (s: any, role: 'anon' | 'authenticated', vt: string, pattern: any[], months: number, authId?: string) => {
  await s.as(role, authId);
  return (await s.q(`select public.estimate_membership_price($1::public.vehicle_type, $2::jsonb, $3) q`, [vt, JSON.stringify(pattern), months]))[0].q;
};
const estErr = async (s: any, vt: string, pattern: any[], months: number) => {
  await s.as('anon');
  return s.err(`select public.estimate_membership_price('${vt}'::public.vehicle_type, '${JSON.stringify(pattern)}'::jsonb, ${months})`);
};

describe('1 to 7 washes a week', () => {
  it('prices every frequency from the base per-wash rates: 65 bike, 150 car body, 220 car deep, 250 SUV deep', async () =>
    inTx(async (s) => {
      // car, 7 a week = 4 body + 3 deep, 1 month: body 16 x 150, deep 12 x 220 = 5040; 10% frequency discount
      const car7 = await est(s, 'anon', 'car', wk(['body', 'deep', 'body', 'deep', 'body', 'deep', 'body']), 1);
      expect(car7).toMatchObject({ washes_total: 28, subtotal_cents: 504000, final_cents: 453600 });
      expect(car7.frequency_discount).toMatchObject({ bp: 1000, cents: 50400 });

      // bike, 5 a week for 3 months: 60 washes x 65; 10% then 5%; under the 15% cap
      const bike5 = await est(s, 'anon', 'bike', wk(['body', 'body', 'body', 'body', 'body']), 3);
      expect(bike5).toMatchObject({ washes_total: 60, subtotal_cents: 390000, final_cents: 333450 });
      expect(bike5.cap.applied).toBe(false);

      // SUV, 4 a week = 2 body (car rate) + 2 deep (SUV rate), 1 month: 8 x 150 + 8 x 250 = 3200
      const suv4 = await est(s, 'anon', 'suv', wk(['body', 'deep', 'body', 'deep']), 1);
      expect(suv4.subtotal_cents).toBe(320000);
      expect(suv4.lines.map((l: any) => `${l.code}:${l.quantity}x${l.unit_cents}`).sort()).toEqual(['car-body-wash:8x15000', 'suv-deep-cleaning:8x25000']);

      // the old tiers are unchanged
      expect((await est(s, 'anon', 'car', wk(['body']), 1)).final_cents).toBe(60000); // 4 x 150, no discount
      expect((await est(s, 'anon', 'car', wk(['body', 'deep']), 1)).final_cents).toBe(148000); // 600 + 880
      expect((await est(s, 'anon', 'car', wk(['body', 'deep', 'body']), 12)).cap.applied).toBe(true); // 10% + 15% is capped at 15%
    }));

  it('any mix of Body and Deep is allowed (even all one kind); bikes have one wash type; 8 a week does not exist', async () =>
    inTx(async (s) => {
      // the mix is the customer's: four Body washes, or five Deep cleanings, are fine (migration 16)
      expect((await est(s, 'anon', 'car', wk(['body', 'body', 'body', 'body']), 1)).subtotal_cents).toBe(16 * 15000);
      expect((await est(s, 'anon', 'car', wk(['deep', 'deep', 'deep', 'deep', 'deep']), 1)).subtotal_cents).toBe(20 * 22000);
      expect(await estErr(s, 'bike', wk(['body', 'deep', 'body', 'body']), 1)).toMatch(/Bikes have one wash type/);
      expect(await estErr(s, 'car', [...wk(['body', 'deep', 'body', 'deep', 'body', 'deep', 'body']), { weekday: 7, kind: 'deep' }], 1)).toMatch(/1 to 7 washes/);
      expect(await estErr(s, 'car', [{ weekday: 1, kind: 'body' }, { weekday: 1, kind: 'deep' }, { weekday: 2, kind: 'body' }, { weekday: 3, kind: 'deep' }], 1)).toMatch(/different day/);
    }));

  it('the estimate is public, but the internal calculator is not, and nothing is stored', async () =>
    inTx(async (s) => {
      const before = (await s.q('select count(*)::int n from public.membership_requests'))[0].n;
      const u = await createCustomer(s);
      expect((await est(s, 'authenticated', 'car', wk(['body']), 1, u.authId)).final_cents).toBe(60000);
      await s.as('anon');
      expect(await s.err(`select app_private.compute_membership_quote('car'::public.vehicle_type, '[{"weekday":1,"kind":"body"}]'::jsonb, 1)`)).toMatch(/permission denied/);
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.membership_requests'))[0].n).toBe(before);
    }));

  it('the 4-7 a week frequency discount is data, not code', async () =>
    inTx(async (s) => {
      await s.as('postgres');
      const rows = await s.q(`select key_value k, discount_bp bp from public.membership_discount_rules where kind='frequency' and active order by 1`);
      expect(rows).toEqual([1, 2, 3, 4, 5, 6, 7].map((k) => ({ k, bp: k >= 3 ? 1000 : 0 })));
    }));

  it('a 5-a-week and a 7-a-week request go through request -> quote -> pay and schedule every wash on different days', async () =>
    inTx(async (s) => {
      const five = await paidMembership(s, { pattern: [1, 2, 3, 4, 5].map((d, i) => ({ weekday: d, kind: i % 2 ? 'deep' : 'body' })), startDays: 3 });
      expect(five.washes).toHaveLength(20); // 5 x 4 weeks x 1 month
      expect(new Set(five.washes.map((w: any) => w.d)).size).toBe(20);

      const seven = await paidMembership(s, { pattern: wk(['body', 'deep', 'body', 'deep', 'body', 'deep', 'body']), startDays: 3 });
      expect(seven.washes).toHaveLength(28);
      expect(new Set(seven.washes.map((w: any) => w.d)).size).toBe(28); // one wash per vehicle per day
      await s.as('postgres');
      const r = (await s.q(`select frequency_per_week f, quoted_amount_cents q from public.membership_requests where id = $1`, [seven.requestId]))[0];
      expect(r).toEqual({ f: 7, q: 453600 });
    }));
});
