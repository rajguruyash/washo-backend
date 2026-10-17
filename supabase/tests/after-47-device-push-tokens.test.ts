/**
 * GREEN tests for 20261004000047_device_push_tokens.sql: a signed-in person saves their phone's push token (and a phone that changes hands moves to the new person); only an admin who
 * manages Campaigns, having sent an announcement, can ask which phones to push it to, and only the phones of customers who received it; nobody can read the tokens directly.
 */
import { describe, expect, it } from 'vitest';
import { createAdmin, createCustomer, createWorker, inTx } from './helpers';

const NOPE = /access|permission denied|Unauthorized/i;
let n = 0;
const tok = (label = 'a') => `fcm-${label}-${String(++n).padStart(4, '0')}-${'x'.repeat(40)}`;

const register = async (s: any, who: { authId: string }, token: string, platform = 'android', version: string | null = '1.0.0') => {
  await s.as('authenticated', who.authId);
  return s.err('select public.register_device_token($1,$2,$3)', [token, platform, version]);
};
const rows = async (s: any) => {
  await s.as('postgres');
  return (await s.q('select token, profile_id, platform, app_version from public.device_tokens order by token')) as { token: string; profile_id: string; platform: string; app_version: string | null }[];
};
const announce = async (s: any, who: { authId: string }, title = 'Free foam wash today') => {
  await s.as('authenticated', who.authId);
  return (await s.q(`select public.admin_send_announcement($1,'Book before 6 pm.','all') r`, [title]))[0].r as { id: string; recipients: number };
};
const targets = async (s: any, who: { authId: string }, id: string) => {
  await s.as('authenticated', who.authId);
  return (await s.q('select public.admin_announcement_push_targets($1) r', [id]))[0].r as { title: string; body: string; devices: { token: string; notification_id: string }[] };
};

describe('saving a phone', () => {
  it('a signed-in person saves their phone, saving it again changes nothing, and it is theirs', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      const t = tok();
      expect(await register(s, c, t)).toBeNull();
      expect(await register(s, c, t, 'android', '1.0.1')).toBeNull();
      const r = (await rows(s)).filter((x) => x.token === t);
      expect(r).toEqual([{ token: t, profile_id: c.profileId, platform: 'android', app_version: '1.0.1' }]);
    }));

  it('refuses a token that is too short or has spaces, and an unknown platform', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      expect(await register(s, c, 'short')).toMatch(/not a valid device token/i);
      expect(await register(s, c, `${'y'.repeat(30)} ${'z'.repeat(10)}`)).toMatch(/not a valid device token/i);
      expect(await register(s, c, tok(), 'windows')).toMatch(/android or ios/i);
    }));

  it('a person keeps their five newest phones', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      const tokens = Array.from({ length: 5 }, () => tok('phone'));
      for (const t of tokens) expect(await register(s, c, t)).toBeNull();
      // (inside one test transaction they would all carry the same moment: give each its own so the oldest is clear)
      await s.as('postgres');
      for (let i = 0; i < tokens.length; i++) await s.q(`update public.device_tokens set last_seen_at = now() - ($2 || ' hours')::interval where token = $1`, [tokens[i], String(10 - i)]);
      const sixth = tok('phone');
      expect(await register(s, c, sixth)).toBeNull();
      const mine = (await rows(s)).filter((x) => x.profile_id === c.profileId).map((x) => x.token);
      expect(mine).toHaveLength(5);
      expect(mine).toContain(sixth);
      expect(mine).not.toContain(tokens[0]); // the oldest went
    }));

  it('a phone signed in as someone else now belongs to them, so the last person stops getting its messages', async () =>
    inTx(async (s) => {
      const a = await createCustomer(s);
      const b = await createCustomer(s);
      const t = tok('shared');
      await register(s, a, t);
      await register(s, b, t);
      expect((await rows(s)).filter((x) => x.token === t).map((x) => x.profile_id)).toEqual([b.profileId]);
    }));

  it('signing out takes the phone away, but only your own', async () =>
    inTx(async (s) => {
      const a = await createCustomer(s);
      const b = await createCustomer(s);
      const t = tok();
      await register(s, a, t);
      await s.as('authenticated', b.authId);
      expect((await s.q('select public.unregister_device_token($1) r', [t]))[0].r).toBe(false); // not b's
      expect((await rows(s)).some((x) => x.token === t)).toBe(true);
      await s.as('authenticated', a.authId);
      expect((await s.q('select public.unregister_device_token($1) r', [t]))[0].r).toBe(true);
      expect((await rows(s)).some((x) => x.token === t)).toBe(false);
    }));

  it('a signed-out caller cannot save or remove one, and nobody can read or write the table directly', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      await s.as('anon');
      expect(await s.err('select public.register_device_token($1)', [tok()])).toMatch(NOPE);
      expect(await s.err('select public.unregister_device_token($1)', [tok()])).toMatch(NOPE);
      await register(s, c, tok());
      await s.as('authenticated', c.authId);
      expect(await s.err('select * from public.device_tokens')).toMatch(/permission denied/i);
      expect(await s.err(`insert into public.device_tokens (token, profile_id) values ('${'q'.repeat(30)}', '${c.profileId}')`)).toMatch(/permission denied/i);
    }));
});

describe('who gets an announcement pushed', () => {
  it('the phones of the customers who received it: not other people, not an archived customer, not a customer with no phone saved', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s, 'marketing');
      const a = await createCustomer(s);
      const b = await createCustomer(s);
      const gone = await createCustomer(s);
      const nobody = await createCustomer(s);
      const w = await createWorker(s);
      const ta1 = tok('a'), ta2 = tok('a'), tb = tok('b'), tg = tok('gone'), tw = tok('worker');
      await register(s, a, ta1); await register(s, a, ta2); await register(s, b, tb); await register(s, gone, tg); await register(s, w, tw);

      const sent = await announce(s, admin);
      expect(sent.recipients).toBeGreaterThanOrEqual(3);
      // a customer archived AFTER they were sent the notification is no longer pushed to (an archived one is never sent a notification at all, so this is the case that matters)
      await s.as('postgres');
      await s.q('update public.profiles set archived_at = now() where id = $1', [gone.profileId]);
      const t = await targets(s, admin, sent.id);
      expect(t).toMatchObject({ title: 'Free foam wash today', body: 'Book before 6 pm.' });
      expect(t.devices.map((d) => d.token).sort()).toEqual([ta1, ta2, tb].sort());

      // each phone carries the id of ITS customer's notification (so a tap can open the right one)
      await s.as('postgres');
      const mine = (await s.q(`select id from public.notifications where profile_id = $1 and reference_id = $2`, [a.profileId, sent.id])) as { id: string }[];
      expect(mine).toHaveLength(1);
      expect(t.devices.filter((d) => [ta1, ta2].includes(d.token)).map((d) => d.notification_id)).toEqual([mine[0].id, mine[0].id]);
      expect(nobody.profileId).toBeTruthy();
    }));

  it('only Campaigns managers can ask, and not for an announcement that does not exist', async () =>
    inTx(async (s) => {
      const boss = await createAdmin(s, 'super_admin');
      const sent = await announce(s, boss);
      const c = await createCustomer(s);
      const w = await createWorker(s);
      const sup = await createAdmin(s, 'support');
      const fin = await createAdmin(s, 'finance');
      for (const who of [c, w, sup, fin]) {
        await s.as('authenticated', who.authId);
        expect(await s.err('select public.admin_announcement_push_targets($1)', [sent.id])).toMatch(NOPE);
      }
      await s.as('anon');
      expect(await s.err('select public.admin_announcement_push_targets($1)', [sent.id])).toMatch(NOPE);
      await s.as('authenticated', boss.authId);
      expect(await s.err('select public.admin_announcement_push_targets($1)', ['00000000-0000-0000-0000-000000000000'])).toMatch(/no longer exists/i);
    }));

  it('phones Firebase says are gone can be forgotten, by a Campaigns manager only', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s, 'operations');
      const c = await createCustomer(s);
      const keep = tok('keep'), drop = tok('drop');
      await register(s, c, keep); await register(s, c, drop);
      await s.as('authenticated', c.authId);
      expect(await s.err('select public.admin_forget_device_tokens($1::text[])', [[drop]])).toMatch(NOPE);
      await s.as('authenticated', admin.authId);
      expect((await s.q('select public.admin_forget_device_tokens($1::text[]) r', [[drop, 'not-a-token-at-all-0000000000']]))[0].r).toBe(1);
      expect((await rows(s)).filter((x) => x.profile_id === c.profileId).map((x) => x.token)).toEqual([keep]);
      await s.as('authenticated', admin.authId);
      expect((await s.q('select public.admin_forget_device_tokens($1::text[]) r', [[]]))[0].r).toBe(0);
    }));
});
