// Pure helpers (no network, no Supabase) so they can be unit-tested in Node and run unchanged in Deno.
import { createHmac, timingSafeEqual } from 'node:crypto';

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The signature Razorpay Checkout returns to the browser: HMAC-SHA256("order_id|payment_id", KEY_SECRET). */
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  if (!keySecret || !orderId || !paymentId || !signature) return false;
  return safeEqualHex(createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex'), signature);
}

/**
 * The signature on a webhook delivery: HMAC-SHA256(raw body, WEBHOOK_SECRET).
 * A missing secret or a missing signature header is a REFUSAL, never a pass. (The previous function skipped
 * verification when the header was absent, which let anyone forge a "payment captured" event.)
 */
export function verifyWebhookSignature(rawBody: string, signature: string | null | undefined, webhookSecret: string): boolean {
  if (!webhookSecret || !signature) return false;
  return safeEqualHex(createHmac('sha256', webhookSecret).update(rawBody).digest('hex'), signature);
}

export interface CapturedPayment {
  orderId: string;
  paymentId: string;
  amountPaise: number;
  currency: string;
  status: string;
}

/** Extracts the payment from a webhook payload, only for events that mean "money was captured". */
export function parseCapturedEvent(payload: unknown): CapturedPayment | null {
  const p = payload as { event?: string; payload?: { payment?: { entity?: Record<string, unknown> } } };
  if (p?.event !== 'payment.captured' && p?.event !== 'order.paid') return null;
  const e = p.payload?.payment?.entity;
  if (!e || typeof e.order_id !== 'string' || typeof e.id !== 'string' || typeof e.amount !== 'number') return null;
  return { orderId: e.order_id, paymentId: e.id, amountPaise: e.amount, currency: String(e.currency ?? ''), status: String(e.status ?? '') };
}

/** Maps a settle_payment result to an HTTP status the caller can act on. */
export function httpStatusForSettle(status: string): number {
  switch (status) {
    case 'fulfilled':
    case 'already_settled':
    case 'unfulfilled': // money is safe and a refund request exists; the customer is told, not errored
      return 200;
    case 'not_captured':
      return 409;
    case 'unknown_order':
      return 404;
    case 'rejected':
    case 'duplicate_payment':
    default:
      return 400;
  }
}
