/** GREEN tests for 20261004000026: a login with no profile gets one when its owner signs in. */
import { describe, expect, it } from 'vitest';
import { createAuthUser, createCustomer, createWorker, inTx, nextPhone, uid } from './helpers';

const ensure = (s: any) => s.err('select public.ensure_my_profile()');
/** An account that signed up before profiles were made automatically: a login with no profile row. */
async function orphan(s: any, o: { email?: string; phone?: string; phoneConfirmed?: boolean; name?: string } = {}) {
  await s.as('postgres');
  await s.q('alter table auth.users disable trigger on_auth_user_created_create_customer_profile'); // as if the account were made before the trigger existed
  const u = await createAuthUser(s, { email: o.email, phone: o.phone, phoneConfirmed: o.phoneConfirmed, fullName: o.name ?? 'Early Bird' });
  await s.as('postgres');
  await s.q('alter table auth.users enable trigger on_auth_user_created_create_customer_profile');
  return u;
}
const profileOf = async (s: any, authId: string) => { await s.as('postgres'); return (await s.q('select id, role::text role, full_name, phone, email from public.profiles where auth_user_id=$1', [authId]))[0]; };

describe('ensure_my_profile', () => {
  it('gives an email login with no profile a customer profile, with its name and email', async () =>
    inTx(async (s) => {
      const email = `${uid()}@t.test`;
      const u = await orphan(s, { email, name: 'Yash Raj' });
      expect(await profileOf(s, u.authId)).toBeUndefined();
      await s.as('authenticated', u.authId);
      const id = (await s.q('select public.ensure_my_profile() id'))[0].id;
      expect(await profileOf(s, u.authId)).toEqual({ id, role: 'customer', full_name: 'Yash Raj', phone: null, email });
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.audit_events where entity_id=$1 and event_type='profile_created_on_sign_in'`, [id]))[0].n).toBe(1);
    }));

  it('does nothing for a login that already has a profile, however often it is called', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      await s.as('authenticated', u.authId);
      const a = (await s.q('select public.ensure_my_profile() id'))[0].id;
      const b = (await s.q('select public.ensure_my_profile() id'))[0].id;
      expect(a).toBe(u.profileId);
      expect(b).toBe(u.profileId);
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.profiles where auth_user_id=$1', [u.authId]))[0].n).toBe(1);
    }));

  it('a login with a CONFIRMED number joins the profile that already has that number, as the trigger does', async () =>
    inTx(async (s) => {
      const phone = nextPhone();
      await s.as('postgres');
      const existing = await createAuthUser(s, { email: `${uid()}@t.test` }); // someone whose profile already carries the number
      await s.q('update public.profiles set phone = $2 where id = $1', [existing.profileId, phone]);
      const u = await orphan(s, { phone, phoneConfirmed: true });
      await s.as('authenticated', u.authId);
      const id = (await s.q('select public.ensure_my_profile() id'))[0].id;
      expect(id).toBe(existing.profileId);
      expect((await profileOf(s, u.authId)).id).toBe(existing.profileId);
    }));

  it('a login with an UNCONFIRMED number does not join anyone: it gets its own profile', async () =>
    inTx(async (s) => {
      const phone = nextPhone();
      await s.as('postgres');
      const existing = await createAuthUser(s, { email: `${uid()}@t.test` });
      await s.q('update public.profiles set phone = $2 where id = $1', [existing.profileId, phone]);
      const u = await orphan(s, { email: `${uid()}@t.test`, phone, phoneConfirmed: false });
      await s.as('authenticated', u.authId);
      const id = (await s.q('select public.ensure_my_profile() id'))[0].id;
      expect(id).not.toBe(existing.profileId);
    }));

  it('a number from the sign-up details is used only when no other profile has it', async () =>
    inTx(async (s) => {
      const phone = nextPhone();
      await s.as('postgres');
      const holder = await createAuthUser(s, { email: `${uid()}@t.test` });
      await s.q('update public.profiles set phone = $2 where id = $1', [holder.profileId, phone]);
      await s.q('alter table auth.users disable trigger on_auth_user_created_create_customer_profile');
      const taken = await createAuthUser(s, { email: `${uid()}@t.test`, metadataPhone: phone });
      const free = await createAuthUser(s, { email: `${uid()}@t.test`, metadataPhone: nextPhone() });
      await s.as('postgres');
      await s.q('alter table auth.users enable trigger on_auth_user_created_create_customer_profile');
      for (const u of [taken, free]) { await s.as('authenticated', u.authId); await s.q('select public.ensure_my_profile()'); }
      expect((await profileOf(s, taken.authId)).phone).toBeNull(); // the holder keeps it, alone
      expect((await profileOf(s, free.authId)).phone).toMatch(/^\+91/);
      expect((await profileOf(s, holder.authId)).phone).toBe(phone);
    }));

  it('only for the caller\'s own login, and not for visitors; it never makes a specialist or an admin', async () =>
    inTx(async (s) => {
      await s.as('anon');
      expect(await ensure(s)).toMatch(/permission denied/);
      const u = await orphan(s, { email: `${uid()}@t.test` });
      const other = await orphan(s, { email: `${uid()}@t.test` });
      await s.as('authenticated', u.authId);
      await s.q('select public.ensure_my_profile()');
      expect(await profileOf(s, other.authId)).toBeUndefined(); // someone else's login is not touched
      expect((await profileOf(s, u.authId)).role).toBe('customer');
      // a signed-in role claim without an auth user behind it
      await s.as('authenticated', uid());
      expect(await ensure(s)).toMatch(/Not authenticated/);
      const w = await createWorker(s);
      await s.as('authenticated', w.authId);
      expect((await s.q('select public.ensure_my_profile() id'))[0].id).toBe(w.profileId); // staff keep their profile and role
    }));
});
