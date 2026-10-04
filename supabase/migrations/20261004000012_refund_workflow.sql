-- 20261004000012_refund_workflow.sql
-- SAFE / additive and re-runnable. Cancelling a paid wash now ends in a full refund that only an ADMIN can release.
--
--   customer cancels a paid on-demand wash  ->  refunds row 'requested' for the FULL amount paid (no cutoff, no deduction)
--   admin presses "Approve and refund"      ->  admin_begin_refund() claims it ('approved'); the website server asks Razorpay to
--                                               refund the original payment; on success admin_finish_refund() records the
--                                               Razorpay refund id ('processed', booking event 'refunded'); if Razorpay
--                                               refuses, admin_fail_refund() keeps the reason and the admin can try again.
--
-- cancel_customer_booking() moves here from cutover/20261005000001 so it works before the cutover. The refund step is the
-- only new behaviour; it does not touch credits. (Production has no membership bookings or credit-paid washes today.)
-- Membership washes still cannot be cancelled by customers; they reschedule (admins may cancel).
--
-- Nothing here pays money out by itself: the database only records the decision. Razorpay is called by the server.

ALTER TABLE public.refunds ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.refunds ADD COLUMN IF NOT EXISTS failure_reason text;

-- ───────────────────────── cancellation (full refund request for a paid wash) ─────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_customer_booking(p_booking_id uuid, p_reason text DEFAULT 'Customer requested cancellation')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public.current_profile_id();
  v_admin boolean := public.is_admin();
  v_booking public.bookings%ROWTYPE;
  v_pay public.payments%ROWTYPE;
  v_reason text := COALESCE(NULLIF(trim(p_reason), ''), 'Customer requested cancellation');
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR (v_booking.customer_profile_id <> v_actor AND NOT v_admin) THEN RAISE EXCEPTION 'Booking not found'; END IF;

  IF v_booking.status NOT IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up') THEN
    RAISE EXCEPTION 'This booking can no longer be cancelled (it is %)', v_booking.status;
  END IF;
  IF v_booking.booking_type = 'membership' AND NOT v_admin THEN
    RAISE EXCEPTION 'Membership washes can be rescheduled but not cancelled. Please reschedule it, or contact WASHO.';
  END IF;

  UPDATE public.bookings
     SET status = 'cancelled', cancel_reason = v_reason, updated_at = now(),
         notes = COALESCE(notes || E'\n', '') || 'Cancelled: ' || v_reason
   WHERE id = p_booking_id;
  IF v_booking.membership_schedule_occurrence_id IS NOT NULL THEN
    UPDATE public.membership_schedule_occurrences SET status = 'cancelled', updated_at = now() WHERE id = v_booking.membership_schedule_occurrence_id;
  END IF;
  UPDATE public.worker_assignments SET is_active = false, unassigned_at = now() WHERE booking_id = p_booking_id AND is_active;

  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
  VALUES (p_booking_id, 'cancelled', v_actor, jsonb_build_object('reason', v_reason, 'cancelled_by', CASE WHEN v_admin THEN 'admin' ELSE 'customer' END));

  -- A paid on-demand wash that is cancelled raises a refund REQUEST for exactly what was paid. An admin approves it.
  SELECT * INTO v_pay FROM public.payments WHERE booking_id = p_booking_id AND status = 'paid' ORDER BY paid_at DESC LIMIT 1;
  IF FOUND AND NOT EXISTS (SELECT 1 FROM public.refunds WHERE payment_id = v_pay.id AND status <> 'reversed') THEN
    INSERT INTO public.refunds (payment_id, booking_id, customer_profile_id, amount_cents, reason, status)
    VALUES (v_pay.id, p_booking_id, v_pay.customer_profile_id, v_pay.amount_cents, 'Booking cancelled: ' || v_reason, 'requested');
    INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
    VALUES (p_booking_id, 'refund_requested', v_actor, jsonb_build_object('payment_id', v_pay.id, 'amount_cents', v_pay.amount_cents));
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.cancel_customer_booking(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_customer_booking(uuid, text) TO authenticated;

-- ───────────────────────── admin: approve and pay a refund ─────────────────────────
-- Step 1. Claims the refund so two admins cannot pay it twice, and hands the server what it needs to call Razorpay.
-- A refund already claimed less than two minutes ago is refused; an older claim means the server died mid-call, and the
-- server checks Razorpay for an existing refund before it creates another.
CREATE OR REPLACE FUNCTION public.admin_begin_refund(p_refund_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r public.refunds%ROWTYPE;
  v_pay public.payments%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_r FROM public.refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund not found'; END IF;
  IF v_r.status IN ('processed', 'reversed') THEN RAISE EXCEPTION 'This refund is already %', v_r.status; END IF;
  IF v_r.status = 'approved' AND v_r.approved_at IS NOT NULL AND v_r.approved_at > now() - interval '2 minutes' THEN
    RAISE EXCEPTION 'This refund is already being paid out. Check again in a minute.';
  END IF;
  SELECT * INTO v_pay FROM public.payments WHERE id = v_r.payment_id;
  IF v_pay.provider IS DISTINCT FROM 'razorpay' OR v_pay.provider_payment_id IS NULL OR v_pay.status NOT IN ('paid', 'partially_refunded') THEN
    RAISE EXCEPTION 'This payment has no captured Razorpay payment to refund. Record the refund by hand instead.';
  END IF;

  UPDATE public.refunds SET status = 'approved', approved_at = now(), failure_reason = NULL, updated_at = now() WHERE id = p_refund_id;
  PERFORM app_private.audit('refund', p_refund_id, 'refund_approved', jsonb_build_object('from', v_r.status, 'amount_cents', v_r.amount_cents));
  RETURN jsonb_build_object(
    'refund_id', v_r.id, 'amount_cents', v_r.amount_cents, 'currency', v_pay.currency,
    'provider_payment_id', v_pay.provider_payment_id, 'booking_id', v_r.booking_id
  );
END $$;
REVOKE ALL ON FUNCTION public.admin_begin_refund(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_begin_refund(uuid) TO authenticated; -- is_admin() inside

-- Step 2a. Razorpay accepted the refund: record its id, tell the customer's timeline, and mark the payment refunded.
CREATE OR REPLACE FUNCTION public.admin_finish_refund(p_refund_id uuid, p_provider_refund_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r public.refunds%ROWTYPE;
  v_pay public.payments%ROWTYPE;
  v_done integer;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  IF p_provider_refund_id IS NULL OR char_length(trim(p_provider_refund_id)) < 4 THEN
    RAISE EXCEPTION 'Enter the Razorpay refund id so the payout can be traced';
  END IF;
  SELECT * INTO v_r FROM public.refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund not found'; END IF;
  IF v_r.status = 'processed' AND v_r.provider_refund_id = trim(p_provider_refund_id) THEN RETURN true; END IF; -- idempotent
  IF v_r.status IN ('processed', 'reversed') THEN RAISE EXCEPTION 'This refund is already %', v_r.status; END IF;

  UPDATE public.refunds
     SET status = 'processed', provider_refund_id = trim(p_provider_refund_id), failure_reason = NULL, updated_at = now()
   WHERE id = p_refund_id;

  SELECT * INTO v_pay FROM public.payments WHERE id = v_r.payment_id FOR UPDATE;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_done FROM public.refunds WHERE payment_id = v_r.payment_id AND status = 'processed';
  UPDATE public.payments
     SET status = CASE WHEN v_done >= v_pay.amount_cents THEN 'refunded'::public.payment_status ELSE 'partially_refunded'::public.payment_status END,
         updated_at = now()
   WHERE id = v_r.payment_id AND status IN ('paid', 'partially_refunded');

  IF v_r.booking_id IS NOT NULL THEN
    INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
    VALUES (v_r.booking_id, 'refunded', public.current_profile_id(),
            jsonb_build_object('refund_id', v_r.id, 'amount_cents', v_r.amount_cents, 'provider_refund_id', trim(p_provider_refund_id)));
  END IF;
  PERFORM app_private.audit('refund', p_refund_id, 'refund_processed', jsonb_build_object('provider_refund_id', trim(p_provider_refund_id), 'amount_cents', v_r.amount_cents));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_finish_refund(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_finish_refund(uuid, text) TO authenticated; -- is_admin() inside

-- Step 2b. Razorpay refused (or could not be reached): keep why, leave it retryable.
CREATE OR REPLACE FUNCTION public.admin_fail_refund(p_refund_id uuid, p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old public.refund_status;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  SELECT status INTO v_old FROM public.refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund not found'; END IF;
  IF v_old IN ('processed', 'reversed') THEN RAISE EXCEPTION 'This refund is already %', v_old; END IF;
  UPDATE public.refunds
     SET status = 'failed', failure_reason = left(COALESCE(NULLIF(trim(p_reason), ''), 'Razorpay did not accept the refund'), 300), updated_at = now()
   WHERE id = p_refund_id;
  PERFORM app_private.audit('refund', p_refund_id, 'refund_failed', jsonb_build_object('from', v_old, 'reason', left(COALESCE(p_reason, ''), 300)));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_fail_refund(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_fail_refund(uuid, text) TO authenticated; -- is_admin() inside

-- Recording a refund you paid by hand in the Razorpay dashboard still works; 'processed' now goes through the same
-- bookkeeping as the automatic path (booking event, payment marked refunded).
CREATE OR REPLACE FUNCTION public.admin_resolve_refund(p_refund_id uuid, p_status public.refund_status, p_provider_refund_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old public.refund_status;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('approved', 'processed', 'failed') THEN RAISE EXCEPTION 'A refund can be marked approved, processed or failed'; END IF;
  IF p_status = 'processed' THEN RETURN public.admin_finish_refund(p_refund_id, p_provider_refund_id); END IF;
  SELECT status INTO v_old FROM public.refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund not found'; END IF;
  IF v_old IN ('processed', 'reversed') THEN RAISE EXCEPTION 'This refund is already %', v_old; END IF;
  UPDATE public.refunds SET status = p_status, provider_refund_id = COALESCE(NULLIF(trim(p_provider_refund_id), ''), provider_refund_id), updated_at = now() WHERE id = p_refund_id;
  PERFORM app_private.audit('refund', p_refund_id, 'refund_' || p_status::text, jsonb_build_object('from', v_old, 'provider_refund_id', p_provider_refund_id));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_resolve_refund(uuid, public.refund_status, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_refund(uuid, public.refund_status, text) TO authenticated; -- is_admin() inside
