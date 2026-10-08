/** The few seconds of memory behind the public pages: it speeds up first looks, and never shows an admin's change late. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

let setPublicCacheEnabled: (on: boolean) => void;
beforeAll(async () => {
  await boot();
  ({ setPublicCacheEnabled } = await import('../src/publicCache')); // after boot: the server's configuration is read the first time it is loaded
  setPublicCacheEnabled(true);
});
afterAll(async () => {
  setPublicCacheEnabled(false);
  await shutdown();
});

const lead = async (c = new Client()) => expectOk(await c.get('/api/catalog')).body.booking_rules.on_demand_min_lead_hours as number;
const setLeadInDb = (n: number) => fake.admin.query(`update public.pricing_settings set value_int = $1 where key = 'on_demand_min_lead_hours'`, [n]);

describe('the catalogue', () => {
  it('is remembered for a moment, and an admin changing a setting shows at once', async () => {
    const admin = await staffClient('admin');
    const original = await lead();
    const other = original === 5 ? 6 : 5;
    await setLeadInDb(other); // changed behind the website's back
    expect(await lead()).toBe(original); // still the remembered answer: nobody waited on the database
    expectOk(await admin.c.put('/api/admin/pricing-settings', { key: 'on_demand_min_lead_hours', value: other }));
    expect(await lead()).toBe(other); // the admin's own change emptied it
    expectOk(await admin.c.put('/api/admin/pricing-settings', { key: 'on_demand_min_lead_hours', value: original }));
    expect(await lead()).toBe(original);
  });

  it('many visitors at once get the same answer from one lookup', async () => {
    const all = await Promise.all(Array.from({ length: 8 }, () => new Client().get('/api/catalog')));
    expect(new Set(all.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(all.every((r) => r.status === 200)).toBe(true);
  });
});

describe('the campaign banner', () => {
  it('a visitor sees a remembered answer; a signed-in customer always sees their own, fresh', async () => {
    await fake.admin.query('update public.campaigns set is_active = false');
    const admin = await staffClient('admin');
    const made = expectOk(await admin.c.post('/api/admin/campaigns', { code: `cache-${Date.now()}`, name: 'Cache test offer', claim_opens_on: istDate(0), claim_closes_on: istDate(3), use_by_date: istDate(8), total_cap: 100, pack_offer_days: 14, pack_bp_1: 500, pack_bp_2: 1000, pack_bp_3plus: 1500, new_customers_only: false }));
    const id = made.body.campaign_id as string;
    expectOk(await admin.c.post(`/api/admin/campaigns/${id}/active`, { active: true }));

    const visitor = async () => expectOk(await new Client().get('/api/campaign')).body.campaign;
    expect((await visitor()).spots_left).toBe(100);
    const n = await customerWithVehicle('car');
    const claimed = expectOk(await n.c.post('/api/campaign/claim', { campaign_id: id, vehicle_id: n.vehicle.id, address_id: n.addr.id }));
    expect(claimed.body.booking_id).toBeTruthy();
    expect((await visitor()).spots_left).toBe(99); // the claim emptied the memory: the count is right straight away
    // the customer's own view carries their claim
    expect(expectOk(await n.c.get('/api/campaign')).body.me).toMatchObject({ state: 'booked' });
    // a change made behind the website's back is not seen by visitors until the memory is emptied or runs out ...
    await fake.admin.query('update public.campaigns set total_cap = 50 where id = $1', [id]);
    expect((await visitor()).spots_left).toBe(99);
    // ... but an admin editing anything empties it
    expectOk(await admin.c.post(`/api/admin/campaigns/${id}/active`, { active: false }));
    expect((await new Client().get('/api/campaign')).body.campaign).toBeNull();
  });
});

describe('a visitor\'s price estimate', () => {
  it('is the same for the same plan, and a customer\'s own estimate is worked out for them', async () => {
    const body = { vehicle_type: 'car', weekly_pattern: [{ weekday: 1, kind: 'body' }, { weekday: 4, kind: 'deep' }], duration_months: 3 };
    const a = expectOk(await new Client().post('/api/membership-estimate', body));
    const b = expectOk(await new Client().post('/api/membership-estimate', body));
    expect(b.body).toEqual(a.body);
    const n = await customerWithVehicle('car');
    expectOk(await n.c.post('/api/membership-estimate', body));
  });
});
