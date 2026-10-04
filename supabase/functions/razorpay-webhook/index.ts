// Razorpay -> WASHO, server to server. This is the ONLY webhook endpoint (the Render API has none).
// Deploy with JWT verification OFF (Razorpay cannot send a JWT); the signature is the authentication.
//
// Requires the secret RAZORPAY_WEBHOOK_SECRET, which must equal the "Secret" typed into the webhook in the
// Razorpay dashboard. (That is NOT the API key secret.) Without it every delivery is refused.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { adminClient, razorpayWebhookSecret } from '../_shared/clients.ts';
import { parseCapturedEvent, verifyWebhookSignature } from '../_shared/razorpay.ts';

serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const secret = razorpayWebhookSecret();
  if (!secret) {
    console.error('RAZORPAY_WEBHOOK_SECRET is not set: refusing all webhook deliveries');
    return new Response('Webhook not configured', { status: 503 });
  }

  const raw = await req.text();
  if (!verifyWebhookSignature(raw, req.headers.get('X-Razorpay-Signature'), secret)) {
    return new Response('Invalid signature', { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('Bad payload', { status: 400 });
  }

  const captured = parseCapturedEvent(payload);
  if (!captured) return new Response(JSON.stringify({ status: 'ignored' }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const { data, error } = await adminClient().rpc('svc_settle_payment', {
    p_provider_order_id: captured.orderId,
    p_provider_payment_id: captured.paymentId,
    p_amount_cents: captured.amountPaise,
    p_currency: captured.currency,
    p_provider_status: captured.status,
    p_expected_profile_id: null,
    p_source: 'webhook',
  });
  if (error) {
    console.error('webhook settle failed', error.message);
    return new Response('Temporary error', { status: 500 }); // Razorpay retries
  }
  // Every outcome (settled, already settled, unknown order, unfulfilled-and-refunded) is final: acknowledge it.
  return new Response(JSON.stringify({ status: data?.status ?? 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
