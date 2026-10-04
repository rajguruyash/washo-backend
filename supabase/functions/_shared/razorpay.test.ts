import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { httpStatusForSettle, parseCapturedEvent, verifyCheckoutSignature, verifyWebhookSignature } from './razorpay';

const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');

describe('checkout signature', () => {
  it('accepts the genuine signature and rejects tampering', () => {
    const sig = hmac('key_secret', 'order_1|pay_1');
    expect(verifyCheckoutSignature('order_1', 'pay_1', sig, 'key_secret')).toBe(true);
    expect(verifyCheckoutSignature('order_1', 'pay_2', sig, 'key_secret')).toBe(false); // different payment
    expect(verifyCheckoutSignature('order_2', 'pay_1', sig, 'key_secret')).toBe(false); // different order
    expect(verifyCheckoutSignature('order_1', 'pay_1', sig, 'other_secret')).toBe(false);
    expect(verifyCheckoutSignature('order_1', 'pay_1', sig.slice(0, -1) + '0', 'key_secret')).toBe(false);
  });
  it('refuses empty inputs rather than passing', () => {
    expect(verifyCheckoutSignature('', 'p', 'x', 's')).toBe(false);
    expect(verifyCheckoutSignature('o', 'p', '', 's')).toBe(false);
    expect(verifyCheckoutSignature('o', 'p', hmac('', 'o|p'), '')).toBe(false);
  });
});

describe('webhook signature', () => {
  const body = JSON.stringify({ event: 'payment.captured' });
  it('accepts a signed body', () => expect(verifyWebhookSignature(body, hmac('whsec', body), 'whsec')).toBe(true));
  it('rejects a tampered body or wrong secret', () => {
    expect(verifyWebhookSignature(body + ' ', hmac('whsec', body), 'whsec')).toBe(false);
    expect(verifyWebhookSignature(body, hmac('whsec', body), 'wrong')).toBe(false);
  });
  it('REFUSES an unsigned request (the old function let these through)', () => {
    expect(verifyWebhookSignature(body, null, 'whsec')).toBe(false);
    expect(verifyWebhookSignature(body, undefined, 'whsec')).toBe(false);
    expect(verifyWebhookSignature(body, '', 'whsec')).toBe(false);
  });
  it('REFUSES everything when no webhook secret is configured', () => {
    expect(verifyWebhookSignature(body, hmac('', body), '')).toBe(false);
  });
});

describe('webhook payload parsing', () => {
  const ev = (event: string, entity: any) => ({ event, payload: { payment: { entity } } });
  it('extracts a captured payment', () => {
    expect(parseCapturedEvent(ev('payment.captured', { id: 'pay_1', order_id: 'order_1', amount: 15000, currency: 'INR', status: 'captured' })))
      .toEqual({ orderId: 'order_1', paymentId: 'pay_1', amountPaise: 15000, currency: 'INR', status: 'captured' });
    expect(parseCapturedEvent(ev('order.paid', { id: 'pay_1', order_id: 'order_1', amount: 100, currency: 'INR', status: 'captured' }))?.orderId).toBe('order_1');
  });
  it('ignores other events and malformed payloads', () => {
    expect(parseCapturedEvent(ev('payment.failed', { id: 'p', order_id: 'o', amount: 1 }))).toBeNull();
    expect(parseCapturedEvent(ev('payment.captured', { id: 'p', amount: 1 }))).toBeNull();
    expect(parseCapturedEvent(ev('payment.captured', { id: 'p', order_id: 'o', amount: '15000' }))).toBeNull();
    expect(parseCapturedEvent(null)).toBeNull();
    expect(parseCapturedEvent({})).toBeNull();
  });
});

describe('settle outcome -> HTTP', () => {
  it('maps outcomes', () => {
    expect(httpStatusForSettle('fulfilled')).toBe(200);
    expect(httpStatusForSettle('already_settled')).toBe(200);
    expect(httpStatusForSettle('unfulfilled')).toBe(200);
    expect(httpStatusForSettle('not_captured')).toBe(409);
    expect(httpStatusForSettle('unknown_order')).toBe(404);
    expect(httpStatusForSettle('rejected')).toBe(400);
    expect(httpStatusForSettle('anything_else')).toBe(400);
  });
});
