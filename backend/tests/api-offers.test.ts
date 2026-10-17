/**
 * The offer on the home screen over the website API: an admin who manages Campaigns writes an offer (a discount or a complimentary wash) and switches it on; the public
 * endpoint (what the website strip and the app's Home read, signed in or not) then shows it; nobody else can write it. (Supabase is a local stand-in; the rules are the database's.)
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, boot, customerWithVehicle, expectOk, fake, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

type Offer = { id: string; kind: string; headline: string; details: string | null; code: string | null; is_active: boolean; status: string };
const uniq = () => crypto.randomBytes(3).toString('hex').toUpperCase();

/** Other tests may leave offers behind; each one here starts from none. */
const clean = () => fake.admin.query('delete from public.promo_offers');
const visible = async () => (expectOk(await new Client().get('/api/offers')).body.offers as { id: string; headline: string; code: string | null }[]);

describe('offers', () => {
  it('marketing makes one, it is off until switched on, then a visitor and a customer both see it, and it goes when switched off', async () => {
    await clean();
    const mkt = await staffClient('admin', { access: 'marketing' });
    const o = expectOk(await mkt.c.post('/api/admin/offers', { kind: 'discount', headline: 'Extra 10% off memberships', details: 'This week only.' })).body.offer as Offer;
    expect(o).toMatchObject({ is_active: false, status: 'off' });
    expect(await visible()).toHaveLength(0);

    expectOk(await mkt.c.post(`/api/admin/offers/${o.id}/active`, { active: true }));
    expect(await visible()).toEqual([expect.objectContaining({ id: o.id, headline: 'Extra 10% off memberships', code: null })]);
    const cust = await customerWithVehicle('car');
    expect(expectOk(await cust.c.get('/api/offers')).body.offers).toHaveLength(1);

    expectOk(await mkt.c.post(`/api/admin/offers/${o.id}/active`, { active: false }));
    expect(await visible()).toHaveLength(0);
  });

  it('changing the words shows on the public endpoint at once, and a complimentary wash can be made switched on', async () => {
    await clean();
    const ops = await staffClient('admin', { access: 'operations' });
    const o = expectOk(await ops.c.post('/api/admin/offers', { kind: 'complimentary_wash', headline: 'A free wash for new customers', active: true })).body.offer as Offer;
    expect((await visible())[0].headline).toBe('A free wash for new customers');
    expectOk(await ops.c.put(`/api/admin/offers/${o.id}`, { kind: 'complimentary_wash', headline: 'Your first wash is on us', active: true }));
    expect((await visible())[0].headline).toBe('Your first wash is on us');
    const list = expectOk(await ops.c.get('/api/admin/offers')).body.offers as Offer[];
    expect(list.map((x) => x.id)).toContain(o.id);
  });

  it('a discount can show a coupon code, only while that coupon works', async () => {
    await clean();
    const sup = await staffClient('admin', { access: 'super_admin' });
    const code = `OFF${uniq()}`;
    const coupon = expectOk(await sup.c.post('/api/admin/coupons', { code, discount_bp: 1000, label: 'Extra 10%', applies_to: 'both' })).body.coupon as { id: string };
    expectOk(await sup.c.post('/api/admin/offers', { kind: 'discount', headline: 'Extra 10% off', code, active: true }));
    expect((await visible())[0].code).toBe(code);
    expectOk(await sup.c.post(`/api/admin/coupons/${coupon.id}/active`, { active: false }));
    expect((await visible())[0].code).toBeNull();
    const bad = await sup.c.post('/api/admin/offers', { kind: 'discount', headline: 'Ghost code', code: 'NOSUCH99' });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toMatch(/no coupon with the code/i);
  });

  it('deleting removes it', async () => {
    await clean();
    const mkt = await staffClient('admin', { access: 'marketing' });
    const o = expectOk(await mkt.c.post('/api/admin/offers', { kind: 'discount', headline: 'Short lived', active: true })).body.offer as Offer;
    expectOk(await mkt.c.post(`/api/admin/offers/${o.id}/delete`, {}));
    expect(await visible()).toHaveLength(0);
    expect((await mkt.c.post(`/api/admin/offers/${o.id}/delete`, {})).status).toBe(422);
  });

  it('says what is wrong with what was typed', async () => {
    const mkt = await staffClient('admin', { access: 'marketing' });
    expect((await mkt.c.post('/api/admin/offers', { kind: 'bogus', headline: 'Hello there' })).status).toBe(400);
    expect((await mkt.c.post('/api/admin/offers', { kind: 'discount', headline: 'ab' })).status).toBe(400);
    expect((await mkt.c.post('/api/admin/offers', { kind: 'discount', headline: 'x'.repeat(61) })).status).toBe(400);
    expect((await mkt.c.post('/api/admin/offers', { kind: 'discount', headline: 'Fine', details: 'y'.repeat(141) })).status).toBe(400);
    const past = await mkt.c.post('/api/admin/offers', { kind: 'discount', headline: 'Too late', ends_on: '2020-01-01', active: true });
    expect(past.status).toBe(422);
    expect(past.body.message).toMatch(/last day cannot be in the past/i);
  });

  it('only Campaigns managers can change offers; the one gate closes it to support, finance, customers and visitors', async () => {
    const sup = await staffClient('admin', { access: 'support' });
    const fin = await staffClient('admin', { access: 'finance' });
    const cust = await customerWithVehicle('car');
    const id = crypto.randomUUID();
    for (const who of [sup, fin, cust]) {
      expect((await who.c.get('/api/admin/offers')).status).toBe(403);
      expect((await who.c.post('/api/admin/offers', { kind: 'discount', headline: 'Not allowed' })).status).toBe(403);
      expect((await who.c.put(`/api/admin/offers/${id}`, { kind: 'discount', headline: 'Not allowed' })).status).toBe(403);
      expect((await who.c.post(`/api/admin/offers/${id}/active`, { active: true })).status).toBe(403);
      expect((await who.c.post(`/api/admin/offers/${id}/delete`, {})).status).toBe(403);
    }
    const visitor = new Client();
    expect((await visitor.get('/api/admin/offers')).status).toBe(401);
    expect((await visitor.post('/api/admin/offers', { kind: 'discount', headline: 'Not allowed' })).status).toBe(401);
    expect((await visitor.get('/api/offers')).status).toBe(200); // reading what is live is open to everyone
  });
});
