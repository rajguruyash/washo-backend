-- 20261004000006_reschedule_membership_wash.sql
-- SAFE: same signature the mobile app already calls; strictly more correct.
--
-- What was wrong with the live function:
--   * changing the TIME SLOT always failed ("Booking date and time slot must match the schedule occurrence"):
--     the occurrence trigger and the booking trigger each demanded the other be updated first
--   * a wash could be moved outside the membership's own term, onto a day the vehicle was already booked,
--     or on a membership that is no longer active
--   * a worker who had already claimed the wash stayed assigned to the old date
--
-- Membership washes can be RESCHEDULED but not cancelled by the customer (WASHO rule). Moving a wash
-- consumes nothing: there are no credits; the wash simply happens on its new date.
--
-- One core (app_private.reschedule_wash) serves the customer and WASHO's admins, so both follow the same rules.
--
-- Worker queue behaviour: the moved wash is released from whoever held it. If the membership has a regular
-- specialist (memberships.assigned_worker_profile_id) the wash goes straight back into THAT worker's queue on
-- its new date; otherwise it returns to the pool. A 'rescheduled' booking event records old and new date/slot,
-- which is what the worker queue shows as "moved from ...".

CREATE OR REPLACE FUNCTION app_private.reschedule_wash(
  p_occurrence_id uuid, p_new_date date, p_new_slot public.time_slot,
  p_actor uuid,            -- profile making the change
  p_customer uuid,         -- non-null: the caller must own the membership (customer path); null: admin path
  p_min_date date,         -- earliest date allowed for this caller
  p_reason text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o public.membership_schedule_occurrences%ROWTYPE;
  v_membership public.memberships%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_worker uuid;
BEGIN
  SELECT * INTO o FROM public.membership_schedule_occurrences WHERE id = p_occurrence_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wash not found'; END IF;

  SELECT m.* INTO v_membership
    FROM public.membership_schedules ms JOIN public.memberships m ON m.id = ms.membership_id
   WHERE ms.id = o.membership_schedule_id;
  IF p_customer IS NOT NULL AND v_membership.customer_profile_id <> p_customer THEN RAISE EXCEPTION 'Wash not found'; END IF;
  IF v_membership.status <> 'active' THEN RAISE EXCEPTION 'This membership is not active'; END IF;

  SELECT * INTO v_booking FROM public.bookings WHERE membership_schedule_occurrence_id = p_occurrence_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wash not found'; END IF;
  IF v_booking.status NOT IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'rescheduled') THEN
    RAISE EXCEPTION 'This wash is % and cannot be rescheduled', v_booking.status;
  END IF;

  IF p_new_date IS NULL OR p_new_date < p_min_date THEN
    RAISE EXCEPTION 'Washes need at least 1 day of preparation. The earliest date is %', p_min_date;
  END IF;
  IF p_new_date < o.original_date THEN
    RAISE EXCEPTION 'A wash cannot be moved earlier than its original date (%)', o.original_date;
  END IF;
  IF p_new_date > (v_membership.end_at AT TIME ZONE 'Asia/Kolkata')::date THEN
    RAISE EXCEPTION 'Please choose a date within your membership, which ends on %', (v_membership.end_at AT TIME ZONE 'Asia/Kolkata')::date;
  END IF;
  IF p_new_date = o."current_date" AND p_new_slot = o.time_slot THEN
    RAISE EXCEPTION 'That is already the date and time of this wash';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bookings
              WHERE vehicle_id = v_booking.vehicle_id AND scheduled_date = p_new_date AND id <> v_booking.id
                AND status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'in_progress')) THEN
    RAISE EXCEPTION 'This vehicle already has a wash on that date';
  END IF;

  -- The two validation triggers require booking and occurrence to agree at every step, so move them in an
  -- order where they always do: (1) the date (the occurrence trigger carries the booking along), then
  -- (2) the slot on the occurrence, then (3) the same slot on the booking.
  IF p_new_date <> o."current_date" THEN
    UPDATE public.membership_schedule_occurrences
       SET "current_date" = p_new_date, status = 'rescheduled', updated_at = now() WHERE id = p_occurrence_id;
  END IF;
  IF p_new_slot <> o.time_slot THEN
    UPDATE public.membership_schedule_occurrences
       SET time_slot = p_new_slot, status = 'rescheduled', updated_at = now() WHERE id = p_occurrence_id;
  END IF;

  UPDATE public.bookings
     SET time_slot = p_new_slot, status = 'confirmed', customer_confirmed_at = NULL, updated_at = now(),
         notes = COALESCE(notes, '') || E'\nRescheduled from ' || v_booking.scheduled_date::text || ' to ' || p_new_date::text
   WHERE id = v_booking.id;

  -- Whoever held the old date no longer does.
  UPDATE public.worker_assignments SET is_active = false, unassigned_at = now() WHERE booking_id = v_booking.id AND is_active;

  -- A membership with a regular specialist keeps that specialist on its washes.
  SELECT p.id INTO v_worker FROM public.profiles p WHERE p.id = v_membership.assigned_worker_profile_id AND p.role = 'worker';
  IF v_worker IS NOT NULL THEN
    INSERT INTO public.worker_assignments (booking_id, worker_profile_id, is_active, assigned_at) VALUES (v_booking.id, v_worker, true, now());
    UPDATE public.bookings SET status = 'worker_assigned' WHERE id = v_booking.id;
  END IF;

  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
  VALUES (v_booking.id, 'rescheduled', p_actor,
          jsonb_build_object('old_date', v_booking.scheduled_date, 'old_slot', v_booking.time_slot,
                             'new_date', p_new_date, 'new_slot', p_new_slot,
                             'by', CASE WHEN p_customer IS NULL THEN 'admin' ELSE 'customer' END,
                             'reason', NULLIF(trim(p_reason), ''),
                             'worker_profile_id', v_worker));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app_private.reschedule_wash(uuid, date, public.time_slot, uuid, uuid, date, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reschedule_booking_occurrence(p_occurrence_id uuid, p_new_date date, p_new_slot public.time_slot)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_customer uuid := public.current_profile_id();
  v_min_date date := (now() AT TIME ZONE 'Asia/Kolkata')::date + 2;
BEGIN
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  RETURN app_private.reschedule_wash(p_occurrence_id, p_new_date, p_new_slot, v_customer, v_customer, v_min_date, NULL);
END $$;

REVOKE ALL ON FUNCTION public.reschedule_booking_occurrence(uuid, date, public.time_slot) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reschedule_booking_occurrence(uuid, date, public.time_slot) TO authenticated;
