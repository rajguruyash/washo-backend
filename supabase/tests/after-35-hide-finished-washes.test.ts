/**
 * GREEN tests for 20261004000035_hide_finished_washes.sql: a customer clears a finished wash from their own list and can bring it back; nothing is deleted.
 */
import { describe, expect, it } from 'vitest';
import { confirmedBooking, createAdmin, createCustomer, createWorker, inTx, uid } from './helpers';

const as = async (s: any, u: { authId: string }) => s.as('authenticated', u.authId);
const hide = async (s: any, u: { authId: string }, id: string) => { await as(s, u); return s.err('select public.hide_my_wash($1)', [id]); };
const setStatus = async (s: any, id: string, status: string) => { await s.as('postgres'); await s.q(`update public.bookings set status = $2 where id = $1`, [id, status]); };
const mine = async (s: any, u: { authId: string }) => { await as(s, u); return (await s.q('select booking_id from public.customer_hidden_washes')).map((r: any) => r.booking_id); };

describe('clearing a finished wash', () => {
  it('a done, cancelled, refunded or missed wash can be cleared, and only that customer sees what they cleared', async () =>
    inTx(async (s) => {
      for (const status of ['completed', 'cancelled', 'refunded', 'no_show']) {
        const w = await confirmedBooking(s);
        await setStatus(s, w.id, status);
        expect(await hide(s, w.u, w.id), status).toBeNull();
        expect(await mine(s, w.u)).toEqual([w.id]);
        const other = await createCustomer(s);
        expect(await mine(s, other)).toEqual([]);
      }
    }));

  it('a wash that is coming up, in progress, or has a refund waiting cannot be cleared', async () =>
    inTx(async (s) => {
      for (const status of ['confirmed', 'worker_assigned', 'worker_called', 'in_progress', 'refund_requested']) {
        const w = await confirmedBooking(s);
        await setStatus(s, w.id, status);
        expect(await hide(s, w.u, w.id), status).toMatch(/finished/);
      }
    }));

  it('not someone else\'s wash; clearing twice is fine; "undo" brings it back; nothing is deleted', async () =>
    inTx(async (s) => {
      const w = await confirmedBooking(s);
      await setStatus(s, w.id, 'completed');
      const stranger = await createCustomer(s);
      expect(await hide(s, stranger, w.id)).toMatch(/Booking not found/);
      expect(await hide(s, w.u, uid())).toMatch(/Booking not found/);
      expect(await hide(s, w.u, w.id)).toBeNull();
      expect(await hide(s, w.u, w.id)).toBeNull();
      expect(await mine(s, w.u)).toEqual([w.id]);
      await as(s, w.u);
      expect(await s.err('select public.unhide_my_wash($1)', [w.id])).toBeNull();
      expect(await mine(s, w.u)).toEqual([]);
      await as(s, w.u);
      expect(await s.err('select public.hide_my_wash($1)', [w.id])).toBeNull();
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.bookings where id = $1', [w.id]))[0].n).toBe(1);
    }));

  it('a specialist, an admin and a visitor cannot use it; the list cannot be written directly', async () =>
    inTx(async (s) => {
      const w = await confirmedBooking(s);
      await setStatus(s, w.id, 'completed');
      for (const who of [await createWorker(s), await createAdmin(s, 'super_admin')]) {
        expect(await hide(s, who, w.id)).toMatch(/Customer profile not found/);
        await as(s, who);
        expect(await s.err('select public.unhide_my_wash($1)', [w.id])).toMatch(/Customer profile not found/);
      }
      await s.as('anon');
      expect(await s.err('select public.hide_my_wash($1)', [w.id])).toMatch(/permission denied/i);
      await as(s, w.u);
      expect(await s.err(`insert into public.customer_hidden_washes (customer_profile_id, booking_id) values ($1,$2)`, [w.u.profileId, w.id])).toMatch(/permission denied/i);
    }));
});
