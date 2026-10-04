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

async function razorpay<T = any>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
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
    throw new HttpError(500, 'payment_gateway_error', 'We could not reach the payment provider. Please try again.');
  }
  if (res.ok) return (await res.json()) as T;
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; description?: string } };
  if (res.status === 401) console.error('Razorpay rejected the API keys (check RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET).');
  else console.error(`Razorpay ${path} failed: ${res.status} ${body.error?.code ?? ''} ${body.error?.description ?? ''}`);
  throw new HttpError(500, 'payment_gateway_error', 'We could not start the payment. Please try again.');
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

export async function verifyAndSettle(profile: Profile, f: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }): Promise<SettleResult> {
  assertConfigured();
  if (!signatureIsValid(f.razorpay_order_id, f.razorpay_payment_id, f.razorpay_signature)) {
    throw new HttpError(400, 'bad_signature', 'We could not verify this payment. If money was deducted it will be reconciled automatically.');
  }

  // Ask Razorpay what actually happened rather than trusting the browser.
  let p = await razorpay<{ id: string; order_id: string; amount: number; currency: string; status: string }>(`/v1/payments/${encodeURIComponent(f.razorpay_payment_id)}`);
  if (p.order_id !== f.razorpay_order_id) throw new HttpError(400, 'order_mismatch', 'This payment does not match the order.');
  if (p.status === 'authorized') {
    // Accounts that do not auto-capture: capture exactly the authorised amount.
    p = await razorpay(`/v1/payments/${encodeURIComponent(p.id)}/capture`, { method: 'POST', body: { amount: p.amount, currency: p.currency } });
  }

  const result = await withApiRole(async (c) =>
    (
      await c.query('SELECT public.svc_settle_payment($1, $2, $3, $4, $5, $6, $7) AS r', [
        f.razorpay_order_id, f.razorpay_payment_id, p.amount, p.currency, p.status, profile.id, 'verify',
      ])
    ).rows[0].r as SettleResult
  );

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
