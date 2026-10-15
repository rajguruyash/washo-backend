/**
 * GREEN tests for 20261004000044_staff_phone_never_linked.sql: a phone sign-in joins an old CUSTOMER profile that carries the number, but never moves, merges or
 * deletes an admin's or specialist's profile (that bug left the admin's email login with no profile, and the next email sign-in made an empty customer one).
 */
import { describe, expect, it } from 'vitest';
import { createAdmin, createAuthUser, createCustomer, createWorker, inTx, nextPhone, uid } from './helpers';

const profileRow = async (s: any, profileId: string) => { await s.as('postgres'); return (await s.q('select id, auth_user_id, role::text role, phone from public.profiles where id=$1', [profileId]))[0]; };
const isStaffNumber = async (s: any, authId: string) => { await s.as('authenticated', authId); return (await s.q('select public.my_phone_is_staff() r'))[0].r as boolean; };

describe.each([['an admin', createAdmin], ['a specialist', createWorker]] as const)('%s asks for a phone code with their own number', (_who, make) => {
  it('their profile stays on their email login: not moved, not merged, not deleted', async () =>
    inTx(async (s) => {
      const staff = await make(s as any);
      await s.as('postgres');
      await s.q('update public.profiles set phone = $2 where id = $1', [staff.profileId, '9' + nextPhone().slice(-9)]); // stored the way a team profile stores it
      const before = await profileRow(s, staff.profileId);
      const intruder = await createAuthUser(s, { phone: `+91${before.phone}`, phoneConfirmed: true });

      const after = await profileRow(s, staff.profileId);
      expect(after).toEqual(before);                                   // same login, same role, same number
      expect(intruder.profileId).not.toBe(staff.profileId);            // the phone login got a profile of its own...
      const own = await profileRow(s, intruder.profileId);
      expect(own.role).toBe('customer');
      expect(own.phone).toBeNull();                                    // ...without the team member's number copied onto it
      expect(await isStaffNumber(s, intruder.authId)).toBe(true);      // and the website can tell, and refuses it
    }));

  it('also when the login is confirmed AFTER it was created, and when ensure_my_profile runs', async () =>
    inTx(async (s) => {
      const staff = await make(s as any);
      await s.as('postgres');
      await s.q('update public.profiles set phone = $2 where id = $1', [staff.profileId, '9' + nextPhone().slice(-9)]);
      const before = await profileRow(s, staff.profileId);
      const login = await createAuthUser(s, { phone: `+91${before.phone}`, phoneConfirmed: false });
      await s.as('postgres');
      await s.q('update auth.users set phone_confirmed_at = now() where id = $1', [login.authId]); // GoTrue confirms the number when the code is accepted
      expect(await profileRow(s, staff.profileId)).toEqual(before);
      await s.as('authenticated', login.authId);
      await s.q('select public.ensure_my_profile()');
      expect(await profileRow(s, staff.profileId)).toEqual(before);
    }));
});

describe('customers are unaffected', () => {
  it('a phone login still joins the old CUSTOMER profile that carries its number', async () =>
    inTx(async (s) => {
      const phone = nextPhone();
      await s.as('postgres');
      const old = await createAuthUser(s, { email: `${uid()}@t.test` });
      await s.q('update public.profiles set phone = $2 where id = $1', [old.profileId, phone]);
      const login = await createAuthUser(s, { phone, phoneConfirmed: true });
      expect(login.profileId).toBe(old.profileId);
      expect((await profileRow(s, old.profileId)).auth_user_id).toBe(login.authId);
      expect(await isStaffNumber(s, login.authId)).toBe(false);
    }));

  it('an ordinary customer, and a team member signing in with their OWN phone login, are not flagged', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      expect(await isStaffNumber(s, c.authId)).toBe(false);
      const w = await createWorker(s); // a specialist whose profile really is on a phone login
      expect(await isStaffNumber(s, w.authId)).toBe(false);
    }));
});
