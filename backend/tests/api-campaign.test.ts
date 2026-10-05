/**
 * The free-wash campaign over the website API: the Admin page creates and runs it, a visitor sees it, a new customer claims a free
 * wash, and after the wash the pack offer shows up in the price and is charged. Supabase is a local stand-in; the rules are real.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PATTERN_3, boot, expectOk, fake, istDate, randomPhone, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

const dbOne = async (sql: string, params: unknown[] = []) => (await fake.admin.query(sql, params)).rows[0];
const uniq = () => crypto.randomBytes(3).toString('hex');
const ONE = [{ weekday: 1, kind: 'body' }];

/** Only one campaign is live at a time on the website, so each test starts from a clean slate. */
async function reset() {
  await fake.admin.query('update public.campaigns set is_active = false');
}

const campaignBody = (o: Record<string, unknown> = {}) => ({
  code: `navratri-${uniq()}`, name: 'Navratri free wash', description: 'A free body wash for new customers.',
  claim_opens_on: istDate(0), claim_closes_on: istDate(3), use_by_date: istDate(7),
  total_cap: 100, daily_cap: 15, pack_offer_days: 14, pack_bp_1: 500, pack_bp_2: 1000, pack_bp_3plus: 1500, ...o,
});

async function liveCampaign(o: Record<string, unknown> = {}) {
  await reset();
  const admin = await staffClient('admin');
  const id = expectOk(await admin.c.post('/api/admin/campaigns', campaignBody(o))).body.campaign_id as string;
  expectOk(await admin.c.post(`/api/admin/campaigns/${id}/active`, { active: true }));
  return { admin, id };
}

/** A new customer: signed in by phone with a profile, their own address (own flat) and a vehicle of their own. */
async function newcomer(o: { type?: 'bike' | 'car' | 'suv'; flat?: string; reg?: string } = {}) {
  const c = new Client();
  const { phone } = await c.loginCustomer(randomPhone());
  expectOk(await c.put('/api/me', { full_name: 'Asha Kulkarni', email: `asha${uniq()}@example.com` }));
  const addr = expectOk(await c.post('/api/addresses', { society_name: 'Yashwin Orizzonte', building_block: 'B', flat_number: o.flat ?? `F-${uniq()}`, parking_location: 'Basement P1' })).body.address;
  const reg = o.reg ?? `MH12${uniq().toUpperCase()}${crypto.randomInt(1000, 9999)}`;
  const vehicle = expectOk(await c.post('/api/vehicles', { vehicle_type: o.type ?? 'car', make: 'Hyundai', model: o.type === 'bike' ? 'Activa' : 'Creta', registration_number: reg, color: 'White', address_id: addr.id })).body.vehicle;
  return { c, phone, addr, vehicle, reg };
}

const claimBody = (camp: string, n: { vehicle: { id: string }; addr: { id: string } }, o: Record<string, unknown> = {}) => ({
  campaign_id: camp, vehicle_id: n.vehicle.id, date: istDate(2), time_slot: 'morning', address_id: n.addr.id, parking_location: 'Basement P1', ...o,
});
const completeWash = (bookingId: string) => fake.admin.query(`update public.bookings set status = 'completed', completed_at = now() where id = $1`, [bookingId]);

describe('only admins run campaigns', () => {
  it('everything under /api/admin/campaigns is closed to customers, specialists and visitors', async () => {
    const n = await newcomer();
    const worker = await staffClient('worker');
    const calls: [string, string, unknown?][] = [
      ['get', '/api/admin/campaigns'], ['post', '/api/admin/campaigns', campaignBody()], ['get', `/api/admin/campaigns/${crypto.randomUUID()}`],
      ['put', `/api/admin/campaigns/${crypto.randomUUID()}`, campaignBody()], ['post', `/api/admin/campaigns/${crypto.randomUUID()}/active`, { active: true }],
      ['get', `/api/admin/campaigns/${crypto.randomUUID()}/claims`],
    ];
    for (const [m, path, body] of calls) {
      expect((await (n.c as any)[m](path, body)).status, `customer ${path}`).toBe(403);
      expect((await (worker.c as any)[m](path, body)).status, `worker ${path}`).toBe(403);
      expect((await (new Client() as any)[m](path, body)).status, `visitor ${path}`).toBe(401);
    }
  });
});

describe('creating and running a campaign', () => {
  it('starts switched off, lists with live numbers, edits, and the public page follows the switch', async () => {
    await reset();
    const admin = await staffClient('admin');
    const visitor = new Client();
    expect(expectOk(await visitor.get('/api/campaign')).body).toMatchObject({ success: true, campaign: null, me: null, offer: null });

    const body = campaignBody({ description: undefined });
    const created = expectOk(await admin.c.post('/api/admin/campaigns', body));
    expect(created.status).toBe(201);
    const id = created.body.campaign_id as string;
    expect(expectOk(await visitor.get('/api/campaign')).body.campaign).toBeNull(); // not live until switched on

    const list = expectOk(await admin.c.get('/api/admin/campaigns')).body.campaigns;
    expect(list.find((c: any) => c.id === id)).toMatchObject({ code: body.code, name: 'Navratri free wash', is_active: false, total_cap: 100, daily_cap: 15, claimed: 0, booked: 0, completed: 0, packs_bought: 0, pack_bp_1: 500, pack_bp_2: 1000, pack_bp_3plus: 1500 });

    expectOk(await admin.c.post(`/api/admin/campaigns/${id}/active`, { active: true }));
    const live = expectOk(await visitor.get('/api/campaign')).body;
    expect(live.campaign).toMatchObject({ id, name: 'Navratri free wash', state: 'open', total_cap: 100, spots_left: 100, use_by_date: body.use_by_date, new_customers_only: true });
    expect(live.campaign.pack_offer).toEqual({ days: 14, bp_1: 500, bp_2: 1000, bp_3plus: 1500 });
    expect(live.me).toBeNull(); // a visitor has no claim

    expectOk(await admin.c.put(`/api/admin/campaigns/${id}`, campaignBody({ code: 'ignored-on-edit', name: 'Navratri special', total_cap: 60, daily_cap: null })));
    expect(expectOk(await admin.c.get(`/api/admin/campaigns/${id}`)).body.campaign).toMatchObject({ code: body.code, name: 'Navratri special', total_cap: 60, daily_cap: null });
    expectOk(await admin.c.post(`/api/admin/campaigns/${id}/active`, { active: false }));
    expect(expectOk(await visitor.get('/api/campaign')).body.campaign).toBeNull();
  });

  it('refuses bad input: plain-English rule errors from the database and per-field errors from the form', async () => {
    const admin = await staffClient('admin');
    const rule = await admin.c.post('/api/admin/campaigns', campaignBody({ pack_bp_3plus: 1600 }));
    expect(rule.status).toBe(422);
    expect(rule.body.message).toMatch(/more than the 15 percent/);
    const dates = await admin.c.post('/api/admin/campaigns', campaignBody({ claim_opens_on: istDate(3), claim_closes_on: istDate(1) }));
    expect(dates.status).toBe(422);
    expect(dates.body.message).toMatch(/close before they open/);
    const fields = await admin.c.post('/api/admin/campaigns', campaignBody({ total_cap: 0, name: 'x' }));
    expect(fields.status).toBe(400);
    expect(fields.body.details.fields).toMatchObject({ total_cap: expect.any(String), name: expect.any(String) });
    const dup = campaignBody();
    expectOk(await admin.c.post('/api/admin/campaigns', dup));
    expect((await admin.c.post('/api/admin/campaigns', dup)).body.message).toMatch(/already a campaign called/);
  });
});

describe('a new customer claims the free wash', () => {
  it('signed out, they must sign in first; signed in they book it, see it everywhere, and cannot claim twice', async () => {
    const { id, admin } = await liveCampaign();
    const n = await newcomer();
    expect((await new Client().post('/api/campaign/claim', claimBody(id, n))).status).toBe(401);

    const status = expectOk(await n.c.get('/api/campaign')).body;
    expect(status.campaign).toMatchObject({ id, state: 'open' });
    expect(status.me).toEqual({ state: 'eligible' });

    const claimed = expectOk(await n.c.post('/api/campaign/claim', claimBody(id, n)));
    expect(claimed.status).toBe(201);
    expect(claimed.body).toMatchObject({ campaign_name: 'Navratri free wash', service_name: 'Car Body Wash' });
    const bookingId = claimed.body.booking_id as string;

    // an ordinary booking for the customer: confirmed, free, nothing to pay
    const list = expectOk(await n.c.get('/api/bookings?scope=upcoming')).body.bookings;
    expect(list.find((b: any) => b.id === bookingId)).toMatchObject({ status: 'confirmed', price_cents: 0, booking_type: 'on_demand', service_name: 'Car Body Wash' });
    expect(expectOk(await n.c.get(`/api/bookings/${bookingId}`)).body.booking).toMatchObject({ campaign_name: 'Navratri free wash', price_cents: 0 });
    expect(expectOk(await n.c.get('/api/campaign')).body.me).toMatchObject({ state: 'booked', booking_id: bookingId, scheduled_date: istDate(2), time_slot: 'morning' });
    expect((await dbOne('select count(*)::int n from public.payments where booking_id = $1', [bookingId])).n).toBe(0);

    // WASHO sees it, tagged, in Washes, History and the wash sheet, and in the campaign's own numbers
    const washes = expectOk(await admin.c.get(`/api/admin/bookings?from=${istDate(2)}&to=${istDate(2)}`)).body.bookings;
    expect(washes.find((b: any) => b.id === bookingId)).toMatchObject({ campaign_name: 'Navratri free wash', price_cents: 0 });
    const history = expectOk(await admin.c.get(`/api/admin/history?from=${istDate(0)}&to=${istDate(5)}&q=${n.reg}`)).body.bookings;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: bookingId, campaign_name: 'Navratri free wash' });
    expect(expectOk(await admin.c.get(`/api/admin/bookings/${bookingId}`)).body.booking.campaign_name).toBe('Navratri free wash');
    const claims = expectOk(await admin.c.get(`/api/admin/campaigns/${id}/claims`)).body.claims;
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ status: 'booked', customer_name: 'Asha Kulkarni', customer_phone: `+91${n.phone}`, booking_id: bookingId, registration_number: n.reg, vehicle_model: 'Creta', pack_cents: null });
    const detail = expectOk(await admin.c.get(`/api/admin/campaigns/${id}`)).body;
    expect(detail.campaign).toMatchObject({ claimed: 1, booked: 1, completed: 0 });
    expect(detail.days).toEqual([{ date: istDate(2), washes: 1 }]);

    const again = await n.c.post('/api/campaign/claim', claimBody(id, n, { date: istDate(3) }));
    expect(again.status).toBe(422);
    expect(again.body.message).toMatch(/already claimed your free wash/);
  });

  it('is refused for an existing customer, a repeated plate or flat, a day that is full, and when everything is claimed', async () => {
    const { id } = await liveCampaign({ total_cap: 3, daily_cap: 1 });
    const a = await newcomer({ flat: 'T1-101', reg: 'MH12QQ0001' });
    expectOk(await a.c.post('/api/campaign/claim', claimBody(id, a)));

    // the same plate on another number, then the same flat on another number
    const samePlate = await newcomer({ reg: 'mh 12 qq 0001' });
    expect((await samePlate.c.post('/api/campaign/claim', claimBody(id, samePlate, { date: istDate(3) }))).body.message).toMatch(/already been claimed for this vehicle/);
    const sameFlat = await newcomer({ flat: 'T1 - 101' });
    expect((await sameFlat.c.post('/api/campaign/claim', claimBody(id, sameFlat, { date: istDate(3) }))).body.message).toMatch(/already been claimed for this address/);

    // the daily limit (1 a day) is full on that day and says so on the public status
    const b = await newcomer();
    const full = await b.c.post('/api/campaign/claim', claimBody(id, b));
    expect(full.status).toBe(422);
    expect(full.body.message).toMatch(/fully booked for free washes/);
    expect(expectOk(await b.c.get('/api/campaign')).body.campaign.full_dates).toEqual([istDate(2)]);
    expectOk(await b.c.post('/api/campaign/claim', claimBody(id, b, { date: istDate(3) })));

    // an existing customer (a wash on their record) is not new
    const old = await newcomer();
    await fake.admin.query(
      `insert into public.bookings (customer_profile_id, vehicle_id, service_id, booking_type, scheduled_date, time_slot, status)
       select p.id, $2, (select id from public.services where code = 'car-body-wash'), 'on_demand', current_date - 6, 'morning', 'completed' from public.profiles p where p.phone = $1`,
      [`+91${old.phone}`, old.vehicle.id]
    );
    expect(expectOk(await old.c.get('/api/campaign')).body.me).toEqual({ state: 'ineligible', reason: 'existing_customer' });
    expect((await old.c.post('/api/campaign/claim', claimBody(id, old, { date: istDate(4) }))).body.message).toMatch(/for new WASHO customers/);

    // total of 3 claimed (a, b and ... one more), then the last spot goes and the rest see "full"
    const c3 = await newcomer();
    expectOk(await c3.c.post('/api/campaign/claim', claimBody(id, c3, { date: istDate(4) })));
    const late = await newcomer();
    expect((await late.c.post('/api/campaign/claim', claimBody(id, late, { date: istDate(5) }))).body.message).toMatch(/All the free washes have been claimed/);
    expect(expectOk(await late.c.get('/api/campaign')).body.campaign).toMatchObject({ state: 'full', spots_left: 0 });
  });

  it('only customers can claim: an admin or a specialist cannot', async () => {
    const { id } = await liveCampaign();
    const n = await newcomer();
    const worker = await staffClient('worker');
    expect((await worker.c.post('/api/campaign/claim', claimBody(id, n))).status).toBe(403);
    expect(expectOk(await worker.c.get('/api/campaign')).body.me).toBeNull();
  });

  it('cancelling gives the claim back; the customer can claim again', async () => {
    const { id, admin } = await liveCampaign({ total_cap: 1 });
    const n = await newcomer();
    const first = expectOk(await n.c.post('/api/campaign/claim', claimBody(id, n)));
    expect(expectOk(await n.c.get('/api/campaign')).body.campaign.spots_left).toBe(0);
    expectOk(await n.c.post(`/api/bookings/${first.body.booking_id}/cancel`, { reason: 'Plans changed' }));
    const after = expectOk(await n.c.get('/api/campaign')).body;
    expect(after.campaign.spots_left).toBe(1);
    expect(after.me).toEqual({ state: 'eligible' });
    expectOk(await n.c.post('/api/campaign/claim', claimBody(id, n, { date: istDate(4) })));
    const detail = expectOk(await admin.c.get(`/api/admin/campaigns/${id}`)).body.campaign;
    expect(detail).toMatchObject({ claimed: 1, booked: 1, released: 1 });
    const released = expectOk(await admin.c.get(`/api/admin/campaigns/${id}/claims?status=released`)).body.claims;
    expect(released).toHaveLength(1);
  });
});

describe('after the free wash: the welcome offer on a wash pack', () => {
  const doneWash = async () => {
    const live = await liveCampaign();
    const n = await newcomer();
    const claimed = expectOk(await n.c.post('/api/campaign/claim', claimBody(live.id, n))).body;
    return { ...live, n, claimed };
  };

  it('is not there until the wash is done; then the estimate shows the offer to that customer only', async () => {
    const { id, n, claimed } = await doneWash();
    const estimate = async (c: Client, pattern: unknown[] = ONE, months = 1) =>
      expectOk(await c.post('/api/membership-estimate', { vehicle_type: 'car', weekly_pattern: pattern, duration_months: months })).body.estimate;

    expect((await estimate(n.c)).final_cents).toBe(60000);
    expect(expectOk(await n.c.get('/api/campaign')).body.offer).toBeNull();

    await completeWash(claimed.booking_id);
    const offer = expectOk(await n.c.get('/api/campaign')).body.offer;
    expect(offer).toMatchObject({ campaign_name: 'Navratri free wash', bp_1: 500, bp_2: 1000, bp_3plus: 1500 });
    expect(new Date(offer.expires_at).getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);

    const mine = await estimate(n.c);
    expect(mine).toMatchObject({ final_cents: 57000, frequency_discount: { bp: 500, label: 'Welcome offer · 1 wash per week' }, campaign_offer: { bp: 500 } });
    expect(await estimate(n.c, PATTERN_3)).toMatchObject({ final_cents: 176800, frequency_discount: { bp: 1500 } });
    // everyone else, and a visitor, see the normal price
    const other = await newcomer();
    expect((await estimate(other.c)).final_cents).toBe(60000);
    expect((await estimate(new Client())).final_cents).toBe(60000);
    expect((await estimate(new Client())).campaign_offer).toBeUndefined();
    void id;
  });

  it('is charged at the offer price, used once, and the Admin page shows the pack it bought', async () => {
    const { id, admin, n, claimed } = await doneWash();
    await completeWash(claimed.booking_id);

    const order = expectOk(
      await n.c.post('/api/payments/membership-checkout', {
        vehicle_id: n.vehicle.id, weekly_pattern: ONE, duration_months: 1, time_slot: 'morning', start_date: istDate(4), address_id: n.addr.id,
      })
    ).body.order;
    expect(order.amount).toBe(57000); // 5% off 4 x ₹150
    const paid = expectOk(await n.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result;
    expect(paid.membership_id).toBeTruthy();

    expect(expectOk(await n.c.get('/api/campaign')).body.offer).toBeNull(); // used once
    expect(expectOk(await n.c.post('/api/membership-estimate', { vehicle_type: 'car', weekly_pattern: ONE, duration_months: 1 })).body.estimate.final_cents).toBe(60000);

    const detail = expectOk(await admin.c.get(`/api/admin/campaigns/${id}`)).body.campaign;
    expect(detail).toMatchObject({ claimed: 1, completed: 1, packs_bought: 1, offers_open: 0 });
    expect(Number(detail.packs_cents)).toBe(57000);
    const claims = expectOk(await admin.c.get(`/api/admin/campaigns/${id}/claims?status=completed`)).body.claims;
    expect(claims[0]).toMatchObject({ status: 'completed', pack_cents: 57000 });
    // the claim search finds the customer by phone
    expect(expectOk(await admin.c.get(`/api/admin/campaigns/${id}/claims?q=${n.phone}`)).body.claims).toHaveLength(1);
    expect(expectOk(await admin.c.get(`/api/admin/campaigns/${id}/claims?q=nobody-here`)).body.claims).toHaveLength(0);
  });
});
