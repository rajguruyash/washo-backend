// Called by the app right after Razorpay Checkout succeeds. Verifies, in order:
//   1. who is asking (their JWT) and that they own the payment
//   2. Razorpay's signature over order_id|payment_id
//   3. Razorpay's OWN record of the payment: captured, same order, amount and currency
// then asks the database to settle it. The database re-checks ownership, amount and idempotency.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { adminClient, corsHeaders, json, razorpayAuth, razorpayKeySecret, userClient } from '../_shared/clients.ts';
import { httpStatusForSettle, verifyCheckoutSignature } from '../_shared/razorpay.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authorization = req.headers.get('Authorization');
  if (!authorization) return json({ error: 'Sign in to continue' }, 401);

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = await req.json();
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return json({ error: 'Missing payment details' }, 400);

    const { data: userData, error: userErr } = await userClient(authorization).auth.getUser();
    if (userErr || !userData.user) return json({ error: 'Sign in to continue' }, 401);

    if (!verifyCheckoutSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature, razorpayKeySecret())) {
      return json({ error: 'We could not verify this payment. If money was deducted it will be reconciled automatically.' }, 400);
    }

    // Ask Razorpay what actually happened, rather than trusting what the browser says.
    const rz = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpay_payment_id)}`, { headers: { Authorization: razorpayAuth() } });
    if (!rz.ok) return json({ error: 'Could not confirm the payment with Razorpay. Please wait a moment and refresh.' }, 502);
    const p = (await rz.json()) as { id: string; order_id: string; amount: number; currency: string; status: string };
    if (p.order_id !== razorpay_order_id) return json({ error: 'Payment does not match the order' }, 400);

    const admin = adminClient();
    const { data: profileId } = await admin.rpc('svc_profile_id_for_auth_user', { p_auth_user_id: userData.user.id });
    const { data: result, error } = await admin.rpc('svc_settle_payment', {
      p_provider_order_id: razorpay_order_id,
      p_provider_payment_id: razorpay_payment_id,
      p_amount_cents: p.amount,
      p_currency: p.currency,
      p_provider_status: p.status,
      p_expected_profile_id: profileId,
      p_source: 'verify',
    });
    if (error) {
      console.error('settle failed', error.message);
      return json({ error: 'We received your payment but could not finish the booking. We will sort it out; you have not been charged twice.' }, 500);
    }
    return json(result, httpStatusForSettle(result.status));
  } catch (err) {
    console.error('verify-razorpay-payment', err instanceof Error ? err.message : err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});
