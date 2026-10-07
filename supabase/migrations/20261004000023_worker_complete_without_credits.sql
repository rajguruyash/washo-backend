-- 20261004000023_worker_complete_without_credits.sql
-- SAFE / re-runnable. A specialist can complete a MEMBERSHIP wash again.
--
-- Production still has the mobile app's original worker_complete_wash(): for a membership wash it calls consume_membership_entitlement_for_booking()
-- (it spends a wash CREDIT), and memberships bought on the website have no credits (there are no credits any more), so the specialist's final
-- "Mark wash completed" fails and the customer never sees the wash as done. Single washes and free-wash campaign washes were not affected.
--
-- This is ONLY the credit-free completion from supabase/cutover/20261005000001, split out so specialists can finish washes now. It does NOT touch
-- anything else in that cutover (the old mobile booking functions keep working, photos stay as they are, workers' view of customers is unchanged).
-- When the cutover is applied later, it replaces this function with the identical one: nothing changes.
--
-- What it does: the wash must be held by the caller and in progress, needs at least one before and one after photo, becomes completed (with the
-- time), the membership's schedule entry is marked completed, a "wash_completed" event is logged and the customer is notified. Completing a wash
-- that is already completed does nothing (it returns true). No data is touched when this migration is applied.

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
