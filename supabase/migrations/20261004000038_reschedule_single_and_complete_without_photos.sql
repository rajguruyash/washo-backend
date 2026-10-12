-- 20261004000038_reschedule_single_and_complete_without_photos.sql
-- SAFE / re-runnable. Two small changes to two existing functions. No table, column or row is touched when this is applied.
--
-- 1. An admin can move a SINGLE (on-demand) wash too, paid or not. admin_reschedule_wash(booking, new_date, new_slot, reason) used to move membership washes only.
--    A membership wash goes exactly as before (it still uses the shared core app_private.reschedule_wash). A single wash:
--      * must still be open (not started, finished, cancelled or refunded)
--      * can go to today or any later day and any time window (admins are not held to the customer's notice, and booking a wash for a customer does not look at capacity either)
--      * cannot land on a day when the same vehicle already has another open wash
--      * goes back to "confirmed" and whoever was going to do it is released, so WASHO picks a specialist for the new day; the customer's "confirmed on the phone" is cleared
--      * the timeline says "WASHO moved this wash" with the new date (a "rescheduled" event, by admin, with the reason), and the customer gets a notification
--
-- 2. A specialist can complete a wash WITHOUT photos. worker_complete_wash() used to refuse until there was at least one before and one after photo.
--    Photos are still encouraged and still stored and shown when they are taken; they are no longer required. Everything else is the same (the wash must be held by the
--    caller and in progress; completing twice does nothing; a membership's schedule entry is marked completed; the customer is told). The "wash_completed" event now records
--    how many before and after photos there were, so WASHO can see a wash that was finished without any.
--    This is the same function that supabase/cutover/20261005000001 defines (the cutover copy has the same change, so applying it later does not bring the rule back).

-- ───────────────────────── 1. admin moves a wash (membership or single) ─────────────────────────
CREATE OR REPLACE FUNCTION public.admin_reschedule_wash(p_booking_id uuid, p_new_date date, p_new_slot public.time_slot, p_reason text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_b public.bookings%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_service text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 300 THEN RAISE EXCEPTION 'Please keep the reason under 300 characters'; END IF;

  SELECT * INTO v_b FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wash not found'; END IF;

  -- A membership wash: the one shared core, exactly as before.
  IF v_b.membership_schedule_occurrence_id IS NOT NULL THEN
    RETURN app_private.reschedule_wash(v_b.membership_schedule_occurrence_id, p_new_date, p_new_slot, public.current_profile_id(), NULL, v_today, p_reason);
  END IF;

  -- A single wash.
  IF v_b.booking_type <> 'on_demand' THEN RAISE EXCEPTION 'This wash cannot be moved here'; END IF;
  IF v_b.status NOT IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'rescheduled') THEN
    RAISE EXCEPTION 'This wash is % and cannot be rescheduled', v_b.status;
  END IF;
  IF p_new_date IS NULL OR p_new_slot IS NULL THEN RAISE EXCEPTION 'Choose the new date and time'; END IF;
  IF p_new_date < v_today THEN RAISE EXCEPTION 'Choose today or a later date'; END IF;
  IF p_new_date = v_b.scheduled_date AND p_new_slot = v_b.time_slot THEN
    RAISE EXCEPTION 'That is already the date and time of this wash';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bookings
              WHERE vehicle_id = v_b.vehicle_id AND scheduled_date = p_new_date AND id <> v_b.id
                AND status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'in_progress')) THEN
    RAISE EXCEPTION 'This vehicle already has a wash on that date';
  END IF;

  UPDATE public.bookings
     SET scheduled_date = p_new_date, time_slot = p_new_slot, status = 'confirmed', customer_confirmed_at = NULL, updated_at = now(),
         notes = COALESCE(notes, '') || E'\nRescheduled from ' || v_b.scheduled_date::text || ' to ' || p_new_date::text
   WHERE id = v_b.id;

  -- Whoever held the old date no longer does; WASHO chooses a specialist for the new one.
  UPDATE public.worker_assignments SET is_active = false, unassigned_at = now() WHERE booking_id = v_b.id AND is_active;

  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
  VALUES (v_b.id, 'rescheduled', public.current_profile_id(),
          jsonb_build_object('old_date', v_b.scheduled_date, 'old_slot', v_b.time_slot, 'new_date', p_new_date, 'new_slot', p_new_slot,
                             'by', 'admin', 'reason', v_reason, 'worker_profile_id', NULL));

  SELECT name INTO v_service FROM public.services WHERE id = v_b.service_id;
  INSERT INTO public.notifications (profile_id, category, title, body, reference_id)
  VALUES (v_b.customer_profile_id, 'booking_confirmed', 'Your wash was moved',
          COALESCE(v_service, 'Your wash') || ' is now on ' || to_char(p_new_date, 'Dy DD Mon') || ' (' || p_new_slot || ')', v_b.id);
  PERFORM app_private.audit('booking', v_b.id, 'admin_rescheduled_wash',
    jsonb_build_object('from_date', v_b.scheduled_date, 'from_slot', v_b.time_slot, 'to_date', p_new_date, 'to_slot', p_new_slot, 'reason', v_reason));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_reschedule_wash(uuid, date, public.time_slot, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reschedule_wash(uuid, date, public.time_slot, text) TO authenticated; -- is_admin() inside

-- ───────────────────────── 2. a specialist completes a wash with or without photos ─────────────────────────
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

  UPDATE public.bookings SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = p_booking_id;
  IF v_booking.membership_schedule_occurrence_id IS NOT NULL THEN
    UPDATE public.membership_schedule_occurrences SET status = 'completed', updated_at = now() WHERE id = v_booking.membership_schedule_occurrence_id;
  END IF;
  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
  VALUES (p_booking_id, 'wash_completed', v_worker, jsonb_build_object('photos_before', v_before, 'photos_after', v_after));
  INSERT INTO public.notifications (profile_id, category, title, body, reference_id)
  VALUES (v_booking.customer_profile_id, 'wash_completed', 'Doorstep wash completed',
          CASE WHEN v_before + v_after > 0 THEN 'Your vehicle has been cleaned. Check the before and after photos in the app.' ELSE 'Your vehicle has been cleaned.' END,
          p_booking_id);
  RETURN true;
END $$;
