// Creates a Razorpay order for an amount the DATABASE computed. The client never sends an amount.
//
//   { "type": "on_demand", "vehicle_id", "service_id", "scheduled_date", "time_slot", "address_id"?, "parking_location"?, "target_completion_time"?, "source"? }
//   { "type": "membership", "request_id" }                      (accept a WASHO-approved quote and pay for it)
//
// The database function runs AS THE CALLER (their JWT), so ownership and eligibility are enforced by Postgres.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { adminClient, corsHeaders, json, razorpayAuth, razorpayKeyId, userClient } from '../_shared/clients.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authorization = req.headers.get('Authorization');
  if (!authorization) return json({ error: 'Sign in to continue' }, 401);

  try {
    const body = await req.json();
    const asUser = userClient(authorization);

    // 1) The database validates the request and decides the amount.
    let payment: { payment_id: string; amount_cents: number; currency: string; receipt: string; provider_order_id?: string | null };
    if (body.type === 'membership') {
      const { data, error } = await asUser.rpc('accept_membership_quote', { p_request_id: body.request_id });
      if (error) return json({ error: error.message }, 400);
      payment = data;
    } else if (body.type === 'on_demand') {
      const { data, error } = await asUser.rpc('create_booking_payment_intent', {
        p_vehicle_id: body.vehicle_id,
        p_service_id: body.service_id,
        p_scheduled_date: body.scheduled_date,
        p_time_slot: body.time_slot,
        p_address_id: body.address_id ?? null,
        p_parking_location: body.parking_location ?? null,
        p_target_completion_time: body.target_completion_time ?? null,
        p_source: body.source === 'website' ? 'website' : 'mobile_app',
      });
      if (error) return json({ error: error.message }, 400);
      payment = data;
    } else {
      return json({ error: 'Unknown payment type' }, 400);
    }

    const prefill = await (async () => {
      const { data } = await asUser.auth.getUser();
      return { contact: data.user?.phone ?? '', email: data.user?.email ?? '' };
    })();

    // 2) Reusing an open order (customer retried payment): nothing new to create.
    if (payment.provider_order_id) {
      return json({ order_id: payment.provider_order_id, amount: payment.amount_cents, currency: payment.currency, key_id: razorpayKeyId(), payment_id: payment.payment_id, prefill });
    }

    // 3) Create the order at Razorpay for exactly that amount, then record it against the payment.
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: razorpayAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: payment.amount_cents, currency: 'INR', receipt: payment.receipt, notes: { payment_id: payment.payment_id } }),
    });
    if (!res.ok) {
      console.error('Razorpay order creation failed', res.status);
      return json({ error: 'We could not start the payment. Please try again.' }, 502);
    }
    const order = (await res.json()) as { id: string };

    const admin = adminClient();
    const { data: userData } = await asUser.auth.getUser();
    const { data: profileId } = await admin.rpc('svc_profile_id_for_auth_user', { p_auth_user_id: userData.user?.id });
    const { error: attachErr } = await admin.rpc('svc_attach_provider_order', {
      p_payment_id: payment.payment_id,
      p_provider_order_id: order.id,
      p_expected_profile_id: profileId,
    });
    if (attachErr) return json({ error: attachErr.message }, 400);

    return json({ order_id: order.id, amount: payment.amount_cents, currency: payment.currency, key_id: razorpayKeyId(), payment_id: payment.payment_id, prefill });
  } catch (err) {
    console.error('create-razorpay-order', err instanceof Error ? err.message : err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});
