/** GREEN tests for 20261004000015_campaign_audience.sql: a campaign can be open to anyone, or to new customers only. */
import { describe, expect, it } from 'vitest';
import { createAdmin, createCustomer, createVehicle, inTx, istDate, uid } from './helpers';

const NOT_ADMIN = /admin access required|permission denied/i;
const svc = async (s: any) => { await s.as('postgres'); return (await s.q(`select id from public.services where code='car-body-wash'`))[0].id as string; };

async function person(s: any, plate?: string) {
  const u = await createCustomer(s);
  await s.as('postgres');
  const addr = (await s.q(`insert into public.customer_addresses (customer_profile_id, society_name, building_block, flat_number, parking_location, is_default) values ($1,'Yashwin Orizzonte','B',$2,'P1',true) returning id`, [u.profileId, `F-${uid().slice(0, 6)}`]))[0].id as string;
  const veh = await createVehicle(s, u.profileId, 'car');
  if (plate) await s.q('update public.vehicles set registration_number=$2 where id=$1', [veh, plate]);
  return { u, addr, veh };
}
/** A completed wash on this person's record: they are no longer "new". */
async function hadAWash(s: any, p: any) {
  const id = await svc(s);
  await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',current_date - 5,'morning','completed')`, [p.u.profileId, p.veh, id]);
}
async function save(s: any, admin: any, id: string | null, flag: boolean | null, o: { code?: string } = {}) {
  const [d0, d3, d7] = [await istDate(s, 0), await istDate(s, 3), await istDate(s, 7)];
  await s.as('authenticated', admin.authId);
  return (await s.q(`select public.admin_save_campaign($1,$2,'Navratri free wash','',$3::date,$4::date,$5::date,100,null,14,500,1000,1500,true,$6::boolean) id`, [id, o.code ?? `t-${uid().slice(0, 8)}`, d0, d3, d7, flag]))[0].id as string;
}
const claim = async (s: any, p: any, camp: string, date: string) => {
  await s.as('authenticated', p.u.authId);
  return s.err(`select public.claim_campaign_wash($1::uuid, $2::uuid, $3::date, 'morning'::public.time_slot, $4::uuid, 'P1')`, [camp, p.veh, date, p.addr]);
};
const status = async (s: any, p: any) => { await s.as('authenticated', p.u.authId); return (await s.q('select public.get_campaign_status() r'))[0].r; };

describe('who can claim', () => {
  it('a campaign made without an answer is for new customers only; an admin can open it to anyone, and back', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const unset = await save(s, admin, null, null);
      await s.as('postgres');
      expect((await s.q('select new_customers_only n from public.campaigns where id=$1', [unset]))[0].n).toBe(true);
      const open = await save(s, admin, null, false);
      await s.as('postgres');
      expect((await s.q('select new_customers_only n from public.campaigns where id=$1', [open]))[0].n).toBe(false);
      // editing with no answer leaves it alone; with an answer it changes
      await save(s, admin, open, null);
      await s.as('postgres');
      expect((await s.q('select new_customers_only n from public.campaigns where id=$1', [open]))[0].n).toBe(false);
      await save(s, admin, open, true);
      await s.as('postgres');
      expect((await s.q('select new_customers_only n from public.campaigns where id=$1', [open]))[0].n).toBe(true);
      // one version of the function, and only an admin may use it
      expect((await s.q(`select count(*)::int n from pg_proc where proname='admin_save_campaign'`))[0].n).toBe(1);
      const c = await createCustomer(s);
      await s.as('authenticated', c.authId);
      expect(await s.err(`select public.admin_save_campaign(null,'sneaky-open','Sneaky','',current_date,current_date,current_date,5,null,14,500,1000,1500,true,false)`)).toMatch(NOT_ADMIN);
    }));

  it('open to anyone: an existing customer, even one whose vehicle was washed before, can claim; new-only still refuses them', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const everyone = await save(s, admin, null, false);
      const newOnly = await save(s, admin, null, true);
      const day = await istDate(s, 3);
      const old = await person(s);
      await hadAWash(s, old);
      expect((await status(s, old)).campaign).toBeTruthy();
      // two campaigns are live: the one the website shows is the most recently opened, so check each by claiming directly
      expect(await claim(s, old, newOnly, day)).toMatch(/for new WASHO customers/);
      expect(await claim(s, old, everyone, day)).toBeNull();
    }));

  it('open to anyone still means one per phone, vehicle plate and flat', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const camp = await save(s, admin, null, false);
      const day = await istDate(s, 3);
      const a = await person(s, 'MH12XY0101');
      expect(await claim(s, a, camp, day)).toBeNull();
      expect(await claim(s, a, camp, await istDate(s, 4))).toMatch(/already claimed your free wash/);
      const samePlate = await person(s, 'mh 12 xy 0101');
      expect(await claim(s, samePlate, camp, day)).toMatch(/already been claimed for this vehicle/);
    }));

  it('the website is told which it is, and an existing customer is "eligible" only when anyone may claim', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const old = await person(s);
      await hadAWash(s, old);
      const camp = await save(s, admin, null, true);
      expect((await status(s, old)).campaign).toMatchObject({ new_customers_only: true });
      expect((await status(s, old)).me).toEqual({ state: 'ineligible', reason: 'existing_customer' });
      await save(s, admin, camp, false);
      expect((await status(s, old)).campaign).toMatchObject({ new_customers_only: false });
      expect((await status(s, old)).me).toEqual({ state: 'eligible' });
    }));
});
