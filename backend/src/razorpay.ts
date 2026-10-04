import crypto from 'crypto';
import { config } from './config';
import { withApiRole } from './db';
import { HttpError } from './errors';
import type { Profile } from './profile';

/**
 * Razorpay Standard Checkout, server side:
 *   1. openOrder      creates the Razorpay order for the amount THE DATABASE priced (the browser never sends an amount)
 *   2. (browser)      opens the Checkout modal with that order
 *   3. verifyAndSettle checks Razorpay's signature, then Razorpay's own record of the payment, then asks the database to
 *                      settle it. Nothing is activated, scheduled or confirmed unless that succeeds.
 * The key secret is only ever used here.
 */

export interface PaymentIntent {
  payment_id: string;
  amount_cents: number;
  currency?: string;
  receipt: string;
  provider_order_id?: string | null;
}

export interface Order {
  order_id: string;
  amount: number;
  currency: string;
  key_id: string;
  payment_id: string;
  prefill: { contact?: string; email?: string };
}

const MIN_PAISE = 100;

function assertConfigured() {
  if (!config.razorpay.configured) {
    console.error('Razorpay is not configured: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in the server environment.');
    throw new HttpError(503, 'payments_unavailable', 'Online payments are not switched on yet. Please try again later, or contact WASHO.');
  }
}

const basicAuth = () => 'Basic ' + Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');

/** Razorpay said no (or could not be reached). `description` is Razorpay's own wording, safe to show to an admin. */
class GatewayError extends Error {
  constructor(public status: number, public description: string) {
    super(description);
  }
}

async function call<T = any>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.razorpay.apiBase}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: basicAuth(), 'Content-Type': 'application/json' },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error('Razorpay unreachable:', (err as Error).message);
    throw new GatewayError(0, 'Razorpay could not be reached');
  }
  if (res.ok) return (await res.json()) as T;
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; description?: string } };
  if (res.status === 401) console.error('Razorpay rejected the API keys (check RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET).');
  else console.error(`Razorpay ${path} failed: ${res.status} ${body.error?.code ?? ''} ${body.error?.description ?? ''}`);
  throw new GatewayError(res.status, body.error?.description ?? `Razorpay answered ${res.status}`);
}

/** Customer-facing calls: any failure is one friendly error. */
async function razorpay<T = any>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  try {
    return await call<T>(path, init);
  } catch (err) {
    if (!(err instanceof GatewayError)) throw err;
    throw new HttpError(
      500,
      'payment_gateway_error',
      err.status === 0 ? 'We could not reach the payment provider. Please try again.' : 'We could not start the payment. Please try again.'
    );
  }
}

/** Opens (or reuses) the Razorpay order for a pending payment the database created for this customer. */
export async function openOrder(profile: Profile, intent: PaymentIntent): Promise<Order> {
  assertConfigured();
  if (!Number.isInteger(intent.amount_cents) || intent.amount_cents < MIN_PAISE) {
    throw new HttpError(422, 'amount_too_small', 'This amount is too small to pay online.');
  }
  let orderId = intent.provider_order_id ?? null;
  if (!orderId) {
    const order = await razorpay<{ id: string }>('/v1/orders', {
      method: 'POST',
      body: { amount: intent.amount_cents, currency: 'INR', receipt: intent.receipt, notes: { payment_id: intent.payment_id } },
    });
    orderId = order.id;
    // Recorded against the payment (and checked to be this customer's) so verification can find it.
    await withApiRole((c) => c.query('SELECT public.svc_attach_provider_order($1, $2, $3)', [intent.payment_id, orderId, profile.id]));
  }
  return {
    order_id: orderId,
    amount: intent.amount_cents,
    currency: 'INR',
    key_id: config.razorpay.keyId,
    payment_id: intent.payment_id,
    prefill: { ...(profile.phone ? { contact: profile.phone } : {}), ...(profile.email ? { email: profile.email } : {}) },
  };
}

/** HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET), compared in constant time. */
export function signatureIsValid(orderId: string, paymentId: string, signature: string): boolean {
  if (!config.razorpay.keySecret || !orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac('sha256', config.razorpay.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface SettleResult {
  status: string;
  payment_id?: string;
  booking_id?: string | null;
  membership_id?: string | null;
  reason?: string;
}

interface GatewayPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
}

/** What Razorpay itself says about a payment. */
export async function fetchGatewayPayment(paymentId: string): Promise<GatewayPayment> {
  assertConfigured();
  return razorpay<GatewayPayment>(`/v1/payments/${encodeURIComponent(paymentId)}`);
}

/**
 * The one place a Razorpay payment becomes a booking or membership, whoever noticed it (the browser, a webhook, a re-check):
 * ask Razorpay what happened (never trust the caller), capture an authorised payment, then let the database settle it.
 * The database is idempotent: the same payment settled twice is simply "already settled".
 */
async function settleFromGateway(orderId: string, paymentId: string, profileId: string | null, source: string): Promise<SettleResult> {
  let p = await fetchGatewayPayment(paymentId);
  if (p.order_id !== orderId) throw new HttpError(400, 'order_mismatch', 'This payment does not match the order.');
  if (p.status === 'authorized') {
    // Accounts that do not auto-capture: capture exactly the authorised amount.
    p = await razorpay(`/v1/payments/${encodeURIComponent(p.id)}/capture`, { method: 'POST', body: { amount: p.amount, currency: p.currency } });
  }
  return withApiRole(async (c) =>
    (await c.query('SELECT public.svc_settle_payment($1, $2, $3, $4, $5, $6, $7) AS r', [orderId, paymentId, p.amount, p.currency, p.status, profileId, source])).rows[0].r as SettleResult
  );
}

export async function verifyAndSettle(profile: Profile, f: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }): Promise<SettleResult> {
  assertConfigured();
  if (!signatureIsValid(f.razorpay_order_id, f.razorpay_payment_id, f.razorpay_signature)) {
    throw new HttpError(400, 'bad_signature', 'We could not verify this payment. If money was deducted it will be reconciled automatically.');
  }
  const result = await settleFromGateway(f.razorpay_order_id, f.razorpay_payment_id, profile.id, 'verify');

  switch (result.status) {
    case 'fulfilled':
    case 'already_settled':
    case 'unfulfilled': // money is safe and a refund request exists: the customer is told, not errored
      return result;
    case 'not_captured':
      throw new HttpError(409, 'not_captured', 'Your payment has not completed yet. Please wait a moment and refresh.');
    case 'unknown_order':
      throw new HttpError(404, 'unknown_order', 'We could not find that payment.');
    default:
      console.error('Payment rejected by the database:', JSON.stringify(result));
      throw new HttpError(400, 'payment_rejected', 'We could not confirm this payment. If money was deducted it will be reconciled automatically.');
  }
}

/**
 * "Did this checkout actually get paid?" Asks Razorpay for the payments made against an order and settles one that went through.
 * This is what rescues a payment whose browser never reported back (the customer switched to Google Pay, the tab was cleared, the
 * phone lost signal). Returns null when Razorpay shows nothing paid for the order.
 */
export async function reconcileOrder(orderId: string, profileId: string | null, source: string): Promise<SettleResult | null> {
  assertConfigured();
  const list = await razorpay<{ items?: GatewayPayment[] }>(`/v1/orders/${encodeURIComponent(orderId)}/payments`);
  const items = list.items ?? [];
  const hit = items.find((p) => p.status === 'captured') ?? items.find((p) => p.status === 'authorized');
  if (!hit) return null;
  return settleFromGateway(orderId, hit.id, profileId, source);
}

/**
 * Razorpay tells us about a payment itself (Settings → Webhooks → payment.captured / order.paid), so a payment is recorded even if
 * the customer's browser never came back. The body must be the exact bytes Razorpay signed.
 */
export async function processWebhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ handled: boolean; status?: string }> {
  const secret = config.razorpay.webhookSecret;
  if (!secret) {
    console.error('A Razorpay webhook arrived but RAZORPAY_WEBHOOK_SECRET is not set on the server.');
    throw new HttpError(503, 'webhook_not_configured', 'Webhook is not configured.');
  }
  if (!rawBody || !signature) throw new HttpError(400, 'bad_signature', 'Missing signature.');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(400, 'bad_signature', 'Bad signature.');

  let event: { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string } } } };
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', 'Malformed body.');
  }
  if (event.event !== 'payment.captured' && event.event !== 'order.paid') return { handled: false };
  const payment = event.payload?.payment?.entity;
  if (!payment?.id || !payment.order_id) return { handled: false };
  const result = await settleFromGateway(payment.order_id, payment.id, null, 'webhook');
  if (result.status === 'unfulfilled') console.warn(`Webhook: payment ${payment.id} was paid but could not be fulfilled (${result.reason ?? 'see refunds'}).`);
  return { handled: true, status: result.status };
}

// ───────────────────────── refunds ─────────────────────────

export interface RefundOutcome {
  ok: boolean;
  /** Razorpay's refund id when ok. */
  refundId?: string;
  /** Why Razorpay refused, when not ok. */
  reason?: string;
}

/**
 * Refunds `amountPaise` of a captured Razorpay payment back to the customer's original payment method.
 * Safe to call again for the same WASHO refund: it first looks for a refund Razorpay already made for it
 * (matched by the WASHO refund id we put in the notes) and returns that instead of paying twice.
 */
export async function refundPayment(f: { refundId: string; providerPaymentId: string; amountPaise: number }): Promise<RefundOutcome> {
  assertConfigured();
  const pid = encodeURIComponent(f.providerPaymentId);
  try {
    const existing = await call<{ items?: { id: string; amount: number; notes?: Record<string, string> | unknown[]; status?: string }[] }>(`/v1/payments/${pid}/refunds?count=100`);
    const prior = (existing.items ?? []).find((r) => !Array.isArray(r.notes) && r.notes?.washo_refund_id === f.refundId && r.status !== 'failed');
    if (prior) return { ok: true, refundId: prior.id };

    const made = await call<{ id: string }>(`/v1/payments/${pid}/refund`, {
      method: 'POST',
      body: { amount: f.amountPaise, speed: 'normal', receipt: f.refundId.slice(0, 40), notes: { washo_refund_id: f.refundId } },
    });
    return { ok: true, refundId: made.id };
  } catch (err) {
    if (err instanceof GatewayError) return { ok: false, reason: err.description };
    throw err;
  }
}
