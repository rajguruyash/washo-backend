// Helpers for the Send SMS Hook (send-sms-hook). Pure: no Supabase client, no Deno API, so they unit-test in Node and run unchanged in Deno.
//
// What this file guarantees, because an OTP is a login credential:
//   * a request is accepted only with a valid Standard Webhooks signature, a fresh timestamp, and an id not seen before;
//   * the 2Factor API key, the request URL and the OTP never reach a log line or an error message. (Deno's fetch puts the URL in its
//     error text, so a fetch error is only ever classified, never printed.)
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Standard Webhooks accepts a timestamp up to 5 minutes old or 5 minutes ahead (clock drift). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
/** Supabase gives a hook about 5 seconds; leave room for our own work and the reply. */
export const TWOFACTOR_TIMEOUT_MS = 3500;
export const DEFAULT_OTP_TEMPLATE = 'WASHO_LOGIN_OTP';

const TWOFACTOR_BASE = 'https://2factor.in/API/V1';
const enc = new TextEncoder();

function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ───────────────────────── Standard Webhooks (what Supabase signs hooks with) ─────────────────────────

/**
 * The hook secret as Supabase shows it ("v1,whsec_<base64>") -> the raw HMAC key. Null when it is missing or not a usable secret, so a
 * mis-pasted secret fails loudly at the first request instead of verifying nothing.
 */
export function parseHookSecret(raw: string | null | undefined): Uint8Array | null {
  if (!raw) return null;
  const b64 = raw.trim().replace(/^v1,/, '').replace(/^whsec_/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  try {
    const key = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return key.length >= 16 ? key : null;
  } catch {
    return null;
  }
}

export type SignatureCheck = { ok: true } | { ok: false; reason: 'missing_headers' | 'bad_timestamp' | 'stale_timestamp' | 'bad_signature' };

/**
 * Verifies a Standard Webhooks delivery: HMAC-SHA256 over "<webhook-id>.<webhook-timestamp>.<raw body>" with the secret, base64, in a header
 * that may carry several space-separated "v1,<signature>" values (key rotation). The timestamp must be within the tolerance of now, which
 * together with the one-time id (see ReplayGuard) is the replay protection. The body is the RAW text: never re-serialised JSON.
 */
export function verifyStandardWebhook(i: {
  id: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: string;
  secret: Uint8Array;
  nowSeconds: number;
  toleranceSeconds?: number;
}): SignatureCheck {
  if (!i.id || i.id.length > 256 || !i.timestamp || !i.signature) return { ok: false, reason: 'missing_headers' };
  if (!/^\d{1,12}$/.test(i.timestamp)) return { ok: false, reason: 'bad_timestamp' };
  const tolerance = i.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(i.nowSeconds - Number(i.timestamp)) > tolerance) return { ok: false, reason: 'stale_timestamp' };
  const expected = createHmac('sha256', i.secret).update(`${i.id}.${i.timestamp}.${i.rawBody}`).digest('base64');
  let matched = false;
  for (const part of i.signature.split(/\s+/)) {
    const comma = part.indexOf(',');
    if (comma < 0 || part.slice(0, comma) !== 'v1') continue; // only version v1 exists; never accept an unknown scheme
    if (safeEqual(part.slice(comma + 1), expected)) matched = true; // no early exit: every candidate costs the same
  }
  return matched ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/**
 * Remembers which webhook ids were already accepted, so a captured request cannot be sent again inside the timestamp window. The window
 * is +-5 minutes, so an id must be remembered for 10 (plus a margin). Memory is per isolate: it stops an immediate replay on the same
 * instance, and the timestamp window plus Supabase's own SMS rate limits bound anything beyond that. Bounded in size.
 */
export class ReplayGuard {
  private seen = new Map<string, number>(); // id -> forget-at (ms)
  private ttlMs: number;
  private max: number;
  constructor(ttlMs = 11 * 60_000, max = 5000) {
    this.ttlMs = ttlMs;
    this.max = max;
  }
  /** True when the id is new (it is now reserved); false when it was already accepted. */
  claim(id: string, nowMs: number): boolean {
    for (const [seenId, until] of this.seen) if (until <= nowMs) this.seen.delete(seenId);
    if (this.seen.has(id)) return false;
    while (this.seen.size >= this.max) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    this.seen.set(id, nowMs + this.ttlMs);
    return true;
  }
  /** Give the id back after a failed send, so Supabase's retry of the same delivery is not mistaken for a replay. */
  release(id: string): void {
    this.seen.delete(id);
  }
}

// ───────────────────────── what Supabase sends ─────────────────────────

export type HookPayload =
  | { ok: true; mobile: string; otp: string }
  | { ok: false; reason: 'malformed' | 'unsupported_phone' | 'bad_otp' };

/**
 * An Indian mobile number as Supabase stores it ("919172792929", with or without a "+") -> its 10 digits. Anything else is refused:
 * 2Factor delivers to India only, and a number we cannot read must not be guessed at.
 */
export function indianMobile(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^\+?91([6-9]\d{9})$/.exec(raw.trim());
  return m ? m[1] : null;
}

/** Reads the hook body: { user: { phone }, sms: { otp } }. 2Factor's custom OTP is 4 to 6 digits; WASHO's is 6 (Auth -> SMS OTP Length). */
export function parseHookPayload(rawBody: string): HookPayload {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const b = body as { user?: { phone?: unknown }; sms?: { otp?: unknown } } | null;
  const phone = b?.user?.phone;
  const otp = b?.sms?.otp;
  if (typeof phone !== 'string' || typeof otp !== 'string') return { ok: false, reason: 'malformed' };
  const mobile = indianMobile(phone);
  if (!mobile) return { ok: false, reason: 'unsupported_phone' };
  if (!/^\d{4,6}$/.test(otp)) return { ok: false, reason: 'bad_otp' };
  return { ok: true, mobile, otp };
}

/** The phone as it is safe to log: country code and the last four digits. */
export const maskMobile = (mobile: string): string => `91******${mobile.slice(-4)}`;

// ───────────────────────── 2Factor ─────────────────────────

/**
 * 2Factor "Send OTP (Manual Generation)", from their official API documentation:
 *   GET https://2factor.in/API/V1/:api_key/SMS/:phone_number/:otp_value/:otp_template_name
 * phone_number in international format (their example: +919999999999), otp_value a 4-6 digit OTP that WE supply, otp_template_name the approved
 * template. Never the AUTOGEN or VERIFY endpoints: 2Factor must send exactly the code Supabase generated and will check.
 * The returned string contains the API key and the OTP: pass it straight to fetch, never log it.
 */
export function twoFactorSendUrl(apiKey: string, mobile: string, otp: string, template: string): string {
  return `${TWOFACTOR_BASE}/${encodeURIComponent(apiKey)}/SMS/+91${mobile}/${otp}/${encodeURIComponent(template)}`;
}

export type SendResult =
  | { ok: true }
  | { ok: false; kind: 'timeout' | 'network' | 'upstream_unavailable' | 'rejected'; httpStatus?: number; detail?: string };

/** Removes every secret from text that may be logged, drops control characters and shortens it. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  return out.replace(/\p{Cc}/gu, ' ').slice(0, 120);
}

type SendInput = {
  apiKey: string;
  mobile: string;
  otp: string;
  template: string;
  fetchFn: typeof fetch;
  timeoutMs?: number;
};

async function request(i: SendInput, signal: AbortSignal): Promise<SendResult> {
  try {
    const res = await i.fetchFn(twoFactorSendUrl(i.apiKey, i.mobile, i.otp, i.template), {
      method: 'GET',
      redirect: 'error', // a redirect would carry the key to another address
      headers: { Accept: 'application/json' },
      signal,
    });
    const text = (await res.text()).slice(0, 2000);
    let status = '';
    let details = '';
    try {
      const j = JSON.parse(text) as { Status?: unknown; Details?: unknown };
      status = typeof j.Status === 'string' ? j.Status : '';
      details = typeof j.Details === 'string' ? j.Details : '';
    } catch {
      /* not JSON: treated as a rejection below */
    }
    if (res.ok && status === 'Success') return { ok: true }; // "Details" is a session id we do not need
    const detail = redact(details || 'no details', [i.apiKey, i.otp, i.mobile]);
    if (res.status >= 500 || res.status === 429) return { ok: false, kind: 'upstream_unavailable', httpStatus: res.status, detail };
    return { ok: false, kind: 'rejected', httpStatus: res.status, detail };
  } catch {
    return { ok: false, kind: signal.aborted ? 'timeout' : 'network' };
  }
}

/**
 * Asks 2Factor to text this OTP. The result says what happened in words that are safe to log and never carries the URL, the key or the code:
 * a timeout or network error is only classified (the error text is dropped on purpose), and 2Factor's own "Details" is redacted first.
 * The wait is capped twice: the request is aborted at the timeout, and the answer no longer depends on fetch honouring the abort.
 */
export async function sendOtpVia2Factor(i: SendInput): Promise<SendResult> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<SendResult>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort();
      resolve({ ok: false, kind: 'timeout' });
    }, i.timeoutMs ?? TWOFACTOR_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request(i, ctl.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
