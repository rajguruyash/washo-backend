/**
 * GREEN tests for 20261004000037_campaign_delete.sql: an admin deletes a campaign. It is archived, not removed: it is switched off for good, leaves the website, and every claim,
 * booking and offer stays.
 */
import { describe, expect, it } from 'vitest';
import { createAdmin, createCustomer, createVehicle, createWorker, inTx, istDate, uid } from './helpers';

const NOT_ADMIN = /admin access required|permission denied/i;

async function campaign(s: any, o: { active?: boolean } = {}) {
  const opens = await istDate(s, 0), closes = await istDate(s, 3), useBy = await istDate(s, 7);
  await s.as('postgres');
  return (await s.q(
    `insert into public.campaigns (code, name, is_active, claim_opens_on, claim_closes_on, use_by_date, total_cap, pack_offer_days, pack_offer_bp_1, pack_offer_bp_2, pack_offer_bp_3plus, new_customers_only)
     values ($1, 'Free wash', $2, $3, $4, $5, 100, 14, 500, 1000, 1500, false) returning id, code`, [`t-${uid().slice(0, 8)}`, o.active ?? true, opens, closes, useBy]
  ))[0] as { id: string; code: string };
}
async function person(s: any) {
  const u = await createCustomer(s);
  await s.as('postgres');
  const addr = (await s.q(`insert into public.customer_addresses (customer_profile_id, society_name, building_block, flat_number, parking_location, is_default) values ($1,'Yashwin Orizzonte','B',$2,'Basement P1',true) returning id`, [u.profileId, `F-${uid().slice(0, 6)}`]))[0].id as string;
  const veh = await createVehicle(s, u.profileId, 'car');
  return { u, addr, veh };
}
const asAdmin = async (s: any) => { const a = await createAdmin(s, 'super_admin'); await s.as('authenticated', a.authId); return a; };

describe('deleting a campaign', () => {
  it('archives it and switches it off; claims, bookings and offers stay; the website no longer shows it', async () =>
    inTx(async (s) => {
      const c = await campaign(s);
      const p = await person(s);
      const day = await istDate(s, 3);
      await s.as('authenticated', p.u.authId);
      const claim = (await s.q(`select public.claim_campaign_wash($1::uuid,$2::uuid,$3::date,'morning',$4::uuid,'Basement P1') r`, [c.id, p.veh, day, p.addr]))[0].r;
      await s.as('anon');
      expect((await s.q('select public.get_campaign_status() r'))[0].r.campaign).toMatchObject({ id: c.id });
      await asAdmin(s);
      expect((await s.q('select public.admin_archive_campaign($1) r', [c.id]))[0].r).toBe(true);
      await s.as('anon');
      expect((await s.q('select public.get_campaign_status() r'))[0].r.campaign).toBeNull();
      await s.as('postgres');
      expect((await s.q('select is_active, archived_at is not null a from public.campaigns where id = $1', [c.id]))[0]).toEqual({ is_active: false, a: true });
      expect((await s.q('select count(*)::int n from public.campaign_claims where campaign_id = $1', [c.id]))[0].n).toBe(1);
      expect((await s.q('select count(*)::int n from public.bookings where id = $1', [claim.booking_id]))[0].n).toBe(1);
      const ev = await s.q(`select metadata from public.audit_events where entity_id = $1 and event_type = 'campaign_deleted'`, [c.id]);
      expect(ev).toHaveLength(1);
      expect(ev[0].metadata).toEqual({ code: c.code, claims: 1 });
    }));

  it('nobody can claim a deleted campaign, and it can never be switched on or edited again; its code stays taken', async () =>
    inTx(async (s) => {
      const c = await campaign(s);
      const p = await person(s);
      await asAdmin(s);
      await s.q('select public.admin_archive_campaign($1)', [c.id]);
      const day = await istDate(s, 3);
      await s.as('authenticated', p.u.authId);
      expect(await s.err(`select public.claim_campaign_wash($1::uuid,$2::uuid,$3::date,'morning',$4::uuid,'Basement P1')`, [c.id, p.veh, day, p.addr])).toMatch(/not running right now/);
      await asAdmin(s);
      expect(await s.err('select public.admin_set_campaign_active($1, true)', [c.id])).toMatch(/This campaign was deleted/);
      expect(await s.err(`select public.admin_save_campaign($1,'','Renamed','',current_date,current_date + 2,current_date + 6,50,null,14,500,1000,1500)`, [c.id])).toMatch(/This campaign was deleted/);
      expect(await s.err(`select public.admin_save_campaign(null,$1,'Again','',current_date,current_date + 2,current_date + 6,50,null,14,500,1000,1500)`, [c.code])).toMatch(/There is already a campaign called/);
      await s.as('postgres');
      expect(await s.err(`update public.campaigns set archived_at = null where id = '${c.id}'`)).toMatch(/This campaign was deleted/);
    }));

  it('a campaign that was never switched on, or has no claims, can be deleted; one that is not there, or already deleted, is "not found"', async () =>
    inTx(async (s) => {
      const off = await campaign(s, { active: false });
      await asAdmin(s);
      expect((await s.q('select public.admin_archive_campaign($1) r', [off.id]))[0].r).toBe(true);
      expect(await s.err('select public.admin_archive_campaign($1)', [off.id])).toMatch(/Campaign not found/);
      expect(await s.err('select public.admin_archive_campaign($1)', [uid()])).toMatch(/Campaign not found/);
    }));

  it('only an admin may delete one', async () =>
    inTx(async (s) => {
      const c = await campaign(s);
      const cust = await createCustomer(s);
      const worker = await createWorker(s);
      for (const who of [{ role: 'authenticated', id: cust.authId }, { role: 'authenticated', id: worker.authId }, { role: 'anon', id: null }] as const) {
        await s.as(who.role, who.id);
        expect(await s.err('select public.admin_archive_campaign($1)', [c.id])).toMatch(NOT_ADMIN);
      }
      await s.as('postgres');
      expect((await s.q('select archived_at from public.campaigns where id = $1', [c.id]))[0].archived_at).toBeNull();
    }));
});
