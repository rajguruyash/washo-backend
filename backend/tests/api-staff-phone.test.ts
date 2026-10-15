/**
 * An admin or specialist who asks for a phone code with their own number is told to use email, is not signed in, and keeps their email sign-in
 * (before the fix their profile was moved to the phone login and the next email sign-in made an empty customer profile).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, boot, expectOk, fake, randomPhone, shutdown, staffClient } from './helpers';
import { FAKE } from './fakeSupabase';

beforeAll(boot);
afterAll(shutdown);

const dbOne = async (sql: string, params: unknown[] = []) => (await fake.admin.query(sql, params)).rows[0];

describe.each(['admin', 'worker'] as const)('a %s using a phone code with their own number', (role) => {
  it('is refused with a clear message, stays out, and can still sign in with email', async () => {
    const phone = randomPhone();
    const staff = await fake.createStaff(role, { phone });
    const before = await dbOne('select id, auth_user_id, role::text role from public.profiles where phone = $1', [phone]);

    const c = new Client();
    expectOk(await c.post('/api/auth/otp/request', { phone }));
    const v = await c.post('/api/auth/otp/verify', { phone, code: FAKE.otpCode, source: 'android' });
    expect(v.status).toBe(403);
    expect(v.body.code).toBe('staff_use_email');
    expect(v.body.message).toMatch(/team account/i);
    expect((await c.get('/api/me')).status).toBe(401); // not signed in

    // the profile did not move
    expect(await dbOne('select id, auth_user_id, role::text role from public.profiles where phone = $1', [phone])).toEqual(before);

    // and the email sign-in is still THEIR profile, not a new customer one
    const again = new Client();
    expectOk(await again.loginStaff(staff.email, staff.password));
    const me = expectOk(await again.get('/api/me')).body.user;
    expect(me.role).toBe(role);
    expect(me.id).toBe(before.id);
  });
});
