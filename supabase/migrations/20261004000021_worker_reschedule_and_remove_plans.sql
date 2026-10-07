-- 20261004000021_worker_reschedule_and_remove_plans.sql
-- SAFE / additive and re-runnable. Two small things:
--
-- 1. A SPECIALIST can move a membership wash when the customer's vehicle is not available that day.
--    worker_reschedule_wash(booking, new_date, new_slot?, reason?) uses the same core as the customer's and the admin's reschedule
--    (app_private.reschedule_wash), so the same rules hold: the membership must be active, the wash not started, the new day inside the term,
--    no other wash for that vehicle that day. What differs: a specialist may choose any day from today on (a customer needs 2 days' notice),
--    only for a wash they hold, and the wash stays with them on its new date unless the membership has a different regular specialist.
--    The booking's timeline says it was the specialist who moved it and why (the customer sees it).
--
-- 2. A CUSTOMER can remove a plan from their own pages: a plan they started but never paid for, or a membership / request that has ended.
--    Nothing is deleted: customer_hidden_plans remembers what they cleared (admins still see everything), and an unpaid plan's checkout is
--    stopped (its open payment is marked failed, the request cancelled), the same way starting a different plan already does.
--    An active membership and a payment that has come in are never touched.

-- ───────────────────────── 1. the shared reschedule core also names the specialist ─────────────────────────
-- Same function as migration 06; the only change is the 'by' value in the booking event: customer | worker | admin.
CREATE OR REPLACE FUNCTION app_private.reschedule_wash(
  p_occurrence_id uuid, p_new_date date, p_new_slot public.time_slot,
  p_actor uuid,            -- profile making the change
  p_customer uuid,         -- non-null: the caller must own the membership (customer path); null: staff path
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
                             'by', CASE WHEN p_customer IS NOT NULL THEN 'customer'
                                        WHEN EXISTS (SELECT 1 FROM public.profiles a WHERE a.id = p_actor AND a.role = 'worker') THEN 'worker'
                                        ELSE 'admin' END,
                             'reason', NULLIF(trim(p_reason), ''),
                             'worker_profile_id', v_worker));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app_private.reschedule_wash(uuid, date, public.time_slot, uuid, uuid, date, text) FROM PUBLIC, anon, authenticated;

-- A specialist moves a membership wash they hold (the vehicle is not available that day, or another reason).
CREATE OR REPLACE FUNCTION public.worker_reschedule_wash(p_booking_id uuid, p_new_date date, p_new_slot public.time_slot DEFAULT NULL, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_worker uuid := public.current_profile_id();
  v_b public.bookings%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_slot public.time_slot;
  v_reason text := COALESCE(NULLIF(btrim(COALESCE(p_reason, '')), ''), 'Vehicle was not available');
BEGIN
  IF NOT public.is_worker() OR NOT public.is_current_worker_assignment(p_booking_id) THEN
    RAISE EXCEPTION 'Not authorized for this wash assignment';
  END IF;
  IF char_length(v_reason) > 300 THEN RAISE EXCEPTION 'Please keep the reason under 300 characters'; END IF;

  SELECT * INTO v_b FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF v_b.membership_schedule_occurrence_id IS NULL THEN
    RAISE EXCEPTION 'Only a membership wash can be moved here. For a single wash, report the problem and WASHO will sort it out';
  END IF;
  IF v_b.status = 'in_progress' THEN RAISE EXCEPTION 'The wash has already started'; END IF;
  IF p_new_date IS NULL THEN RAISE EXCEPTION 'Choose the new date'; END IF;
  IF p_new_date < v_today THEN RAISE EXCEPTION 'Choose today or a later date'; END IF;
  v_slot := COALESCE(p_new_slot, v_b.time_slot);

  PERFORM app_private.reschedule_wash(v_b.membership_schedule_occurrence_id, p_new_date, v_slot, v_worker, NULL, v_today, v_reason);

  -- The wash stays with this specialist on its new date, unless the membership has its own regular specialist (the core already gave it to them).
  IF NOT EXISTS (SELECT 1 FROM public.worker_assignments WHERE booking_id = p_booking_id AND is_active) THEN
    INSERT INTO public.worker_assignments (booking_id, worker_profile_id, is_active, assigned_at) VALUES (p_booking_id, v_worker, true, now());
    UPDATE public.bookings SET status = 'worker_assigned', updated_at = now() WHERE id = p_booking_id;
  END IF;

  PERFORM app_private.audit('booking', p_booking_id, 'worker_rescheduled_wash',
    jsonb_build_object('from_date', v_b.scheduled_date, 'to_date', p_new_date, 'slot', v_slot, 'reason', v_reason));
  RETURN jsonb_build_object('booking_id', p_booking_id, 'old_date', v_b.scheduled_date, 'new_date', p_new_date, 'new_slot', v_slot);
END $$;
REVOKE ALL ON FUNCTION public.worker_reschedule_wash(uuid, date, public.time_slot, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.worker_reschedule_wash(uuid, date, public.time_slot, text) TO authenticated; -- is_worker() inside

-- ───────────────────────── 2. a customer clears a plan from their own pages ─────────────────────────
CREATE TABLE IF NOT EXISTS public.customer_hidden_plans (
  customer_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL,
  ref_id uuid NOT NULL,
  hidden_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_profile_id, kind, ref_id),
  CONSTRAINT customer_hidden_plans_kind_check CHECK (kind IN ('membership', 'membership_request'))
);
ALTER TABLE public.customer_hidden_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_hidden_plans_own_read ON public.customer_hidden_plans;
CREATE POLICY customer_hidden_plans_own_read ON public.customer_hidden_plans FOR SELECT TO authenticated
  USING (customer_profile_id = public.current_profile_id());
REVOKE ALL ON public.customer_hidden_plans FROM anon, authenticated;
GRANT SELECT ON public.customer_hidden_plans TO authenticated; -- RLS: their own rows only

-- kind 'membership_request': a plan started but not paid, or an earlier request that has ended.  kind 'membership': one that has ended.
-- Returns what happened: { removed, stopped_checkout }.
CREATE OR REPLACE FUNCTION public.remove_my_plan(p_kind text, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_status text;
  v_stopped boolean := false;
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer') THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;

  IF p_kind = 'membership_request' THEN
    SELECT status::text INTO v_status FROM public.membership_requests WHERE id = p_id AND customer_profile_id = v_profile FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found'; END IF;
    IF v_status = 'active' THEN RAISE EXCEPTION 'This plan has been paid for and is now a membership'; END IF;
    IF v_status IN ('submitted', 'quoted', 'accepted') THEN
      -- Unpaid: stop its checkout. A payment that has already come in is never thrown away.
      IF EXISTS (SELECT 1 FROM public.payments WHERE membership_request_id = p_id AND status::text NOT IN ('pending', 'failed', 'cancelled', 'expired')) THEN
        RAISE EXCEPTION 'A payment for this plan has been received. It will show up as a membership shortly';
      END IF;
      UPDATE public.payments SET status = 'failed', updated_at = now() WHERE membership_request_id = p_id AND status = 'pending';
      UPDATE public.membership_requests SET status = 'cancelled', updated_at = now() WHERE id = p_id;
      PERFORM app_private.audit('membership_request', p_id, 'membership_plan_removed_by_customer', jsonb_build_object('was', v_status));
      v_stopped := true;
    END IF;
  ELSIF p_kind = 'membership' THEN
    SELECT status::text INTO v_status FROM public.memberships WHERE id = p_id AND customer_profile_id = v_profile;
    IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found'; END IF;
    IF v_status = 'active' THEN RAISE EXCEPTION 'An active membership cannot be removed. Contact WASHO to pause or end it'; END IF;
  ELSE
    RAISE EXCEPTION 'Unknown kind of plan';
  END IF;

  INSERT INTO public.customer_hidden_plans (customer_profile_id, kind, ref_id) VALUES (v_profile, p_kind, p_id) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('removed', true, 'stopped_checkout', v_stopped);
END $$;
REVOKE ALL ON FUNCTION public.remove_my_plan(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_my_plan(text, uuid) TO authenticated;
