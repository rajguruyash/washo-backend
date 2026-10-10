import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ReplayGuard,
  indianMobile,
  maskMobile,
  parseHookPayload,
  parseHookSecret,
  redact,
  sendOtpVia2Factor,
  twoFactorSendUrl,
  verifyStandardWebhook,
} from './sms.ts';

// A secret in the shape Supabase shows it: "v1,whsec_" + base64 of 32 bytes.
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 3);
const SECRET_TEXT = `v1,whsec_${btoa(String.fromCharCode(...KEY_BYTES))}`;
const sign = (id: string, ts: string | number, body: string, key: Uint8Array = KEY_BYTES) => `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;

describe('parseHookSecret', () => {
  it('reads Supabase\'s "v1,whsec_<base64>" form (and the bare "whsec_" form)', () => {
    expect(parseHookSecret(SECRET_TEXT)).toEqual(KEY_BYTES);
    expect(parseHookSecret(`whsec_${btoa(String.fromCharCode(...KEY_BYTES))}`)).toEqual(KEY_BYTES);
    expect(parseHookSecret(`  ${SECRET_TEXT}\n`)).toEqual(KEY_BYTES);
  });
  it('refuses anything that is not a usable secret', () => {
    for (const bad of [undefined, null, '', 'v1,whsec_', 'v1,whsec_%%%', 'v1,whsec_abc', 'plain text with spaces', `v1,whsec_${btoa('short')}`]) expect(parseHookSecret(bad as string), String(bad)).toBeNull();
  });
});

// The published Standard Webhooks test vector (github.com/standard-webhooks/standard-webhooks, in its Python and Go library tests): a public sample, NOT a credential.
// The "whsec_" prefix is kept apart from the body so secret scanners, which look for "whsec_" followed by key characters, do not mistake it for a real signing secret.
const VECTOR_SECRET_BODY = 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

describe('verifyStandardWebhook', () => {
  // The published Standard Webhooks test vector (standardwebhooks.com / svix): proves the signing scheme itself, not just our own round trip.
  it('matches the published reference vector', () => {
    const secret = parseHookSecret(`whsec_${VECTOR_SECRET_BODY}`)!;
    const base = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: '1614265330', rawBody: '{"test": 2432232314}', secret, nowSeconds: 1614265330 };
    expect(verifyStandardWebhook({ ...base, signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' })).toEqual({ ok: true });
    expect(verifyStandardWebhook({ ...base, signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OF=' }).ok).toBe(false);
  });

  const now = 1_800_000_000;
  const body = '{"user":{"phone":"919172792929"},"sms":{"otp":"123456"}}';
  const good = (over: Partial<Parameters<typeof verifyStandardWebhook>[0]> = {}) => ({
    id: 'msg_abc', timestamp: String(now), signature: sign('msg_abc', now, body), rawBody: body, secret: KEY_BYTES, nowSeconds: now, ...over,
  });

  it('accepts a correctly signed, fresh request', () => {
    expect(verifyStandardWebhook(good())).toEqual({ ok: true });
  });
  it('refuses a wrong secret, a changed body, a changed id and a changed timestamp', () => {
    const other = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    expect(verifyStandardWebhook(good({ signature: sign('msg_abc', now, body, other) }))).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyStandardWebhook(good({ rawBody: body.replace('123456', '654321') }))).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyStandardWebhook(good({ id: 'msg_other' }))).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyStandardWebhook(good({ timestamp: String(now + 1) }))).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('signs the raw text: the same JSON written differently does not verify', () => {
    expect(verifyStandardWebhook(good({ rawBody: JSON.stringify(JSON.parse(body), null, 1) })).ok).toBe(false);
  });
  it('timestamp window: five minutes either side is fine, one second more is not (replay protection)', () => {
    for (const drift of [-300, 300, 0]) {
      const ts = String(now + drift);
      expect(verifyStandardWebhook(good({ timestamp: ts, signature: sign('msg_abc', ts, body) })), String(drift)).toEqual({ ok: true });
    }
    for (const drift of [-301, 301, -86_400]) {
      const ts = String(now + drift);
      expect(verifyStandardWebhook(good({ timestamp: ts, signature: sign('msg_abc', ts, body) })), String(drift)).toEqual({ ok: false, reason: 'stale_timestamp' });
    }
  });
  it('refuses missing headers and unreadable timestamps', () => {
    expect(verifyStandardWebhook(good({ id: null })).ok).toBe(false);
    expect(verifyStandardWebhook(good({ timestamp: undefined })).ok).toBe(false);
    expect(verifyStandardWebhook(good({ signature: null })).ok).toBe(false);
    expect(verifyStandardWebhook(good({ id: '' })).ok).toBe(false);
    for (const ts of ['abc', '-5', '1.5', '1e9', '']) expect(verifyStandardWebhook(good({ timestamp: ts })).ok, ts).toBe(false);
  });
  it('several signatures in the header (key rotation): one valid is enough, an unknown version never counts', () => {
    const real = sign('msg_abc', now, body);
    expect(verifyStandardWebhook(good({ signature: `v1,AAAA ${real}` }))).toEqual({ ok: true });
    expect(verifyStandardWebhook(good({ signature: `${real} v1,AAAA` }))).toEqual({ ok: true });
    expect(verifyStandardWebhook(good({ signature: real.replace('v1,', 'v2,') })).ok).toBe(false);
    expect(verifyStandardWebhook(good({ signature: real.slice(3) })).ok).toBe(false); // no version at all
    expect(verifyStandardWebhook(good({ signature: 'v1,' })).ok).toBe(false);
    expect(verifyStandardWebhook(good({ signature: real + 'A' })).ok).toBe(false); // different length
  });
});

describe('ReplayGuard', () => {
  it('lets an id through once', () => {
    const g = new ReplayGuard();
    expect(g.claim('a', 0)).toBe(true);
    expect(g.claim('a', 1000)).toBe(false);
    expect(g.claim('b', 1000)).toBe(true);
  });
  it('gives the id back after a failed send, so a retry of the same delivery works', () => {
    const g = new ReplayGuard();
    g.claim('a', 0);
    g.release('a');
    expect(g.claim('a', 10)).toBe(true);
  });
  it('forgets an id after the window (longer than the +-5 minute timestamp window)', () => {
    const g = new ReplayGuard();
    g.claim('a', 0);
    expect(g.claim('a', 10 * 60_000)).toBe(false);
    expect(g.claim('a', 11 * 60_000)).toBe(true);
  });
  it('stays bounded', () => {
    const g = new ReplayGuard(60_000, 3);
    for (const id of ['a', 'b', 'c', 'd', 'e']) g.claim(id, 0);
    // the oldest were dropped to keep the memory fixed; the newest are still remembered
    expect(g.claim('e', 1)).toBe(false);
    expect(g.claim('a', 1)).toBe(true);
  });
});

describe('the hook body', () => {
  const body = (phone: unknown, otp: unknown) => JSON.stringify({ user: { id: 'u', phone }, sms: { otp } });
  it('reads the phone and the OTP', () => {
    expect(parseHookPayload(body('919172792929', '123456'))).toEqual({ ok: true, mobile: '9172792929', otp: '123456' });
    expect(parseHookPayload(body('+919172792929', '0123'))).toEqual({ ok: true, mobile: '9172792929', otp: '0123' });
  });
  it('texts the number Supabase says it is texting (sms.phone), which for a phone-number change is the NEW one, not user.phone', () => {
    const full = (user: object, sms: object) => JSON.stringify({ metadata: { uuid: 'x', name: 'send-sms' }, user, sms });
    expect(parseHookPayload(full({ phone: '919000000001' }, { otp: '123456', phone: '919876543210' }))).toEqual({ ok: true, mobile: '9876543210', otp: '123456' });
    // older Auth versions send no sms.phone: user.phone, then user.phone_change for an account that has no phone yet
    expect(parseHookPayload(full({ phone: '919876543210' }, { otp: '123456' }))).toEqual({ ok: true, mobile: '9876543210', otp: '123456' });
    expect(parseHookPayload(full({ phone: '', phone_change: '919876543210' }, { otp: '123456' }))).toEqual({ ok: true, mobile: '9876543210', otp: '123456' });
    expect(parseHookPayload(full({ phone_change: '919876543210' }, { otp: '123456', phone: '' }))).toEqual({ ok: true, mobile: '9876543210', otp: '123456' });
  });
  it('never falls back to the old number when sms.phone says the code is for a number it cannot deliver to', () => {
    const raw = JSON.stringify({ user: { phone: '919876543210' }, sms: { otp: '123456', phone: '14155550123' } });
    expect(parseHookPayload(raw)).toEqual({ ok: false, reason: 'unsupported_phone' });
  });
  it('refuses numbers 2Factor cannot deliver to, and codes it would not send', () => {
    for (const p of ['14155550123', '9172792929', '915172792929', '91917279292', '9191727929299', 'abc']) expect(parseHookPayload(body(p, '123456')), p).toEqual({ ok: false, reason: 'unsupported_phone' });
    for (const o of ['123', '1234567', '12 456', 'abcdef', '']) expect(parseHookPayload(body('919172792929', o)), o).toEqual({ ok: false, reason: 'bad_otp' });
  });
  it('refuses anything that is not the shape Supabase sends', () => {
    for (const raw of ['not json', 'null', '[]', '{}', body(null, '123456'), body('', '123456'), body('   ', '123456'), body('919172792929', 123456), JSON.stringify({ sms: { otp: '123456' } })]) {
      expect(parseHookPayload(raw), raw).toEqual({ ok: false, reason: 'malformed' });
    }
  });
  it('indianMobile accepts only +91 / 91 followed by a mobile number', () => {
    expect(indianMobile('919876543210')).toBe('9876543210');
    expect(indianMobile('+916000000000')).toBe('6000000000');
    expect(indianMobile('915000000000')).toBeNull(); // landline-style start
    expect(indianMobile(919876543210)).toBeNull();
  });
  it('shows only the last four digits when a number is logged', () => {
    expect(maskMobile('9172792929')).toBe('91******2929');
  });
});

describe('2Factor request format (official: GET /API/V1/:api_key/SMS/:phone_number/:otp_value/:otp_template_name)', () => {
  it('builds the custom-OTP URL with the international phone number and OUR code, never AUTOGEN', () => {
    const url = twoFactorSendUrl('KEY-1234', '9172792929', '123456', 'WASHO_LOGIN_OTP');
    expect(url).toBe('https://2factor.in/API/V1/KEY-1234/SMS/+919172792929/123456/WASHO_LOGIN_OTP');
    expect(url).not.toMatch(/AUTOGEN|VERIFY/);
  });
  it('cannot be steered by odd characters in the key or the template', () => {
    const url = twoFactorSendUrl('a/b?c#d', '9172792929', '123456', '../x y');
    expect(url).toBe('https://2factor.in/API/V1/a%2Fb%3Fc%23d/SMS/+919172792929/123456/..%2Fx%20y');
  });
});

describe('sendOtpVia2Factor', () => {
  const KEY = 'SECRET-KEY-9f3a';
  const OTP = '482913';
  const base = { apiKey: KEY, mobile: '9172792929', otp: OTP, template: 'WASHO_LOGIN_OTP' };
  const reply = (status: number, body: unknown) => (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
  const leaks = (r: unknown) => {
    const text = JSON.stringify(r);
    return [KEY, OTP, '2factor.in', '9172792929'].filter((s) => text.includes(s));
  };

  it('succeeds on {"Status":"Success"}', async () => {
    expect(await sendOtpVia2Factor({ ...base, fetchFn: reply(200, { Status: 'Success', Details: 'ab88279e-0105-415f-912e-2f24162b8cbb' }) })).toEqual({ ok: true });
  });
  it('calls exactly the documented URL with GET, no redirects, and a cancel signal', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"Status":"Success","Details":"x"}');
    }) as unknown as typeof fetch;
    await sendOtpVia2Factor({ ...base, fetchFn });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://2factor.in/API/V1/${KEY}/SMS/+919172792929/${OTP}/WASHO_LOGIN_OTP`);
    expect(calls[0].init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
  it('2Factor says no (bad key, bad number, no balance): rejected, and the explanation is redacted', async () => {
    const r = await sendOtpVia2Factor({ ...base, fetchFn: reply(400, { Status: 'Error', Details: `Invalid API Key ${KEY} for ${OTP} to 9172792929` }) });
    expect(r).toMatchObject({ ok: false, kind: 'rejected', httpStatus: 400 });
    expect(leaks(r)).toEqual([]);
    expect((r as { detail: string }).detail).toContain('Invalid API Key');
  });
  it('an HTTP 200 that is not "Success" is still a failure', async () => {
    expect(await sendOtpVia2Factor({ ...base, fetchFn: reply(200, { Status: 'Error', Details: 'Template not found' }) })).toMatchObject({ ok: false, kind: 'rejected' });
    expect(await sendOtpVia2Factor({ ...base, fetchFn: reply(200, '<html>maintenance</html>') })).toMatchObject({ ok: false, kind: 'rejected' });
    expect(await sendOtpVia2Factor({ ...base, fetchFn: reply(200, '{"Status":"Success"') })).toMatchObject({ ok: false, kind: 'rejected' });
  });
  it('a 5xx or 429 from 2Factor is "unavailable" (worth a retry), not a rejection', async () => {
    expect(await sendOtpVia2Factor({ ...base, fetchFn: reply(503, 'busy') })).toMatchObject({ ok: false, kind: 'upstream_unavailable', httpStatus: 503 });
    expect(await sendOtpVia2Factor({ ...base, fetchFn: reply(429, { Status: 'Error', Details: 'slow down' }) })).toMatchObject({ ok: false, kind: 'upstream_unavailable' });
  });
  it('a slow 2Factor is cut off at the timeout and the request is cancelled', async () => {
    let signal: AbortSignal | undefined;
    const slow = ((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise((_res, rej) => signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    }) as unknown as typeof fetch;
    const started = Date.now();
    const r = await sendOtpVia2Factor({ ...base, fetchFn: slow, timeoutMs: 40 });
    expect(r).toEqual({ ok: false, kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(signal!.aborted).toBe(true);
  });
  it('a network error is classified and its text (which in Deno holds the full URL) is dropped', async () => {
    const boom = (async (url: string) => {
      throw new TypeError(`error sending request for url (${url}): connection refused`);
    }) as unknown as typeof fetch;
    const r = await sendOtpVia2Factor({ ...base, fetchFn: boom });
    expect(r).toEqual({ ok: false, kind: 'network' });
    expect(leaks(r)).toEqual([]);
  });
  it('a body that stalls after the headers is also cut off', async () => {
    const stalls = (async (_url: string, init: RequestInit) => {
      const body = new ReadableStream({ start(c) { (init.signal as AbortSignal).addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); } });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    expect(await sendOtpVia2Factor({ ...base, fetchFn: stalls, timeoutMs: 40 })).toEqual({ ok: false, kind: 'timeout' });
  });
});

describe('redact', () => {
  it('removes secrets, control characters, and shortens', () => {
    expect(redact('key=ABC code=123456\nnext', ['ABC', '123456'])).toBe('key=[redacted] code=[redacted] next');
    expect(redact('x'.repeat(500), [])).toHaveLength(120);
    expect(redact('same', [''])).toBe('same');
  });
});
