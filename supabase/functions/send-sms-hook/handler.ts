// The Send SMS Hook, as a function of (request, dependencies) so every path can be tested in Node without a network, a clock or a secret.
// index.ts wires the real ones.
import {
  DEFAULT_OTP_TEMPLATE,
  maskMobile,
  parseHookPayload,
  parseHookSecret,
  sendOtpVia2Factor,
  verifyStandardWebhook,
  type ReplayGuard,
} from '../_shared/sms.ts';

export interface HookDeps {
  getenv: (name: string) => string | undefined;
  fetchFn: typeof fetch;
  nowMs: () => number;
  /** Fields are already safe to print: no key, no URL, no OTP, no full phone number. */
  log: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, string | number>) => void;
  replay: ReplayGuard;
  timeoutMs?: number;
}

const MAX_BODY_BYTES = 64 * 1024;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const accepted = () => new Response('{}', { status: 200, headers: JSON_HEADERS });
/** Supabase passes `error.message` back to whoever asked for the code, so these are plain words and nothing else. */
const refuse = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { http_code: status, message } }), { status, headers: JSON_HEADERS });

const CANNOT_SEND = 'We could not send the code right now. Please try again.';

/** Never throws: whatever goes wrong, the caller gets a plain refusal and the log gets the error's NAME only (its text can hold the URL). */
export async function handleSendSmsHook(req: Request, d: HookDeps): Promise<Response> {
  try {
    return await run(req, d);
  } catch (e) {
    d.log('error', 'unexpected', { error: e instanceof Error ? e.name : 'unknown' });
    return refuse(500, CANNOT_SEND);
  }
}

async function run(req: Request, d: HookDeps): Promise<Response> {
  const started = d.nowMs();
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Configuration. A missing or unusable secret refuses everything: a hook that cannot verify must never send.
  const secret = parseHookSecret(d.getenv('SEND_SMS_HOOK_SECRET'));
  const apiKey = d.getenv('TWOFACTOR_API_KEY')?.trim() ?? '';
  const template = d.getenv('TWOFACTOR_OTP_TEMPLATE')?.trim() || DEFAULT_OTP_TEMPLATE;
  if (!secret || !apiKey || apiKey.length > 200 || !/^[A-Za-z0-9_-]{1,64}$/.test(template)) {
    d.log('error', 'not_configured', { hookSecretOk: secret ? 1 : 0, apiKeySet: apiKey ? 1 : 0, templateOk: /^[A-Za-z0-9_-]{1,64}$/.test(template) ? 1 : 0 });
    return refuse(500, 'The SMS hook is not configured.');
  }

  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return refuse(413, 'Request too large.');
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return refuse(413, 'Request too large.');

  const id = req.headers.get('webhook-id');
  const check = verifyStandardWebhook({
    id,
    timestamp: req.headers.get('webhook-timestamp'),
    signature: req.headers.get('webhook-signature'),
    rawBody,
    secret,
    nowSeconds: Math.floor(d.nowMs() / 1000),
  });
  if (!check.ok) {
    d.log('warn', 'refused', { reason: check.reason });
    return refuse(401, 'Invalid signature.');
  }

  const payload = parseHookPayload(rawBody);
  if (!payload.ok) {
    d.log('warn', 'bad_payload', { reason: payload.reason });
    return refuse(400, payload.reason === 'unsupported_phone' ? 'Codes can only be sent to Indian mobile numbers (+91).' : 'The request could not be read.');
  }
  const who = maskMobile(payload.mobile);

  // The same delivery twice (a replay, or a duplicate) texts nothing the second time. The first send already answered it.
  if (!d.replay.claim(id as string, d.nowMs())) {
    d.log('info', 'duplicate', { id: id as string, to: who });
    return accepted();
  }

  const sent = await sendOtpVia2Factor({ apiKey, mobile: payload.mobile, otp: payload.otp, template, fetchFn: d.fetchFn, timeoutMs: d.timeoutMs }).catch(
    () => ({ ok: false as const, kind: 'network' as const }),
  );
  const ms = d.nowMs() - started;
  if (sent.ok) {
    d.log('info', 'sent', { id: id as string, to: who, ms });
    return accepted();
  }

  // Not sent: give the id back so Supabase's retry of this same delivery goes through, and say only what is safe to say.
  d.replay.release(id as string);
  const extra: Record<string, string | number> = {};
  if ('httpStatus' in sent && sent.httpStatus !== undefined) extra.httpStatus = sent.httpStatus;
  if ('detail' in sent && sent.detail) extra.detail = sent.detail;
  d.log('error', 'send_failed', { id: id as string, to: who, kind: sent.kind, ms, ...extra });
  // 503 asks Supabase to try again (a timeout, a network drop or a 2Factor outage); 500 is final (2Factor said no: key, template, balance).
  return sent.kind === 'rejected' ? refuse(500, CANNOT_SEND) : refuse(503, CANNOT_SEND);
}
