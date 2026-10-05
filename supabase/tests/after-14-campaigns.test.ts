/** GREEN tests for 20261004000014_campaigns.sql: the free-wash campaign (claim rules and caps) and the welcome offer on wash packs. */
import { describe, expect, it } from 'vitest';
import { PATTERN_3, createAdmin, createCustomer, createVehicle, createWorker, inTx, istDate, uid } from './helpers';

const NOT_ADMIN = /admin access required|permission denied/i;

type Camp = { total?: number; daily?: number | null; opens?: number; closes?: number; useBy?: number; active?: boolean; bp?: [number, number, number]; days?: number; newOnly?: boolean };

/** A campaign inserted directly (the admin functions have their own tests). Dates are days from today in Pune. */
async function campaign(s: any, o: Camp = {}) {
  const opens = await istDate(s, o.opens ?? 0);
  const closes = await istDate(s, o.closes ?? 3);
  const useBy = await istDate(s, o.useBy ?? 7);
  await s.as('postgres');
  const [b1, b2, b3] = o.bp ?? [500, 1000, 1500];
  return (await s.q(
    `insert into public.campaigns (code, name, is_active, claim_opens_on, claim_closes_on, use_by_date, total_cap, daily_cap, pack_offer_days, pack_offer_bp_1, pack_offer_bp_2, pack_offer_bp_3plus, new_customers_only)
     values ($1, 'Navratri free wash', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
    [`t-${uid().slice(0, 8)}`, o.active ?? true, opens, closes, useBy, o.total ?? 100, o.daily === undefined ? null : o.daily, o.days ?? 14, b1, b2, b3, o.newOnly ?? true]
  ))[0].id as string;
}

/** A customer with their own address (a distinct flat unless one is given) and a vehicle. */
async function person(s: any, o: { type?: 'bike' | 'car' | 'suv'; flat?: string; plate?: string } = {}) {
  const u = await createCustomer(s);
  await s.as('postgres');
  const addr = (await s.q(
    `insert into public.customer_addresses (customer_profile_id, society_name, building_block, flat_number, parking_location, is_default)
     values ($1, 'Yashwin Orizzonte', 'B', $2, 'Basement P1', true) returning id`,
    [u.profileId, o.flat ?? `F-${uid().slice(0, 6)}`]
  ))[0].id as string;
  const veh = await createVehicle(s, u.profileId, o.type ?? 'car');
  if (o.plate) await s.q('update public.vehicles set registration_number = $2 where id = $1', [veh, o.plate]);
  return { u, addr, veh };
}

const claimSql = `select public.claim_campaign_wash($1::uuid, $2::uuid, $3::date, $4::public.time_slot, $5::uuid, 'Basement P1') r`;
const claim = async (s: any, p: any, camp: string, date: string, o: { slot?: string; veh?: string; addr?: string | null } = {}) => {
  await s.as('authenticated', p.u.authId);
  return (await s.q(claimSql, [camp, o.veh ?? p.veh, date, o.slot ?? 'morning', o.addr === undefined ? p.addr : o.addr]))[0].r;
};
const claimErr = async (s: any, p: any, camp: string, date: string, o: { slot?: string; veh?: string; addr?: string | null } = {}) => {
  await s.as('authenticated', p.u.authId);
  return s.err(claimSql, [camp, o.veh ?? p.veh, date, o.slot ?? 'morning', o.addr === undefined ? p.addr : o.addr]);
};
const status = async (s: any, p: { u: { authId: string } } | null) => {
  await (p ? s.as('authenticated', p.u.authId) : s.as('anon'));
  return (await s.q('select public.get_campaign_status() r'))[0].r;
};
/** The wash is done: the same status change a specialist's completion makes. */
const complete = async (s: any, bookingId: string) => {
  await s.as('postgres');
  await s.q(`update public.bookings set status = 'completed', completed_at = now() where id = $1`, [bookingId]);
};
const estimate = async (s: any, p: { u: { authId: string } } | null, vtype: string, pattern: unknown[], months = 1) => {
  await (p ? s.as('authenticated', p.u.authId) : s.as('anon'));
  return (await s.q('select public.estimate_membership_price($1::public.vehicle_type, $2::jsonb, $3) q', [vtype, JSON.stringify(pattern), months]))[0].q;
};
const ONE = [{ weekday: 1, kind: 'body' }];

describe('who can do what', () => {
  it('only an admin writes campaigns; people cannot write the tables; anonymous visitors can read the status', async () =>
    inTx(async (s) => {
      const c = await person(s);
      const w = await createWorker(s);
      const camp = await campaign(s);
      const day = await istDate(s, 5);
      const calls = [
        `select public.admin_save_campaign(null,'sneaky-offer','Sneaky','',current_date,current_date,current_date,5,null,14,500,1000,1500)`,
        `select public.admin_set_campaign_active('${camp}', false)`,
      ];
      for (const who of [{ role: 'authenticated', id: c.u.authId }, { role: 'authenticated', id: w.authId }, { role: 'anon', id: null }] as const) {
        await s.as(who.role, who.id);
        for (const sql of calls) expect(await s.err(sql), sql).toMatch(NOT_ADMIN);
        expect(await s.err(`update public.campaigns set total_cap = 99999 where id = '${camp}'`)).toMatch(/permission denied/);
        expect(await s.err(`insert into public.campaign_claims (campaign_id, customer_profile_id, booking_id, plate) values ('${camp}','${c.u.profileId}','${uid()}','X')`)).toMatch(/permission denied/);
      }
      // claiming needs a signed-in customer
      await s.as('anon');
      expect(await s.err(claimSql, [camp, c.veh, day, 'morning', c.addr])).toMatch(/permission denied/);
      await s.as('authenticated', w.authId);
      expect(await s.err(claimSql, [camp, c.veh, day, 'morning', c.addr])).toMatch(/Customer profile not found/);
      // the status is public
      expect((await status(s, null)).campaign).toMatchObject({ state: 'open' });
    }));

  it('a customer reads only their own claim and its campaign; an admin reads all', async () =>
    inTx(async (s) => {
      const a = await person(s);
      const b = await person(s);
      const admin = await createAdmin(s);
      const camp = await campaign(s);
      const day = await istDate(s, 2);
      await claim(s, a, camp, day);
      await s.as('authenticated', a.u.authId);
      expect((await s.q('select count(*)::int n from public.campaign_claims'))[0].n).toBe(1);
      expect((await s.q('select count(*)::int n from public.campaigns'))[0].n).toBe(1);
      await s.as('authenticated', b.u.authId);
      expect((await s.q('select count(*)::int n from public.campaign_claims'))[0].n).toBe(0);
      expect((await s.q('select count(*)::int n from public.campaigns'))[0].n).toBe(0);
      await s.as('authenticated', admin.authId);
      expect((await s.q('select count(*)::int n from public.campaign_claims'))[0].n).toBe(1);
      expect((await s.q('select count(*)::int n from public.campaigns'))[0].n).toBe(1);
    }));
});

describe('the admin creates and edits a campaign', () => {
  it('starts switched off, validates every field, never changes the short name, and switches on and off', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const [d0, d2, d6] = [await istDate(s, 0), await istDate(s, 2), await istDate(s, 6)];
      await s.as('authenticated', admin.authId);
      const save = (p: unknown[]) => s.q(`select public.admin_save_campaign($1,$2,$3,$4,$5::date,$6::date,$7::date,$8,$9,$10,$11,$12,$13,$14) id`, p);
      const id = (await save([null, ' Navratri-2026 ', ' Navratri free wash ', 'First 100 new customers', d0, d2, d6, 100, 15, 14, 500, 1000, 1500, null]))[0].id;
      await s.as('postgres');
      expect((await s.q('select code, name, is_active, total_cap, daily_cap, pack_offer_bp_1, pack_offer_bp_2, pack_offer_bp_3plus, new_customers_only from public.campaigns where id=$1', [id]))[0])
        .toEqual({ code: 'navratri-2026', name: 'Navratri free wash', is_active: false, total_cap: 100, daily_cap: 15, pack_offer_bp_1: 500, pack_offer_bp_2: 1000, pack_offer_bp_3plus: 1500, new_customers_only: true });
      expect((await s.q(`select count(*)::int n from public.audit_events where entity_id=$1 and event_type='campaign_created'`, [id]))[0].n).toBe(1);
      expect((await status(s, null)).campaign).toBeNull(); // not live until switched on

      await s.as('authenticated', admin.authId);
      const bad = async (p: unknown[]) => { await s.as('authenticated', admin.authId); return s.err(`select public.admin_save_campaign($1,$2,$3,$4,$5::date,$6::date,$7::date,$8,$9,$10,$11,$12,$13,$14)`, p); };
      expect(await bad([null, 'navratri-2026', 'Again', '', d0, d2, d6, 5, null, 14, 500, 1000, 1500, null])).toMatch(/already a campaign called/);
      expect(await bad([null, 'Not A Slug!', 'Name', '', d0, d2, d6, 5, null, 14, 500, 1000, 1500, null])).toMatch(/short name/);
      expect(await bad([null, 'ok-name', 'N', '', d0, d2, d6, 5, null, 14, 500, 1000, 1500, null])).toMatch(/name/);
      expect(await bad([null, 'ok-name', 'Name', '', d2, d0, d6, 5, null, 14, 500, 1000, 1500, null])).toMatch(/close before they open/);
      expect(await bad([null, 'ok-name', 'Name', '', d2, d2, d0, 5, null, 14, 500, 1000, 1500, null])).toMatch(/last day to use/);
      expect(await bad([null, 'ok-name', 'Name', '', d0, d2, d6, 0, null, 14, 500, 1000, 1500, null])).toMatch(/how many free washes/);
      expect(await bad([null, 'ok-name', 'Name', '', d0, d2, d6, 5, 0, 14, 500, 1000, 1500, null])).toMatch(/daily limit/);
      expect(await bad([null, 'ok-name', 'Name', '', d0, d2, d6, 5, null, 0, 500, 1000, 1500, null])).toMatch(/1 to 365 days/);
      expect(await bad([null, 'ok-name', 'Name', '', d0, d2, d6, 5, null, 14, 500, 1000, 1600, null])).toMatch(/more than the 15 percent/);

      // edit: the code stays, the rest changes
      await save([id, 'something-else', 'Navratri special', null, d0, d2, d6, 120, null, 10, 500, 1000, 1500, null]);
      await s.as('postgres');
      expect((await s.q('select code, name, total_cap, daily_cap, pack_offer_days from public.campaigns where id=$1', [id]))[0]).toEqual({ code: 'navratri-2026', name: 'Navratri special', total_cap: 120, daily_cap: null, pack_offer_days: 10 });

      await s.as('authenticated', admin.authId);
      expect((await s.q('select public.admin_set_campaign_active($1, true) r', [id]))[0].r).toBe(true);
      expect((await status(s, null)).campaign).toMatchObject({ code: 'navratri-2026', state: 'open', spots_left: 120 });
      await s.as('authenticated', admin.authId);
      await s.q('select public.admin_set_campaign_active($1, false)', [id]);
      expect((await status(s, null)).campaign).toBeNull();
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_set_campaign_active('${uid()}', true)`)).toMatch(/Campaign not found/);
    }));

  it('will not set the total below what is already claimed', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const camp = await campaign(s, { total: 5 });
      const day = await istDate(s, 2);
      const [a, b] = [await person(s), await person(s)];
      await claim(s, a, camp, day);
      await claim(s, b, camp, day);
      const [d0, d3, d7] = [await istDate(s, 0), await istDate(s, 3), await istDate(s, 7)];
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_save_campaign('${camp}','x','Name','',$1::date,$2::date,$3::date,1,null,14,500,1000,1500)`, [d0, d3, d7])).toMatch(/2 free washes are already claimed/);
      await s.q(`select public.admin_save_campaign('${camp}','x','Name','',$1::date,$2::date,$3::date,2,null,14,500,1000,1500)`, [d0, d3, d7]);
    }));
});

describe('claiming the free wash', () => {
  it('books a confirmed, free body wash with no payment, tagged to the campaign', async () =>
    inTx(async (s) => {
      const p = await person(s, { type: 'car' });
      const camp = await campaign(s);
      const day = await istDate(s, 2);
      const r = await claim(s, p, camp, day, { slot: 'afternoon' });
      expect(r).toMatchObject({ campaign_name: 'Navratri free wash', service_name: 'Car Body Wash' });
      await s.as('postgres');
      const b = (await s.q(`select status::text st, booking_type::text bt, price_cents, source, to_char(scheduled_date,'YYYY-MM-DD') d, time_slot::text slot, address_id, customer_profile_id, parking_location from public.bookings where id=$1`, [r.booking_id]))[0];
      expect(b).toEqual({ st: 'confirmed', bt: 'on_demand', price_cents: 0, source: 'website', d: day, slot: 'afternoon', address_id: p.addr, customer_profile_id: p.u.profileId, parking_location: 'Basement P1' });
      expect((await s.q('select count(*)::int n from public.payments where booking_id=$1', [r.booking_id]))[0].n).toBe(0);
      expect((await s.q('select status, plate, flat_key from public.campaign_claims where id=$1', [r.claim_id]))[0]).toMatchObject({ status: 'booked', plate: expect.stringMatching(/^MH12AB/), flat_key: expect.stringContaining('yashwinorizzonte|b|f-') });
      expect((await s.q(`select count(*)::int n from public.booking_events where booking_id=$1 and event_type='booking_created'`, [r.booking_id]))[0].n).toBe(1);
      expect((await s.q(`select count(*)::int n from public.notifications where profile_id=$1 and category='booking_confirmed'`, [p.u.profileId]))[0].n).toBe(1);
      expect((await s.q(`select count(*)::int n from public.audit_events where entity_id=$1 and event_type='campaign_wash_claimed'`, [r.booking_id]))[0].n).toBe(1);
      expect((await status(s, p)).me).toMatchObject({ state: 'booked', booking_id: r.booking_id, scheduled_date: day, time_slot: 'afternoon' });
    }));

  it('gives a bike, a car and an SUV the right body wash', async () =>
    inTx(async (s) => {
      const camp = await campaign(s);
      const day = await istDate(s, 2);
      const out: string[] = [];
      for (const type of ['bike', 'car', 'suv'] as const) {
        const p = await person(s, { type });
        out.push((await claim(s, p, camp, day)).service_name);
      }
      expect(out).toEqual(['Bike Body Wash', 'Car Body Wash', 'Car Body Wash']);
    }));

  it('uses the customer\'s default address when none is sent, and needs an address at all', async () =>
    inTx(async (s) => {
      const camp = await campaign(s);
      const day = await istDate(s, 2);
      const p = await person(s);
      const r = await claim(s, p, camp, day, { addr: null });
      await s.as('postgres');
      expect((await s.q('select address_id from public.bookings where id=$1', [r.booking_id]))[0].address_id).toBe(p.addr);

      const noAddr = await person(s);
      await s.as('postgres');
      await s.q('delete from public.customer_addresses where id=$1', [noAddr.addr]);
      expect(await claimErr(s, noAddr, camp, day, { addr: null })).toMatch(/Add your address first/);
    }));

  it('is closed before it opens, after it closes, when switched off, and for a wash past the last day', async () =>
    inTx(async (s) => {
      const p = await person(s);
      const [d2, d3, d8] = [await istDate(s, 2), await istDate(s, 3), await istDate(s, 8)];
      const notYet = await campaign(s, { opens: 2, closes: 4 });
      expect(await claimErr(s, p, notYet, d3)).toMatch(/This offer opens on/);
      const over = await campaign(s, { opens: -4, closes: -1 });
      expect(await claimErr(s, p, over, d3)).toMatch(/This offer has ended/);
      const off = await campaign(s, { active: false });
      expect(await claimErr(s, p, off, d3)).toMatch(/not running right now/);
      const open = await campaign(s, { useBy: 4 });
      expect(await claimErr(s, p, open, d8)).toMatch(/must be on or before/);
      expect(await claimErr(s, p, open, await istDate(s, -1))).toMatch(/Choose today or a later date/);
      expect(await claimErr(s, p, open, d2, { addr: uid() })).toMatch(/Address not found/);
      expect(await claimErr(s, p, uid(), d2)).toMatch(/not running right now/);
    }));

  it('is for new customers only: any earlier wash or any membership rules a customer out, a cancelled wash does not', async () =>
    inTx(async (s) => {
      const camp = await campaign(s);
      const day = await istDate(s, 3);

      const had = await person(s);
      await s.as('postgres');
      const svc = (await s.q(`select id from public.services where code='car-body-wash'`))[0].id;
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',current_date - 5,'morning','completed')`, [had.u.profileId, had.veh, svc]);
      expect(await claimErr(s, had, camp, day)).toMatch(/for new WASHO customers/);
      expect((await status(s, had)).me).toMatchObject({ state: 'ineligible', reason: 'existing_customer' });

      const scheduled = await person(s);
      await s.as('postgres');
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',current_date + 6,'morning','confirmed')`, [scheduled.u.profileId, scheduled.veh, svc]);
      expect(await claimErr(s, scheduled, camp, day)).toMatch(/for new WASHO customers/);

      const cancelled = await person(s);
      await s.as('postgres');
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',current_date + 6,'morning','cancelled')`, [cancelled.u.profileId, cancelled.veh, svc]);
      expect((await status(s, cancelled)).me).toMatchObject({ state: 'eligible' });
      await claim(s, cancelled, camp, day);

      // when a campaign is open to everyone, an existing customer can claim
      const everyone = await campaign(s, { newOnly: false });
      expect((await claim(s, had, everyone, day, { slot: 'night' })).booking_id).toBeTruthy();
    }));

  it('is one per phone, one per vehicle plate and one per flat (a second number does not get a second wash)', async () =>
    inTx(async (s) => {
      const camp = await campaign(s);
      const day = await istDate(s, 3);
      const a = await person(s, { flat: 'B-702', plate: 'MH12ZZ1111' });
      await claim(s, a, camp, day);
      expect(await claimErr(s, a, camp, await istDate(s, 4))).toMatch(/already claimed your free wash/);

      // another number, the same plate (different spacing and case)
      const samePlate = await person(s, { plate: 'mh 12 zz 1111' });
      expect(await claimErr(s, samePlate, camp, day)).toMatch(/already been claimed for this vehicle/);

      // another number and plate, the same flat (different case and spaces)
      const sameFlat = await person(s, { flat: ' b - 702 ' });
      expect(await claimErr(s, sameFlat, camp, day)).toMatch(/already been claimed for this address/);

      // a different phone, plate and flat is fine
      const other = await person(s);
      expect((await claim(s, other, camp, day)).booking_id).toBeTruthy();
    }));

  it('refuses a vehicle someone has already had washed, and a vehicle that is not theirs', async () =>
    inTx(async (s) => {
      const camp = await campaign(s);
      const day = await istDate(s, 3);
      const old = await person(s, { plate: 'MH14AB4444' });
      await s.as('postgres');
      const svc = (await s.q(`select id from public.services where code='car-body-wash'`))[0].id;
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',current_date - 9,'morning','completed')`, [old.u.profileId, old.veh, svc]);
      const fresh = await person(s, { plate: 'MH 14 AB 4444' });
      expect(await claimErr(s, fresh, camp, day)).toMatch(/already been washed by WASHO/);
      const other = await person(s);
      expect(await claimErr(s, fresh, camp, day, { veh: other.veh })).toMatch(/Vehicle not found/);
    }));

  it('stops at the total, and at the daily limit (listing the full days)', async () =>
    inTx(async (s) => {
      const [d2, d3] = [await istDate(s, 2), await istDate(s, 3)];
      const camp = await campaign(s, { total: 3, daily: 2 });
      const [a, b, c, d] = [await person(s), await person(s), await person(s), await person(s)];
      await claim(s, a, camp, d2);
      expect((await status(s, null)).campaign).toMatchObject({ spots_left: 2, full_dates: [] });
      await claim(s, b, camp, d2);
      expect((await status(s, null)).campaign).toMatchObject({ spots_left: 1, full_dates: [d2] });
      expect(await claimErr(s, c, camp, d2, { slot: 'night' })).toMatch(/fully booked for free washes/);
      await claim(s, c, camp, d3);
      expect(await claimErr(s, d, camp, d3)).toMatch(/All the free washes have been claimed/);
      expect((await status(s, d)).campaign).toMatchObject({ state: 'full', spots_left: 0 });
    }));

  it('one wash per vehicle per day still holds', async () =>
    inTx(async (s) => {
      const camp = await campaign(s);
      const day = await istDate(s, 3);
      const p = await person(s);
      await s.as('postgres');
      const svc = (await s.q(`select id from public.services where code='car-body-wash'`))[0].id;
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4::date,'night','cancelled')`, [p.u.profileId, p.veh, svc, day]);
      expect((await claim(s, p, camp, day)).booking_id).toBeTruthy(); // a cancelled one does not block
      const q = await person(s);
      await s.as('postgres');
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4::date,'night','pending')`, [q.u.profileId, q.veh, svc, day]);
      // q now has a live wash, so is not new either way; open the campaign to everyone to reach the day rule
      const all = await campaign(s, { newOnly: false });
      expect(await claimErr(s, q, all, day)).toMatch(/already has a wash booked that day/);
    }));
});

describe('cancelling, completing and missing the free wash', () => {
  it('a cancelled wash gives the claim back, so the customer can claim again, and frees the plate and flat', async () =>
    inTx(async (s) => {
      const camp = await campaign(s, { total: 1 });
      const [d2, d4] = [await istDate(s, 2), await istDate(s, 4)];
      const p = await person(s);
      const r = await claim(s, p, camp, d2);
      expect((await status(s, null)).campaign).toMatchObject({ spots_left: 0 });
      await s.as('authenticated', p.u.authId);
      await s.q(`select public.cancel_customer_booking($1, 'Plans changed')`, [r.booking_id]);
      await s.as('postgres');
      expect((await s.q('select status from public.campaign_claims where id=$1', [r.claim_id]))[0].status).toBe('released');
      expect((await status(s, p)).campaign).toMatchObject({ spots_left: 1 });
      expect((await status(s, p)).me).toMatchObject({ state: 'eligible' });
      const again = await claim(s, p, camp, d4);
      expect(again.booking_id).not.toBe(r.booking_id);
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.campaign_claims where customer_profile_id=$1`, [p.u.profileId]))[0].n).toBe(2);
    }));

  it('a completed wash starts the pack offer and tells the customer; a no-show uses the claim up', async () =>
    inTx(async (s) => {
      const camp = await campaign(s, { days: 14 });
      const day = await istDate(s, 2);
      const p = await person(s);
      const r = await claim(s, p, camp, day);
      expect((await status(s, p)).offer).toBeNull(); // not before the wash is done
      await complete(s, r.booking_id);
      const cl = (await s.q(`select status, completed_at is not null done, offer_expires_at > now() + interval '13 days' a, offer_expires_at < now() + interval '15 days' b from public.campaign_claims where id=$1`, [r.claim_id]))[0];
      expect(cl).toEqual({ status: 'completed', done: true, a: true, b: true });
      expect((await s.q(`select count(*)::int n from public.notifications where profile_id=$1 and title='Your free wash is done'`, [p.u.profileId]))[0].n).toBe(1);
      expect((await status(s, p)).offer).toMatchObject({ campaign_name: 'Navratri free wash', bp_1: 500, bp_2: 1000, bp_3plus: 1500 });
      expect((await status(s, p)).me).toMatchObject({ state: 'completed' });
      expect(await claimErr(s, p, camp, await istDate(s, 4))).toMatch(/already claimed your free wash/);

      const q = await person(s);
      const r2 = await claim(s, q, camp, day);
      await s.as('postgres');
      await s.q(`update public.bookings set status = 'no_show' where id = $1`, [r2.booking_id]);
      expect((await s.q('select status from public.campaign_claims where id=$1', [r2.claim_id]))[0].status).toBe('forfeited');
      expect(await claimErr(s, q, camp, await istDate(s, 4))).toMatch(/already claimed your free wash/);
      expect((await status(s, q)).offer).toBeNull();
    }));
});

describe('the welcome offer on a wash pack', () => {
  const withOffer = async (s: any, o: Camp = {}, vtype: 'bike' | 'car' | 'suv' = 'car') => {
    const camp = await campaign(s, o);
    const p = await person(s, { type: vtype });
    const r = await claim(s, p, camp, await istDate(s, 2));
    await complete(s, r.booking_id);
    return { camp, p, claim: r };
  };

  it('5% for 1 a week, 10% for 2 a week, 15% for 3 or more, and 15% for 4 to 7', async () =>
    inTx(async (s) => {
      const { p } = await withOffer(s);
      // car, 1 body wash a week, 1 month: 4 x 150 = 600
      const one = await estimate(s, p, 'car', ONE);
      expect(one).toMatchObject({ subtotal_cents: 60000, final_cents: 57000, frequency_discount: { bp: 500, cents: 3000, label: 'Welcome offer · 1 wash a week' }, campaign_offer: { bp: 500, name: 'Navratri free wash' } });
      // car, 2 a week (1 body + 1 deep): 4 x (150 + 220) = 1480
      const two = await estimate(s, p, 'car', [{ weekday: 1, kind: 'body' }, { weekday: 4, kind: 'deep' }]);
      expect(two).toMatchObject({ subtotal_cents: 148000, final_cents: 133200, frequency_discount: { bp: 1000, label: 'Welcome offer · 2 washes a week' } });
      // 3 a week: 2080, the normal 10% would be 1872, the offer 15% is 1768
      const three = await estimate(s, p, 'car', PATTERN_3);
      expect(three).toMatchObject({ subtotal_cents: 208000, final_cents: 176800, frequency_discount: { bp: 1500 } });
      // 7 a week (4 body + 3 deep): 4 x 1260 = 5040; 15% off = 4284
      const seven = await estimate(s, p, 'car', [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, kind: d % 2 ? 'deep' : 'body' })));
      expect(seven).toMatchObject({ subtotal_cents: 504000, final_cents: 428400, frequency_discount: { bp: 1500 } });
    }));

  it('a bike gets it too', async () =>
    inTx(async (s) => {
      const { p } = await withOffer(s, {}, 'bike');
      expect(await estimate(s, p, 'bike', ONE)).toMatchObject({ subtotal_cents: 26000, final_cents: 24700 });
    }));

  it('stacks with the length discount and still stops at the 15% cap', async () =>
    inTx(async (s) => {
      const { p } = await withOffer(s);
      // 2 a week for 3 months: 10% frequency (offer), then 5% length off the rest = 10% + 4.5% = 14.5%, under the cap
      const q3 = await estimate(s, p, 'car', [{ weekday: 1, kind: 'body' }, { weekday: 4, kind: 'deep' }], 3);
      expect(q3).toMatchObject({ subtotal_cents: 444000, frequency_discount: { cents: 44400 }, duration_discount: { cents: 19980 }, cap: { applied: false }, final_cents: 379620 });
      // 3 a week for 12 months: 15% + 15% of the rest would be 27.75%, the cap holds it at 15%
      const q12 = await estimate(s, p, 'car', PATTERN_3, 12);
      expect(q12).toMatchObject({ subtotal_cents: 2496000, cap: { applied: true }, total_discount_cents: 374400, final_cents: 2121600 });
    }));

  it('is never lower than the normal discount, and nobody else gets it', async () =>
    inTx(async (s) => {
      const { p } = await withOffer(s, { bp: [500, 1000, 500] }); // 3 a week offered at 5%, below the normal 10%
      const three = await estimate(s, p, 'car', PATTERN_3);
      expect(three).toMatchObject({ final_cents: 187200, frequency_discount: { bp: 1000, label: '3 washes a week' } });
      expect(three.campaign_offer).toBeUndefined();

      const { p: q } = await withOffer(s);
      const stranger = await person(s);
      expect((await estimate(s, stranger, 'car', ONE)).final_cents).toBe(60000);
      expect((await estimate(s, null, 'car', ONE)).final_cents).toBe(60000);
      expect((await estimate(s, q, 'car', ONE)).final_cents).toBe(57000);
    }));

  it('is not given before the free wash is done, nor after the window has passed', async () =>
    inTx(async (s) => {
      const camp = await campaign(s);
      const p = await person(s);
      await claim(s, p, camp, await istDate(s, 2));
      expect((await estimate(s, p, 'car', ONE)).final_cents).toBe(60000); // booked, not done

      const { p: q } = await withOffer(s);
      expect((await estimate(s, q, 'car', ONE)).final_cents).toBe(57000);
      await s.as('postgres');
      await s.q(`update public.campaign_claims set offer_expires_at = now() - interval '1 minute' where customer_profile_id = $1`, [q.u.profileId]);
      expect((await estimate(s, q, 'car', ONE)).final_cents).toBe(60000);
      expect((await status(s, q)).offer).toBeNull();
    }));

  it('is charged at the offer price, used once, and recorded against the membership', async () =>
    inTx(async (s) => {
      const { p, claim: r } = await withOffer(s);
      const start = await istDate(s, 4);
      await s.as('authenticated', p.u.authId);
      const pay = (await s.q(`select public.start_membership_checkout($1,$2::jsonb,1,'morning'::public.time_slot,$3::date,$4,'Basement P1') r`, [p.veh, JSON.stringify(ONE), start, p.addr]))[0].r;
      expect(pay.amount_cents).toBe(57000);
      await s.as('service_role');
      const order = `order_${uid().slice(0, 8)}`;
      await s.q('select app_private.attach_provider_order($1,$2)', [pay.payment_id, order]);
      const res = (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured',$4) r`, [order, `pay_${uid().slice(0, 8)}`, pay.amount_cents, p.u.profileId]))[0].r;
      expect(res.status).toBe('fulfilled');
      await s.as('postgres');
      expect((await s.q('select final_amount_cents, discount_amount_cents from public.memberships where id=$1', [res.membership_id]))[0]).toEqual({ final_amount_cents: 57000, discount_amount_cents: 3000 });
      const cl = (await s.q('select offer_membership_id, offer_used_at is not null used from public.campaign_claims where id=$1', [r.claim_id]))[0];
      expect(cl).toEqual({ offer_membership_id: res.membership_id, used: true });
      // used once: the next price is the normal one and the status no longer offers it
      expect((await estimate(s, p, 'car', ONE)).final_cents).toBe(60000);
      expect((await status(s, p)).offer).toBeNull();
    }));
});
