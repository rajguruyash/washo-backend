import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ReplayGuard } from '../_shared/sms.ts';
import { handleSendSmsHook, type HookDeps } from './handler.ts';

const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i * 5 + 11);
const HOOK_SECRET = `v1,whsec_${btoa(String.fromCharCode(...KEY_BYTES))}`;
const API_KEY = 'TF-KEY-7c1e-SECRET';
const OTP = '482913';
const PHONE = '919172792929';
const NOW_MS = 1_800_000_000_000;

const bodyOf = (phone: string = PHONE, otp: string = OTP) => JSON.stringify({ user: { id: 'u-1', phone, email: '' }, sms: { otp } });
const sign = (id: string, ts: string, body: string) => `v1,${createHmac('sha256', KEY_BYTES).update(`${id}.${ts}.${body}`).digest('base64')}`;

function hook(over: { fetch?: (url: string) => Promise<Response> | Response; env?: Record<string, string | undefined>; timeoutMs?: number; replay?: ReplayGuard } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const env: Record<string, string | undefined> = { SEND_SMS_HOOK_SECRET: HOOK_SECRET, TWOFACTOR_API_KEY: API_KEY, ...over.env };
  const fetchImpl = over.fetch ?? (() => new Response(JSON.stringify({ Status: 'Success', Details: 'session-1' }), { status: 200 }));
  const deps: HookDeps = {
    getenv: (n) => env[n],
    fetchFn: (async (url: string) => {
      calls.push(url);
      return fetchImpl(url);
    }) as unknown as typeof fetch,
    nowMs: () => NOW_MS,
    log: (level, event, fields) => logs.push(JSON.stringify({ level, event, ...fields })),
    replay: over.replay ?? new ReplayGuard(),
    timeoutMs: over.timeoutMs,
  };
  const send = (o: { body?: string; id?: string; ts?: string; sig?: string | null; method?: string; headers?: Record<string, string> } = {}) => {
    const body = o.body ?? bodyOf();
    const id = o.id ?? 'msg_001';
    const ts = o.ts ?? String(NOW_MS / 1000);
    const headers: Record<string, string> = { 'webhook-id': id, 'webhook-timestamp': ts, ...o.headers };
    if (o.sig !== null) headers['webhook-signature'] = o.sig ?? sign(id, ts, body);
    return handleSendSmsHook(new Request('https://x.functions.supabase.co/send-sms-hook', { method: o.method ?? 'POST', headers, body: o.method === 'GET' ? undefined : body }), deps);
  };
  return { send, calls, logs, deps };
}

/** Nothing a person, a log aggregator or Supabase's error text could use to read the key, the OTP, the URL or the whole phone number. */
const noSecrets = (text: string) => {
  for (const s of [API_KEY, OTP, '2factor.in', PHONE, '9172792929', 'whsec_', HOOK_SECRET, 'API/V1']) expect(text, s).not.toContain(s);
};

describe('a valid delivery', () => {
  it('texts the OTP Supabase generated through the approved template, and answers 200 with an empty object', async () => {
    const h = hook();
    const res = await h.send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(h.calls).toEqual([`https://2factor.in/API/V1/${API_KEY}/SMS/+919172792929/${OTP}/WASHO_LOGIN_OTP`]);
    noSecrets(h.logs.join('\n'));
    expect(h.logs.join('\n')).toContain('91******2929');
  });
  it('uses TWOFACTOR_OTP_TEMPLATE when it is set, and refuses an unusable template name', async () => {
    const a = hook({ env: { TWOFACTOR_OTP_TEMPLATE: 'WASHO_LOGIN_OTP_V2' } });
    await a.send();
    expect(a.calls[0].endsWith('/WASHO_LOGIN_OTP_V2')).toBe(true);
    const b = hook({ env: { TWOFACTOR_OTP_TEMPLATE: '../../x' } });
    expect((await b.send()).status).toBe(500);
    expect(b.calls).toEqual([]);
  });
});

describe('signature, timestamp and replay', () => {
  it('refuses a bad signature, a missing signature and a signature for another body, and sends nothing', async () => {
    const h = hook();
    for (const sig of ['v1,AAAA', '', 'garbage', sign('msg_001', String(NOW_MS / 1000), bodyOf('919000000000'))]) {
      const res = await h.send({ sig });
      expect(res.status, sig).toBe(401);
      expect(await res.json()).toEqual({ error: { http_code: 401, message: 'Invalid signature.' } });
    }
    expect((await h.send({ sig: null })).status).toBe(401);
    expect(h.calls).toEqual([]);
    noSecrets(h.logs.join('\n'));
  });
  it('refuses a missing webhook-id or webhook-timestamp', async () => {
    const h = hook();
    const body = bodyOf();
    const ts = String(NOW_MS / 1000);
    const noId = await handleSendSmsHook(new Request('https://x/', { method: 'POST', headers: { 'webhook-timestamp': ts, 'webhook-signature': sign('msg_001', ts, body) }, body }), h.deps);
    const noTs = await handleSendSmsHook(new Request('https://x/', { method: 'POST', headers: { 'webhook-id': 'msg_001', 'webhook-signature': sign('msg_001', ts, body) }, body }), h.deps);
    expect([noId.status, noTs.status]).toEqual([401, 401]);
    expect(h.calls).toEqual([]);
  });
  it('refuses an old (or far-future) timestamp even when the signature is genuine', async () => {
    const h = hook();
    for (const drift of [-301, 301, -3600]) {
      const ts = String(NOW_MS / 1000 + drift);
      expect((await h.send({ ts, sig: sign('msg_001', ts, bodyOf()) })).status, String(drift)).toBe(401);
    }
    expect(h.calls).toEqual([]);
    const ok = String(NOW_MS / 1000 - 299);
    expect((await h.send({ ts: ok, sig: sign('msg_001', ok, bodyOf()) })).status).toBe(200);
  });
  it('the same signed delivery sent again is acknowledged but texts nothing a second time', async () => {
    const h = hook();
    expect((await h.send()).status).toBe(200);
    const again = await h.send();
    expect(again.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('"event":"duplicate"'))).toBe(true);
    // a genuinely new delivery (new id) for the same number is a new request
    expect((await h.send({ id: 'msg_002' })).status).toBe(200);
    expect(h.calls).toHaveLength(2);
  });
  it('after a failed send, Supabase\'s retry of the same delivery is sent (it is not mistaken for a replay)', async () => {
    let attempt = 0;
    const h = hook({ fetch: () => (++attempt === 1 ? new Response('busy', { status: 503 }) : new Response('{"Status":"Success","Details":"s"}')) });
    expect((await h.send()).status).toBe(503);
    expect((await h.send()).status).toBe(200);
    expect(h.calls).toHaveLength(2);
  });
});

describe('2Factor failures do not leak and do not crash', () => {
  it('2Factor says the key/template/number is wrong: a final 500 with plain words; the log says why, without secrets', async () => {
    const h = hook({ fetch: () => new Response(JSON.stringify({ Status: 'Error', Details: `Invalid API Key: ${API_KEY} (otp ${OTP})` }), { status: 400 }) });
    const res = await h.send();
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { http_code: 500, message: 'We could not send the code right now. Please try again.' } });
    noSecrets(text);
    noSecrets(h.logs.join('\n'));
    expect(h.logs.join('\n')).toContain('Invalid API Key');
  });
  it('2Factor is down (5xx): 503, so Supabase may try again', async () => {
    const h = hook({ fetch: () => new Response('Bad gateway', { status: 502 }) });
    const res = await h.send();
    expect(res.status).toBe(503);
    noSecrets(await res.text());
    noSecrets(h.logs.join('\n'));
  });
  it('2Factor never answers and ignores the cancel signal: still a 503 inside the budget, nothing sent twice', async () => {
    const h = hook({ timeoutMs: 30, fetch: () => new Promise<Response>(() => undefined) });
    const started = Date.now();
    const res = await h.send();
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(1000);
    noSecrets(await res.text());
    noSecrets(h.logs.join('\n'));
    expect(h.logs.join('\n')).toContain('"kind":"timeout"');
  });
  it('a real fetch that honours the abort signal is cut off at the timeout: 503, clean log', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const deps: HookDeps = {
      getenv: (n) => ({ SEND_SMS_HOOK_SECRET: HOOK_SECRET, TWOFACTOR_API_KEY: API_KEY })[n],
      fetchFn: ((url: string, init: RequestInit) => {
        calls.push(url);
        return new Promise((_res, rej) => (init.signal as AbortSignal).addEventListener('abort', () => rej(new DOMException(`aborted ${url}`, 'AbortError'))));
      }) as unknown as typeof fetch,
      nowMs: () => NOW_MS,
      log: (level, event, fields) => logs.push(JSON.stringify({ level, event, ...fields })),
      replay: new ReplayGuard(),
      timeoutMs: 30,
    };
    const body = bodyOf();
    const ts = String(NOW_MS / 1000);
    const res = await handleSendSmsHook(new Request('https://x/', { method: 'POST', headers: { 'webhook-id': 'm1', 'webhook-timestamp': ts, 'webhook-signature': sign('m1', ts, body) }, body }), deps);
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(1);
    noSecrets(await res.text());
    noSecrets(logs.join('\n'));
    expect(logs.join('\n')).toContain('"kind":"timeout"');
  });
  it('a network error whose own text holds the URL is never printed', async () => {
    const h = hook({
      fetch: (url) => {
        throw new TypeError(`error sending request for url (${url}) key=${API_KEY} otp=${OTP}`);
      },
    });
    const res = await h.send();
    expect(res.status).toBe(503);
    noSecrets(await res.text());
    noSecrets(h.logs.join('\n'));
    expect(h.logs.join('\n')).toContain('"kind":"network"');
  });
  it('an unexpected exception inside the handler is a plain 500 and only the error NAME is logged', async () => {
    const h = hook();
    h.deps.replay = { claim: () => { throw new RangeError(`boom ${API_KEY} ${OTP}`); }, release: () => undefined } as unknown as ReplayGuard;
    const res = await h.send();
    expect(res.status).toBe(500);
    noSecrets(await res.text());
    noSecrets(h.logs.join('\n'));
    expect(h.logs.join('\n')).toContain('RangeError');
  });
});

describe('what it refuses to send', () => {
  it('a number outside India, or a code of the wrong length: 400, nothing sent, and the number/code are not echoed', async () => {
    const h = hook();
    for (const body of [bodyOf('14155550123'), bodyOf('919172792929', '12345678'), bodyOf('919172792929', 'abc123'), 'not json', '{}']) {
      const res = await h.send({ body });
      const text = await res.text();
      expect(res.status, body).toBe(400);
      expect(text).not.toContain('14155550123');
      expect(text).not.toContain('12345678');
    }
    expect(h.calls).toEqual([]);
  });
  it('only POST', async () => {
    const h = hook();
    expect((await h.send({ method: 'GET' })).status).toBe(405);
    expect(h.calls).toEqual([]);
  });
  it('a huge body', async () => {
    const h = hook();
    const res = await h.send({ body: JSON.stringify({ pad: 'x'.repeat(70_000) }) });
    expect(res.status).toBe(413);
    expect(h.calls).toEqual([]);
  });
});

describe('configuration', () => {
  it('without the hook secret, the API key, or with an unusable secret, nothing is ever sent', async () => {
    for (const env of [{ SEND_SMS_HOOK_SECRET: undefined }, { SEND_SMS_HOOK_SECRET: 'v1,whsec_nope' }, { TWOFACTOR_API_KEY: undefined }, { TWOFACTOR_API_KEY: '   ' }]) {
      const h = hook({ env });
      const res = await h.send();
      expect(res.status, JSON.stringify(env)).toBe(500);
      noSecrets(await res.text());
      noSecrets(h.logs.join('\n'));
      expect(h.calls).toEqual([]);
    }
  });
  it('an unsigned request to a hook that is not configured is also refused (no "everything is fine" state)', async () => {
    const h = hook({ env: { SEND_SMS_HOOK_SECRET: undefined } });
    expect((await h.send({ sig: null })).status).toBe(500);
    expect(h.calls).toEqual([]);
  });
});
