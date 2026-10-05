import { describe, expect, it } from 'vitest';
import { COUNT_FROM_RUPEES, anchorTotalCents } from './CountPrice';

describe('price count-down anchors', () => {
  it('each service counts down from the number the owner chose to its rate-card price', () => {
    expect(COUNT_FROM_RUPEES).toEqual({ 'bike-body-wash': 150, 'car-body-wash': 200, 'car-deep-cleaning': 350, 'suv-deep-cleaning': 500 });
    const rateCard: Record<string, number> = { 'bike-body-wash': 65, 'car-body-wash': 150, 'car-deep-cleaning': 220, 'suv-deep-cleaning': 250 };
    for (const [code, from] of Object.entries(COUNT_FROM_RUPEES)) expect(from).toBeGreaterThan(rateCard[code]); // always counts DOWN to the real price
  });

  it('a pack counts down from the same plan priced at the anchors', () => {
    // 2 per week for a month on a car: 4 body + 4 deep
    expect(anchorTotalCents([{ code: 'car-body-wash', quantity: 4 }, { code: 'car-deep-cleaning', quantity: 4 }])).toBe((4 * 200 + 4 * 350) * 100);
  });

  it('gives no anchor (so the plain price shows) when a line is unknown', () => {
    expect(anchorTotalCents([{ code: 'something-new', quantity: 4 }])).toBeNull();
    expect(anchorTotalCents([{ quantity: 4 }])).toBeNull();
  });
});
