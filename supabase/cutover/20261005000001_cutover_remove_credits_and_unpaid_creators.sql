-- 20261005000001_cutover_remove_credits_and_unpaid_creators.sql
-- *** CUTOVER: apply ONLY after the mobile app + edge functions use the payment-intent flow. ***
-- Older mobile builds that still call the retired functions will get a clear "please update" message
-- instead of silently creating unpaid bookings or free memberships.
--
--   * credits are retired: no entitlement is read or written by any live function
--   * worker_complete_wash completes a wash; it no longer consumes anything
--   * cancel_customer_booking: fixed (it wrote an event the CHECK rejected), no credit logic,
--     membership washes can be rescheduled but not cancelled by the customer, paid on-demand
--     cancellations raise a refund REQUEST for WASHO to review
--   * create_on_demand_booking / create_custom_membership / book_membership_credit_wash /
--     consume_membership_entitlement_for_booking become stubs that refuse
--
-- No data is touched. The credit tables themselves are handled by the next file.

-- ───────────────────────── wash completion: no credits ─────────────────────────
CREATE OR REPLACE FUNCTION public.worker_complete_wash(p_booking_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_worker uuid := public.current_profile_id();
  v_booking public.bookings%ROWTYPE;
  v_before integer;
  v_after integer;
BEGIN
  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;
  IF NOT public.is_current_worker_assignment(p_booking_id) THEN
    RAISE EXCEPTION 'Only the assigned worker may complete this booking';
  END IF;
  IF v_booking.status = 'completed' THEN RETURN true; END IF; -- idempotent
  IF v_booking.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Start the wash before completing it (status is %)', v_booking.status;
  END IF;

  SELECT count(*) FILTER (WHERE phase = 'before'), count(*) FILTER (WHERE phase = 'after')
    INTO v_before, v_after FROM public.booking_photos WHERE booking_id = p_booking_id;
  IF v_before < 1 THEN RAISE EXCEPTION 'At least 1 before photo is required before completion'; END IF;
  IF v_after < 1 THEN RAISE EXCEPTION 'At least 1 after photo is required before completion'; END IF;

  UPDATE public.bookings SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = p_booking_id;
  IF v_booking.membership_schedule_occurrence_id IS NOT NULL THEN
    UPDATE public.membership_schedule_occurrences SET status = 'completed', updated_at = now() WHERE id = v_booking.membership_schedule_occurrence_id;
  END IF;
  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id) VALUES (p_booking_id, 'wash_completed', v_worker);
  INSERT INTO public.notifications (profile_id, category, title, body, reference_id)
  VALUES (v_booking.customer_profile_id, 'wash_completed', 'Doorstep wash completed',
          'Your vehicle has been cleaned. Check the before and after photos in the app.', p_booking_id);
  RETURN true;
END $$;

-- ───────────────────────── cancellation ─────────────────────────
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

  -- A paid on-demand wash that is cancelled raises a refund REQUEST. WASHO decides and pays it out.
  SELECT * INTO v_pay FROM public.payments WHERE booking_id = p_booking_id AND status = 'paid' ORDER BY paid_at DESC LIMIT 1;
  IF FOUND AND NOT EXISTS (SELECT 1 FROM public.refunds WHERE payment_id = v_pay.id AND status <> 'reversed') THEN
    INSERT INTO public.refunds (payment_id, booking_id, customer_profile_id, amount_cents, reason, status)
    VALUES (v_pay.id, p_booking_id, v_pay.customer_profile_id, v_pay.amount_cents, 'Booking cancelled: ' || v_reason, 'requested');
    INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
    VALUES (p_booking_id, 'refund_requested', v_actor, jsonb_build_object('payment_id', v_pay.id, 'amount_cents', v_pay.amount_cents));
  END IF;
  RETURN true;
END $$;

-- ───────────────────────── admin_update_booking: no credit refunds ─────────────────────────
-- The original refunded a "wash credit" and extended entitlements when WASHO cancelled a membership wash. Credits are gone;
-- a cancelled wash is now handled explicitly (reschedule it with admin_reschedule_wash, or cancel it and decide on a refund).
CREATE OR REPLACE FUNCTION public.admin_update_booking(p_booking_id uuid, p_status text DEFAULT NULL, p_worker_profile_id uuid DEFAULT NULL, p_notes text DEFAULT NULL, p_parking_location text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_new_status public.booking_status;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: Only Super Admin can modify bookings.'; END IF;
  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found.'; END IF;
  v_new_status := COALESCE(NULLIF(p_status, '')::public.booking_status, v_booking.status);

  UPDATE public.bookings
     SET status = v_new_status, notes = COALESCE(p_notes, notes), parking_location = COALESCE(p_parking_location, parking_location),
         updated_at = now(), completed_at = CASE WHEN v_new_status = 'completed' AND completed_at IS NULL THEN now() ELSE completed_at END
   WHERE id = p_booking_id;

  IF v_booking.membership_schedule_occurrence_id IS NOT NULL AND v_new_status IN ('completed', 'cancelled', 'in_progress') THEN
    UPDATE public.membership_schedule_occurrences SET status = v_new_status::text::public.occurrence_status, updated_at = now()
     WHERE id = v_booking.membership_schedule_occurrence_id;
  END IF;

  IF p_worker_profile_id IS NOT NULL THEN
    PERFORM public.admin_assign_worker(p_booking_id, p_worker_profile_id);
  END IF;

  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
  VALUES (p_booking_id, 'admin_booking_updated', public.current_profile_id(),
          jsonb_build_object('new_status', v_new_status, 'reassigned_worker', p_worker_profile_id, 'notes', p_notes));
  RETURN jsonb_build_object('success', true, 'booking_id', p_booking_id, 'status', v_new_status);
END $$;

-- ───────────────────────── retired entry points ─────────────────────────
-- Same signatures as before so old app builds get a readable message, not "function does not exist".
CREATE OR REPLACE FUNCTION public.create_on_demand_booking(p_vehicle_id uuid, p_service_id uuid, p_scheduled_date date, p_time_slot public.time_slot)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Booking now starts with payment. Please update the WASHO app.' USING ERRCODE = 'P0001'; END $$;

CREATE OR REPLACE FUNCTION public.create_on_demand_booking(p_vehicle_id uuid, p_service_id uuid, p_scheduled_date date, p_time_slot public.time_slot, p_address_id uuid DEFAULT NULL, p_parking_location text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Booking now starts with payment. Please update the WASHO app.' USING ERRCODE = 'P0001'; END $$;

CREATE OR REPLACE FUNCTION public.create_on_demand_booking(p_vehicle_id uuid, p_service_id uuid, p_scheduled_date date, p_time_slot public.time_slot, p_address_id uuid DEFAULT NULL, p_parking_location text DEFAULT NULL, p_target_completion_time text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Booking now starts with payment. Please update the WASHO app.' USING ERRCODE = 'P0001'; END $$;

CREATE OR REPLACE FUNCTION public.create_custom_membership(p_vehicle_id uuid, p_service_id uuid, p_duration_months integer, p_washes_per_month integer, p_schedule_days integer[], p_time_slot public.time_slot, p_target_completion_time text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Memberships are now requested and approved by WASHO first. Please update the WASHO app.' USING ERRCODE = 'P0001'; END $$;

CREATE OR REPLACE FUNCTION public.book_membership_credit_wash(p_vehicle_id uuid, p_service_id uuid, p_scheduled_date date, p_time_slot public.time_slot, p_target_completion_time text DEFAULT NULL, p_address_id uuid DEFAULT NULL, p_parking_location text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Wash credits have been retired. Your membership washes are already scheduled; you can reschedule them. Please update the WASHO app.' USING ERRCODE = 'P0001'; END $$;

CREATE OR REPLACE FUNCTION public.consume_membership_entitlement_for_booking(p_booking_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Wash credits have been retired.' USING ERRCODE = 'P0001'; END $$;

-- The only thing in the credit system customers could still SEE is the legacy tables; the next file archives them.
