/** GREEN tests for 20261004000007_fix_worker_call_and_start.sql */
import { describe, expect, it } from 'vitest';
import { createCustomer, createVehicle, createWorker, inTx, serviceId } from './helpers';

async function booking(s: any, status = 'confirmed') {
  const u = await createCustomer(s);
  const veh = await createVehicle(s, u.profileId);
  const svc = await serviceId(s, 'car-body-wash');
  await s.as('postgres');
  const id = (await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',current_date+3,'morning',$4) returning id`, [u.profileId, veh, svc, status]))[0].id;
  return { u, id };
}
const st = async (s: any, id: string) => { await s.as('postgres'); return (await s.q(`select status::text s from public.bookings where id=$1`, [id]))[0].s; };
const holder = async (s: any, id: string) => { await s.as('postgres'); return (await s.q(`select worker_profile_id w from public.worker_assignments where booking_id=$1 and is_active`, [id])).map((r: any) => r.w); };

describe('worker_call_customer', () => {
  it('works (it never did in production) and records the call', async () =>
    inTx(async (s) => {
      const { id } = await booking(s);
      const w = await createWorker(s);
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_call_customer('${id}')`)).toBeNull();
      expect(await st(s, id)).toBe('worker_called');
      expect(await holder(s, id)).toEqual([w.profileId]);
      expect((await s.q(`select event_type from public.booking_events where booking_id=$1 order by created_at`, [id])).map((e: any) => e.event_type)).toEqual(['worker_assigned', 'worker_called']);
    }));

  it('cannot steal a job that another worker holds', async () =>
    inTx(async (s) => {
      const { id } = await booking(s);
      const w1 = await createWorker(s);
      const w2 = await createWorker(s);
      await s.as('authenticated', w1.authId);
      await s.q(`select public.worker_claim_booking('${id}')`);
      await s.as('authenticated', w2.authId);
      expect(await s.err(`select public.worker_call_customer('${id}')`)).toMatch(/already assigned to another specialist/);
      expect(await holder(s, id)).toEqual([w1.profileId]);
    }));

  it('keeps an in-progress wash in progress', async () =>
    inTx(async (s) => {
      const { id } = await booking(s);
      const w = await createWorker(s);
      await s.as('authenticated', w.authId);
      await s.q(`select public.worker_start_wash('${id}')`);
      expect(await s.err(`select public.worker_call_customer('${id}')`)).toBeNull();
      expect(await st(s, id)).toBe('in_progress');
    }));

  it('customers cannot use it', async () =>
    inTx(async (s) => {
      const { id, u } = await booking(s);
      await s.as('authenticated', u.authId);
      expect(await s.err(`select public.worker_call_customer('${id}')`)).toMatch(/Only authenticated workers/);
    }));
});

describe('worker_start_wash', () => {
  it('starts an unclaimed confirmed wash (claiming it) and is idempotent for the same worker', async () =>
    inTx(async (s) => {
      const { id } = await booking(s);
      const w = await createWorker(s);
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_start_wash('${id}')`)).toBeNull();
      expect(await st(s, id)).toBe('in_progress');
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_start_wash('${id}')`)).toBeNull();
      expect(await holder(s, id)).toEqual([w.profileId]);
      expect((await s.q(`select count(*)::int n from public.booking_events where booking_id=$1 and event_type='wash_started'`, [id]))[0].n).toBe(1);
    }));

  it('cannot take over a wash another worker has claimed, even before it is in progress', async () =>
    inTx(async (s) => {
      const { id } = await booking(s);
      const w1 = await createWorker(s);
      const w2 = await createWorker(s);
      await s.as('authenticated', w1.authId);
      await s.q(`select public.worker_claim_booking('${id}')`);
      await s.as('authenticated', w2.authId);
      expect(await s.err(`select public.worker_start_wash('${id}')`)).toMatch(/already assigned to another specialist/);
      expect(await holder(s, id)).toEqual([w1.profileId]);
      expect(await st(s, id)).toBe('worker_assigned');
    }));

  it('will not start an unpaid, refunded, completed or cancelled booking', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      for (const status of ['pending', 'refunded', 'completed', 'cancelled', 'no_show']) {
        const { id } = await booking(s, status);
        await s.as('authenticated', w.authId);
        expect(await s.err(`select public.worker_start_wash('${id}')`), status).toMatch(/not available to claim|cannot be started/);
      }
    }));
});

describe('service-only wrappers (for edge functions)', () => {
  it('service role can call them; customers, workers and anon cannot', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const w = await createWorker(s);
      for (const who of [['authenticated', u.authId], ['authenticated', w.authId], ['anon', null]] as const) {
        await s.as(who[0], who[1]);
        expect(await s.err(`select public.svc_settle_payment('o','p',1,'INR','captured')`)).toMatch(/permission denied/);
        expect(await s.err(`select public.svc_attach_provider_order(gen_random_uuid(),'o')`)).toMatch(/permission denied/);
        expect(await s.err(`select public.svc_profile_id_for_auth_user('${u.authId}')`)).toMatch(/permission denied/);
      }
      await s.as('service_role');
      expect((await s.q(`select public.svc_settle_payment('nope','p',1,'INR','captured') r`))[0].r.status).toBe('unknown_order');
      expect((await s.q(`select public.svc_profile_id_for_auth_user($1) id`, [u.authId]))[0].id).toBe(u.profileId);
    }));
});
