/** GREEN tests for 20261004000025: a customer who signed in with their email gives a mobile number without confirming it. */
import { describe, expect, it } from 'vitest';
import { createAuthUser, createCustomer, createWorker, inTx, nextPhone, uid } from './helpers';

const set = (s: any, phone: string | null) => s.err(`select public.set_my_phone(${phone === null ? 'null' : `'${phone}'`})`);
const phoneOf = async (s: any, profile: string) => { await s.as('postgres'); return (await s.q('select phone from public.profiles where id=$1', [profile]))[0].phone; };
const emailCustomer = (s: any) => createAuthUser(s, { email: `${uid()}@t.test` }); // no phone, as after signing in with an email code

describe('set_my_phone', () => {
  it('saves a 10-digit number as +91..., in any of the usual ways of typing it, and records that it was typed, not verified', async () =>
    inTx(async (s) => {
      const u = await emailCustomer(s);
      expect(await phoneOf(s, u.profileId)).toBeNull();
      for (const typed of ['9876543210', '98765 43210', '+91 98765-43210', '919876543210', '09876543210']) {
        await s.as('authenticated', u.authId);
        expect(await set(s, typed), typed).toBeNull();
        expect(await phoneOf(s, u.profileId), typed).toBe('+919876543210'); // (phoneOf looks as the database owner, so sign in again each time)
      }
      await s.as('postgres');
      expect((await s.q(`select metadata->>'last4' l from public.audit_events where entity_id=$1 and event_type='phone_added_unverified' order by created_at desc limit 1`, [u.profileId]))[0].l).toBe('3210');
    }));

  it('refuses anything that is not a 10-digit Indian mobile number', async () =>
    inTx(async (s) => {
      const u = await emailCustomer(s);
      await s.as('authenticated', u.authId);
      for (const bad of ['987654321', '98765432100', '5876543210', 'abcdefghij', '', '12345', '+44 7911 123456']) {
        expect(await set(s, bad), bad).toMatch(/valid 10-digit mobile number/);
      }
      expect(await phoneOf(s, u.profileId)).toBeNull();
    }));

  it('can be changed later (a mistyped number), and cleared', async () =>
    inTx(async (s) => {
      const u = await emailCustomer(s);
      await s.as('authenticated', u.authId);
      expect(await set(s, '9876543210')).toBeNull();
      expect(await set(s, '9123456780')).toBeNull();
      expect(await phoneOf(s, u.profileId)).toBe('+919123456780');
      await s.as('authenticated', u.authId);
      expect(await set(s, null)).toBeNull();
      expect(await phoneOf(s, u.profileId)).toBeNull();
    }));

  it('refuses a number that another WASHO account already has, however it is written', async () =>
    inTx(async (s) => {
      const taken = await createCustomer(s, { phone: '+919811122233' });
      const u = await emailCustomer(s);
      await s.as('authenticated', u.authId);
      expect(await set(s, '9811122233')).toMatch(/already registered with WASHO/);
      expect(await set(s, '+91 98111 22233')).toMatch(/already registered with WASHO/);
      expect(await phoneOf(s, taken.profileId)).toBe('+919811122233'); // untouched
      expect(await phoneOf(s, u.profileId)).toBeNull();
    }));

  it('a typed number never merges or takes over anything: other profiles, bookings and logins stay exactly as they were', async () =>
    inTx(async (s) => {
      const a = await emailCustomer(s);
      const b = await emailCustomer(s);
      await s.as('authenticated', a.authId);
      expect(await set(s, '9822233344')).toBeNull();
      await s.as('postgres');
      const rows = await s.q('select id, auth_user_id from public.profiles where id = any($1)', [[a.profileId, b.profileId]]);
      expect(rows).toHaveLength(2); // both still exist, each with its own login
      expect(rows.find((r: any) => r.id === a.profileId).auth_user_id).toBe(a.authId);
      expect(rows.find((r: any) => r.id === b.profileId).auth_user_id).toBe(b.authId);
    }));

  it('not for someone who signs in WITH a confirmed number (that is their identity), nor for staff, visitors or a stranger\'s profile', async () =>
    inTx(async (s) => {
      const byPhone = await createCustomer(s, { phone: nextPhone() });
      await s.as('authenticated', byPhone.authId);
      expect(await set(s, '9876501234')).toMatch(/how you sign in/);

      const w = await createWorker(s);
      await s.as('authenticated', w.authId);
      expect(await set(s, '9876501234')).toMatch(/Customer profile not found/);

      await s.as('anon');
      expect(await set(s, '9876501234')).toMatch(/permission denied/);
    }));
});
