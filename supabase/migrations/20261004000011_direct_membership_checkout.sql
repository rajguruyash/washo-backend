-- 20261004000011_direct_membership_checkout.sql
-- SAFE / additive and re-runnable. The customer now PAYS DIRECTLY for a membership: no waiting for WASHO to approve a quote.
--
--   start_membership_checkout()  validates the plan (same rules as create_membership_request), prices it from the rate card
--   (same calculator, every discount explicit), records the price on the request and opens the pending payment, all in one
--   call. The server then opens the Razorpay order for exactly payment.amount_cents; nothing is created for the customer
--   (no membership, no washes) until settle_payment() has verified the money, exactly as before.
--
-- The earlier request -> WASHO quote -> accept path still works for requests that already exist (admin_review_membership_request,
-- accept_membership_quote). A customer who starts a new checkout supersedes their own unfinished one for that vehicle; if money
-- for the superseded attempt still arrives, settle_payment() records it as unfulfilled and raises a refund request.

CREATE OR REPLACE FUNCTION public.start_membership_checkout(
  p_vehicle_id uuid,
  p_weekly_pattern jsonb,
  p_duration_months integer,
  p_time_slot public.time_slot,
  p_start_date date,
  p_address_id uuid DEFAULT NULL,
  p_parking_location text DEFAULT NULL,
  p_customer_notes text DEFAULT NULL,
  p_target_completion_time text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_pattern jsonb;
  v_same uuid;
  v_id uuid;
  v_req public.membership_requests%ROWTYPE;
  v_final bigint;
  v_pay jsonb;
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer') THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;

  -- Retrying the very same plan while its payment is still open: hand back that payment instead of making another.
  IF jsonb_typeof(p_weekly_pattern) = 'array' AND jsonb_array_length(p_weekly_pattern) > 0 THEN
    BEGIN
      SELECT jsonb_agg(jsonb_build_object('weekday', (e->>'weekday')::int, 'kind', e->>'kind') ORDER BY (e->>'weekday')::int)
        INTO v_pattern FROM jsonb_array_elements(p_weekly_pattern) e;
      SELECT r.id INTO v_same
        FROM public.membership_requests r JOIN public.payments pay ON pay.id = r.payment_id
        JOIN public.vehicles v ON v.id = r.vehicle_id
       WHERE r.customer_profile_id = v_profile AND r.vehicle_id = p_vehicle_id AND r.status = 'accepted'
         AND pay.status = 'pending' AND pay.expires_at > now()
         AND r.weekly_pattern = v_pattern AND r.duration_months = p_duration_months AND r.time_slot = p_time_slot AND r.start_date = p_start_date
         AND r.address_id IS NOT DISTINCT FROM COALESCE(p_address_id, v.address_id)
       LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      v_same := NULL; -- malformed input is reported by the validation below
    END;
    IF v_same IS NOT NULL THEN
      v_pay := public.accept_membership_quote(v_same);
      RETURN v_pay || jsonb_build_object('request_id', v_same);
    END IF;
  END IF;

  -- A different plan for the same vehicle replaces this customer's unfinished checkout (it must not block a fresh one).
  UPDATE public.payments SET status = 'failed', updated_at = now()
   WHERE status = 'pending' AND id IN (SELECT payment_id FROM public.membership_requests
                                        WHERE customer_profile_id = v_profile AND vehicle_id = p_vehicle_id
                                          AND status IN ('quoted', 'accepted') AND payment_id IS NOT NULL);
  UPDATE public.membership_requests SET status = 'cancelled', updated_at = now()
   WHERE customer_profile_id = v_profile AND vehicle_id = p_vehicle_id AND status IN ('submitted', 'quoted', 'accepted');

  -- Validates everything (vehicle ownership, address, start date, the mix, the length) and stores the rate-card price.
  v_id := public.create_membership_request(p_vehicle_id, p_weekly_pattern, p_duration_months, p_time_slot, p_start_date,
                                           p_address_id, p_parking_location, p_customer_notes, p_target_completion_time);

  SELECT * INTO v_req FROM public.membership_requests WHERE id = v_id FOR UPDATE;
  v_final := (v_req.system_quote->>'final_cents')::bigint;
  UPDATE public.membership_requests
     SET status = 'quoted', adjustment_cents = 0, adjustment_reason = NULL, quoted_amount_cents = v_final::int,
         quoted_breakdown = v_req.system_quote || jsonb_build_object('adjustment', jsonb_build_object('cents', 0, 'reason', NULL), 'final_cents', v_final),
         quote_expires_at = now() + make_interval(mins => app_private.setting('payment_intent_minutes') + 5),
         reviewed_at = now(), updated_at = now()
   WHERE id = v_id;

  PERFORM app_private.audit('membership_request', v_id, 'membership_checkout_started',
    jsonb_build_object('quoted_amount_cents', v_final, 'frequency_per_week', v_req.frequency_per_week, 'duration_months', v_req.duration_months));

  -- Opens the pending payment for exactly the stored price.
  v_pay := public.accept_membership_quote(v_id);
  RETURN v_pay || jsonb_build_object('request_id', v_id);
END $$;

REVOKE ALL ON FUNCTION public.start_membership_checkout(uuid, jsonb, integer, public.time_slot, date, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_membership_checkout(uuid, jsonb, integer, public.time_slot, date, uuid, text, text, text) TO authenticated;
