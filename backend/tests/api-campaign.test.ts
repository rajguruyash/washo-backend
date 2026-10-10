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
  campaign_id: camp, vehicle_id: n.vehicle.id, address_id: n.addr.id, parking_location: 'Basement P1', ...o, // no date or time: WASHO picks them
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
    expect(claimed.body).toMatchObject({ campaign_name: 'Navratri free wash', service_name: 'Car Body Wash', scheduled_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), time_slot: expect.stringMatching(/^(morning|afternoon|night)$/) });
    const bookingId = claimed.body.booking_id as string;
    const when = { date: claimed.body.scheduled_date as string, slot: claimed.body.time_slot as string }; // picked by WASHO, and told to the customer at once

    // an ordinary booking for the customer: confirmed, free, nothing to pay
    const list = expectOk(await n.c.get('/api/bookings?scope=upcoming')).body.bookings;
    expect(list.find((b: any) => b.id === bookingId)).toMatchObject({ status: 'confirmed', price_cents: 0, booking_type: 'on_demand', service_name: 'Car Body Wash' });
    expect(expectOk(await n.c.get(`/api/bookings/${bookingId}`)).body.booking).toMatchObject({ campaign_name: 'Navratri free wash', price_cents: 0 });
    expect(expectOk(await n.c.get('/api/campaign')).body.me).toMatchObject({ state: 'booked', booking_id: bookingId, scheduled_date: when.date, time_slot: when.slot });
    expect((await dbOne('select count(*)::int n from public.payments where booking_id = $1', [bookingId])).n).toBe(0);

    // WASHO sees it, tagged, in Washes, History and the wash sheet, and in the campaign's own numbers
    const washes = expectOk(await admin.c.get(`/api/admin/bookings?from=${when.date}&to=${when.date}`)).body.bookings;
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
    expect(detail.days).toEqual([{ date: when.date, washes: 1 }]);

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

    // the daily limit (1 a day): the first day is full and says so on the public status; the next person is simply placed on the next day
    const b = await newcomer();
    const firstDay = (await dbOne(`select to_char(b.scheduled_date,'YYYY-MM-DD') d from public.campaign_claims cl join public.bookings b on b.id = cl.booking_id where cl.campaign_id = $1`, [id])).d;
    expect(expectOk(await b.c.get('/api/campaign')).body.campaign.full_dates).toEqual([firstDay]);
    const next = expectOk(await b.c.post('/api/campaign/claim', claimBody(id, b)));
    expect(next.body.scheduled_date > firstDay).toBe(true);

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

describe('how much notice a wash needs', () => {
  it('the catalogue carries it, so the booking pages can grey out times that cannot be booked', async () => {
    const admin = await staffClient('admin');
    const rules = async () => expectOk(await new Client().get('/api/catalog')).body.booking_rules;
    const before = await rules();
    expect(before).toEqual({ on_demand_min_lead_hours: expect.any(Number), membership_min_lead_days: expect.any(Number) });
    expectOk(await admin.c.put('/api/admin/pricing-settings', { key: 'on_demand_min_lead_hours', value: 48 }));
    expect((await rules()).on_demand_min_lead_hours).toBe(48);
    // and the database places a free wash by the same rule: at 48 hours' notice the day and window it picks start at least 48 hours from now
    const { id } = await liveCampaign();
    const n = await newcomer();
    const placed = expectOk(await n.c.post('/api/campaign/claim', claimBody(id, n))).body;
    const startHour = { morning: 7, afternoon: 12, night: 19 }[placed.time_slot as 'morning' | 'afternoon' | 'night'];
    const starts = new Date(`${placed.scheduled_date}T${String(startHour).padStart(2, '0')}:00:00+05:30`).getTime();
    expect(starts).toBeGreaterThanOrEqual(Date.now() + 48 * 3_600_000 - 60_000);
    expectOk(await admin.c.put('/api/admin/pricing-settings', { key: 'on_demand_min_lead_hours', value: before.on_demand_min_lead_hours }));
  });
});

describe('who can claim', () => {
  const existingCustomer = async () => {
    const n = await newcomer();
    await fake.admin.query(
      `insert into public.bookings (customer_profile_id, vehicle_id, service_id, booking_type, scheduled_date, time_slot, status)
       select p.id, $2, (select id from public.services where code = 'car-body-wash'), 'on_demand', current_date - 6, 'morning', 'completed' from public.profiles p where p.phone = $1`,
      [`+91${n.phone}`, n.vehicle.id]
    );
    return n;
  };

  it('a campaign switched on for anyone lets an existing customer claim; the website says it is open to everyone', async () => {
    const { id, admin } = await liveCampaign({ new_customers_only: false });
    expect(expectOk(await new Client().get('/api/campaign')).body.campaign).toMatchObject({ id, new_customers_only: false });
    expect(expectOk(await admin.c.get(`/api/admin/campaigns/${id}`)).body.campaign.new_customers_only).toBe(false);
    const old = await existingCustomer();
    expect(expectOk(await old.c.get('/api/campaign')).body.me).toEqual({ state: 'eligible' });
    expectOk(await old.c.post('/api/campaign/claim', claimBody(id, old)));
    expect(expectOk(await old.c.get('/api/campaign')).body.me).toMatchObject({ state: 'booked' });
  });

  it('left at the default it is for new customers only, and the admin can flip it in the edit form', async () => {
    const { id, admin } = await liveCampaign();
    expect(expectOk(await admin.c.get(`/api/admin/campaigns/${id}`)).body.campaign.new_customers_only).toBe(true);
    const old = await existingCustomer();
    expect((await old.c.post('/api/campaign/claim', claimBody(id, old))).body.message).toMatch(/for new WASHO customers/);
    expectOk(await admin.c.put(`/api/admin/campaigns/${id}`, campaignBody({ new_customers_only: false })));
    expect(expectOk(await admin.c.get(`/api/admin/campaigns/${id}`)).body.campaign.new_customers_only).toBe(false);
    expectOk(await old.c.post('/api/campaign/claim', claimBody(id, old)));
    // an edit that says nothing about it leaves it as it is
    const { new_customers_only: _omit, ...rest } = campaignBody() as Record<string, unknown>;
    void _omit;
    expectOk(await admin.c.put(`/api/admin/campaigns/${id}`, rest));
    expect(expectOk(await admin.c.get(`/api/admin/campaigns/${id}`)).body.campaign.new_customers_only).toBe(false);
  });
});

describe('claims open and close at an exact time', () => {
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const timed = (opensInMin: number, closesInMin: number, o: Record<string, unknown> = {}) =>
    campaignBody({ claim_opens_at: at(opensInMin), claim_closes_at: at(closesInMin), claim_opens_on: istDate(0), claim_closes_on: istDate(0), use_by_date: istDate(7), ...o });
  const live = async (b: Record<string, unknown>) => {
    await reset();
    const admin = await staffClient('admin');
    const id = expectOk(await admin.c.post('/api/admin/campaigns', b)).body.campaign_id as string;
    expectOk(await admin.c.post(`/api/admin/campaigns/${id}/active`, { active: true }));
    return { admin, id };
  };

  it('before the opening time the page says upcoming (with the time) and a claim is refused with the time; after it opens, claims work', async () => {
    const { admin, id } = await live(timed(120, 600));
    const visitor = new Client();
    const up = expectOk(await visitor.get('/api/campaign')).body.campaign;
    expect(up).toMatchObject({ id, state: 'upcoming' });
    expect(Date.parse(up.claim_opens_at)).toBeGreaterThan(Date.now());
    expect(Date.parse(up.claim_closes_at)).toBeGreaterThan(Date.parse(up.claim_opens_at));
    const n = await newcomer();
    const refused = await n.c.post('/api/campaign/claim', claimBody(id, n));
    expect(refused.status).toBe(422);
    expect(refused.body.message).toMatch(/^This offer opens on \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (am|pm)$/);
    // the admin moves the opening to a minute ago: it is open at once
    const list = expectOk(await admin.c.get('/api/admin/campaigns')).body.campaigns.find((c: any) => c.id === id);
    expect(list.claim_opens_at).toBeTruthy();
    expectOk(await admin.c.put(`/api/admin/campaigns/${id}`, timed(-1, 600, { code: undefined })));
    expect(expectOk(await visitor.get('/api/campaign')).body.campaign).toMatchObject({ id, state: 'open' });
    expect(expectOk(await n.c.post('/api/campaign/claim', claimBody(id, n))).status).toBe(201);
  });

  it('after the closing time it is over: nothing on the page, and a claim is refused', async () => {
    const { admin, id } = await live(timed(-600, 600));
    expectOk(await admin.c.put(`/api/admin/campaigns/${id}`, timed(-600, -1, { code: undefined })));
    expect(expectOk(await new Client().get('/api/campaign')).body.campaign).toBeNull();
    const n = await newcomer();
    const refused = await n.c.post('/api/campaign/claim', claimBody(id, n));
    expect(refused.status).toBe(422);
    expect(refused.body.message).toBe('This offer has ended');
  });

  it('saves and lists the times; the dates are the Pune dates of those times; a campaign saved with no times has none', async () => {
    await reset();
    const admin = await staffClient('admin');
    const created = expectOk(await admin.c.post('/api/admin/campaigns', campaignBody({ claim_opens_at: '2099-03-10T00:30:00+05:30', claim_closes_at: '2099-03-12T20:00:00+05:30', claim_opens_on: '2099-03-10', claim_closes_on: '2099-03-12', use_by_date: '2099-03-20' }))).body.campaign_id as string;
    const row = expectOk(await admin.c.get(`/api/admin/campaigns/${created}`)).body.campaign;
    expect(Date.parse(row.claim_opens_at)).toBe(Date.parse('2099-03-10T00:30:00+05:30'));
    expect(Date.parse(row.claim_closes_at)).toBe(Date.parse('2099-03-12T20:00:00+05:30'));
    expect(String(row.claim_opens_on).slice(0, 10)).toBe('2099-03-10');   // the Pune date, not the UTC one (the evening before)
    const plain = expectOk(await admin.c.post('/api/admin/campaigns', campaignBody())).body.campaign_id as string;
    const p = expectOk(await admin.c.get(`/api/admin/campaigns/${plain}`)).body.campaign;
    expect(p.claim_opens_at).toBeNull();
    expect(p.claim_closes_at).toBeNull();
  });

  it('says what is wrong: only one time, closing before opening, a time that is not a time', async () => {
    const admin = await staffClient('admin');
    const post = (o: Record<string, unknown>) => admin.c.post('/api/admin/campaigns', campaignBody({ claim_opens_at: at(60), claim_closes_at: at(600), ...o }));
    const one = await post({ claim_closes_at: undefined });
    expect(one.status).toBe(422);
    expect(one.body.message).toBe('Set both the time claims open and the time they close');
    const back = await post({ claim_closes_at: at(30) });
    expect(back.status).toBe(422);
    expect(back.body.message).toBe('Claims must close after they open');
    expect((await post({ claim_opens_at: 'tomorrow morning' })).status).toBe(400);
    expect((await post({ claim_opens_at: '2099-03-10T10:00:00' })).status).toBe(400);      // no offset: it would be ambiguous
  });
});
